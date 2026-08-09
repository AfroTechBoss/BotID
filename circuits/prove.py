"""Produce a Gold-tier proof for one execution.

This is what the relayer shells out to when a Gold delivery is made or a Bronze one is challenged.

    python prove.py '{"values": [12500, 34000, 4200]}'
    python prove.py '{"values": [...], "instances": ["256", ...]}'

    -> {"proof": "0x...", "instances": ["..."], "weights": [...]}

`instances` in the *input* is optional and is a safety rail, not a parameter: pass the instance
vector the agent already committed to on chain and this refuses to prove anything else. Without
it the tool is still correct, it just cannot tell you that the proof it made is the proof the
delivery needs. With it, a stale build, a re-quantised feed value or a model that was recompiled
between delivery and challenge is caught here — before the agent spends a proof and its bond
finding out on chain.

The proof is printed as hex, ready to go into the first field of the adapter's attestation:

    abi.encode(bytes proof, uint256[] instances, Reveal[] reveals)
"""

import json
import sys

import ezkl

from common import call, die, from_field, paths, scale_bits
from run import witness


def prove(values, expected=None):
    p = paths()
    ins, outs = witness(values, p)
    instances = ins + outs

    if expected is not None:
        want = [int(x) for x in expected]
        if want != instances:
            die(
                "this build does not reproduce the committed instance vector.\n"
                f"  committed {want}\n  produced  {instances}\n"
                "Proving would waste the work: the adapter compares these cell for cell. Check "
                "that the circuit is the one the model was registered with."
            )

    if not (p["pk"].exists() and p["srs"].exists()):
        die("build/pk.key or build/kzg.srs is missing — run pipeline.py")

    call(
        ezkl.prove,
        str(p["witness"]),
        str(p["compiled"]),
        str(p["pk"]),
        str(p["proof"]),
        srs_path=str(p["srs"]),
    )

    proof = json.loads(p["proof"].read_text())

    # Verify locally before handing the proof over. A proof that fails here fails on chain too,
    # and on chain it costs a delivery.
    ok = call(
        ezkl.verify,
        str(p["proof"]),
        str(p["settings"]),
        str(p["vk"]),
        srs_path=str(p["srs"]),
    )
    if not ok:
        die("the proof did not verify against its own verifying key — the build is inconsistent")

    hex_proof = proof["hex_proof"] if "hex_proof" in proof else None
    if not hex_proof:
        die("ezkl did not emit a hex proof; the adapter needs the EVM-encoded form")

    bits = scale_bits()
    return {
        "proof": hex_proof,
        "instances": [str(f) for f in instances],
        "weights": [from_field(f) >> bits for f in outs],
    }


def main():
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    try:
        req = json.loads(raw)
        values = req["values"]
    except (ValueError, KeyError, TypeError):
        die('expected JSON of the form {"values": [...], "instances": [...]}')

    print(json.dumps(prove(values, req.get("instances"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
