"""Unit tests for pinned-source freshness checks; network-free."""
import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from audit_filter_candidates import ROOT, read_json, git_blob_sha
from check_upstream_drift import assess_sources, sources_to_check, BRANCHES


class UpstreamDriftTests(unittest.TestCase):
    def setUp(self):
        self.candidate = read_json(ROOT / "verification/filter-candidates.json")
        self.independent = read_json(ROOT / "verification/filter-independent-baselines.json")

    def test_valid_sources_exactly_four_and_no_mutation(self):
        before = copy.deepcopy((self.candidate, self.independent))
        sources = sources_to_check(self.candidate, self.independent)
        self.assertEqual(len(sources), 4)
        self.assertEqual((self.candidate, self.independent), before)
        self.assertEqual(len({(x["repository"], x["path"]) for x in sources}), 4)

    def test_missing_or_unauthorized_sources_fail_closed(self):
        candidate = copy.deepcopy(self.candidate)
        del candidate["sources"]["tracking"]
        with self.assertRaises(ValueError):
            sources_to_check(candidate, self.independent)
        independent = copy.deepcopy(self.independent)
        independent["sources"][0]["path"] = "../secrets"
        with self.assertRaises(ValueError):
            sources_to_check(self.candidate, independent)

    def test_unchanged_content_vs_changed_pins_is_explicit(self):
        c = copy.deepcopy(self.candidate)
        i = copy.deepcopy(self.independent)
        payloads = {}
        rows = sources_to_check(c, i)
        for index, row in enumerate(rows):
            payload = ("record-%d\n" % index).encode()
            row["git_blob_sha"] = git_blob_sha(payload)
            payloads[row["path"]] = payload
        heads = {key: str(index+1)*40 for index, key in enumerate(BRANCHES)}
        def current_head(repo, branch):
            self.assertEqual(BRANCHES[repo], branch)
            return heads[repo]
        def current_file(uri):
            return next(value for path, value in payloads.items() if uri.endswith("/" + path))
        report = assess_sources(c, i, current_head, current_file)
        self.assertEqual(report["sources_checked"], 4)
        self.assertEqual(report["drift_files"], 0)
        self.assertFalse(report["automatic_source_pin_update"])
        self.assertEqual(report["publication"], "NO_GO")
        self.assertTrue(all(x["rule_adoption"] == "FORBIDDEN" for x in report["files"]))
        self.assertEqual({x["observed_head"] for x in report["files"]}, set(heads.values()))
        drift_uri = "/" + rows[0]["path"]
        report = assess_sources(c, i, current_head,
                                lambda uri: b"modified\n" if uri.endswith(drift_uri) else current_file(uri))
        self.assertEqual(report["drift_files"], 1)
        self.assertEqual(report["up_to_date_contents"], 3)
        self.assertEqual(sum(x["status"] == "DRIFT_OBSERVED" for x in report["files"]), 1)
        self.assertFalse(report["automatic_source_pin_update"])

    def test_invalid_branch_sha_and_oversized_response_fails(self):
        with self.assertRaisesRegex(ValueError, "invalid upstream branch head"):
            assess_sources(self.candidate, self.independent,
                           lambda repo, branch: "not-a-sha",
                           lambda uri: b"unused")
        with self.assertRaisesRegex(ValueError, "invalid upstream content"):
            assess_sources(self.candidate, self.independent,
                           lambda repo, branch: "f"*40,
                           lambda uri: b"x"*4_000_001)

    def test_path_not_taken_from_untrusted_source(self):
        c = copy.deepcopy(self.candidate)
        c["sources"]["tracking"]["repository"] = "attacker/other"
        with self.assertRaisesRegex(ValueError, "invalid tracking/allowlist"):
            assess_sources(c, self.independent, lambda repo, branch: "f"*40, lambda uri: b"unused")

    def test_immutable_head_used_for_file_not_moving_branch_name(self):
        uri_values = []
        def read_blob(uri):
            uri_values.append(uri)
            return b"source bytes\n"
        assess_sources(self.candidate, self.independent,
                       lambda repo, branch: "b"*40, read_blob)
        self.assertEqual(len(uri_values), 4)
        self.assertTrue(all("/" + "b"*40 + "/" in uri for uri in uri_values))
        self.assertTrue(all("/master/" not in uri for uri in uri_values))


if __name__ == "__main__":
    unittest.main()
