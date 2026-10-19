import copy
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

    def test_embedded_line_breaks_cannot_inject_rules_through_metadata(self):
        for separator in ['\r', '\n', '\v', '\f', '\x85', '\u2028', '\u2029', '\x00']:
            for field in ['label', 'header']:
                with self.subTest(separator=repr(separator), field=field), TemporaryDirectory() as tmp:
                    data = copy.deepcopy(self.data)
                    injected = 'fixture' + separator + '||unreviewed.example^$third-party'
                    if field == 'label':
                        data['rule_sets']['ads-core']['label'] = injected
                    else:
                        data['outputs'][0]['headers'].append('! Note: ' + injected)
                    root = Path(tmp)
                    (root / 'ad.txt').write_text('keep')
                    self.assertTrue(generation.generate(data, {'s': root}))
                    self.assertEqual((root / 'ad.txt').read_text(), 'keep')

    def test_rule_paths_cannot_inject_a_second_line_or_controls(self):
        for separator in ['\n', '\r', '\t', '\0', '\x7f', '\x80', '\x85', '\x9f', '\u2028', '\u2029']:
            with self.subTest(separator=repr(separator)), TemporaryDirectory() as tmp:
                data = copy.deepcopy(self.data)
                data['rule_sets']['ads-core']['rules'][0] = '||doubleclick.net/path' + separator + '||unreviewed.example^$third-party'
                root = Path(tmp)
                (root / 'ad.txt').write_text('keep')
                self.assertTrue(generation.generate(data, {'s':root}))
                self.assertEqual((root / 'ad.txt').read_text(), 'keep')
                self.assertEqual(len(list(root.iterdir())), 1)

    def test_c1_controls_are_invalid_in_labels_and_headers(self):
        for character in ['\x80', '\x90', '\x9f']:
            for field in ['label', 'header']:
                with self.subTest(character=repr(character), field=field):
                    data = copy.deepcopy(self.data)
                    if field == 'label':
                        data['rule_sets']['ads-core']['label'] = 'fixture' + character
                    else:
                        data['outputs'][0]['headers'].append('! Note: fixture' + character)
                    self.assertTrue(generation.validate_profiles(data))

    def test_components_over_255_characters_are_rejected_before_writes(self):
        self.assertTrue(generation.valid_relative('a'*251+'.txt'))
        for path in ['a'*252+'.txt', 'a'*256+'/file.txt']:
            with self.subTest(path=path), TemporaryDirectory() as tmp:
                data = copy.deepcopy(self.data)
                data['outputs'][-1]['scope'] = 's'
                data['outputs'][-1]['path'] = path
                root = Path(tmp)
                (root / 'ad.txt').write_text('keep')
                self.assertTrue(generation.generate(data, {'s':root}))
                self.assertEqual((root / 'ad.txt').read_text(), 'keep')
                self.assertEqual(len(list(root.iterdir())), 1)
        data = copy.deepcopy(self.data)
        data['outputs'][0]['includes'] = ['a'*252+'.txt']
        self.assertTrue(generation.validate_profiles(data))

    def test_nonportable_and_aliased_paths_are_rejected_before_writes(self):
        for path in ['./ad.txt', 'v2//ad.txt', 'C:/ad.txt', '.git/ad.txt',
                     'bad\u0000name.txt', 'bad\nname.txt', '../ad.txt', '/ad.txt',
                     'CON.txt', 'aux/report.txt', 'folder./ad.txt']:
            with self.subTest(path=path), TemporaryDirectory() as tmp:
                data = copy.deepcopy(self.data)
                data['outputs'][0]['path'] = path
                self.assertTrue(generation.generate(data, {'s': Path(tmp)}))
                self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_colliding_outputs_are_rejected_before_any_file_is_changed(self):
        for path in ['Ad.txt', 'ad.txt/nested.txt']:
            with self.subTest(path=path), TemporaryDirectory() as tmp:
                data = copy.deepcopy(self.data)
                output = copy.deepcopy(data['outputs'][0])
                output['path'] = path
                data['outputs'].append(output)
                root = Path(tmp)
                (root / 'ad.txt').write_text('keep')
                errors = generation.generate(data, {'s': root})
                self.assertTrue(any('conflicting' in error for error in errors))
                self.assertEqual((root / 'ad.txt').read_text(), 'keep')

    def test_existing_path_conflicts_are_detected_before_any_output_is_written(self):
        for conflict in ['parent-file', 'target-directory']:
            with self.subTest(conflict=conflict), TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / 'ad.txt').write_text('keep')
                if conflict == 'parent-file':
                    (root / 'v2').write_text('keep parent')
                else:
                    (root / 'v2/ad.txt').mkdir(parents=True)
                with self.assertRaisesRegex(ValueError, 'not a regular'):
                    generation.generate(self.data, {'s': root})
                self.assertEqual((root / 'ad.txt').read_text(), 'keep')
                self.assertFalse((root / 'tracking.txt').exists())

    def test_scope_and_hostname_types_are_validation_errors(self):
        for scope in [[], {}, None, True]:
            data = copy.deepcopy(self.data)
            data['outputs'][0]['scope'] = scope
            with self.subTest(scope=scope):
                self.assertTrue(generation.validate_profiles(data))
        for host in ['127.0.0.1', '.'.join(['a'*63]*4), 'invalid..example']:
            data = copy.deepcopy(self.data)
            data['rule_sets']['ads-core']['rules'] = [f'||{host}^$third-party']
            with self.subTest(host=host):
                self.assertTrue(any('invalid hostname' in e for e in generation.validate_profiles(data)))

    def test_invalid_output_metadata_is_rejected(self):
        for old, new in [('! Version: {version}', '! Version: 20000101.1'),
                         ('! Expires: 5 days', '! Expires: 0 days'),
                         ('! Homepage: https://', '! Homepage: http://')]:
            data = copy.deepcopy(self.data)
            data['outputs'][0]['headers'] = [line.replace(old, new) for line in data['outputs'][0]['headers']]
            with self.subTest(new=new):
                self.assertTrue(generation.validate_profiles(data))

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
