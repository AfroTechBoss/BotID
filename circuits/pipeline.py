"""Compile the ONNX graph into a halo2 circuit, a proving key, and an on-chain verifier.

Run once per model. The outputs that matter downstream are:

    build/model.compiled   the circuit          -> needed to prove
    build/pk.key           proving key          -> needed to prove (keep off public hosts)
    build/vk.key           verifying key        -> pins the circuit's identity
    build/Verifier.sol     EVM verifier         -> deployed and bound via ZkAdapter.setVerifier
    build/settings.json    scales and layout    -> asserted against on every proof

The settings assertions below are not decoration. `ZkAdapter` compares the circuit's public
instances to values it derives from the request, so a circuit compiled at a scale other than the
one the model is registered with, or with anything other than public inputs and public outputs,
produces proofs that are perfectly valid and never accepted. Failing here is the cheap place to
find that out.
"""

import json
import sys

import ezkl

from common import call, die, from_field, paths, scale_bits, spec
from export_onnx import reference
from run import witness

# The SRS ceremony transcript ezkl fetches. Nothing about the protocol depends on trusting it
# beyond the usual KZG setup assumption, but it does have to be the same one the verifier was
# generated against.
LOGROWS_CAP = 20


def run_args():
    bits = scale_bits()
    args = ezkl.PyRunArgs()
    # The scale is not a tuning knob here, it is part of the model's on-chain registration.
    #
    # Scale 0 looks tempting for an integer model — the instance cell would be the value itself
    # and there would be nothing to agree on. It does not work. At scale 0 the reciprocal ezkl
    # builds for `Div` quantises to zero, so the allocator's final division silently returns
    # nothing: every output cell comes out 0 while the proof verifies happily. Any model that
    # normalises, softmaxes or averages hits the same wall, so the scale is carried through to
    # the adapter instead of being designed around.
    args.input_scale = bits
    args.param_scale = bits
    args.scale_rebase_multiplier = 1
    # Both halves of the instance vector must be public — that vector is the entire interface
    # between the proof and the chain.
    args.input_visibility = "public"
    args.output_visibility = "public"
    # Model constants live in the verifying key, so they are part of the model's identity and
    # cannot be swapped by the prover.
    args.param_visibility = "fixed"
    return args


def assert_settings(p):
    s = json.loads(p["settings"].read_text())
    run = s["run_args"]

    if run["input_visibility"] != "Public" or run["output_visibility"] != "Public":
        die(
            "circuit must be compiled with public inputs and public outputs; got "
            f"{run['input_visibility']}/{run['output_visibility']}"
        )
    bits = scale_bits()
    if int(run["input_scale"]) != bits:
        die(
            f"input_scale is {run['input_scale']}, not the {bits} in spec.json. The adapter "
            "compares each input cell against `value << inputScaleBits` by exact equality, so "
            "a circuit at any other scale produces valid proofs that are never accepted."
        )

    counts = s.get("num_rows"), s.get("total_assignments")
    print(f"  logrows                {s['run_args']['logrows']}")
    print(f"  input/output scale     {run['input_scale']}/{run.get('output_scale', run['input_scale'])}")
    print(f"  rows, assignments      {counts[0]}, {counts[1]}")
    return s


def assert_fidelity(p):
    """Run the compiled circuit against the integer reference on every calibration sample.

    This step exists because of a specific failure that nothing else catches. `ezkl` compiles a
    division into a multiplication by a looked-up reciprocal, and when the reciprocal underflows
    the quantisation the operation returns zero — silently. The circuit compiles, `setup`
    succeeds, proofs verify, and every output is 0. There is no error anywhere in the pipeline;
    the only symptom is that the answers are wrong.

    So the pipeline is not allowed to hand over a proving key it has not seen produce the right
    numbers. A mismatch here is a modelling bug, not a configuration one — the fix is in the
    graph, not in the scale.
    """
    bits = scale_bits()
    rows = json.loads(p["calibration"].read_text())["input_data"]
    worst = 0

    for row in rows:
        values = [int(v) for v in row]
        _, outs = witness(values, p)
        got = [from_field(f) >> bits for f in outs]
        want = reference(values)
        if got != want:
            die(
                "the circuit disagrees with the integer reference.\n"
                f"  inputs    {values}\n  circuit   {got}\n  reference {want}\n"
                "An all-zero row here means a division's reciprocal quantised away — divide by a "
                "bounded count, not by a running total. See the notes in export_onnx.py."
            )
        worst = max(worst, max(abs(a - b) for a, b in zip(got, want)) if got else 0)

    print(f"  {len(rows)} calibration samples reproduce the reference exactly")
    return worst


def main():
    p = paths()
    s = spec()

    if not p["onnx"].exists():
        die("build/model.onnx is missing — run export_onnx.py first")

    print("gen-settings")
    call(ezkl.gen_settings, str(p["onnx"]), str(p["settings"]), py_run_args=run_args())

    print("calibrate-settings")
    # The scale is pinned by spec.json, so calibration is only being asked to size the lookup
    # tables to the magnitudes in calibration.json — not to search for a scale of its own.
    call(ezkl.calibrate_settings,
        str(p["calibration"]),
        str(p["onnx"]),
        str(p["settings"]),
        "accuracy",
        scales=[scale_bits()],
        scale_rebase_multiplier=[1],
        max_logrows=LOGROWS_CAP,
    )
    assert_settings(p)

    print("compile-circuit")
    call(ezkl.compile_circuit, str(p["onnx"]), str(p["compiled"]), str(p["settings"]))

    print("check-fidelity")
    assert_fidelity(p)

    print("get-srs")
    call(ezkl.get_srs, str(p["settings"]), srs_path=str(p["srs"]))

    print("setup")
    call(ezkl.setup, str(p["compiled"]), str(p["vk"]), str(p["pk"]), srs_path=str(p["srs"]))

    print("create-evm-verifier")
    try:
        call(ezkl.create_evm_verifier, 
            str(p["vk"]),
            str(p["settings"]),
            str(p["verifier_sol"]),
            str(p["verifier_abi"]),
            srs_path=str(p["srs"]),
        )
        print(f"  {p['verifier_sol']}")
    except Exception as exc:  # noqa: BLE001 — solc is an external dependency of this step only
        print(f"  ! could not render the EVM verifier: {exc}")
        print("    This step shells out to solc. Everything above it succeeded, so proving and")
        print("    off-chain verification still work; only on-chain Gold is blocked.")
        return 1

    print(f"\nmodel  {s['name']}")
    print(f"feeds  {s['feeds']} -> {s['outputs']} outputs")
    print(f"instances expected on chain: {s['feeds'] + s['outputs']}")
    print(f"\nregister with:  setVerifier(keccak256(\"{s['name']}\"), <verifier>, {scale_bits()})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
