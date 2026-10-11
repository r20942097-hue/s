from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from validate_lists import validate

TEMPLATE = """[Adblock Plus 2.0]
! Title: Test
! Version: 20261011.1
! Expires: 5 days
! Homepage: https://example.com/
! Description: Test list
! License: CC0-1.0
||example.com^$third-party
"""


class ListMetadataTests(unittest.TestCase):
    def test_repository_lists(self):
        self.assertEqual(validate(), [])

    def test_include_cycle_is_rejected(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_text(TEMPLATE + "!#include b.txt\n")
            (root / "b.txt").write_text(TEMPLATE + "!#include a.txt\n")
            self.assertTrue(any("include cycle" in e for e in validate(root)))

    def test_parent_include_is_rejected(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_text(TEMPLATE + "!#include ../outside.txt\n")
            self.assertTrue(any("invalid or missing include" in e for e in validate(root)))

    def test_missing_include_is_rejected(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_text(TEMPLATE + "!#include missing.txt\n")
            self.assertTrue(any("invalid or missing include" in e for e in validate(root)))

    def test_duplicate_rule_and_invalid_date_are_rejected(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_text(TEMPLATE.replace("20261011", "20261340") + "||example.com^$third-party\n")
            errors = validate(root)
            self.assertTrue(any("invalid version date" in e for e in errors))
            self.assertTrue(any("duplicate active rule" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
