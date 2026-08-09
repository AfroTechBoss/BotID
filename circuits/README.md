# circuits

The Gold tier's circuit: an ONNX model, the `ezkl` pipeline that turns it into a halo2 proving
key and an on-chain verifier, and the two entrypoints the relayer calls.

```
spec.json         the model's identity — feeds, outputs, scale, domain
export_onnx.py    builds the graph, and the integer reference the circuit is checked against
pipeline.py       gen-settings -> calibrate -> compile -> fidelity -> srs -> setup -> verifier
run.py            inference: values -> public instances (no proof)
prove.py          proving: values -> hex proof + instances
common.py         paths, spec loading, field encoding
```

## Setup

`ezkl` ships as a prebuilt wheel; nothing needs compiling.

```bash
python -m venv .venv && .venv/Scripts/activate && pip install ezkl onnx numpy
```

On Windows, put the virtualenv somewhere shallow. `pip` fails with `[WinError 206] The filename
or extension is too long` if the environment's path is deep, and the error names a package rather
than the real cause.

## Build

```bash
python export_onnx.py && python pipeline.py
```

That writes `build/`, of which four files matter:

| file | role |
| --- | --- |
| `model.compiled` | the circuit — needed to run or prove |
| `pk.key` | proving key, ~150MB — needed to prove, keep off public hosts |
| `vk.key` | verifying key — pins the circuit's identity |
| `Verifier.sol` | the EVM verifier, deployed and bound with `ZkAdapter.setVerifier` |

Registration is the last line `pipeline.py` prints:

```
setVerifier(keccak256("botid.reference-allocator.v1"), <verifier>, 8)
```

The third argument is the scale. Get it wrong and every honest proof for the model is rejected —
a liveness failure, not a security one, but a silent one.

## Run and prove

```bash
python run.py '{"values": [12500, 34000, 4200]}'
python prove.py '{"values": [12500, 34000, 4200]}'
```

`run.py` is the inference path, and it is what every tier should call — Bronze and Silver
included. The output commitment goes on chain at delivery, long before anyone asks for a proof.
If a Bronze agent computes its answer with a hand-written reimplementation of the model and that
reimplementation differs from the circuit in the last digit, the agent has already committed to a
number it cannot later prove. Running the circuit at every tier makes the tiers agree by
construction instead of by review.

`prove.py` accepts an optional `instances` field. Pass the vector the agent committed to and it
refuses to prove anything else, so a stale build is caught before the proof is spent.

## The instance vector

`ZkAdapter` expects exactly the model's input tensor followed by its output tensor:

```
instances[0 .. nIn)          input cells   = value << inputScaleBits
instances[nIn .. nIn + nOut) output cells
```

Nothing protocol-specific is in the circuit. `inputCommitment` and `outputCommitment` are keccak
commitments, and halo2 cannot compute keccak without a gadget `ezkl` does not expose; binding
them on chain costs 6 gas a word and checks against the router's own storage instead of against a
number the prover chose. The reasoning is written out in full in `ZkAdapter.sol`.

Signed values use the bn254 encoding — `v >= 0 ? v : P - |v|` — and magnitudes at or beyond
`2^128` are refused before reduction, because a reveal of the literal integer `P - 42` would
otherwise produce the same cell as `-42`.

## Two constraints that shaped the model

Both were found by watching the circuit fail, and both are the reason the reference allocator
looks the way it does rather than the way the obvious version would.

**`ezkl` division is a reciprocal lookup.** `Div` compiles to a multiplication by a looked-up
`1/d`, so the quotient's precision is set by how well the reciprocal survives quantisation.
Divide by a bundle total in the hundreds of thousands and the reciprocal rounds to zero: the
circuit compiles, `setup` succeeds, proofs verify — and every output is 0. There is no error
anywhere. The reference model therefore divides by a *count*, bounded by the number of feeds,
which the lookup represents exactly. `pipeline.py` runs a fidelity check against the integer
reference on every calibration sample specifically so this failure cannot ship.

The same failure appears at `input_scale = 0`, from the other direction: with no fractional bits
at all there is nowhere for a reciprocal to live. Scale 0 is not an option for any model that
divides, which is why the scale is a registration parameter rather than a constant.

**Intermediates must stay under 2^28.** halo2 decomposes values in base `2^14` with two limbs.
The largest intermediate here is `feeds × maxAbsValue << inputScaleBits`; past `2^28` compilation
fails outright with a decomposition error. That is the bound behind `maxAbsValue` in `spec.json`,
and it is a hard trade: raising the scale for precision costs domain, and vice versa.

```
3 × 300000 × 2^8  =  2.30e8   <  2^28 = 2.68e8
```

## Changing the model

Every field in `spec.json` is part of the model's identity. Changing the feed count, the output
count, the scale or the domain changes the circuit, the verifying key, and therefore the agent
id — reputation does not transfer across the change. That is deliberate: a reputation earned by
one model should not be inherited by a different one wearing its name.
