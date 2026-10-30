"""Regression tests for isolated browser integration release guard."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from verify_browser_gates import assess, render


class BrowserAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.surrogate = {
            "schema": "filter-browser-fixture/v1", "browser_fixture": "PASS",
            "extension_loaded": False, "live_site_e2e": "NOT_RUN",
            "browsers": [
                {"engine": e, "surrogate_blocked_request": "PASS",
                 "real_extension": "NOT_RUN", "real_site_e2e": "NOT_RUN"}
                for e in ("chromium", "firefox")
            ]
        }
        self.native = {
            "schema": "filter-chromium-dnr-fixture/v1",
            "real_extension_loaded": True, "baseline_control": "PASS",
            "same_site_control": "PASS", "native_dnr_blocking": "PASS",
            "login_checkout_fixture": "PASS",
            "actual_adblock_extension": "NOT_RUN",
            "live_site_e2e": "NOT_RUN", "publication": "NO_GO"
        }
        self.stock = {
            "schema": "filter-real-ubol-ci/v1", "archive_verified": True,
            "extension_loaded": "PASS", "active_rulesets": 6,
            "stock_dnr_hypothetical": {"status": "OBSERVED", "cases": [
                {"block_action_count": 1, "unresolved_actions": 0}
                for _ in range(7)
            ]}, "candidate_subscription_e2e": "NOT_RUN",
            "live_site_e2e": "NOT_RUN", "real_firefox_ubo": "NOT_RUN",
            "publication": "NO_GO"
        }
        self.imported = {
            "schema": "filter-real-ubol-import-fixture/v1",
            "real_official_extension": True,
            "candidate_rules_supplied": 7, "fixture_only_control_rules": 1,
            "import_compile": "PASS", "actual_live_site_e2e": "NOT_RUN",
            "candidate_incremental_effect": "NOT_ESTABLISHED",
            "firefox_full_ubo": "NOT_RUN", "publication": "NO_GO",
            "observations": {
                "registered": True, "enabled": True,
                "compiled_storage_present": True, "accepted_filters": 8,
                "download_requests": 1, "unsubscribe_reverted": True,
                "control_before": {"match_count": 0},
                "control_after_import": {"block_action_count": 1},
                "control_after_unsubscribe": {"match_count": 0}
            }
        }

    def check(self):
        return assess(self.surrogate, self.native, self.stock, self.imported)

    def test_valid_isolated_four_stage_gate_passes_without_release_claim(self):
        self.assertEqual(self.check(), [])
        summary = render(self.surrogate, self.native, self.stock, self.imported, [])
        self.assertIn("NO_GO / NEEDS_HUMAN", summary)
        self.assertIn("NOT_RUN", summary)
        self.assertIn("7 held candidates + 1 test-only", summary)

    def test_synthetic_vs_real_extension_must_remain_separated(self):
        self.surrogate["extension_loaded"] = True
        self.assertTrue(any("surrogate" in x or "synthetic" in x for x in self.check()))

    def test_stock_evidence_all_seven_required(self):
        self.stock["stock_dnr_hypothetical"]["cases"][2]["block_action_count"] = 0
        self.assertTrue(any("stock evidence" in x for x in self.check()))

    def test_candidate_and_fixture_counts_strictly_separate(self):
        self.imported["candidate_rules_supplied"] = 8
        self.assertTrue(any("local import" in x for x in self.check()))

    def test_import_must_not_skip_dnr_rollback(self):
        self.imported["observations"]["unsubscribe_reverted"] = False
        self.assertTrue(any("local import" in x for x in self.check()))

    def test_control_must_change_then_revert(self):
        self.imported["observations"]["control_after_import"]["block_action_count"] = 0
        self.assertTrue(any("synthetic DNR" in x for x in self.check()))
        self.imported["observations"]["control_after_import"]["block_action_count"] = 1
        self.imported["observations"]["control_after_unsubscribe"]["match_count"] = 1
        self.assertTrue(any("synthetic DNR" in x for x in self.check()))

    def test_publication_and_real_site_claims_are_not_allowed(self):
        self.stock["publication"] = "GO"
        self.assertTrue(self.check())
        self.stock["publication"] = "NO_GO"
        self.imported["actual_live_site_e2e"] = "PASS"
        self.assertTrue(self.check())

    def test_no_invented_browser_success(self):
        self.surrogate["browsers"].pop()
        self.assertTrue(any("two-engine" in x for x in self.check()))
        self.surrogate["browsers"].append({
            "engine": "firefox", "surrogate_blocked_request": "PASS",
            "real_extension": "NOT_RUN", "real_site_e2e": "NOT_RUN"
        })
        self.native["native_dnr_blocking"] = "NOT_RUN"
        self.assertTrue(any("native" in x for x in self.check()))


if __name__ == "__main__":
    unittest.main()
