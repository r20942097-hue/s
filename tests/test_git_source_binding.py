"""Real local Git fixture tests for copied-source ZIP -> committed Git blob binding.

No network, no GitHub credentials, no Git push, no signature generation.
"""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import git_source_binding as binding

REPO = "r20942097-hue/faaff"
PAYLOAD = b"source-commit-bound-zip-fixture-2026"


class GitSourceBindingTests(unittest.TestCase):
    def git(self, *args, cwd=None):
        return subprocess.run(["git", "-C", str(cwd or self.source), *args],
                              check=True, capture_output=True).stdout.decode("utf-8").strip()

    def commit(self, message="fixture"):
        subprocess.run(["git", "-C", str(self.source), "-c", "user.name=CI",
                        "-c", "user.email=ci@example.invalid", "commit", "-qm", message],
                       check=True, capture_output=True)
        return self.git("rev-parse", "HEAD")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root / "checkout"
        self.source.mkdir()
        subprocess.run(["git", "init", "-q", str(self.source)], check=True, capture_output=True)
        self.git("remote", "add", "origin", "https://github.com/" + REPO + ".git")
        self.file = self.source / "code.js"
        self.file.write_bytes(PAYLOAD)
        self.git("add", "code.js")
        self.head = self.commit()
        self.zip = root / "candidate.zip"
        self.claim = root / "claim.json"
        self.rezip()
        self.reclaim()

    def rezip(self, members=None):
        if members is None:
            members = [("code.js", PAYLOAD)]
        with zipfile.ZipFile(self.zip, "w", compression=zipfile.ZIP_STORED) as archive:
            for path, content in members:
                archive.writestr(path, content)

    def reclaim(self, commit=None):
        self.data = {
            "schema": "gpt1-source-zip-parity/v1",
            "product": "fixture",
            "artifact_sha256": hashlib.sha256(self.zip.read_bytes()).hexdigest(),
            "source_commit": self.head if commit is None else commit,
            "files": [{"source": "code.js", "member": "code.js",
                       "sha256": hashlib.sha256(PAYLOAD).hexdigest()}],
        }
        self.save()

    def save(self):
        self.claim.write_text(json.dumps(self.data), encoding="utf-8")

    def result(self, **changes):
        return binding.verify(changes.get("claim", self.claim),
                              changes.get("source", self.source),
                              changes.get("artifact", self.zip),
                              changes.get("repo", REPO))

    def test_exact_git_blob_and_zip_match(self):
        result = self.result()
        self.assertEqual(result["status"], "MATCH")
        self.assertEqual(result["git_tree_parity"], "MATCH")
        self.assertEqual(result["source_zip_parity"], "MATCH")
        self.assertEqual(result["decision"], "CANDIDATE_NO_GO")
        self.assertEqual(result["signed_attestation"], "NOT_RUN")
        self.assertEqual(result["upstream_repository_authenticated"], "NOT_RUN")

    def test_cli_pass(self):
        with patch("builtins.print"):
            self.assertEqual(binding.main(["--claim", str(self.claim),
                         "--source-root", str(self.source), "--artifact", str(self.zip),
                         "--expected-repo", REPO, "--json"]), 0)

    def test_unknown_repo_without_git(self):
        with patch.object(binding.subprocess, "run") as run:
            self.assertEqual(self.result(repo="untrusted/repo")["status"], "FAIL")
            run.assert_not_called()

    def test_missing_git_pin(self):
        self.data["source_commit"] = None
        self.save()
        self.assertEqual(self.result()["status"], "FAIL")

    def test_wrong_head(self):
        self.data["source_commit"] = "0" * 40
        self.save()
        self.assertEqual(self.result()["status"], "FAIL")

    def test_modified_checkout(self):
        self.file.write_bytes(b"changed bytes")
        self.assertEqual(self.result()["status"], "FAIL")

    def test_untracked_file_rejected(self):
        (self.source / "extra.txt").write_text("untracked")
        self.assertEqual(self.result()["status"], "FAIL")

    def test_staged_change_rejected(self):
        self.file.write_bytes(b"changed bytes")
        self.git("add", "code.js")
        self.assertEqual(self.result()["status"], "FAIL")

    def test_recommitted_identical_content_rejected(self):
        (self.source / "note.txt").write_text("another commit")
        self.git("add", "note.txt")
        self.commit("another")
        self.assertEqual(self.result()["status"], "FAIL")

    def test_missing_remote_rejected(self):
        self.git("remote", "remove", "origin")
        self.assertEqual(self.result()["status"], "FAIL")

    def test_wrong_remote_rejected(self):
        self.git("remote", "set-url", "origin", "https://github.com/evil/other.git")
        self.assertEqual(self.result()["status"], "FAIL")

    def test_remote_with_userinfo_rejected(self):
        self.git("remote", "set-url", "origin", "https://token@github.com/" + REPO)
        self.assertEqual(self.result()["status"], "FAIL")

    def test_scp_style_origin_allowed_but_not_authenticated(self):
        self.git("remote", "set-url", "origin", "git@github.com:" + REPO + ".git")
        result = self.result()
        self.assertEqual(result["status"], "MATCH")
        self.assertEqual(result["upstream_repository_authenticated"], "NOT_RUN")

    def test_subdirectory_root_rejected(self):
        sub = self.source / "nested"
        sub.mkdir()
        self.assertEqual(self.result(source=sub)["status"], "FAIL")

    def test_other_git_checkout_rejected(self):
        self.assertEqual(self.result(source=Path(self.temp.name))["status"], "FAIL")

    def test_zip_has_unmapped_entry(self):
        self.rezip([("code.js", PAYLOAD), ("unmapped.txt", b"bad")])
        self.reclaim()
        self.assertEqual(self.result()["status"], "FAIL")

    def test_zip_changed_file(self):
        self.rezip([("code.js", b"replaced")])
        self.reclaim()
        self.assertEqual(self.result()["status"], "FAIL")

    def test_zip_recompression_with_updated_outer_digest_allowed(self):
        with zipfile.ZipFile(self.zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("code.js", PAYLOAD)
        self.reclaim()
        self.assertEqual(self.result()["status"], "MATCH")

    def test_missing_git_program(self):
        with patch.object(binding.subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_too_many_mapped_files_rejected(self):
        with patch.object(binding, "MAX_FILES", 0):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_oversized_git_blob_policy_rejected(self):
        with patch.object(binding, "MAX_BLOB_BYTES", 5):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_git_command_timeout_rejected(self):
        with patch.object(binding.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 25)):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_read_only_does_not_change_head(self):
        old = self.git("rev-parse", "HEAD")
        self.assertEqual(self.result()["status"], "MATCH")
        self.assertEqual(self.git("rev-parse", "HEAD"), old)

    def test_artifact_symlink_rejected(self):
        actual = Path(self.temp.name) / "original.zip"
        self.zip.rename(actual)
        try:
            self.zip.symlink_to(actual)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.assertEqual(self.result()["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()
