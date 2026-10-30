"""Regression fixtures for read-only delta discovery (no web, no mutation)."""
import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from audit_filter_candidates import ROOT, read_json
from scan_upstream_delta import scan


class DeltaScanTests(unittest.TestCase):
    def setUp(self):
        self.profiles = read_json(ROOT / "filter-profiles.json")
        self.evidence = read_json(ROOT / "verification/filter-candidates.json")

    def test_nonoverlapping_candidate_queued_without_publishing(self):
        text = "||genuinely-unique-test.example^$third-party\n"
        report = scan(self.profiles, self.evidence, text, "", 10)
        self.assertEqual(report["new_candidate_hosts"], 1)
        self.assertEqual(report["publication"], "NO_GO")
        self.assertEqual(report["queue"][0]["live_site_e2e"], "NOT_RUN")
        self.assertTrue(report["queue"][0]["needs_manual_review"])

    def test_existing_or_parent_coverage_is_not_recommended(self):
        text = ("||doubleclick.net^$third-party\n"
                "||ads.doubleclick.net^$third-party\n"
                "||google-analytics.com^$third-party\n"
                "||not-in-existing.example^$third-party\n")
        report = scan(self.profiles, self.evidence, text, "", 10)
        self.assertEqual(report["new_candidate_hosts"], 1)
        self.assertEqual(report["already_covered_or_parent_overlap"], 3)

    def test_upstream_allowlist_literal_reference_fails_open_to_manual_review(self):
        text = "||novel-tracking.example^$third-party\n"
        allow = "@@||novel-tracking.example^$domain=checkout.example\n"
        report = scan(self.profiles, self.evidence, text, allow, 10)
        self.assertEqual(report["candidate_hosts_with_selected_allowlist_reference"], 1)
        self.assertEqual(report["queue"][0]["selected_allowlist_references"], [1])
        self.assertEqual(report["queue"][0]["status"], "REVIEW_REQUIRED")

    def test_host_boundaries_reject_lookalike(self):
        text = "||novel-tracking.example^$third-party\n"
        allow = "@@||fake-novel-tracking.example.org^\n"
        report = scan(self.profiles, self.evidence, text, allow, 10)
        self.assertEqual(report["candidate_hosts_with_selected_allowlist_reference"], 0)

    def test_ignore_nonportable_or_overbroad_rules_and_duplicates(self):
        text = ("||new.example^$third-party\n"
                "||new.example^$third-party\n"
                "||weird..example^$third-party\n"
                "||broad.example^\n"
                "||another.example^$script,third-party\n"
                "@@||some.example^$third-party\n"
                "||127.0.0.1^$third-party\n")
        report = scan(self.profiles, self.evidence, text, "", 10)
        self.assertEqual([item["host"] for item in report["queue"]], ["new.example"])

    def test_results_sorted_stably_and_output_is_limited(self):
        text = "\n".join("||" + host + "^$third-party" for host in
                         ["z-new.example", "a-new.example", "b-new.example"])
        report = scan(self.profiles, self.evidence, text, "", 2)
        self.assertEqual(report["new_candidate_hosts"], 3)
        self.assertEqual([x["host"] for x in report["queue"]],
                         ["a-new.example", "b-new.example"])

    def test_invalid_limit_or_text_rejected(self):
        for value in (0, 201, -10, 1.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                scan(self.profiles, self.evidence, "", "", value)
        with self.assertRaises(ValueError):
            scan(self.profiles, self.evidence, b"not text", "", 10)

    def test_no_mutations_of_inputs(self):
        before_profile = copy.deepcopy(self.profiles)
        before_evidence = copy.deepcopy(self.evidence)
        scan(self.profiles, self.evidence, "||unique.example^$third-party", "")
        self.assertEqual(self.profiles, before_profile)
        self.assertEqual(self.evidence, before_evidence)


if __name__ == "__main__":
    unittest.main()
