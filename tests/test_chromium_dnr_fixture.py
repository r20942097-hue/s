"""Offline checks for ephemeral MV3 DNR fixture: never ship test extension."""
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from chromium_dnr_fixture import build_extension


class LocalDNRFixtureTests(unittest.TestCase):
    def test_extension_contains_only_local_and_thirdparty_scoped_rule(self):
        with TemporaryDirectory() as temp:
            root = Path(temp) / "temporary"
            build_extension(root, 45678)
            manifest = json.loads((root / "manifest.json").read_text())
            rules = json.loads((root / "rules.json").read_text())
            self.assertEqual(manifest["manifest_version"], 3)
            self.assertEqual(len(manifest["declarative_net_request"]["rule_resources"]), 1)
            self.assertNotIn("host_permissions", manifest)
            self.assertEqual(manifest["permissions"], ["declarativeNetRequest"])
            self.assertEqual(len(rules), 1)
            rule = rules[0]
            self.assertEqual(rule["action"]["type"], "block")
            self.assertEqual(rule["condition"]["domainType"], "thirdParty")
            self.assertEqual(rule["condition"]["resourceTypes"], ["image"])
            self.assertEqual(rule["condition"]["urlFilter"], "|http://127.0.0.1:45678/beacon")
            self.assertEqual(set(x.name for x in root.iterdir()),
                             {"manifest.json", "rules.json", "background.js"})

    def test_cannot_overwrite_existing_extension_dir(self):
        with TemporaryDirectory() as temp:
            root = Path(temp) / "temporary"
            root.mkdir()
            with self.assertRaises(FileExistsError):
                build_extension(root, 45678)

    def test_no_production_filter_rule_or_url_in_test_fixture(self):
        with TemporaryDirectory() as temp:
            root = Path(temp) / "temporary"
            build_extension(root, 45678)
            text = (root / "rules.json").read_text() + (root / "manifest.json").read_text()
            self.assertNotIn("githubusercontent", text)
            self.assertNotIn("id5-sync", text)
            self.assertNotIn("easyprivacy", text)
            self.assertNotIn("tabs", text)


if __name__ == "__main__":
    unittest.main()
