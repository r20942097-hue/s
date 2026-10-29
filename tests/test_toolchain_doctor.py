"""Offline mocked PATH discovery and status separation tests."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import toolchain_doctor as audit


def fake(command):
    if command in ("git", "python", "node", "npm", "gh"):
        return "/fixture/" + command
    return None


class ToolchainDoctorTests(unittest.TestCase):
    def test_core_profile_has_required_tools(self):
        result = audit.inspect("core", fake, lambda name: None)
        self.assertEqual(result["status"], "PATH_DISCOVERY_COMPLETE")

    def test_github_ci_profile_complete(self):
        self.assertEqual(audit.inspect("github-ci", fake, lambda n: None)
                         ["required_not_found_on_path"], [])

    def test_browser_profile_finds_missing_tools(self):
        result = audit.inspect("browser-media", fake, lambda name: None)
        self.assertIn("firefox", result["required_not_found_on_path"])
        self.assertIn("web-ext", result["required_not_found_on_path"])

    def test_security_profile_detects_missing_linters(self):
        result = audit.inspect("full-security", fake, lambda name: None)
        self.assertIn("actionlint", result["required_not_found_on_path"])
        self.assertIn("zizmor", result["required_not_found_on_path"])

    def test_missing_gh_detected(self):
        result = audit.inspect("github-ci",
                               lambda c: fake(c) if c != "gh" else None,
                               lambda n: None)
        self.assertIn("gh", result["required_not_found_on_path"])

    def test_alternate_chromium_command(self):
        def resolve(command):
            return "/fixture/chrome" if command == "chrome" else fake(command)
        result = audit.inspect("browser-media", resolve, lambda n: None)
        chrom = next(x for x in result["tools"] if x["tool"] == "chromium")
        self.assertEqual(chrom["path_command_found"], "chrome")

    def test_module_visibility_not_runtime_proof(self):
        result = audit.inspect("core", fake, lambda n: object())
        self.assertTrue(result["python_modules"][0]["import_spec_found"])
        self.assertEqual(result["python_modules"][0]["runtime_test"], "NOT_RUN")

    def test_path_visibility_not_authentication(self):
        result = audit.inspect("github-ci", fake, lambda n: None)
        self.assertEqual(result["github_authenticated"], "NOT_TESTED")
        self.assertEqual(result["release_decision"], "CANDIDATE_NO_GO")

    def test_unrecognised_profile(self):
        with self.assertRaises(ValueError):
            audit.inspect("bogus", fake, lambda n: None)

    def test_cli_diagnostic_mode_is_not_install(self):
        with patch.object(audit, "inspect", return_value={
                "status": "INCOMPLETE_PATH_DISCOVERY", "required_not_found_on_path": ["gh"]}):
            with patch("builtins.print"):
                self.assertEqual(audit.main(["--profile", "github-ci"]), 0)
                self.assertEqual(audit.main(["--profile", "github-ci",
                                             "--require-path-tools"]), 1)

    def test_json_serialisable(self):
        json.dumps(audit.inspect("core", fake, lambda n: None))

    def test_no_actual_browser_e2e_claim(self):
        result = audit.inspect("browser-media", fake, lambda n: None)
        self.assertEqual(result["browser_extension_e2e"], "NOT_RUN")


if __name__ == "__main__":
    unittest.main()
