import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import generate_lists as generation


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads(generation.PROFILE_PATH.read_text())

    def test_duplicate_json_keys_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            json.loads('{"version": "one", "version": "two"}', object_pairs_hook=generation.reject_duplicate_keys)

    def test_profiles_are_valid(self):
        self.assertEqual(generation.validate_profiles(self.data), [])

    def test_checked_in_outputs_are_current(self):
        self.assertEqual(generation.generate(self.data, {'s': generation.ROOT}, check=True), [])

    def test_generation_is_repeatable(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(generation.generate(self.data, {'s': root}), [])
            before = (root / 'ad.txt').read_bytes()
            self.assertEqual(generation.generate(self.data, {'s': root}), [])
            self.assertEqual((root / 'ad.txt').read_bytes(), before)
            self.assertEqual(generation.generate(self.data, {'s': root}, check=True), [])

    def test_license_mixing_is_rejected(self):
        self.data['outputs'][0]['rule_sets'].append('ads-v2')
        errors = generation.validate_profiles(self.data)
        self.assertTrue(any('license' in error for error in errors))

    def test_duplicate_rules_are_rejected(self):
        rules = self.data['rule_sets']['ads-core']['rules']
        rules.append(rules[0])
        self.assertTrue(any('duplicate' in error for error in generation.validate_profiles(self.data)))

    def test_bad_profile_does_not_modify_outputs(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'ad.txt').write_text('keep')
            self.data['outputs'][0]['path'] = '../outside.txt'
            self.assertTrue(generation.generate(self.data, {'s': root}))
            self.assertEqual((root / 'ad.txt').read_text(), 'keep')

    def test_mirror_is_not_written_without_explicit_root(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            generation.generate(self.data, {'s': root})
            self.assertFalse((root / 'browser_filter_lists').exists())

    def test_in_tree_symlink_output_is_rejected(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'target.txt').write_text('keep')
            (root / 'ad.txt').symlink_to('target.txt')
            with self.assertRaises(ValueError):
                generation.generate(self.data, {'s': root})
            self.assertEqual((root / 'target.txt').read_text(), 'keep')

    def test_stale_output_is_detected(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            generation.generate(self.data, {'s': root})
            (root / 'ad.txt').write_text('stale')
            errors = generation.generate(self.data, {'s': root}, check=True)
            self.assertTrue(any('stale generated' in error for error in errors))


if __name__ == '__main__':
    unittest.main()
