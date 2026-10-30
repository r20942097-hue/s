"""Independent upstream trust boundary; deterministic, network-free regression tests."""
import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from audit_filter_candidates import ROOT, read_json
from independent_baseline import (
    fetch_baselines, git_blob_sha, observed_network_hosts, observed_reference,
    validate_baselines
)
from scan_upstream_delta import scan


class IndependentBaselineTests(unittest.TestCase):
    def setUp(self):
        self.info = read_json(ROOT / "verification/filter-independent-baselines.json")
        self.profiles = read_json(ROOT / "filter-profiles.json")
        self.candidates = read_json(ROOT / "verification/filter-candidates.json")

    def test_registered_sources_and_governance(self):
        validate_baselines(self.info)
        self.assertFalse(self.info["auto_promote"])
        self.assertEqual(self.info["live_site_e2e"], "NOT_RUN")

    def test_wrong_repository_and_path_rejected(self):
        for key, value in (("repository", "example/evil"),
                           ("path", "easyprivacy/../secret"),
                           ("git_blob_sha", "not-a-hash")):
            with self.subTest(key=key):
                info = copy.deepcopy(self.info)
                info["sources"][0][key] = value
                with self.assertRaises(ValueError):
                    validate_baselines(info)

    def test_duplicate_baseline_file_and_mixed_commits_rejected(self):
        info = copy.deepcopy(self.info)
        info["sources"][1]["path"] = info["sources"][0]["path"]
        with self.assertRaises(ValueError):
            validate_baselines(info)
        info = copy.deepcopy(self.info)
        info["sources"][1]["commit"] = "f"*40
        with self.assertRaises(ValueError):
            validate_baselines(info)

    def test_auto_promotion_and_missing_source_rejected(self):
        info = copy.deepcopy(self.info)
        info["auto_promote"] = True
        with self.assertRaises(ValueError):
            validate_baselines(info)
        info = copy.deepcopy(self.info)
        info["sources"].pop()
        with self.assertRaises(ValueError):
            validate_baselines(info)

    def test_tampered_or_oversized_snapshot_rejected(self):
        data = {
            self.info["sources"][0]["path"]: b"||match.test^$third-party\n",
            self.info["sources"][1]["path"]: b"||region.test^$third-party\n"
        }
        info = copy.deepcopy(self.info)
        for row in info["sources"]:
            row["git_blob_sha"] = git_blob_sha(data[row["path"]])
        result = fetch_baselines(info, retrieve=lambda uri: next(
            value for path, value in data.items() if uri.endswith(path)))
        self.assertEqual(len(result), 2)
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            fetch_baselines(info, retrieve=lambda uri: b"changed\n")
        with self.assertRaisesRegex(ValueError, "oversized"):
            fetch_baselines(info, retrieve=lambda uri: b"0"*1_000_001)

    def test_only_network_rules_are_observed(self):
        sources = {
            "easyprivacy/easyprivacy_trackingservers_thirdparty.txt":
                "||parent.example^$third-party\n@@||allowed.example^\n! ||comment.example^\nfoo.example##.ad\n",
            "easyprivacy/easyprivacy_trackingservers_international.txt":
                "||regional.example^$third-party\n"
        }
        observed = observed_network_hosts(sources)
        self.assertEqual(observed_reference("sub.parent.example", observed),
                         "easyprivacy/easyprivacy_trackingservers_thirdparty.txt")
        self.assertIsNone(observed_reference("allowed.example", observed))
        self.assertIsNone(observed_reference("foo.example", observed))
        self.assertIsNone(observed_reference("just-another.example", observed))

    def test_independent_paths_and_types_do_not_imply_full_host_block(self):
        from independent_baseline import observed_scope
        paths = [source["path"] for source in self.info["sources"]]
        data = {
            paths[0]: ("||script-only.example^$third-party,script\n"
                       "||path-only.example/tracker$third-party\n"
                       "||unrestricted.example^$third-party\n"
                       "||entire.example^\n"),
            paths[1]: "||sub.from-parent.example^$third-party\n"
        }
        observed = observed_network_hosts(data)
        self.assertEqual(observed_scope("script-only.example", observed)["scope"], "restricted")
        self.assertEqual(observed_scope("path-only.example", observed)["scope"], "restricted")
        self.assertEqual(observed_scope("unrestricted.example", observed)["scope"], "full")
        self.assertEqual(observed_scope("cdn.entire.example", observed)["scope"], "full")
        self.assertIsNone(observed_scope("from-parent.example", observed))

    def test_scoped_baseline_observation_is_not_full_scope_block(self):
        paths = [source["path"] for source in self.info["sources"]]
        baseline = {
            paths[0]: "||restricted-observation.example/path$third-party\n",
            paths[1]: "||full-observation.example^$third-party\n"
        }
        report = scan(
            self.profiles, self.candidates,
            "||restricted-observation.example^$third-party\n"
            "||full-observation.example^$third-party\n"
            "||not-observed.example^$third-party\n",
            "", baseline_sources=baseline
        )
        self.assertEqual(report["candidate_hosts_also_observed_in_selected_easyprivacy"], 2)
        self.assertEqual(report["candidate_hosts_with_selected_easyprivacy_full_host_rule"], 1)
        self.assertEqual(report["candidate_hosts_with_selected_easyprivacy_scoped_rule_only"], 1)
        grouped = {row["host"]: row for row in report["queue"]}
        self.assertEqual(grouped["restricted-observation.example"]["selected_independent_easyprivacy_scope"], "restricted")
        self.assertEqual(grouped["full-observation.example"]["selected_independent_easyprivacy_scope"], "full")
        self.assertIsNone(grouped["not-observed.example"]["selected_independent_easyprivacy_scope"])

    def test_crosscheck_categorization_without_adopting(self):
        paths = [source["path"] for source in self.info["sources"]]
        sources = {
            paths[0]: "||sub-idsync.example^$third-party\n",
            paths[1]: "||regional-sync.example^$third-party\n"
        }
        report = scan(
            self.profiles, self.candidates,
            "||sub-idsync.example^$third-party\n||fresh-choice.example^$third-party\n",
            "", limit=10, baseline_sources=sources
        )
        self.assertEqual(report["selected_independent_easyprivacy_comparison"], "PASS")
        self.assertEqual(report["candidate_hosts_also_observed_in_selected_easyprivacy"], 1)
        self.assertEqual(report["candidate_hosts_not_observed_in_selected_easyprivacy"], 1)
        self.assertEqual(report["publication"], "NO_GO")
        by_host = {item["host"]: item for item in report["queue"]}
        self.assertEqual(by_host["sub-idsync.example"]["selected_independent_easyprivacy_reference"], paths[0])
        self.assertIsNone(by_host["fresh-choice.example"]["selected_independent_easyprivacy_reference"])

    def test_crosscheck_not_run_is_explicit(self):
        r = scan(self.profiles, self.candidates,
                 "||independent-unchecked.example^$third-party", "")
        self.assertEqual(r["selected_independent_easyprivacy_comparison"], "NOT_RUN")
        self.assertIsNone(r["candidate_hosts_also_observed_in_selected_easyprivacy"])

    def test_incomplete_crosscheck_not_a_pass(self):
        with self.assertRaises(ValueError):
            scan(self.profiles, self.candidates, "", "", baseline_sources={
                "easyprivacy/easyprivacy_trackingservers_thirdparty.txt": "||a.example^$third-party"
            })


if __name__ == "__main__":
    unittest.main()
