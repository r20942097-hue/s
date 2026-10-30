"""Tests for fail-closed CI evidence aggregation (no network)."""
import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from summarize_filter_gates import gather, render


class GateSummaryTests(unittest.TestCase):
    def setUp(self):
        self.stable = {
            "schema": "filter-stable-fidelity-check/v1",
            "status": "PASS", "protected_asset_count": 8,
            "verified_asset_count": 8, "errors": [], "live_site_e2e": "NOT_RUN"
        }
        self.candidate = {
            "record_schema": "filter-candidates/v1", "metadata": "PASS",
            "upstream_snapshot": "PASS", "candidate_count": 4,
            "errors": [], "publication": "NEEDS_HUMAN", "live_site_e2e": "NOT_RUN"
        }
        self.delta = {
            "schema": "upstream-delta-review/v2", "queue_total": 3,
            "new_candidate_hosts": 3, "selected_independent_easyprivacy_comparison": "PASS",
            "candidate_hosts_also_observed_in_selected_easyprivacy": 2,
            "candidate_hosts_with_selected_easyprivacy_full_host_rule": 1,
            "candidate_hosts_with_selected_easyprivacy_scoped_rule_only": 1,
            "candidate_hosts_with_selected_allowlist_exception": 0,
            "publication": "NO_GO", "live_site_e2e": "NOT_RUN"
        }
        self.drift = {
            "schema": "filter-upstream-drift/v1", "sources_checked": 4,
            "drift_files": 0, "automatic_source_pin_update": False,
            "publication": "NO_GO", "live_site_e2e": "NOT_RUN"
        }

    def check(self):
        return gather(self.stable, self.candidate, self.delta, self.drift)

    def test_four_valid_independent_reports_pass(self):
        self.assertEqual(self.check(), [])
        s = render(self.stable, self.candidate, self.delta, self.drift, [])
        self.assertIn("PASS (automated only)", s)
        self.assertIn("NOT_RUN", s)
        self.assertIn("NO_GO", s)

    def test_candidate_evidence_not_verified_fails(self):
        self.candidate["upstream_snapshot"] = "NOT_RUN"
        self.assertTrue(any("candidate source" in x for x in self.check()))

    def test_accidental_or_disallowed_stable_mutation_fails(self):
        self.stable["verified_asset_count"] = 7
        self.assertTrue(any("stable asset" in x for x in self.check()))

    def test_mixed_full_vs_scoped_baseline_totals_fail(self):
        self.delta["candidate_hosts_with_selected_easyprivacy_full_host_rule"] = 3
        self.assertTrue(any("inconsistent delta" in x for x in self.check()))

    def test_silent_candidate_promotion_fails(self):
        self.delta["publication"] = "GO"
        self.assertTrue(any("publication" in x for x in self.check()))
        self.delta["publication"] = "NO_GO"
        self.candidate["publication"] = "GO"
        self.assertTrue(any("owner" in x for x in self.check()))

    def test_drift_is_information_not_fatal_if_pins_unchanged(self):
        self.drift["drift_files"] = 2
        self.assertEqual(self.check(), [])
        self.drift["automatic_source_pin_update"] = True
        self.assertTrue(any("auto-promotion" in x for x in self.check()))

    def test_never_claim_live_site_e2e_pass(self):
        for report in (self.stable, self.candidate, self.delta, self.drift):
            with self.subTest(schema=report["schema"] if "schema" in report else report["record_schema"]):
                report["live_site_e2e"] = "PASS"
                self.assertTrue(any("live-browser" in x for x in self.check()))
                report["live_site_e2e"] = "NOT_RUN"

    def test_subscription_coverage_matrix_is_checked(self):
        # Stable and optional filters have different membership by design.
        self.delta["already_covered_by_local_parent_or_exact"] = 1
        rows = [{"name": name, "covered_by_exact_or_parent": 1,
                 "not_covered_by_exact_or_parent": 3}
                for name in ("ad.txt", "tracking.txt", "v2/ad.txt",
                             "v2/tracking.txt", "v2/strict.txt",
                             "v2/tracking-extra.txt", "stable_combined", "v2_balanced")]
        matrix = {
            "schema": "filter-subscription-coverage/v1",
            "independent_comparison": "PASS",
            "source_host_universe": 4,
            "publication": "NO_GO",
            "live_site_e2e": "NOT_RUN",
            "outputs": rows,
            "proposed_candidate_count": 7,
            "proposed_candidate_evidence": [
                {
                    "host": "candidate-%d.example" % i,
                    "output": "v2/tracking.txt" if i < 3 else "v2/tracking-extra.txt",
                    "selected_easyprivacy_match_shape": None,
                    "adopted_to_stable": False,
                    "real_site_compatibility": "NOT_RUN",
                    "incremental_blocking_value": "NOT_ESTABLISHED"
                } for i in range(7)
            ]
        }
        self.assertEqual(gather(self.stable, self.candidate, self.delta, self.drift,
                                matrix=matrix), [])
        rendered = render(self.stable, self.candidate, self.delta, self.drift,
                          [], matrix=matrix)
        self.assertIn("stable_combined", rendered)
        matrix["outputs"][0]["covered_by_exact_or_parent"] = 2
        self.assertTrue(any("scope coverage" in x for x in
                            gather(self.stable, self.candidate, self.delta, self.drift,
                                   matrix=matrix)))
        matrix["outputs"][0]["covered_by_exact_or_parent"] = 1
        matrix["publication"] = "GO"
        self.assertTrue(any("nonpublishable" in x for x in
                            gather(self.stable, self.candidate, self.delta, self.drift,
                                   matrix=matrix)))
        matrix["publication"] = "NO_GO"
        matrix["outputs"].pop()
        matrix["outputs"].pop()
        self.assertTrue(any("matrix total" in x for x in
                            gather(self.stable, self.candidate, self.delta, self.drift,
                                   matrix=matrix)))

    def test_candidate_row_improper_status_fails_closed(self):
        self.delta["already_covered_by_local_parent_or_exact"] = 1
        rows = [{"name": name, "covered_by_exact_or_parent": 1,
                 "not_covered_by_exact_or_parent": 3}
                for name in ("ad.txt", "tracking.txt", "v2/ad.txt",
                             "v2/tracking.txt", "v2/strict.txt",
                             "v2/tracking-extra.txt", "stable_combined", "v2_balanced")]
        evidence = [
            {"host": "candidate-%d.example" % i,
             "output": "v2/tracking.txt" if i < 3 else "v2/tracking-extra.txt",
             "selected_easyprivacy_match_shape": None,
             "adopted_to_stable": False,
             "real_site_compatibility": "NOT_RUN",
             "incremental_blocking_value": "NOT_ESTABLISHED"} for i in range(7)
        ]
        matrix = {"schema": "filter-subscription-coverage/v1",
                  "independent_comparison": "PASS",
                  "source_host_universe": 4, "publication": "NO_GO",
                  "live_site_e2e": "NOT_RUN",
                  "outputs": rows, "proposed_candidate_count": 7,
                  "proposed_candidate_evidence": evidence}
        self.assertEqual(gather(self.stable, self.candidate, self.delta,
                                self.drift, matrix=matrix), [])
        matrix["proposed_candidate_evidence"][0]["adopted_to_stable"] = True
        self.assertTrue(any("unsafe proposed candidate" in err for err in
                            gather(self.stable, self.candidate, self.delta,
                                   self.drift, matrix=matrix)))

    def test_missing_metadata_fails_closed(self):
        self.delta["candidate_hosts_with_selected_easyprivacy_full_host_rule"] = None
        self.assertTrue(self.check())
        self.drift["sources_checked"] = None
        self.assertTrue(self.check())


if __name__ == "__main__":
    unittest.main()
