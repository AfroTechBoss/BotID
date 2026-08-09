"""Run the circuit on a set of feed values and report the public instances it produces.

This is the inference path, not the proving path. An agent calls it to learn what it is about to
commit to — the output commitment goes on chain at delivery, minutes or hours before anyone asks
for a proof, and if the number it commits to is not the number the circuit will produce, the
delivery is already lost.

    echo "{\"values\": [12500, 34000, 4200]}" | python run.py
    python run.py '{"values": [12500, 34000, 4200]}'

    -> {"inputs": [...], "outputs": [...], "values": [...], "weights": [...]}

`inputs` and `outputs` are the two halves of the instance vector, as decimal field elements, in
the order `ZkAdapter` expects them. `weights` is the same output tensor read back as plain
integers, for humans.

Running the *circuit* rather than a reimplementation of it is the whole point. Bronze, Silver and
Gold all have to agree on what the model returns, and the cheapest way to guarantee that is for
every tier to call this and none of them to have an opinion of its own.
"""

import json
import sys

import ezkl

from common import call, die, felt_to_int, from_field, paths, scale_bits, spec, to_field


def witness(values, p=None, quiet=True):
    """Feed values -> (input instances, output instances), both as field elements.

    Asserts the circuit's input cells are exactly `to_field(value)`. That equality is what
    `ZkAdapter._toField` re-derives on chain, so a disagreement here is a Gold delivery that will
    be rejected — better to hear about it now than after paying for a proof.
    """
    p = p or paths()
    s = spec()
    bits = scale_bits()
    cap = int(s["maxAbsValue"])

    if len(values) != s["feeds"]:
        die(f"model takes {s['feeds']} feeds, got {len(values)}")
    for v in values:
        if abs(int(v)) > cap:
            die(
                f"value {v} is outside the model's declared domain of +/-{cap}. The circuit does "
                "not merely lose accuracy past this point, it fails to synthesise — see the "
                "domain note in spec.json."
            )
    if not p["compiled"].exists():
        die("build/model.compiled is missing — run export_onnx.py then pipeline.py")

    json.dump({"input_data": [[float(int(v)) for v in values]]}, open(p["input"], "w"))
    call(ezkl.gen_witness, str(p["input"]), str(p["compiled"]), str(p["witness"]))
    w = json.loads(p["witness"].read_text())

    ins = [felt_to_int(f) for group in w["inputs"] for f in group]
    outs = [felt_to_int(f) for group in w["outputs"] for f in group]

    expected = [to_field(v, bits) for v in values]
    if ins != expected:
        die(
            "the circuit's input cells are not the quantised feed values.\n"
            f"  circuit  {ins}\n  expected {expected}\n"
            f"Every Gold proof from this build would be rejected on chain. The usual cause is a "
            f"circuit compiled at a scale other than the {bits} in spec.json."
        )
    if len(outs) != s["outputs"]:
        die(f"model should emit {s['outputs']} outputs, circuit emitted {len(outs)}")

    if not quiet:
        print(f"scale {bits}, {len(ins)} input cells, {len(outs)} output cells", file=sys.stderr)
    return ins, outs


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    try:
        values = json.loads(raw)["values"]
    except (ValueError, KeyError, TypeError):
        die('expected JSON of the form {"values": [12500, 34000, 4200]}')

    ins, outs = witness(values)
    bits = scale_bits()
    print(
        json.dumps(
            {
                "inputs": [str(f) for f in ins],
                "outputs": [str(f) for f in outs],
                "values": [int(v) for v in values],
                # The output tensor carries the same shift as the input tensor, so undoing it is
                # what turns a field element back into basis points.
                "weights": [from_field(f) >> bits for f in outs],
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
