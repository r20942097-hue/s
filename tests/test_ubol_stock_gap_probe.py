"""Offline tests for bounded stock DNR coverage screening."""
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ubol_stock_gap_probe import categorize, shortlist, REQUEST_TYPES
from audit_filter_candidates import ROOT, read_json


class StockGapScreenTests(unittest.TestCase):
    def setUp(self):
        self.profiles = read_json(ROOT / "filter-profiles.json")
        self.evidence = read_json(ROOT / "verification/filter-candidates.json")
        self.baselines = {
            "easyprivacy/easyprivacy_trackingservers_thirdparty.txt": "",
            "easyprivacy/easyprivacy_trackingservers_international.txt": ""
        }

    def test_shortlist_excludes_local_covered_and_selected_allowlist(self):
        tracking = ("||scorecardresearch.com^$third-party\n"
                    "||unique-review-host.example^$third-party\n"
                    "||bad-allow-host.example^$third-party\n")
        selected, total = shortlist(
            self.profiles, self.evidence, tracking,
            "@@||bad-allow-host.example^$third-party", self.baselines, 2)
        self.assertEqual(total, 2)
        self.assertEqual([row["host"] for row in selected],
                         ["unique-review-host.example"])

    def test_shortlist_rejects_invalid_sample_limit(self):
        for limit in (False, 0, 121, "10"):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                shortlist(self.profiles, self.evidence, "", "", self.baselines, limit)

    def test_categorization_keeps_no_match_as_review_only(self):
        choices = [{"host": "sample.example", "source_url": "https://example.invalid/pin",
                    "line": 123}]
        cases = [{"host": "sample.example", "request_type": kind,
                  "matched_rules": [], "block_action_count": 0,
                  "unresolved_actions": 0} for kind in REQUEST_TYPES]
        found = categorize(choices, {"cases": cases})
        self.assertEqual(found[0]["classification"], "NO_STOCK_BLOCK_MATCH_IN_TESTED_SHAPES")
        self.assertFalse(found[0]["proposed_for_publication"])
        self.assertEqual(found[0]["site_breakage"], "NOT_RUN")

    def test_detects_stock_block_in_one_type(self):
        choices = [{"host": "sample.example", "source_url": "source", "line": 1}]
        cases = [{"host": "sample.example", "request_type": kind,
                  "matched_rules": [{"action_type": "block"}] if kind == "image" else [],
                  "block_action_count": 1 if kind == "image" else 0,
                  "unresolved_actions": 0} for kind in REQUEST_TYPES]
        found = categorize(choices, {"cases": cases})
        self.assertEqual(found[0]["classification"], "STOCK_BLOCKED_IN_TESTED_SHAPES")

    def test_missing_or_unresolved_types_fail_closed(self):
        choices = [{"host": "sample.example", "source_url": "source", "line": 1}]
        cases = [{"host": "sample.example", "request_type": kind,
                  "matched_rules": [], "block_action_count": 0,
                  "unresolved_actions": 1 if kind == "script" else 0}
                 for kind in REQUEST_TYPES]
        self.assertEqual(categorize(choices, {"cases": cases})[0]["classification"],
                         "UNRESOLVED")
        with self.assertRaisesRegex(ValueError, "incomplete"):
            categorize(choices, {"cases": cases[:-1]})


if __name__ == "__main__":
    unittest.main()
