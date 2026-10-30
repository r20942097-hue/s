"""Safety guards for nonpublished URL modifier lab."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ubol_param_import_lab import RULE, TEST_PAYLOAD, subset, check_import
from ubol_local_param_http_probe import build_urls


class URLModifierLabTests(unittest.TestCase):
    def test_lab_rule_exactly_one_and_never_published(self):
        lines = [line for line in TEST_PAYLOAD.decode("utf-8").splitlines()
                 if line and not line.startswith("!")]
        self.assertEqual(lines, [RULE])
        self.assertEqual(RULE, "*$removeparam=utm_source")
        self.assertNotIn("fbclid", TEST_PAYLOAD.decode("utf-8"))

    def test_signed_url_and_oauth_controls_are_present(self):
        rows = subset(build_urls(9001))
        keys = {r["key"] for r in rows}
        self.assertEqual(keys, {
            "utm_source", "fbclid", "gclid", "state", "code", "X-Amz-Signature"
        })
        self.assertEqual(len(rows), 6)

    def test_import_rejects_unaccepted_disabled_or_missing_modifier(self):
        url = "http://127.0.0.1:12345/candidate-list.txt"
        valid = {"id": url, "enabled": True, "filters": {"accepted": 1},
                 "rules": {"redirect": 1}}
        self.assertEqual(check_import([valid], url, 1)["accepted"], 1)
        for rows in ([], [{**valid, "enabled": False}],
                     [{**valid, "filters": {"accepted": 0}}],
                     [valid, valid]):
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "registered exactly once|accept/enable"):
                check_import(rows, url, 1)


if __name__ == "__main__":
    unittest.main()
