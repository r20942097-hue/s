"""Synthetic and registry-derived tests for subscription-scope comparisons."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from audit_filter_candidates import ROOT, read_json
from compare_subscription_coverage import analyze, matching_sets, REPORT_SCHEMA


class SubscriptionCoverageTests(unittest.TestCase):
    def setUp(self):
        self.profiles = read_json(ROOT / "filter-profiles.json")
        self.evidence = read_json(ROOT / "verification/filter-candidates.json")

    def test_all_profiles_present_and_unchanged(self):
        before = copy.deepcopy(self.profiles)
        text = ("||doubleclick.net^$third-party\n"
                "||hotjar.com^$third-party\n"
                "||id5-sync.com^$third-party\n"
                "||unseen-coverage.example^$third-party\n")
        report = analyze(self.profiles, self.evidence, text, "")
        self.assertEqual(report["schema"], REPORT_SCHEMA)
        self.assertEqual(report["publication"], "NO_GO")
        self.assertEqual(report["live_site_e2e"], "NOT_RUN")
        self.assertEqual(self.profiles, before)
        self.assertEqual(report["source_host_universe"], 4)
        self.assertEqual(report["independent_comparison"], "NOT_RUN")
        rows = {item["name"]: item for item in report["outputs"]}
        self.assertIn("ad.txt", rows)
        self.assertIn("tracking.txt", rows)
        self.assertIn("v2/tracking-extra.txt", rows)
        self.assertIn("stable_combined", rows)
        self.assertIn("v2_balanced", rows)
        self.assertEqual(rows["ad.txt"]["covered_by_exact_or_parent"], 1)
        self.assertEqual(rows["tracking.txt"]["covered_by_exact_or_parent"], 1)
        self.assertEqual(rows["v2/tracking-extra.txt"]["covered_by_exact_or_parent"], 0)
        self.assertEqual(rows["stable_combined"]["covered_by_exact_or_parent"], 2)
        self.assertEqual(rows["v2_balanced"]["covered_by_exact_or_parent"], 2)
        for item in rows.values():
            self.assertEqual(item["covered_by_exact_or_parent"]
                             + item["not_covered_by_exact_or_parent"], 4)

    def test_all_seven_proposed_candidates_have_individual_evidence(self):
        sources = {
            "easyprivacy/easyprivacy_trackingservers_thirdparty.txt":
                "||bidr.io^$third-party\n||getblue.io^$third-party\n",
            "easyprivacy/easyprivacy_trackingservers_international.txt":
                "||ebis.ne.jp^$third-party\n"
        }
        report = analyze(self.profiles, self.evidence, "", "", baselines=sources)
        rows = report["proposed_candidate_evidence"]
        self.assertEqual(report["proposed_candidate_count"], 0)
        self.assertEqual(report["retired_stock_overlap_count"], 7)
        self.assertEqual(len(rows), 7)
        by_host = {row["host"]: row for row in rows}
        for host, parent in {
            "match.prod.bidr.io": "bidr.io",
            "event.getblue.io": "getblue.io",
            "sync.ebis.ne.jp": "ebis.ne.jp"
        }.items():
            self.assertEqual(by_host[host]["selected_easyprivacy_match_shape"], "full")
            self.assertEqual(by_host[host]["selected_easyprivacy_matching_host"], parent)
        for host in ("sync.adkernel.com", "sync.richaudience.com",
                     "id5-sync.com", "pixel.wetracked.io"):
            self.assertIsNone(by_host[host]["selected_easyprivacy_match_shape"])
        self.assertTrue(all(row["adopted_to_stable"] is False for row in rows))
        self.assertTrue(all(row["status"] == "RETIRED_STOCK_OVERLAP" and row["active_rule"] is False for row in rows))
        self.assertTrue(all(row["incremental_blocking_value"] == "NOT_ESTABLISHED" for row in rows))
        self.assertTrue(all(row["real_site_compatibility"] == "NOT_RUN" for row in rows))

    def test_proposed_candidate_rule_removed_is_not_silently_ignored(self):
        changed = copy.deepcopy(self.profiles)
        changed["rule_sets"]["privacy-v2"]["rules"].append("||sync.adkernel.com^$third-party")
        with self.assertRaisesRegex(ValueError, "leaked"):
            analyze(changed, self.evidence, "", "")
        changed = copy.deepcopy(self.profiles)
        changed["rule_sets"]["privacy-optional-20261030"]["rules"].append(
            "||another.example^$third-party")
        with self.assertRaisesRegex(ValueError, "leaked"):
            analyze(changed, self.evidence, "", "")

    def test_optional_not_silently_added_to_stable(self):
        rules = matching_sets(self.profiles, ("ad.txt", "tracking.txt"))
        self.assertNotIn("privacy-optional-20261030", rules)
        self.assertNotIn("privacy-v2", rules)
        v2 = matching_sets(self.profiles, ("v2/tracking.txt",))
        self.assertIn("privacy-v2", v2)
        self.assertNotIn("privacy-optional-20261030", v2)

    def test_invalid_scope_selection_rejected(self):
        for paths in ((), ("missing.txt",), ("ad.txt", "ad.txt"), ("other", "v2/ad.txt")):
            with self.subTest(paths=paths), self.assertRaises(ValueError):
                matching_sets(self.profiles, paths)

    def test_mirror_output_not_accepted_as_published_s_subscription(self):
        mirror = next(x["path"] for x in self.profiles["outputs"] if x["scope"] == "faaff")
        with self.assertRaises(ValueError):
            matching_sets(self.profiles, (mirror,))

    def test_pinned_baseline_comparison_is_separate_from_own_coverage(self):
        sources = {
            "easyprivacy/easyprivacy_trackingservers_thirdparty.txt":
                "||known-independently.example^$third-party\n",
            "easyprivacy/easyprivacy_trackingservers_international.txt":
                "||script-limited.example^$script,third-party\n"
        }
        upstream = ("||known-independently.example^$third-party\n"
                    "||script-limited.example^$third-party\n"
                    "||not-in-any-selected-source.example^$third-party\n")
        report = analyze(self.profiles, self.evidence, upstream, "", baselines=sources)
        self.assertEqual(report["independent_comparison"], "PASS")
        for row in report["outputs"]:
            self.assertEqual(row["selected_easyprivacy_overlap_among_not_covered"], 2)
        self.assertTrue(all(row["not_covered_by_exact_or_parent"] == 3
                            for row in report["outputs"]))

    def test_duplicate_or_missing_published_output_is_a_failure(self):
        data = copy.deepcopy(self.profiles)
        data["outputs"].append(copy.deepcopy(next(o for o in data["outputs"] if o["path"] == "ad.txt")))
        with self.assertRaises(ValueError):
            analyze(data, self.evidence, "", "")
        data = copy.deepcopy(self.profiles)
        data["outputs"] = [o for o in data["outputs"] if o["path"] != "tracking.txt"]
        with self.assertRaises(ValueError):
            analyze(data, self.evidence, "", "")


if __name__ == "__main__":
    unittest.main()
