"""Offline mocked gh CLI verification-policy regression tests (no remote calls)."""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import attestation_verifier as guard

REPO = "r20942097-hue/faaff"
WORKFLOW = ".github/workflows/release.yml"
SHA = "a" * 40
SIGNER_SHA = "b" * 40
REF = "refs/heads/main"
DATA = b"fixture-content-not-a-release"


class AttestationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.artifact = Path(self.tmp.name) / "candidate.zip"
        self.artifact.write_bytes(DATA)
        self.digest = hashlib.sha256(DATA).hexdigest()

    def evidence(self, repo_id=12345, subject=None, predicate=guard.PREDICATE):
        return json.dumps([{
            "verificationResult": {
                "signature": {"certificate": {"sourceRepositoryIdentifier": repo_id}},
                "statement": {"predicateType": predicate,
                              "subject": [{"name": "candidate.zip",
                                           "digest": {"sha256": self.digest if subject is None else subject}}]},
                "verifiedTimestamps": [{"timestamp": "synthetic"}],
            },
            "attestation": {"synthetic": "does not represent an actual signature"},
        }])

    def mock_run(self, stdout=None, repo_id="12345", returncode=0):
        first = subprocess.CompletedProcess([], returncode, self.evidence() if stdout is None else stdout, "")
        second = subprocess.CompletedProcess([], 0, repo_id + "\n", "")
        return patch.object(guard.subprocess, "run", side_effect=[first, second])

    def check(self, **kw):
        params = dict(artifact=self.artifact, repo=REPO, workflow=WORKFLOW,
                      source_sha=SHA, source_ref=REF, expected_sha256=self.digest,
                      signer_sha=SIGNER_SHA)
        params.update(kw)
        return guard.verify(**params)

    def test_success_is_only_candidate_not_go(self):
        with self.mock_run() as cmd:
            result = self.check()
        self.assertEqual(result["status"], "VERIFIED")
        self.assertEqual(result["decision"], "CANDIDATE_NO_GO")
        self.assertEqual(result["runtime_e2e"], "NOT_RUN")
        self.assertEqual(result["git_checkout_verified"], "NOT_RUN")
        args = cmd.call_args_list[0].args[0]
        for flag in ("--repo", "--signer-workflow", "--source-digest",
                     "--signer-digest", "--source-ref", "--cert-oidc-issuer",
                     "--deny-self-hosted-runners", "--limit", "--format"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--signer-digest") + 1], SIGNER_SHA)
        self.assertEqual(args[args.index("--cert-oidc-issuer") + 1],
                         "https://token.actions.githubusercontent.com")
        self.assertEqual(args[args.index("--limit") + 1], "5")
        self.assertNotIn("--bundle", args)
        self.assertNotIn("--owner", args)

    def test_repo_id_mismatch(self):
        with self.mock_run(repo_id="90000"):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_forged_certificate_id(self):
        with self.mock_run(stdout=self.evidence(repo_id=90000)):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_bool_certificate_id_not_valid(self):
        with self.mock_run(stdout=self.evidence(repo_id=True)):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_source_digest_mismatch_in_claim(self):
        with self.mock_run(stdout=self.evidence(subject="0"*64)):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_predicate_type_mismatch(self):
        with self.mock_run(stdout=self.evidence(predicate="https://example.test/not-slsa")):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_unverified_cli_failure(self):
        with self.mock_run(returncode=1):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_invalid_json(self):
        with self.mock_run(stdout="{"):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_empty_attestations(self):
        with self.mock_run(stdout="[]"):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_missing_verification_result(self):
        with self.mock_run(stdout=json.dumps([{"attestation": {}}])):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_missing_statement(self):
        with self.mock_run(stdout=json.dumps([{"verificationResult":
                                               {"signature":{"certificate":{"sourceRepositoryIdentifier":12345}}}}])):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_invalid_repo_id_string(self):
        with self.mock_run(repo_id="unknown"):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_unsupported_repo_fails_without_cli(self):
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check(repo="other/repo")["status"], "INVALID")
            cmd.assert_not_called()

    def test_invalid_signer_fails_without_cli(self):
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check(workflow="../../privileged.yml")["status"], "INVALID")
            cmd.assert_not_called()

    def test_invalid_source_sha_fails_without_cli(self):
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check(source_sha="HEAD")["status"], "INVALID")
            cmd.assert_not_called()

    def test_invalid_ref_fails_without_cli(self):
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check(source_ref="refs/heads/../../main")["status"], "INVALID")
            cmd.assert_not_called()

    def test_digest_mismatch_blocks_before_cli(self):
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check(expected_sha256="0"*64)["status"], "FAIL")
            cmd.assert_not_called()

    def test_missing_artifact_blocks_before_cli(self):
        self.artifact.unlink()
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check()["status"], "FAIL")
            cmd.assert_not_called()

    def test_symlink_artifact_blocked(self):
        original = Path(self.tmp.name) / "real.zip"
        original.write_bytes(DATA)
        self.artifact.unlink()
        try:
            self.artifact.symlink_to(original)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check()["status"], "FAIL")
            cmd.assert_not_called()

    def test_gh_not_installed(self):
        with patch.object(guard.subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_gh_timeout(self):
        with patch.object(guard.subprocess, "run", side_effect=subprocess.TimeoutExpired("gh", 90)):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_stdout_exceeds_limit(self):
        with patch.object(guard, "MAX_JSON_BYTES", 10):
            with self.mock_run():
                self.assertEqual(self.check()["status"], "FAIL")

    def test_cli_prints_only_status_and_safe_metadata(self):
        with self.mock_run():
            with patch("builtins.print") as out:
                code = guard.main(["--artifact", str(self.artifact), "--repo", REPO,
                                   "--signer-workflow", WORKFLOW, "--signer-sha", SIGNER_SHA,
                                   "--source-sha", SHA, "--source-ref", REF,
                                   "--sha256", self.digest, "--json"])
        self.assertEqual(code, 0)
        result = json.loads(out.call_args.args[0])
        self.assertEqual(result["status"], "VERIFIED")
        self.assertNotIn("attestation", result.get("errors", []))


    def test_invalid_signer_commit_blocks_cli(self):
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check(signer_sha="refs/heads/main")["status"], "INVALID")
            cmd.assert_not_called()

    def test_unhashable_repository_blocks_cli_cleanly(self):
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check(repo=["invalid"])["status"], "INVALID")
            cmd.assert_not_called()

    def test_source_ref_double_separator_rejected(self):
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check(source_ref="refs/heads//main")["status"], "INVALID")
            cmd.assert_not_called()

    def test_source_ref_trailing_separator_rejected(self):
        with patch.object(guard.subprocess, "run") as cmd:
            self.assertEqual(self.check(source_ref="refs/heads/main/")["status"], "INVALID")
            cmd.assert_not_called()

    def test_no_verified_timestamp_rejected(self):
        record = json.loads(self.evidence())
        record[0]["verificationResult"]["verifiedTimestamps"] = []
        with self.mock_run(stdout=json.dumps(record)):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_missing_verified_timestamp_rejected(self):
        record = json.loads(self.evidence())
        del record[0]["verificationResult"]["verifiedTimestamps"]
        with self.mock_run(stdout=json.dumps(record)):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_malformed_verified_timestamp_rejected(self):
        record = json.loads(self.evidence())
        record[0]["verificationResult"]["verifiedTimestamps"] = [False]
        with self.mock_run(stdout=json.dumps(record)):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_attestation_limit_rejects_unexpected_extra_results(self):
        record = json.loads(self.evidence())[0]
        with self.mock_run(stdout=json.dumps([record] * 6)):
            self.assertEqual(self.check()["status"], "FAIL")

    def test_no_actual_attestation_in_tests(self):
        self.assertIn("synthetic", self.evidence())
        self.assertEqual(guard.PREDICATE, "https://slsa.dev/provenance/v1")


if __name__ == "__main__":
    unittest.main()
