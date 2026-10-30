"""No real-site success or publication from scoped fixture output."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from verify_scoped_param_lab import audit

class ScopeReportTests(unittest.TestCase):
    def setUp(self):
        self.doc = {"schema": "filter-scoped-param-lab/v1",
                    "result": "PASS", "publication": "NO_GO",
                    "published_rules": 0, "real_firefox_ubo": "NOT_RUN",
                    "real_site_e2e": "NOT_RUN",
                    "observations": {
                        "target": "PRESENT_REMOVED_RESTORED",
                        "other_paths": "PRESERVED",
                        "other_signed_urls": "PRESERVED",
                        "signed_before_after": "PASS",
                        "same_endpoint_signed": "BROKEN", "real_site": "NOT_RUN"}}
    def test_controlled_report(self):
        self.assertEqual(audit(self.doc), [])
    def test_incomplete_or_misleading_report(self):
        for category, key, wrong in (
            ("observations", "target", "PRESENT"),
            ("observations", "other_signed_urls", "BROKEN"),
            ("observations", "real_site", "PASS"),
            ("observations", "same_endpoint_signed", "UNKNOWN"),
            ("top", "publication", "GO"),
            ("top", "real_site_e2e", "PASS")):
            with self.subTest(key=key, wrong=wrong):
                obj = self.doc if category == "top" else self.doc["observations"]
                original = obj[key]
                obj[key] = wrong
                self.assertTrue(audit(self.doc))
                obj[key] = original

if __name__ == "__main__":
    unittest.main()
