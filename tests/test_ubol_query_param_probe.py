"""Negative controls and epistemic safety for query-parameter stock DNR probe."""
from pathlib import Path
import sys
import unittest
from urllib.parse import urlsplit, parse_qsl

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ubol_query_param_probe import cases, summarize, TRACKING, PRESERVE, KINDS


class QueryParameterProbeTests(unittest.TestCase):
    def setUp(self):
        self.rows = cases()
        self.observed = {
            "status": "OBSERVED", "cases": [
                {"index": i, "phase": phase,
                 "request_type": row["request_type"],
                 "host": urlsplit(row["url"]).hostname,
                 "matched_rules": [],
                 "block_action_count": 0, "unresolved_actions": 0}
                for i, row in enumerate(self.rows)
                for phase in ("with_param", "without_param")
            ]
        }

    def test_corpus_has_tracking_and_critical_url_controls(self):
        self.assertEqual(len(self.rows), (len(TRACKING) + len(PRESERVE)) * len(KINDS))
        self.assertEqual(len(set((x["key"], x["request_type"]) for x in self.rows)), len(self.rows))
        for row in self.rows:
            self.assertEqual(row["class"] == "MUST_PRESERVE", row["key"] in PRESERVE)
            query = dict(parse_qsl(urlsplit(row["url"]).query))
            self.assertEqual(query[row["key"]], "synthetic-value")
            self.assertEqual(query["keep"], "ok")
            self.assertEqual(dict(parse_qsl(urlsplit(row["baseline_url"]).query)), {"keep": "ok"})
            self.assertTrue(row["url"].startswith("https://"))
            self.assertTrue(row["request_type"] in KINDS)

    def test_no_match_is_not_claimed_cleaned_or_safe(self):
        results = summarize(self.rows, self.observed)
        self.assertTrue(all(r["stock_dnr_verdict"] == "NO_STOCK_REDIRECT_MATCH_IN_TESTED_SHAPE"
                            for r in results))
        self.assertTrue(all(r["actual_query_stripping"] == "NOT_TESTED"
                            and r["safe_for_signed_urls"] == "NOT_ESTABLISHED"
                            and r["suggest_addition"] is False for r in results))

    def test_redirect_match_is_not_removal_proof(self):
        first = self.observed["cases"][0]
        first["matched_rules"] = [{"action_type": "redirect"}]
        results = summarize(self.rows, self.observed)
        self.assertEqual(results[0]["stock_dnr_verdict"],
                         "STOCK_REDIRECT_RULE_MATCH_NOT_REMOVAL_PROOF")
        self.assertFalse(results[0]["suggest_addition"])

    def test_destination_block_not_confused_with_parameter_stripping(self):
        first = self.observed["cases"][0]
        first["matched_rules"] = [{"action_type": "block"}]
        first["block_action_count"] = 1
        self.assertEqual(summarize(self.rows, self.observed)[0]["stock_dnr_verdict"],
                         "DESTINATION_BLOCKED_OR_PARTLY_BLOCKED")

    def test_unknown_actions_do_not_create_false_gap(self):
        first = self.observed["cases"][0]
        first["unresolved_actions"] = 1
        self.assertEqual(summarize(self.rows, self.observed)[0]["stock_dnr_verdict"],
                         "INDETERMINATE")

    def test_missing_duplicate_or_wrong_context_fails_closed(self):
        self.observed["cases"].pop()
        with self.assertRaisesRegex(ValueError, "missing"):
            summarize(self.rows, self.observed)
        self.setUp()
        self.observed["cases"][-1]["index"] = 0
        with self.assertRaisesRegex(ValueError, "duplicate"):
            summarize(self.rows, self.observed)
        self.setUp()
        self.observed["cases"][0]["host"] = "other.example"
        with self.assertRaisesRegex(ValueError, "shape inconsistent"):
            summarize(self.rows, self.observed)

    def test_no_actual_http_or_personal_data_in_corpus(self):
        self.assertEqual(set(TRACKING), {"utm_source", "utm_campaign", "fbclid", "gclid", "msclkid"})
        self.assertTrue({"state", "code", "token", "redirect_uri", "X-Amz-Signature"} <= set(PRESERVE))
        self.assertTrue(all("synthetic-value" in x["url"]
                            and "keep=ok" in x["url"] for x in self.rows))


if __name__ == "__main__":
    unittest.main()
