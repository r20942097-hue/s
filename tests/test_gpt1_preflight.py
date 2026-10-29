"""Read-only fixture tests for GPT1 repository environment auditing."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# In s, tests/ is at the repository root; the script lives in scripts/.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gpt1_preflight import GATES, REQUIRED, audit, main, tracked_archives


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
        self.assertEqual(result["result"], "PASS")
        self.assertEqual(result["scope"], "structural/offline-only")
        self.assertEqual(result["summary"]["NOT_RUN"], 3)

    def test_faaff_minimal_structure_passes(self):
        self.make_repo("r20942097-hue/faaff")
        self.assertEqual(audit(self.root)["result"], "PASS")

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

    def test_cli_returns_zero_on_fixture(self):
        self.make_repo()
        with patch("builtins.print"):
            self.assertEqual(main(["--root", str(self.root), "--json"]), 0)

    def test_cli_returns_nonzero_on_missing_file(self):
        self.make_repo()
        (self.root / "ad.txt").unlink()
        with patch("builtins.print"):
            self.assertEqual(main(["--root", str(self.root)]), 1)


if __name__ == "__main__":
    unittest.main()
