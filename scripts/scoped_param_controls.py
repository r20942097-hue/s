"""Synthetic endpoint path controls used by the URL safety lab."""
import hashlib
import hmac
from urllib.parse import urlencode, parse_qsl, urlsplit

KEY = b"test-only-hmac-key"
CASES = (("target", "/telemetry/collect", False),
         ("signed_target", "/telemetry/collect", True),
         ("neighbor", "/telemetry/collect-extra", False),
         ("checkout", "/checkout", True),
         ("oauth", "/oauth/callback", True),
         ("media", "/media/chunk", True))

def query(signed):
    pairs = [("utm_source", "fake"), ("keep", "ok")]
    if signed:
        sig = hmac.new(KEY, urlencode(pairs).encode(), hashlib.sha256).hexdigest()
        pairs.append(("X-Amz-Signature", sig))
    return urlencode(pairs)

def parse_received(raw, path, signed):
    parsed = urlsplit(raw)
    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    if parsed.path != path or len(pairs) != len(set(k for k, _ in pairs)):
        raise ValueError("path or duplicate key")
    data = dict(pairs)
    if data.get("keep") != "ok":
        raise ValueError("safe key removed")
    result = {"utm": data.get("utm_source") == "fake"}
    if signed:
        sig = data.get("X-Amz-Signature")
        rest = [(k, v) for k, v in pairs if k != "X-Amz-Signature"]
        expected = hmac.new(KEY, urlencode(rest).encode(), hashlib.sha256).hexdigest()
        result["signature_present"] = isinstance(sig, str)
        result["valid"] = isinstance(sig, str) and hmac.compare_digest(sig, expected)
    return result

def verify(before, active, restored):
    names = {name for name, _, _ in CASES}
    if any(set(state) != names for state in (before, active, restored)):
        raise ValueError("incomplete cases")
    for name, _, signed in CASES:
        if not before[name]["utm"] or not restored[name]["utm"]:
            raise ValueError("baseline mismatch")
        if signed and not (before[name]["valid"] and restored[name]["valid"]):
            raise ValueError("signed baseline mismatch")
    if active["target"]["utm"]:
        raise ValueError("target not stripped")
    for name in ("neighbor", "checkout", "oauth", "media"):
        if not active[name]["utm"]:
            raise ValueError("unrelated path changed")
    if any(not active[name]["valid"] for name in ("checkout", "oauth", "media")):
        raise ValueError("signed URL on unrelated path damaged")
    if not active["signed_target"]["signature_present"]:
        raise ValueError("signature removed")
    return {"target": "PRESENT_REMOVED_RESTORED",
            "other_paths": "PRESERVED",
            "other_signed_urls": "PRESERVED",
            "signed_before_after": "PASS",
            "same_endpoint_signed": ("PASS" if active["signed_target"]["valid"] else "BROKEN"),
            "real_site": "NOT_RUN"}
