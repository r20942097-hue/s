"""Offline regression tests for published subscription compatibility."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from check_subscription_contract import BASE, PUBLIC, check, check_path, main, required_license


class SubscriptionContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in PUBLIC:
            self.put(name)

    def put(self, name, *, license=None, subscription=True, last_newline=True):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        content = ("[Adblock Plus 2.0]\n! Title: Test\n! License: "
                   + (license or required_license(name)) + "\n! Homepage: https://github.com/r20942097-hue/s\n")
        if subscription:
            content += "! Subscription: " + BASE + name + "\n"
        content += "example.org##.test\n"
        p.write_text(content if last_newline else content.rstrip("\n"), encoding="utf-8")

    def test_good_contract(self):
        self.assertEqual(check(self.root)["status"], "PASS")

    def test_nine_published_paths(self):
        self.assertEqual(len(PUBLIC), 9)

    def test_missing_file(self):
        (self.root / "ad.txt").unlink()
        self.assertIn("ad.txt", check(self.root)["issues"])

    def test_directory_instead_of_file(self):
        (self.root / "tracking.txt").unlink()
        (self.root / "tracking.txt").mkdir()
        self.assertIn("tracking.txt", check(self.root)["issues"])

    def test_bad_license(self):
        self.put("v2/ad.txt", license="CC0-1.0")
        self.assertIn("license metadata mismatch", check_path(self.root, "v2/ad.txt"))

    def test_missing_optional_subscription_header_allowed(self):
        self.put("ad-ubo.txt", subscription=False)
        self.assertEqual(check_path(self.root, "ad-ubo.txt"), [])

    def test_subscription_url_change_rejected(self):
        p = self.root / "ad.txt"
        p.write_text(p.read_text().replace(BASE, "https://example.com/"))
        self.assertIn("missing or changed subscription URL metadata", check_path(self.root, "ad.txt"))

    def test_required_subscription_header_removed(self):
        self.put("ad.txt", subscription=False)
        self.assertIn("missing or changed subscription URL metadata",
                      check_path(self.root, "ad.txt"))

    def test_deep_profile_header_removed(self):
        self.put("japanese-text-softener-deep.txt", subscription=False)
        self.assertIn("missing or changed subscription URL metadata",
                      check_path(self.root, "japanese-text-softener-deep.txt"))

    def test_missing_newline(self):
        self.put("ad.txt", last_newline=False)
        self.assertIn("missing trailing newline", check_path(self.root, "ad.txt"))

    def test_bad_adblock_header(self):
        p = self.root / "ad.txt"
        p.write_text(p.read_text().replace("[Adblock Plus 2.0]", "[Other]"))
        self.assertIn("missing Adblock Plus header", check_path(self.root, "ad.txt"))

    def test_linked_public_file(self):
        p = self.root / "ad.txt"
        p.unlink()
        try:
            p.symlink_to(self.root / "tracking.txt")
        except (OSError, NotImplementedError):
            self.skipTest("symlink unsupported")
        self.assertIn("symbolic link or linked ancestor", check_path(self.root, "ad.txt"))

    def test_linked_v2_ancestor(self):
        p = self.root / "v2"
        external = self.root / "outside"
        p.rename(external)
        try:
            p.symlink_to(external, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink unsupported")
        self.assertIn("symbolic link or linked ancestor", check_path(self.root, "v2/ad.txt"))

    def test_duplicate_license(self):
        p = self.root / "ad.txt"
        p.write_text(p.read_text() + "! License: CC0-1.0\n")
        self.assertIn("license metadata mismatch", check_path(self.root, "ad.txt"))

    def test_cli_good(self):
        with patch("builtins.print"):
            self.assertEqual(main(["--root", str(self.root), "--json"]), 0)

    def test_cli_bad(self):
        (self.root / "ad.txt").unlink()
        with patch("builtins.print"):
            self.assertEqual(main(["--root", str(self.root)]), 1)


if __name__ == "__main__":
    unittest.main()
