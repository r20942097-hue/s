"""Safety guards for nonpublished URL modifier lab."""
from pathlib import Path
import hashlib
import hmac
from urllib.parse import urlencode
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ubol_param_import_lab import RULE, TEST_PAYLOAD, subset, check_import, fixture_signature_check
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

    def test_signed_url_fails_when_global_modifier_strips_signed_utm(self):
        data = urlencode((("utm_source", "synthetic"), ("keep", "ok")))
        signature = hmac.new(b"isolated-fixture-test-key", data.encode(),
                             hashlib.sha256).hexdigest()
        before = "/fixture?" + data + "&X-Amz-Signature=" + signature
        self.assertTrue(fixture_signature_check(before)["signature_valid"])
        self.assertTrue(fixture_signature_check(before)["utm_source_present"])
        after = "/fixture?keep=ok&X-Amz-Signature=" + signature
        self.assertFalse(fixture_signature_check(after)["signature_valid"])
        self.assertTrue(fixture_signature_check(after)["signature_preserved"])
        self.assertFalse(fixture_signature_check(after)["utm_source_present"])
        self.assertTrue(fixture_signature_check(before)["signature_valid"])

    def test_duplicate_signed_fixture_keys_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "malformed"):
            fixture_signature_check("/fixture?utm_source=a&utm_source=b")

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
