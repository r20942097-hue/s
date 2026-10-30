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
        self.assertEqual(report["already_covered_by_local_parent_or_exact"], 3)

    def test_upstream_allowlist_literal_reference_fails_open_to_manual_review(self):
        text = "||novel-tracking.example^$third-party\n"
        allow = "@@||novel-tracking.example^$domain=checkout.example\n"
        report = scan(self.profiles, self.evidence, text, allow, 10)
        self.assertEqual(report["candidate_hosts_with_selected_allowlist_reference"], 1)
        self.assertEqual(report["candidate_hosts_with_selected_allowlist_exception"], 1)
        self.assertEqual(report["queue"][0]["selected_allowlist_exception_lines"], [1])
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
        for value in (0, 201, -10, 1.5, True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                scan(self.profiles, self.evidence, "", "", value)
        with self.assertRaises(ValueError):
            scan(self.profiles, self.evidence, b"not text", "", 10)

    def test_parent_domain_expansion_is_flagged_and_not_counted_as_covered(self):
        # An ancestor of an already blocked host is not automatically redundant.
        text = ("||wetracked.io^$third-party\n"
                "||pixel.wetracked.io^$third-party\n"
                "||brand-new-review.example^$third-party\n")
        report = scan(self.profiles, self.evidence, text, "", 10)
        self.assertEqual(report["already_covered_by_local_parent_or_exact"], 1)
        self.assertEqual(report["parent_expansion_candidates"], 1)
        self.assertEqual(report["new_candidate_hosts"], 2)
        expanded = next(x for x in report["queue"] if x["host"] == "wetracked.io")
        self.assertEqual(expanded["coverage"], "expands-existing-child")
        self.assertIn("parent_domain_expansion", expanded["risk_flags"])
        self.assertEqual(report["queue"][0]["host"], "brand-new-review.example")

    def test_path_scoped_rule_does_not_imply_all_resource_coverage(self):
        profiles = copy.deepcopy(self.profiles)
        profiles["rule_sets"]["strict-v2"]["rules"].append(
            "||partial-path-test.example/tracker.js$third-party")
        report = scan(profiles, self.evidence,
                      "||partial-path-test.example^$third-party", "", limit=10)
        self.assertEqual(report["new_candidate_hosts"], 1)
        self.assertEqual(report["already_covered_by_local_parent_or_exact"], 0)
        self.assertEqual(report["restricted_scope_expansion_candidates"], 1)
        self.assertIn("type_or_path_scope_expansion", report["queue"][0]["risk_flags"])
        self.assertEqual(report["queue"][0]["coverage"], "expands-existing-restricted")

    def test_script_scoped_parent_not_general_host_coverage(self):
        profiles = copy.deepcopy(self.profiles)
        profiles["rule_sets"]["strict-v2"]["rules"].append(
            "||parent-scope-test.example^$third-party,script")
        report = scan(profiles, self.evidence,
                      "||cdn.parent-scope-test.example^$third-party", "", limit=10)
        self.assertEqual(report["new_candidate_hosts"], 1)
        self.assertEqual(report["restricted_scope_expansion_candidates"], 1)
        self.assertEqual(report["queue"][0]["coverage"], "expands-existing-restricted")

    def test_explicit_general_parent_blocks_child_completely(self):
        profiles = copy.deepcopy(self.profiles)
        profiles["rule_sets"]["privacy-core"]["rules"].append(
            "||full-scope-test.example^$third-party")
        report = scan(profiles, self.evidence,
                      "||cdn.full-scope-test.example^$third-party", "", limit=10)
        self.assertEqual(report["new_candidate_hosts"], 0)
        self.assertEqual(report["already_covered_by_local_parent_or_exact"], 1)

    def test_parent_candidate_of_path_rule_is_expansion_not_redundancy(self):
        profiles = copy.deepcopy(self.profiles)
        profiles["rule_sets"]["strict-v2"]["rules"].append(
            "||asset.deep-scope-test.example/pixel$third-party")
        report = scan(profiles, self.evidence,
                      "||deep-scope-test.example^$third-party", "", limit=10)
        self.assertEqual(report["parent_expansion_candidates"], 1)
        self.assertEqual(report["new_candidate_hosts"], 1)
        self.assertEqual(report["queue"][0]["coverage"], "expands-existing-child")

    def test_comment_mention_separated_from_actual_allow_rule(self):
        tracking = ("||somehost.example^$third-party\n"
                    "||anotherhost.example^$third-party\n")
        allow = ("! somehost.example is a recorded tracker\n"
                 "@@||anotherhost.example^$domain=checkout.example\n"
                 "@@||somehost.example-lookalike.org^$domain=foo.test\n")
        report = scan(self.profiles, self.evidence, tracking, allow, 10)
        self.assertEqual(report["candidate_hosts_with_selected_allowlist_reference"], 2)
        self.assertEqual(report["candidate_hosts_with_selected_allowlist_exception"], 1)
        by_name = {row["host"]: row for row in report["queue"]}
        self.assertEqual(by_name["somehost.example"]["selected_allowlist_references"], [1])
        self.assertEqual(by_name["somehost.example"]["selected_allowlist_exception_lines"], [])
        self.assertIn("selected_allowlist_literal_mention", by_name["somehost.example"]["risk_flags"])
        self.assertEqual(by_name["anotherhost.example"]["selected_allowlist_exception_lines"], [2])
        self.assertIn("selected_allowlist_exception", by_name["anotherhost.example"]["risk_flags"])

    def test_literal_reference_deduplicated_per_line(self):
        report = scan(self.profiles, self.evidence,
                      "||unseen-tracker.example^$third-party",
                      "@@||unseen-tracker.example^$domain=unseen-tracker.example",
                      10)
        self.assertEqual(report["queue"][0]["selected_allowlist_references"], [1])
        self.assertEqual(report["queue"][0]["selected_allowlist_exception_lines"], [1])

    def test_review_queue_not_a_live_or_baseline_effectiveness_claim(self):
        report = scan(self.profiles, self.evidence, "||novel.example^$third-party", "")
        self.assertEqual(report["schema"], "upstream-delta-review/v2")
        self.assertEqual(report["live_site_e2e"], "NOT_RUN")
        self.assertEqual(report["publication"], "NO_GO")
        self.assertTrue(any("EasyPrivacy" in note for note in report["limitations"]))

    def test_no_mutations_of_inputs(self):
        before_profile = copy.deepcopy(self.profiles)
        before_evidence = copy.deepcopy(self.evidence)
        scan(self.profiles, self.evidence, "||unique.example^$third-party", "")
        self.assertEqual(self.profiles, before_profile)
        self.assertEqual(self.evidence, before_evidence)


if __name__ == "__main__":
    unittest.main()
