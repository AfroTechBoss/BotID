"""Shared paths, spec loading and field arithmetic for the BotID circuit pipeline.

The one thing worth reading closely here is `to_field` / `from_field`. `ZkAdapter` compares the
circuit's public instances against values it derives itself, so this file and
`contracts/src/adapters/ZkAdapter.sol` have to agree on how a signed integer becomes a bn254
field element. They are four lines each, and they are the seam where a silent disagreement
would turn every honest Gold proof into a rejected delivery.
"""

import json
import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
BUILD = ROOT / "build"

# `ezkl.setup` reads EZKL_REPO_PATH with an unconditional unwrap, so an unset variable is not a
# fallback to a default — it is a Rust panic surfacing through pyo3 as `Err value: NotPresent`,
# several steps after the one that actually needed it. Set at import so every entrypoint in this
# directory inherits it, and only if the caller has not chosen a location of their own.
os.environ.setdefault("EZKL_REPO_PATH", str(BUILD))

# bn254 scalar field, the same constant as ZkAdapter.P.
P = 21888242871839275222246405745257275088548364400416034343698204186575808495617

# ZkAdapter refuses magnitudes at or beyond this bound, because a value near P would otherwise
# alias onto a small one. Mirrored here so the pipeline fails at export time rather than on chain.
MAX_ABS = 1 << 128


def spec():
    return json.loads((ROOT / "spec.json").read_text())


def paths():
    BUILD.mkdir(exist_ok=True)
    return {
        "onnx": BUILD / "model.onnx",
        "settings": BUILD / "settings.json",
        "calibration": BUILD / "calibration.json",
        "compiled": BUILD / "model.compiled",
        "srs": BUILD / "kzg.srs",
        "vk": BUILD / "vk.key",
        "pk": BUILD / "pk.key",
        "input": BUILD / "input.json",
        "witness": BUILD / "witness.json",
        "proof": BUILD / "proof.json",
        "verifier_sol": BUILD / "Verifier.sol",
        "verifier_abi": BUILD / "Verifier.abi",
    }


def scale_bits() -> int:
    """The circuit's `input_scale`. One number, read from spec.json by everything that needs it.

    It has to match three places at once: what `pipeline.py` compiles with, what `ZkAdapter`
    was registered with via `setVerifier`, and what the prover quantises by. A disagreement is
    not a security hole — it rejects honest proofs — but it is a silent one, so nothing here
    hardcodes it.
    """
    return int(spec()["inputScaleBits"])


def to_field(v: int, bits: int | None = None) -> int:
    """Signed value -> bn254 field element, exactly as ZkAdapter._toField does it.

    The bound is checked before the shift, matching the adapter: a magnitude near P would
    otherwise reduce onto a small, innocent-looking cell.
    """
    v = int(v)
    bits = scale_bits() if bits is None else int(bits)
    limit = MAX_ABS >> bits
    if v >= limit or v <= -limit:
        raise ValueError(
            f"value {v} is outside the range the adapter will accept at scale {bits} "
            f"(+/-2^{limit.bit_length() - 1})"
        )
    scaled = v << bits
    return scaled if scaled >= 0 else P - (-scaled)


def from_field(f: int) -> int:
    """Field element -> signed integer. Anything past P/2 is a negative."""
    f = int(f)
    return f if f <= P // 2 else f - P


def felt_to_int(felt) -> int:
    """ezkl witness felt -> Python int.

    The witness writes each field element as 64 hex characters in **little-endian** byte order,
    with no `0x`. It reads like a big-endian number and is not one: `004c1d00...` is 0x1d4c00,
    not 0x004c1d00...000. Getting this backwards produces astronomically wrong instances that
    still look plausible at a glance, so it is worth the four lines to be explicit.
    """
    if isinstance(felt, int):
        return felt
    s = str(felt)
    if s.startswith("0x"):
        return int(s, 16)
    if len(s) == 64:
        return int.from_bytes(bytes.fromhex(s), "little")
    return int(s)


def die(msg: str):
    raise SystemExit(f"error: {msg}")


def call(fn, *args, **kwargs):
    """Invoke an ezkl binding that may or may not be a coroutine in this version.

    ezkl moves functions between sync and async across releases — `get_srs` is awaitable in 23.x
    and was not in earlier ones. Pinning the version would be the tidier fix, but the wheel is a
    large prebuilt binary and forcing a specific one on whoever runs this is worse than the four
    lines it takes to accept either shape.
    """
    import asyncio
    import inspect

    async def invoke():
        # The call itself has to happen with a loop already running: the async bindings are
        # pyo3-asyncio futures, which reach for the running loop at construction rather than
        # at await. Calling them from sync code fails with "no running event loop".
        out = fn(*args, **kwargs)
        return await out if inspect.isawaitable(out) else out

    return asyncio.run(invoke())
