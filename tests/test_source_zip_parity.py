"""Adversarial source -> ZIP byte parity fixtures; nothing is extracted."""
import hashlib
import json
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from source_zip_parity import verify, safe_name, main

PAYLOAD = b"GPT1_EXACT_SOURCE_PAYLOAD_98765"


class SourceZipParityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sources = self.root / "src"
        self.sources.mkdir()
        self.source = self.sources / "code.js"
        self.source.write_bytes(PAYLOAD)
        self.artifact = self.root / "candidate.zip"
        self.claim = self.root / "claim.json"
        self.makezip()
        self.makeclaim()

    def makezip(self, members=None, compression=zipfile.ZIP_STORED):
        if members is None:
            members = [("code.js", PAYLOAD)]
        with zipfile.ZipFile(self.artifact, "w", compression=compression) as z:
            for path, data in members:
                z.writestr(path, data)

    def makeclaim(self, members=None):
        if members is None:
            members = [{"source": "code.js", "member": "code.js",
                        "sha256": hashlib.sha256(PAYLOAD).hexdigest()}]
        self.data = {"schema": "gpt1-source-zip-parity/v1", "product": "fixture",
                     "artifact_sha256": hashlib.sha256(self.artifact.read_bytes()).hexdigest(),
                     "source_commit": None, "files": members}
        self.save()

    def save(self):
        self.claim.write_text(json.dumps(self.data), encoding="utf-8")

    def verdict(self):
        return verify(self.claim, self.sources, self.artifact)

    def test_exact_copy_matches_but_remains_no_go(self):
        x = self.verdict()
        self.assertEqual(x["content_parity"], "MATCH")
        self.assertEqual(x["decision"], "CANDIDATE_NO_GO")
        self.assertEqual(x["signed_attestation_verified"], "NOT_RUN")
        self.assertEqual(x["git_commit_verified"], "NOT_RUN")
        self.assertEqual(x["observed"]["matched"], 1)

    def test_cli_pass(self):
        with patch("builtins.print"):
            self.assertEqual(main(["--claim", str(self.claim), "--source-root", str(self.sources),
                                   "--artifact", str(self.artifact), "--json"]), 0)

    def test_cli_fail(self):
        self.source.unlink()
        with patch("builtins.print"):
            self.assertEqual(main(["--claim", str(self.claim), "--source-root", str(self.sources),
                                   "--artifact", str(self.artifact)]), 1)

    def test_changed_source_rejected(self):
        self.source.write_bytes(PAYLOAD + b"tampered")
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_changed_artifact_rejected(self):
        self.makezip([("code.js", b"changed")])
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_missing_source_rejected(self):
        self.source.unlink()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_unmapped_file_rejected(self):
        self.makezip([("code.js", PAYLOAD), ("untracked.js", "bad")])
        self.makeclaim()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_missing_member_rejected(self):
        self.makezip([("other.js", PAYLOAD)])
        self.makeclaim()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_two_exact_files_match(self):
        (self.sources / "extra.css").write_bytes(b"body{}")
        self.makezip([("code.js", PAYLOAD), ("dist/extra.css", b"body{}")])
        self.makeclaim([self.data["files"][0], {"source": "extra.css", "member": "dist/extra.css",
                                                 "sha256": hashlib.sha256(b"body{}").hexdigest()}])
        self.assertEqual(self.verdict()["observed"]["matched"], 2)

    def test_wrong_claim_digest_rejected(self):
        self.data["artifact_sha256"] = "0" * 64
        self.save()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_invalid_commit_rejected(self):
        self.data["source_commit"] = "main"
        self.save()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_string_commit_is_not_verified_even_if_valid(self):
        self.data["source_commit"] = "a" * 40
        self.save()
        self.assertEqual(self.verdict()["git_commit_verified"], "NOT_RUN")

    def test_claim_extra_approval_field_rejected(self):
        self.data["approval"] = "GO"
        self.save()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_duplicate_source_mapping_rejected(self):
        self.data["files"].append(self.data["files"][0].copy())
        self.save()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_duplicate_casefolded_member_rejected(self):
        other = self.data["files"][0].copy()
        other["source"] = "different.js"
        other["member"] = "CODE.js"
        self.data["files"].append(other)
        self.save()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_path_traversal_rejected(self):
        self.data["files"][0]["source"] = "../secret.js"
        self.save()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_member_backslash_rejected(self):
        self.data["files"][0]["member"] = r"escape\file.js"
        self.save()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_invalid_manifest_json(self):
        self.claim.write_text("{invalid", encoding="utf-8")
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_claim_missing(self):
        self.claim.unlink()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_artifact_missing(self):
        self.artifact.unlink()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_filename_case_collision_zip(self):
        self.makezip([("code.js", PAYLOAD), ("CODE.JS", PAYLOAD)])
        self.makeclaim()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_symlink_source_rejected(self):
        actual = self.sources / "real.js"
        actual.write_bytes(PAYLOAD)
        self.source.unlink()
        try:
            self.source.symlink_to(actual)
        except (OSError, NotImplementedError):
            self.skipTest("symlink unavailable")
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_symlink_member_rejected(self):
        info = zipfile.ZipInfo("code.js")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(self.artifact, "w") as z:
            z.writestr(info, PAYLOAD)
        self.makeclaim()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_corrupted_crc_rejected(self):
        self.artifact.write_bytes(self.artifact.read_bytes().replace(PAYLOAD, PAYLOAD[:-1] + b"6", 1))
        self.makeclaim()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_unsupported_compression_rejected(self):
        self.makezip(compression=zipfile.ZIP_BZIP2)
        self.makeclaim()
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_no_claimed_files_rejected(self):
        self.makeclaim([])
        self.assertEqual(self.verdict()["content_parity"], "MISMATCH")

    def test_custom_build_can_match_but_not_prove_publisher(self):
        new_content = b"new publisher content"
        self.source.write_bytes(new_content)
        self.makezip([("code.js", new_content)])
        self.makeclaim([{"source": "code.js", "member": "code.js",
                         "sha256": hashlib.sha256(new_content).hexdigest()}])
        result = self.verdict()
        self.assertEqual(result["content_parity"], "MATCH")
        self.assertEqual(result["signed_attestation_verified"], "NOT_RUN")

    def test_safe_name_rejects_win_devices(self):
        self.assertFalse(safe_name("COM1.txt"))
        self.assertFalse(safe_name("folder/../x"))
        self.assertFalse(safe_name("/absolute"))
        self.assertTrue(safe_name("valid/source.js"))


if __name__ == "__main__":
    unittest.main()
