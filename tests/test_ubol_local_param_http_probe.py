"""Offline controls for real loopback HTTP query probe; no external network."""
from pathlib import Path
import sys
import unittest
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ubol_local_param_http_probe import build_urls, compare, server, TRACKING, PRESERVE, HOST


class LocalQueryHttpTests(unittest.TestCase):
    def test_only_reserved_host_and_synthetic_params(self):
        rows = build_urls(8765)
        self.assertEqual(len(rows), len(TRACKING) + len(PRESERVE))
        self.assertEqual([r["key"] for r in rows], list(TRACKING + PRESERVE))
        self.assertTrue(all(r["url"].startswith("http://" + HOST + ":8765/fixture?")
                            and "synthetic-value" in r["url"] for r in rows))

    def test_loopback_http_records_only_local_request(self):
        with server() as fixture:
            url = f"http://127.0.0.1:{fixture.server_port}/fixture?state=synthetic-value&keep=ok"
            with urlopen(url, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(b"fixture-ok", response.read())
            self.assertEqual(len(fixture.paths), 1)
            self.assertTrue(fixture.paths[0].endswith("state=synthetic-value&keep=ok"))

    def test_real_http_diff_distinguishes_cleaned_tracking_from_preserved_auth(self):
        before = [{"key": k, "category": "TRACKING_REVIEW" if k in TRACKING else "MUST_PRESERVE",
                   "parameter_present": True, "parameter_missing": False,
                   "safe_control_preserved": True} for k in TRACKING + PRESERVE]
        after = [dict(item) for item in before]
        after[0]["parameter_present"] = False
        after[0]["parameter_missing"] = True
        verdict = compare(before, after)
        self.assertTrue(verdict[0]["with_stock_ubol_removed"])
        self.assertTrue(all(x["incremental_value_of_proposed_rules"] == "NOT_ESTABLISHED"
                            and x["real_public_site_e2e"] == "NOT_RUN" for x in verdict))

    def test_real_http_refuses_auth_or_signature_removal(self):
        before = [{"key": k, "category": "TRACKING_REVIEW" if k in TRACKING else "MUST_PRESERVE",
                   "parameter_present": True, "parameter_missing": False,
                   "safe_control_preserved": True} for k in TRACKING + PRESERVE]
        after = [dict(item) for item in before]
        after[-1]["parameter_present"] = False
        after[-1]["parameter_missing"] = True
        with self.assertRaisesRegex(ValueError, "damaged signed/auth"):
            compare(before, after)

    def test_no_baseline_or_broken_controls_is_rejected(self):
        before = [{"key": k, "category": "TRACKING_REVIEW" if k in TRACKING else "MUST_PRESERVE",
                   "parameter_present": True, "parameter_missing": False,
                   "safe_control_preserved": True} for k in TRACKING + PRESERVE]
        after = [dict(item) for item in before]
        with self.assertRaisesRegex(ValueError, "missing"):
            compare(before[:-1], after)
        before[0]["parameter_present"] = False
        with self.assertRaisesRegex(ValueError, "not reliable"):
            compare(before, after)


if __name__ == "__main__":
    unittest.main()
