"""Adversarial regression fixtures for offline GitHub workflow safety inspection."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from workflow_supply_chain import audit, audit_workflow, main

CHECKOUT = "actions/checkout@" + "3d3c42e5aac5ba805825da76410c181273ba90b1"
SETUP = "actions/setup-python@" + "6d4fd22b20465ccc0f7354476588e8df7c9ca0e0"
FAAFF = "r20942097-hue/faaff"
S = "r20942097-hue/s"


def workflow(action=CHECKOUT, permission="contents: read", event="pull_request:", checkout=True):
    with_lines = "        with:\n          persist-credentials: false\n" if checkout else ""
    return (f"name: Test\non:\n  {event}\npermissions:\n  {permission}\n"
            f"jobs:\n  qa:\n    runs-on: ubuntu-latest\n    steps:\n"
            f"      - uses: {action}\n{with_lines}")


class SupplyChainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.workflows = self.root / ".github" / "workflows"
        self.workflows.mkdir(parents=True)
        self.file = self.workflows / "qa.yml"
        self.file.write_text(workflow(), encoding="utf-8")

    def outcome(self):
        return audit(self.root, FAAFF)["status"]

    def test_valid_workflow(self):
        self.assertEqual(self.outcome(), "PASS")

    def test_two_valid_workflows(self):
        (self.workflows / "another.yaml").write_text(workflow(action=SETUP), encoding="utf-8")
        self.assertEqual(audit(self.root, S)["workflows_checked"], 2)
        self.assertEqual(self.outcome(), "PASS")

    def test_sha_tag_not_allowed(self):
        self.file.write_text(workflow(action="actions/checkout@v7"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_short_sha_not_allowed(self):
        self.file.write_text(workflow(action="actions/checkout@3d3c42e"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_local_uses_requires_review(self):
        self.file.write_text(workflow(action="./.github/actions/custom"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_checkout_without_persist_false(self):
        self.file.write_text(workflow(checkout=False), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_checkout_with_persist_true(self):
        self.file.write_text(workflow().replace("persist-credentials: false", "persist-credentials: true"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_checkout_false_in_next_step_does_not_count(self):
        s = workflow(checkout=False) + "      - name: Another step\n        with:\n          persist-credentials: false\n"
        self.file.write_text(s, encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_nested_uses_with_persist_false(self):
        s = workflow().replace("      - uses:", "      - name: Checkout\n        uses:")
        self.file.write_text(s, encoding="utf-8")
        self.assertEqual(self.outcome(), "PASS")

    def test_privileged_pull_request_target(self):
        self.file.write_text(workflow(event="pull_request_target:"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_privileged_workflow_run(self):
        self.file.write_text(workflow(event="workflow_run:"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_inline_privileged_trigger(self):
        self.file.write_text(workflow().replace("on:\n  pull_request:", "on: [workflow_run]"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_missing_permissions(self):
        self.file.write_text(workflow().replace("permissions:\n  contents: read\n", ""), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_write_permissions_not_allowed(self):
        self.file.write_text(workflow(permission="contents: write"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_read_all_not_allowed(self):
        self.file.write_text(workflow().replace("permissions:\n  contents: read", "permissions: read-all"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_job_permission_override(self):
        self.file.write_text(workflow().replace("    runs-on:", "    permissions:\n      contents: write\n    runs-on:"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_codeql_only_security_events_exception(self):
        self.file.unlink()
        c = self.workflows / "codeql.yml"
        c.write_text(workflow(permission="contents: read\n  security-events: write"), encoding="utf-8")
        self.assertEqual(self.outcome(), "PASS")

    def test_security_events_elsewhere_not_allowed(self):
        self.file.write_text(workflow(permission="contents: read\n  security-events: write"), encoding="utf-8")
        self.assertEqual(self.outcome(), "FAIL")

    def test_symlinked_workflow(self):
        outside = self.root / "outside.yml"
        outside.write_text(workflow(), encoding="utf-8")
        self.file.unlink()
        try:
            self.file.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.assertEqual(self.outcome(), "FAIL")

    def test_missing_directory(self):
        self.file.unlink()
        self.workflows.rmdir()
        self.assertEqual(self.outcome(), "FAIL")

    def test_empty_workflow_set(self):
        self.file.unlink()
        self.assertEqual(self.outcome(), "FAIL")

    def test_unknown_repo_rejected(self):
        self.assertEqual(audit(self.root, "unknown/repo")["status"], "FAIL")

    def test_cli_success(self):
        with patch("builtins.print"):
            self.assertEqual(main(["--root", str(self.root), "--expected-repository", FAAFF, "--json"]), 0)

    def test_cli_failure(self):
        self.file.write_text(workflow(action="actions/checkout@main"), encoding="utf-8")
        with patch("builtins.print"):
            self.assertEqual(main(["--root", str(self.root), "--expected-repository", FAAFF]), 1)

    def test_comment_does_not_add_action(self):
        self.file.write_text(workflow() + "      # - uses: untrusted/x@main\n", encoding="utf-8")
        self.assertEqual(self.outcome(), "PASS")

    def test_synthetic_bad_file_name_is_irrelevant(self):
        self.file.write_text(workflow(), encoding="utf-8")
        result = audit_workflow(self.file, ".github/workflows/qa.yml")
        self.assertEqual(result["result"], "PASS")
        self.assertEqual(len(result["actions"]), 1)


if __name__ == "__main__":
    unittest.main()
