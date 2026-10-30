"""Regression tests for retained tracking protection and nonduplicate admission."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from audit_filter_candidates import ROOT
from generate_lists import render
from check_tracking_protection import audit, POLICY_PATH, PROFILES_PATH, EVIDENCE_PATH


class TrackingProtectionTests(unittest.TestCase):
    def setUp(self):
        self.profiles = json.loads(PROFILES_PATH.read_text(encoding="utf-8"))
        self.policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        self.evidence = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))
        self.rendered = {
            row["path"]: render(self.profiles, row)
            for row in self.profiles["outputs"]
            if row.get("scope") == "s"
            and row.get("path") in ("tracking.txt", "v2/tracking.txt", "v2/tracking-extra.txt")
        }

    def audit(self):
        return audit(self.profiles, self.policy, self.evidence, self.rendered)

    def test_tracking_protection_stays_active_without_redundant_experimental_rules(self):
        errors, result = self.audit()
        self.assertEqual(errors, [])
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["tracking_core_rule_count"], 9)
        self.assertEqual(result["tracking_v2_rule_count"], 38)
        self.assertEqual(result["active_experimental_rule_count"], 0)
        self.assertEqual(result["stock_overlaps_quarantined"], 7)
        self.assertEqual(result["publication"], "NO_GO")

    def test_losing_analytics_or_session_replay_rule_fails(self):
        self.profiles["rule_sets"]["privacy-core"]["rules"].remove(
            "||hotjar.com^$third-party")
        self.assertTrue(any("lost its active filter rules" in x for x in self.audit()[0]))

    def test_losing_ad_measurement_or_beacon_rule_fails(self):
        self.profiles["rule_sets"]["privacy-v2"]["rules"].remove(
            "||beacon.geniee.jp^$third-party")
        self.assertTrue(any("lost its active filter rules" in x for x in self.audit()[0]))

    def test_reintroducing_stock_overlap_is_rejected(self):
        self.profiles["rule_sets"]["privacy-v2"]["rules"].append(
            "||sync.adkernel.com^$third-party")
        self.assertTrue(any("archived stock-overlap" in x for x in self.audit()[0]))

    def test_quarantine_cannot_gain_active_rules(self):
        self.profiles["rule_sets"]["privacy-optional-20261030"]["rules"].append(
            "||new-unreviewed-host.example^$third-party")
        self.assertTrue(any("quarantined stock-overlap rules are active" in x
                            for x in self.audit()[0]))

    def test_stale_or_empty_generated_tracking_fails(self):
        self.rendered["v2/tracking.txt"] = ""
        self.assertTrue(any("generated file differs" in x for x in self.audit()[0]))

    def test_policy_cannot_claim_unverified_privacy_features(self):
        self.policy["additional_privacy_elements"][0]["state"] = "PASS"
        self.assertTrue(any("unsupported or misreported" in x for x in self.audit()[0]))

    def test_policy_cannot_waive_baseline_dedup_or_live_compatibility(self):
        self.policy["candidate_rule_rules"]["require_baseline_overlap_check"] = False
        self.assertTrue(any("missing anti-duplication" in x for x in self.audit()[0]))
        self.policy["candidate_rule_rules"]["require_baseline_overlap_check"] = True
        self.policy["candidate_rule_rules"]["require_live_site_compatibility_before_release"] = False
        self.assertTrue(any("missing anti-duplication" in x for x in self.audit()[0]))

    def test_policy_cannot_claim_publication_or_live_e2e(self):
        self.policy["release"] = "GO"
        self.assertTrue(any("invalid or unsafe" in x for x in self.audit()[0]))
        self.policy["release"] = "NO_GO"
        self.policy["live_site_e2e"] = "PASS"
        self.assertTrue(any("invalid or unsafe" in x for x in self.audit()[0]))

    def test_no_tracking_output_can_be_repointed_to_ads(self):
        for output in self.profiles["outputs"]:
            if output["path"] == "v2/tracking.txt":
                output["rule_sets"] = ["ads-v2"]
        self.assertTrue(any("missing/altered tracking protection output" in x
                            for x in self.audit()[0]))


if __name__ == "__main__":
    unittest.main()
