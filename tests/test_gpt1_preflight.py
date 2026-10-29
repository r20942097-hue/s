"""Read-only fixture tests for GPT1 repository environment auditing."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# In s, tests/ is at the repository root; the script lives in scripts/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gpt1_preflight import GATES, REQUIRED, active_gate, audit, main, safe_required_path, tracked_archives


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def make_repo(self, repo="r20942097-hue/s"):
        for rel in REQUIRED[repo]:
            p = self.root / rel
            if Path(rel).suffix:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("placeholder\n", encoding="utf-8")
            else:
                p.mkdir(parents=True, exist_ok=True)
        state_path = self.root / "ai/PROJECT_STATE.json"
        self.state = {"schema": "project-state/v1", "repository": repo,
                      "gates": {k: "active" for k in GATES}}
        self.save_state()

    def save_state(self):
        p = self.root / "ai/PROJECT_STATE.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(self.state), encoding="utf-8")

    def failure_names(self):
        return [c["name"] for c in audit(self.root)["checks"] if c["status"] == "FAIL"]

    def test_s_minimal_structure_passes(self):
        self.make_repo()
        result = audit(self.root)
        self.assertEqual(result["result"], "PARTIAL")
        self.assertEqual(result["scope"], "structural/offline-only")
        self.assertEqual(result["summary"]["NOT_RUN"], 3)

    def test_faaff_minimal_structure_passes(self):
        self.make_repo("r20942097-hue/faaff")
        self.assertEqual(audit(self.root)["result"], "PARTIAL")

    def test_missing_required_file_is_failure(self):
        self.make_repo()
        (self.root / "ad.txt").unlink()
        self.assertIn("required:ad.txt", self.failure_names())

    def test_wrong_schema_is_failure(self):
        self.make_repo()
        self.state["schema"] = "project-state/v2"
        self.save_state()
        self.assertIn("state-schema", self.failure_names())

    def test_missing_governance_gate_is_failure(self):
        self.make_repo()
        self.state["gates"].pop("PUBLICATION_HOLD")
        self.save_state()
        self.assertIn("governance", self.failure_names())

    def test_unknown_repository_is_failure(self):
        self.make_repo()
        self.state["repository"] = "untrusted/other"
        self.save_state()
        self.assertIn("repository", self.failure_names())

    def test_invalid_json_fails_without_exception(self):
        self.make_repo()
        (self.root / "ai/PROJECT_STATE.json").write_text("{bad", encoding="utf-8")
        self.assertIn("state", self.failure_names())

    def test_missing_state_fails(self):
        self.make_repo()
        (self.root / "ai/PROJECT_STATE.json").unlink()
        self.assertIn("state", self.failure_names())

    def test_archive_guard_fail_is_reported(self):
        self.make_repo()
        with patch("gpt1_preflight.tracked_archives", return_value=("FAIL", ["unsafe.zip"])):
            self.assertIn("tracked-archives", self.failure_names())

    def test_archive_guard_not_run_without_git(self):
        self.make_repo()
        self.assertEqual(tracked_archives(self.root), ("NOT_RUN", []))

    def test_cli_returns_partial_on_fixture_without_git(self):
        self.make_repo()
        with patch("builtins.print"):
            self.assertEqual(main(["--root", str(self.root), "--json"]), 2)

    def test_cli_returns_nonzero_on_missing_file(self):
        self.make_repo()
        (self.root / "ad.txt").unlink()
        with patch("builtins.print"):
            self.assertEqual(main(["--root", str(self.root)]), 1)


    def test_wrong_file_kind_is_failure(self):
        self.make_repo()
        (self.root / "ad.txt").unlink()
        (self.root / "ad.txt").mkdir()
        self.assertIn("required:ad.txt", self.failure_names())

    def test_wrong_directory_kind_is_failure(self):
        self.make_repo("r20942097-hue/faaff")
        p = self.root / "browser_filter_lists"
        p.rmdir()
        p.write_text("not a directory", encoding="utf-8")
        self.assertIn("required:browser_filter_lists", self.failure_names())

    def test_inactive_status_prefix_is_rejected(self):
        self.make_repo()
        self.state["gates"]["P0"] = "actively disabled"
        self.save_state()
        self.assertIn("governance", self.failure_names())

    def test_non_string_repository_is_failure_not_exception(self):
        self.make_repo()
        self.state["repository"] = ["malformed"]
        self.save_state()
        result = audit(self.root)
        self.assertEqual(result["result"], "FAIL")
        self.assertEqual(result["repository"], "UNKNOWN")

    def test_non_string_gate_is_rejected(self):
        self.make_repo()
        self.state["gates"]["P0"] = True
        self.save_state()
        self.assertIn("governance", self.failure_names())

    def test_gate_active_colon_is_accepted(self):
        self.assertTrue(active_gate("active: enabled"))
        self.assertFalse(active_gate("active-but-disabled"))

    def test_identity_mismatch_is_failure(self):
        self.make_repo()
        result = audit(self.root, expected_repo="r20942097-hue/faaff")
        self.assertEqual(result["result"], "FAIL")
        self.assertIn("identity", [c["name"] for c in result["checks"] if c["status"] == "FAIL"])

    def test_require_git_reports_missing_as_failure(self):
        self.make_repo()
        result = audit(self.root, require_git=True)
        self.assertEqual(result["result"], "FAIL")
        self.assertIn("tracked-archives", [c["name"] for c in result["checks"] if c["status"] == "FAIL"])

    def test_verified_git_archive_guard_allows_pass(self):
        self.make_repo()
        with patch("gpt1_preflight.tracked_archives", return_value=("PASS", [])):
            result = audit(self.root, expected_repo="r20942097-hue/s", require_git=True)
        self.assertEqual(result["result"], "PASS")

    def test_symlink_ancestor_is_rejected(self):
        self.make_repo()
        external = self.root / "external"
        external.mkdir()
        path = external / "placeholder.txt"
        path.write_text("safe", encoding="utf-8")
        target = self.root / "ai" / "HANDOFF.md"
        target.unlink()
        try:
            target.symlink_to(path)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation unavailable")
        self.assertFalse(safe_required_path(self.root, "ai/HANDOFF.md", False))

    def test_cli_requires_git_for_ci(self):
        self.make_repo()
        with patch("builtins.print"):
            self.assertEqual(main(["--root", str(self.root), "--require-git"]), 1)


if __name__ == "__main__":
    unittest.main()
