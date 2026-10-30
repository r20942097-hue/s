"""Offline tests for verified, isolated, no-autopromotion source snapshot cache."""
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from pinned_snapshot_cache import ENV, git_blob_sha, verified_read

URI = "https://raw.githubusercontent.com/easylist/easylist/61ef31cb407c2214452f84802b25f760db11020b/test.txt"


class PinnedCacheTests(unittest.TestCase):
    def test_without_cache_does_not_persist_anything(self):
        payload = b"||tracker.example^$third-party\n"
        with patch.dict(os.environ, {ENV: ""}):
            value = verified_read(URI, git_blob_sha(payload), 200,
                                  "filter-test/1", retrieve=lambda url: payload)
            self.assertEqual(value, payload)

    def test_second_fetch_reuses_digest_verified_bytes(self):
        payload = b"pinned-bytes\n"
        invoked = []
        with TemporaryDirectory() as tmp, patch.dict(os.environ, {ENV: tmp}):
            def retrieve(url):
                invoked.append(url)
                return payload
            for index in range(2):
                self.assertEqual(verified_read(URI, git_blob_sha(payload), 200,
                                               "filter-test/1", retrieve=retrieve), payload)
            self.assertEqual(invoked, [URI])
            self.assertEqual(len(list(Path(tmp).iterdir())), 1)

    def test_corrupt_cached_blob_fails_closed_and_never_fetches(self):
        payload = b"expected\n"
        with TemporaryDirectory() as tmp, patch.dict(os.environ, {ENV: tmp}):
            key = Path(tmp) / (git_blob_sha(payload) + ".blob")
            key.write_bytes(b"tampered\n")
            with self.assertRaisesRegex(ValueError, "cached Git blob"):
                verified_read(URI, git_blob_sha(payload), 200,
                              "filter-test/1", retrieve=lambda url: self.fail("network retry forbidden"))

    def test_oversized_download_does_not_cache(self):
        payload = b"x" * 201
        with TemporaryDirectory() as tmp, patch.dict(os.environ, {ENV: tmp}):
            with self.assertRaisesRegex(ValueError, "byte limit"):
                verified_read(URI, git_blob_sha(payload), 200, "filter-test/1",
                              retrieve=lambda _: payload)
            self.assertFalse(list(Path(tmp).iterdir()))

    def test_wrong_hash_does_not_cache(self):
        with TemporaryDirectory() as tmp, patch.dict(os.environ, {ENV: tmp}):
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                verified_read(URI, git_blob_sha(b"expected"), 200, "filter-test/1",
                              retrieve=lambda _: b"wrong")
            self.assertFalse(list(Path(tmp).iterdir()))

    def test_reject_symlink_cache_entry_without_following(self):
        payload = b"approved\n"
        with TemporaryDirectory() as tmp, patch.dict(os.environ, {ENV: tmp}):
            target = Path(tmp) / "target"
            target.write_bytes(payload)
            (Path(tmp) / (git_blob_sha(payload) + ".blob")).symlink_to(target)
            with self.assertRaisesRegex(ValueError, "symlink"):
                verified_read(URI, git_blob_sha(payload), 200, "filter-test/1",
                              retrieve=lambda _: self.fail("unexpected fetch"))

    def test_reject_tracked_repository_as_cache_location(self):
        source_root = Path(__file__).resolve().parents[1]
        with patch.dict(os.environ, {ENV: str(source_root)}):
            with self.assertRaisesRegex(ValueError, "outside"):
                verified_read(URI, git_blob_sha(b"ok"), 200, "filter-test/1",
                              retrieve=lambda _: b"ok")

    def test_invalid_digest_and_untrusted_host_rejected(self):
        with patch.dict(os.environ, {ENV: ""}):
            for digest in ("bad", "A" * 40):
                with self.subTest(digest=digest), self.assertRaises(ValueError):
                    verified_read(URI, digest, 200, "filter-test/1",
                                  retrieve=lambda _: b"data")
            with self.assertRaisesRegex(ValueError, "immutable raw GitHub"):
                verified_read("https://example.org/evil", git_blob_sha(b"x"),
                              200, "filter-test/1", retrieve=lambda _: b"x")


if __name__ == "__main__":
    unittest.main()
