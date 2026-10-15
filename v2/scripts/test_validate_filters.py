import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import validate_filters


def sample(name: str, rule: str) -> str:
    url = validate_filters.EXPECTED[name]
    return "\n".join(
        [
            "[Adblock Plus 2.0]",
            f"! Version: 20261002.1",
            "! Expires: 5 days",
            f"! Subscription: {url}",
            "! License: GPL-3.0-only",
            "! Last reviewed: 2026-10-02",
            rule,
            "",
        ]
    )


class ValidateFiltersTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(validate_filters, "ROOT", self.root)
        self.root_patch.start()

    def tearDown(self):
        self.root_patch.stop()
        self.temp.cleanup()

    def write(self, name: str, content: str) -> None:
        (self.root / name).write_text(content, encoding="utf-8")

    def test_accepts_narrow_third_party_host_rule(self):
        self.write("ad.txt", sample("ad.txt", "||ads.example.com^$third-party"))
        errors, hosts = validate_filters.check_list("ad.txt", validate_filters.EXPECTED["ad.txt"])
        self.assertEqual(errors, [])
        self.assertEqual(hosts, {"ads.example.com"})

    def test_rejects_top_level_or_malformed_host(self):
        self.write("ad.txt", sample("ad.txt", "||com^$third-party"))
        errors, _ = validate_filters.check_list("ad.txt", validate_filters.EXPECTED["ad.txt"])
        self.assertTrue(any("invalid or overly broad host rule" in e for e in errors))

    def test_rejects_first_party_rule(self):
        self.write("ad.txt", sample("ad.txt", "||ads.example.com^"))
        errors, _ = validate_filters.check_list("ad.txt", validate_filters.EXPECTED["ad.txt"])
        self.assertTrue(any("explicitly third-party" in e for e in errors))

    def test_rejects_duplicate_rule(self):
        rule = "||ads.example.com^$third-party"
        self.write("ad.txt", sample("ad.txt", f"{rule}\n{rule}"))
        errors, _ = validate_filters.check_list("ad.txt", validate_filters.EXPECTED["ad.txt"])
        self.assertTrue(any("duplicate rule" in e for e in errors))

    def test_rejects_forceful_modifier(self):
        self.write("ad.txt", sample("ad.txt", "||ads.example.com^$third-party,important"))
        errors, _ = validate_filters.check_list("ad.txt", validate_filters.EXPECTED["ad.txt"])
        self.assertTrue(any("forbidden forceful" in e for e in errors))

    def test_rejects_mismatched_version_date(self):
        body = sample("ad.txt", "||ads.example.com^$third-party").replace("20261002.1", "20260930.1")
        self.write("ad.txt", body)
        errors, _ = validate_filters.check_list("ad.txt", validate_filters.EXPECTED["ad.txt"])
        self.assertTrue(any("version date and last-reviewed date disagree" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
