from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
STANDARD = ROOT / "japanese-text-softener.txt"
DEEP = ROOT / "japanese-text-softener-deep.txt"
LEGACY_RE = re.compile(
    r"(?:MS\s*P\s*Gothic|ＭＳ\s*Ｐゴシック|MS\s*UI\s*Gothic|ＭＳ\s*ＵＩゴシック)",
    re.I,
)


def active_rules(path: Path):
    return [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
        and not line.lstrip().startswith("!")
        and not line.startswith("[Adblock")
    ]


class JapaneseTextSoftenerTests(unittest.TestCase):
    def test_files_exist(self):
        self.assertTrue(STANDARD.is_file())
        self.assertTrue(DEEP.is_file())

    def test_no_duplicate_active_rules(self):
        for path in (STANDARD, DEEP):
            rules = active_rules(path)
            self.assertEqual(len(rules), len(set(rules)), path.name)

    def test_all_active_rules_are_cosmetic(self):
        for path in (STANDARD, DEEP):
            for rule in active_rules(path):
                self.assertIn("##", rule, f"{path.name}: {rule}")

    def test_procedural_rules_end_in_style_action(self):
        for path in (STANDARD, DEEP):
            for rule in active_rules(path):
                if ":matches-css(" in rule:
                    self.assertIn(":style(", rule, rule)
                    self.assertTrue(rule.endswith(")"), rule)

    def test_style_action_is_font_only_and_important(self):
        for path in (STANDARD, DEEP):
            for rule in active_rules(path):
                if ":style(" in rule:
                    style = rule.rsplit(":style(", 1)[1][:-1]
                    self.assertIn("font-family:", style, rule)
                    self.assertIn("!important", style, rule)

    def test_standard_has_no_broad_procedural_scan(self):
        for rule in active_rules(STANDARD):
            if ":matches-css(" not in rule:
                continue
            subject = rule.split(":matches-css(", 1)[0]
            for forbidden in (",div", " div", "span", "svg", ":is(i,"):
                self.assertNotIn(forbidden, subject, rule)

    def test_fast_path_covers_common_inline_text_containers(self):
        text = STANDARD.read_text(encoding="utf-8")
        self.assertIn(":is(body,main,article,section,div,p,span,h1,h2,h3,h4,h5,h6,blockquote", text)
        self.assertIn("caption,figcaption", text)

    def test_standard_has_legacy_font_face_fast_path(self):
        text = STANDARD.read_text(encoding="utf-8")
        self.assertIn('font[face*="MS PGothic" i]', text)
        self.assertIn('font[face*="MS UI Gothic" i]', text)

    def test_standard_has_japanese_language_gate(self):
        text = STANDARD.read_text(encoding="utf-8")
        self.assertIn("##html:lang(ja)", text)

    def test_deep_includes_standard(self):
        text = DEEP.read_text(encoding="utf-8")
        self.assertIn("!#include japanese-text-softener.txt", text)

    def test_regex_positive_cases(self):
        for value in (
            "MS PGothic",
            "MS P Gothic",
            "ms   p gothic",
            "ＭＳ Ｐゴシック",
            "MS UI Gothic",
            "ms  ui gothic",
            "ＭＳ ＵＩゴシック",
            '"MS PGothic", sans-serif',
        ):
            self.assertRegex(value, LEGACY_RE)

    def test_regex_negative_cases(self):
        for value in (
            "MS Gothic",
            "ＭＳ ゴシック",
            "MS Mincho",
            "MS PMincho",
            "Material Icons",
            "Font Awesome 7 Free",
        ):
            self.assertIsNone(LEGACY_RE.search(value), value)

    def test_required_metadata(self):
        text = STANDARD.read_text(encoding="utf-8")
        for marker in (
            "! Title: Japanese Text Softener",
            "! Subscription: https://raw.githubusercontent.com/r20942097-hue/s/main/japanese-text-softener.txt",
            "! Target: uBlock Origin",
            '"Noto Sans JP"',
        ):
            self.assertIn(marker, text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
