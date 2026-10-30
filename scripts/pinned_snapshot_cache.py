"""Opt-in, runner-local cache for immutable, hash-verified upstream Git blobs.

No cross-run persistence, no mutable branch requests, no generated filter writes.
Only explicitly pinned Git blob identities are cacheable. Every cache hit is
rehash-verified; malformed/tampered data fails closed without silent fallback.
"""
import hashlib
import os
from pathlib import Path
import re
import tempfile
from urllib.request import Request, urlopen

SHA40 = re.compile(r"[a-f0-9]{40}\Z")
ENV = "FILTER_PINNED_CACHE_DIR"


def git_blob_sha(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def verified_read(uri, expected_blob, max_bytes, user_agent, retrieve=None):
    if not isinstance(expected_blob, str) or not SHA40.fullmatch(expected_blob):
        raise ValueError("invalid pinned Git blob digest")
    if not isinstance(max_bytes, int) or max_bytes <= 0:
        raise ValueError("invalid snapshot byte limit")
    if not isinstance(uri, str) or not uri.startswith("https://raw.githubusercontent.com/"):
        raise ValueError("snapshot fetch URL must be immutable raw GitHub source")
    # Callers must first validate the trusted repository, exact commit, and path.
    directory = os.environ.get(ENV)
    cache = None
    if directory:
        cache = Path(directory).resolve()
        if not cache.is_absolute() or cache.is_relative_to(Path(__file__).resolve().parents[1]):
            raise ValueError("cache must be outside the checked-out repository")
        cache.mkdir(parents=True, exist_ok=True)
        item = cache / (expected_blob + ".blob")
        if item.is_symlink():
            raise ValueError("cache symlink forbidden")
        if item.exists():
            if not item.is_file():
                raise ValueError("cached source not regular file")
            data = item.read_bytes()
            if len(data) > max_bytes or git_blob_sha(data) != expected_blob:
                raise ValueError("cached Git blob does not match pinned identity")
            return data
    if retrieve is None:
        with urlopen(Request(uri, headers={"User-Agent": user_agent}), timeout=30) as response:
            data = response.read(max_bytes + 1)
    else:
        data = retrieve(uri)
    if not isinstance(data, bytes) or len(data) > max_bytes:
        raise ValueError("upstream source exceeds byte limit")
    if git_blob_sha(data) != expected_blob:
        raise ValueError("pinned upstream Git blob digest mismatch")
    if cache is not None:
        with tempfile.NamedTemporaryFile(dir=cache, delete=False) as handle:
            temp = Path(handle.name)
            try:
                handle.write(data)
            except BaseException:
                temp.unlink(missing_ok=True)
                raise
        try:
            if item.is_symlink():
                raise ValueError("cache symlink forbidden")
            os.replace(temp, item)
        finally:
            temp.unlink(missing_ok=True)
    return data
