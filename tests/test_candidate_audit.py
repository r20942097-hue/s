"""Adversarial tests for opt-in candidate evidence and offline source binding."""
import copy
import hashlib
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import audit_filter_candidates as audit
from generate_lists import validate_profiles


class CandidateAuditTests(unittest.TestCase):
    def setUp(self):
        self.records = audit.read_json(audit.ROOT / "verification/filter-candidates.json")
        self.profiles = audit.read_json(audit.ROOT / "filter-profiles.json")

    def check_error(self, text, records=None, profiles=None, snapshots=None):
        errors, _ = audit.audit(records if records is not None else self.records,
                                profiles if profiles is not None else self.profiles, snapshots)
        self.assertTrue(any(text in x for x in errors), errors)

    def test_default_pass_and_snapshot_explicitly_not_run(self):
        errors, summary = audit.audit(self.records, self.profiles)
        self.assertEqual(errors, [])
        self.assertEqual(summary["metadata"], "PASS")
        self.assertEqual(summary["upstream_snapshot"], "NOT_RUN")
        self.assertEqual(summary["live_site_e2e"], "NOT_RUN")
        self.assertEqual(summary["publication"], "NEEDS_HUMAN")
        self.assertEqual(summary["candidate_count"], 4)
        self.assertEqual(validate_profiles(self.profiles), [])

    def test_duplicate_host_and_unregistered_rule(self):
        record = copy.deepcopy(self.records)
        record["candidates"].append(copy.deepcopy(record["candidates"][0]))
        self.check_error("duplicate evidence host", record)
        self.check_error("does not cover all candidate rules", record)

    def test_non_third_party_or_overbroad_candidate_rejected(self):
        record = copy.deepcopy(self.records)
        record["candidates"][0]["rule"] = "||id5-sync.com^"
        self.check_error("invalid narrowed third-party", record)
        record["candidates"][0]["rule"] = "||id5-sync.com^$third-party,important"
        self.check_error("invalid narrowed third-party", record)

    def test_invalid_host_labels_and_ip_addresses_rejected(self):
        for bad in ("bad..example", "127.0.0.1", "bad-.example", "example"):
            record = copy.deepcopy(self.records)
            record["candidates"][0]["host"] = bad
            record["candidates"][0]["rule"] = "||" + bad + "^$third-party"
            self.check_error("invalid narrowed third-party", record)

    def test_source_path_traversal_and_unapproved_source_rejected(self):
        for unsafe in ("SpywareFilter/sections/../../secrets.txt",
                       "SpywareFilter/sections/other.txt",
                       "SpywareFilter/sections/allowlist.txt/../tracking_servers.txt"):
            record = copy.deepcopy(self.records)
            record["sources"]["tracking"]["path"] = unsafe
            self.check_error("invalid pinned source tracking", record)

    def test_missing_candidate_ruleset_is_a_validation_error_not_crash(self):
        data = copy.deepcopy(self.profiles)
        del data["rule_sets"]["privacy-optional-20261030"]
        self.check_error("invalid candidate rule set/license", profiles=data)

    def test_unknown_source_and_missing_pin_rejected(self):
        record = copy.deepcopy(self.records)
        record["sources"]["tracking"]["repository"] = "other/unknown"
        self.check_error("invalid pinned source tracking", record)
        record["sources"]["tracking"]["repository"] = audit.SOURCE_REPO
        record["sources"]["tracking"]["git_blob_sha"] = "not-a-digest"
        self.check_error("invalid pinned source tracking", record)

    def test_exact_upstream_rule_and_invalid_line_rejected(self):
        record = copy.deepcopy(self.records)
        record["candidates"][1]["line"] = 0
        self.check_error("invalid pinned line evidence", record)
        record["candidates"][1]["line"] = 1959
        record["candidates"][1]["exact_upstream_rule"] = "||other.example^$third-party"
        self.check_error("invalid pinned line evidence", record)

    def test_candidate_cannot_be_promoted_or_change_publication_state(self):
        record = copy.deepcopy(self.records)
        record["governance"]["auto_promote"] = True
        self.check_error("publication / browser safety", record)
        record["governance"]["auto_promote"] = False
        record["governance"]["live_browser_e2e"] = "PASS"
        self.check_error("publication / browser safety", record)

    def test_duplicate_or_parent_rule_elsewhere_is_detected(self):
        data = copy.deepcopy(self.profiles)
        data["rule_sets"]["ads-v2"]["rules"].append("||wetracked.io^$third-party")
        self.check_error("overlaps existing filter family", profiles=data)

    def test_missing_evidence_mapping_and_wrong_license(self):
        data = copy.deepcopy(self.profiles)
        data["rule_sets"]["privacy-optional-20261030"]["rules"].pop()
        self.check_error("does not cover all candidate rules", profiles=data)
        data = copy.deepcopy(self.profiles)
        data["rule_sets"]["privacy-optional-20261030"]["license"] = "CC0-1.0"
        self.check_error("invalid candidate rule set/license", profiles=data)

    def test_candidate_cannot_be_silently_included_in_stable_or_v2_output(self):
        for modification in ("rule_set", "include"):
            with self.subTest(modification=modification):
                data = copy.deepcopy(self.profiles)
                stable = next(item for item in data["outputs"] if item["path"] == "tracking.txt")
                if modification == "rule_set":
                    stable["rule_sets"].append("privacy-optional-20261030")
                else:
                    stable["includes"].append("tracking-extra.txt")
                self.check_error("opt-in candidate must never be included", profiles=data)

    def test_held_item_cannot_be_accepted_without_review(self):
        record = copy.deepcopy(self.records)
        record["held"][0]["host"] = record["candidates"][0]["host"]
        self.check_error("invalid held candidate", record)

    def test_git_blob_identity_uses_git_header_and_detects_tamper(self):
        data = b"test\n"
        target = hashlib.sha1(b"blob 5\x00test\n").hexdigest()
        self.assertEqual(audit.git_blob_sha(data), target)
        self.assertNotEqual(audit.git_blob_sha(b"test\r\n"), target)

    def test_snapshot_detects_wrong_source_blob(self):
        record = copy.deepcopy(self.records)
        record["sources"]["tracking"]["git_blob_sha"] = audit.git_blob_sha(b"not real\n")
        record["sources"]["allowlist"]["git_blob_sha"] = audit.git_blob_sha(b"allowlist\n")
        self.check_error("upstream blob SHA mismatch", record,
                         snapshots={"tracking": b"not real changed\n", "allowlist": b"allowlist\n"})

    def test_snapshot_detects_wrong_line_and_scoped_allowlist_exception(self):
        record = copy.deepcopy(self.records)
        tracking = "\n".join(c["rule"] for c in record["candidates"]) + "\n"
        allowlist = "! no matching exceptions\n"
        record["sources"]["tracking"]["git_blob_sha"] = audit.git_blob_sha(tracking.encode())
        record["sources"]["allowlist"]["git_blob_sha"] = audit.git_blob_sha(allowlist.encode())
        for i, row in enumerate(record["candidates"], 1):
            row["line"] = i
        snapshot = {"tracking": tracking.encode(), "allowlist": allowlist.encode()}
        errors, report = audit.audit(record, self.profiles, snapshot)
        self.assertEqual(errors, [])
        self.assertEqual(report["upstream_snapshot"], "PASS")
        record["candidates"][0]["line"] = 2
        self.check_error("pinned upstream rule/line mismatch", record, snapshots=snapshot)
        record["candidates"][0]["line"] = 1
        allowlist = "@@||id5-sync.com^$domain=example.org\n"
        record["sources"]["allowlist"]["git_blob_sha"] = audit.git_blob_sha(allowlist.encode())
        snapshot["allowlist"] = allowlist.encode()
        self.check_error("selected upstream allowlist contains exception reference", record, snapshots=snapshot)

    def test_record_has_exact_host_scope(self):
        self.assertEqual([x["host"] for x in self.records["candidates"]],
                         ["id5-sync.com", "event.getblue.io", "sync.ebis.ne.jp", "pixel.wetracked.io"])
        self.assertTrue(all(x["rule"].endswith("$third-party") for x in self.records["candidates"]))


if __name__ == "__main__":
    unittest.main()
