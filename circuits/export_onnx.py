"""Build the reference allocator as an ONNX graph.

Written with `onnx.helper` rather than exported from PyTorch, on purpose. In a ZK pipeline the
op list *is* the circuit: every operator becomes constraints, and an op the prover cannot handle
is a dead end discovered an hour into `setup`. A framework export hides that behind whatever a
tracer decided to emit. Here the graph is nine nodes and all of them are visible.

    x    : [1, n]      feed values, whole numbers at the spec's `decimals`
    s    = x @ ones    [1, 1]  bundle total
    dev  = n*x - s     [1, n]  how far each feed sits above the mean, times n
    pos  = relu(dev)   [1, n]  feeds at or below the mean are out
    ind  = min(pos, 1) [1, n]  1 for an above-mean feed, 0 otherwise
    k    = max(ind @ ones, 1)  [1, 1]  how many made the cut, floored at 1
    w    = ind * 10000 / k     [1, n]  basis points, equally split

The strategy is a placeholder and should not be traded. Two structural properties are the point,
and both were arrived at by watching the circuit fail:

  * **Nothing divides by a large variable.** `ezkl` compiles `Div` into a multiplication by a
    looked-up reciprocal, so the quotient's precision is set by how well `1/d` survives
    quantisation. Divide by a bundle total in the hundreds of thousands and the reciprocal
    rounds to zero: the proof verifies perfectly and every weight comes out 0. Dividing by a
    *count* — here at most `n` — keeps the reciprocal in a range the lookup can represent, and
    the circuit reproduces the integer reference exactly on every sample below.

  * **Intermediates stay under 2^28.** halo2 decomposes values in base 2^14 with two limbs. The
    largest intermediate is `n * maxAbsValue << inputScaleBits`; past 2^28 compilation fails
    outright. That is why `spec.json` declares a domain instead of leaving one implied.

`max(k, 1)` rather than `k + 1` is what makes the weights sum to 10000 instead of to a number
that quietly depends on how many feeds won. When no feed is above the mean — an all-identical
bundle — `ind` is all zero, so the allocation is empty rather than the prover being unable to
find a witness.
"""

import json

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from common import paths, spec

OPSET = 17
BPS = 10_000


def build(n: int) -> onnx.ModelProto:
    x = helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, n])
    w = helper.make_tensor_value_info("w", TensorProto.FLOAT, [1, n])

    # Initialisers, not inputs: with `param_visibility=fixed` these are baked into the verifying
    # key, so the constants are part of the model's identity rather than something a prover
    # supplies at proof time.
    initialisers = [
        numpy_helper.from_array(np.ones((n, 1), dtype=np.float32), "ones"),
        numpy_helper.from_array(np.array([[float(n)]], dtype=np.float32), "n"),
        numpy_helper.from_array(np.array([[1.0]], dtype=np.float32), "one"),
        numpy_helper.from_array(np.array([[float(BPS)]], dtype=np.float32), "bps"),
    ]

    nodes = [
        helper.make_node("MatMul", ["x", "ones"], ["sum"]),
        helper.make_node("Mul", ["x", "n"], ["scaled"]),
        helper.make_node("Sub", ["scaled", "sum"], ["dev"]),
        helper.make_node("Relu", ["dev"], ["pos"]),
        helper.make_node("Min", ["pos", "one"], ["ind"]),
        helper.make_node("MatMul", ["ind", "ones"], ["k0"]),
        helper.make_node("Max", ["k0", "one"], ["k"]),
        helper.make_node("Mul", ["ind", "bps"], ["num"]),
        helper.make_node("Div", ["num", "k"], ["w"]),
    ]

    graph = helper.make_graph(nodes, "botid_reference_allocator", [x], [w], initialisers)
    model = helper.make_model(
        graph, opset_imports=[helper.make_opsetid("", OPSET)], producer_name="botid"
    )
    model.ir_version = 9  # onnxruntime/tract in ezkl 23 does not read ir_version 10 yet
    onnx.checker.check_model(model)
    return model


def reference(values):
    """The same computation in exact integer arithmetic.

    This is the oracle: `pipeline.py` checks the compiled circuit against it on every calibration
    sample, and a Gold-capable agent that reimplements the model in another language has to match
    it here too, because the output commitment is what the chain binds.
    """
    x = np.array([int(v) for v in values], dtype=np.int64)
    pos = np.maximum(len(x) * x - x.sum(), 0)
    ind = np.minimum(pos, 1)
    return [int(v) for v in (ind * BPS) // max(int(ind.sum()), 1)]


def samples(cap: int):
    """Calibration data spanning the declared domain.

    `ezkl` sizes its lookup ranges from what it sees here, so the set has to reach the edges of
    the domain rather than sit comfortably in the middle — and it has to include the awkward
    cases: an all-identical bundle, a negative reading, a near-tie.
    """
    return [
        [125_00, 34_000, 42_00],
        [1, 2, 3],
        [cap, 1, cap // 2],
        [7_000, 7_000, 7_000],
        [-cap, 12_000, 0],
        [50_000, 49_000, 51_000],
    ]


if __name__ == "__main__":
    s = spec()
    n = s["feeds"]
    cap = int(s["maxAbsValue"])
    p = paths()

    onnx.save(build(n), p["onnx"])

    rows = samples(cap)
    json.dump(
        {"input_data": [[float(v) for v in row] for row in rows]},
        open(p["calibration"], "w"),
    )

    print(f"wrote {p['onnx']}  ({n} feeds -> {s['outputs']} weights, opset {OPSET})")
    print(f"domain +/-{cap} at scale {s['inputScaleBits']}\n")
    for row in rows:
        print(f"  {row} -> {reference(row)}")
