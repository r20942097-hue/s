"""Adversarial tests for real local Git and mocked live GitHub API results.

Mocked API responses NEVER count as genuine online provenance. CI separately
runs the verifier against GitHub.com with the PR's actual checked-out commit.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import github_commit_identity as identity

REPO = "r20942097-hue/faaff"


class LiveCommitIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "checkout"
        self.root.mkdir()
        subprocess.run(["git", "init", "-q", str(self.root)], check=True, capture_output=True)
        (self.root / "main.py").write_text("print('qa')", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.root), "add", "main.py"], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Fixture",
                        "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"],
                       check=True, capture_output=True)
        self.sha = self.git("rev-parse", "HEAD")
        self.tree = self.git("rev-parse", "HEAD^{tree}")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args],
                              check=True, capture_output=True, text=True).stdout.strip()

    def fake_api(self, endpoint, jq):
        if endpoint == f"repos/{REPO}":
            return {"id": 1389881401, "full_name": REPO}
        if endpoint == f"repos/{REPO}/git/commits/{self.sha}":
            return {"sha": self.sha, "tree": self.tree, "verified": False}
        raise AssertionError("unexpected API endpoint")

    def result(self, **updates):
        args = {"root": self.root, "repo": REPO, "expected_commit": self.sha}
        args.update(updates)
        return identity.check(**args)

    def test_local_commit_matches_mocked_remote_tree(self):
        with patch.object(identity, "_api", side_effect=self.fake_api) as fn:
            r = self.result()
        self.assertEqual(r["status"], "MATCH")
        self.assertEqual(r["live_github_api"], "REPOSITORY_ID_AND_COMMIT_TREE_MATCH")
        self.assertEqual(r["git_commit_signature"], "NOT_GITHUB_VERIFIED")
        self.assertEqual(r["decision"], "CANDIDATE_NO_GO")
        self.assertEqual(r["product_zip_provenance"], "NOT_RUN")
        self.assertEqual(fn.call_count, 2)

    def test_good_commit_signature_is_not_release_go(self):
        def api(endpoint, jq):
            result = self.fake_api(endpoint, jq)
            if "git/commits/" in endpoint:
                result["verified"] = True
            return result
        with patch.object(identity, "_api", side_effect=api):
            r = self.result()
        self.assertEqual(r["git_commit_signature"], "GITHUB_VERIFIED")
        self.assertEqual(r["decision"], "CANDIDATE_NO_GO")

    def test_reject_unknown_repo_without_api(self):
        with patch.object(identity, "_api") as fn:
            self.assertEqual(self.result(repo="example/not-allowed")["status"], "FAIL")
        fn.assert_not_called()

    def test_reject_unknown_commit_without_api(self):
        with patch.object(identity, "_api") as fn:
            self.assertEqual(self.result(expected_commit="HEAD")["status"], "FAIL")
        fn.assert_not_called()

    def test_wrong_git_head_shortcircuits_api(self):
        with patch.object(identity, "_api") as fn:
            self.assertEqual(self.result(expected_commit="0" * 40)["status"], "FAIL")
        fn.assert_not_called()

    def test_repository_id_mismatch(self):
        with patch.object(identity, "_api", side_effect=[{"id": 1234, "full_name": REPO}]) as fn:
            self.assertEqual(self.result()["status"], "FAIL")
        self.assertEqual(fn.call_count, 1)

    def test_bool_repository_id_rejected(self):
        with patch.object(identity, "_api", side_effect=[{"id": True, "full_name": REPO}]):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_repository_rename_rejected(self):
        with patch.object(identity, "_api", side_effect=[{"id": 1389881401, "full_name": "other/repo"}]):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_tree_mismatch_rejected(self):
        def bad(endpoint, jq):
            r = self.fake_api(endpoint, jq)
            if "git/commits/" in endpoint:
                r["tree"] = "0" * 40
            return r
        with patch.object(identity, "_api", side_effect=bad):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_commit_sha_mismatch_rejected(self):
        def bad(endpoint, jq):
            r = self.fake_api(endpoint, jq)
            if "git/commits/" in endpoint:
                r["sha"] = "0" * 40
            return r
        with patch.object(identity, "_api", side_effect=bad):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_missing_commit_object_rejected(self):
        with patch.object(identity, "_api", side_effect=[{"id": 1389881401, "full_name": REPO}, {}]):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_gh_network_failure_rejected(self):
        with patch.object(identity, "_api", side_effect=ValueError("API failed")):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_gh_timeout_rejected(self):
        with patch.object(identity, "_api", side_effect=subprocess.TimeoutExpired("gh", 30)):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_git_subdirectory_rejected(self):
        nested = self.root / "nested"
        nested.mkdir()
        with patch.object(identity, "_api") as fn:
            self.assertEqual(self.result(root=nested)["status"], "FAIL")
        fn.assert_not_called()

    def test_missing_checkout_rejected(self):
        with patch.object(identity, "_api") as fn:
            self.assertEqual(self.result(root=self.root / "missing")["status"], "FAIL")
        fn.assert_not_called()

    def test_symlink_checkout_rejected(self):
        link = Path(self.temp.name) / "link"
        try:
            link.symlink_to(self.root, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not supported")
        with patch.object(identity, "_api") as fn:
            self.assertEqual(self.result(root=link)["status"], "FAIL")
        fn.assert_not_called()

    def test_api_pins_github_host(self):
        with patch.object(identity, "_run", return_value='{"id":1389881401,"full_name":"r20942097-hue/faaff"}') as fn:
            data = identity._api(f"repos/{REPO}", "{id, full_name}")
        self.assertEqual(data["id"], 1389881401)
        args = fn.call_args.args[0]
        self.assertEqual(args[0:4], ["gh", "api", "--hostname", "github.com"])

    def test_api_path_escape_rejected(self):
        with patch.object(identity, "_run") as fn:
            with self.assertRaises(ValueError):
                identity._api("repos/../evil", ".id")
        fn.assert_not_called()

    def test_api_invalid_json_rejected(self):
        with patch.object(identity, "_run", return_value="{bad"):
            with self.assertRaises(ValueError):
                identity._api(f"repos/{REPO}", ".id")

    def test_cli_json_success(self):
        with patch.object(identity, "_api", side_effect=self.fake_api):
            with patch("builtins.print") as out:
                rc = identity.main(["--root", str(self.root), "--repo", REPO,
                                    "--commit", self.sha, "--json"])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out.call_args.args[0])["status"], "MATCH")

    def test_cli_invalid_commit_exits_nonzero(self):
        with patch("builtins.print"):
            self.assertEqual(identity.main(["--root", str(self.root),
                                            "--repo", REPO, "--commit", "HEAD"]), 1)

    def test_missing_cli_executable_rejected(self):
        with patch.object(identity, "_api", side_effect=FileNotFoundError):
            self.assertEqual(self.result()["status"], "FAIL")

    def test_local_signature_not_asserted_as_remote(self):
        with patch.object(identity, "_api", side_effect=self.fake_api):
            r = self.result()
        self.assertEqual(r["browser_e2e"], "NOT_RUN")


if __name__ == "__main__":
    unittest.main()
