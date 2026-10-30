"""Offline positive/negative controls for scoped synthetic URL research."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from scoped_param_controls import CASES, query, parse_received, verify
from ubol_scoped_param_lab import RULE

class ScopeTests(unittest.TestCase):
    def sample(self):
        return {name: parse_received(path + "?" + query(signed), path, signed)
                for name, path, signed in CASES}

    def test_scoped_filter_not_generic(self):
        self.assertEqual(RULE,
            "||tracking-fixture.test^*/telemetry/collect?$removeparam=utm_source")
        self.assertEqual(len(CASES), 6)
        self.assertIn(("signed_target", "/telemetry/collect", True), CASES)

    def test_synthetic_signed_url_fails_if_utm_is_removed(self):
        original = query(True)
        a = parse_received("/checkout?" + original, "/checkout", True)
        clean = "&".join(x for x in original.split("&")
                         if not x.startswith("utm_source="))
        b = parse_received("/checkout?" + clean, "/checkout", True)
        self.assertTrue(a["valid"])
        self.assertFalse(b["valid"])

    def test_offline_matrix_detects_same_endpoint_hazard(self):
        before, active, after = self.sample(), self.sample(), self.sample()
        active["target"]["utm"] = False
        active["signed_target"]["utm"] = False
        active["signed_target"]["valid"] = False
        self.assertEqual(verify(before, active, after)["same_endpoint_signed"], "BROKEN")
        active["checkout"]["utm"] = False
        with self.assertRaisesRegex(ValueError, "unrelated path"):
            verify(before, active, after)

    def test_missing_target_and_bad_signed_rollback_fail(self):
        before, active, after = self.sample(), self.sample(), self.sample()
        with self.assertRaisesRegex(ValueError, "target not stripped"):
            verify(before, active, after)
        active["target"]["utm"] = False
        after["checkout"]["valid"] = False
        with self.assertRaisesRegex(ValueError, "signed baseline mismatch"):
            verify(before, active, after)

if __name__ == "__main__":
    unittest.main()
