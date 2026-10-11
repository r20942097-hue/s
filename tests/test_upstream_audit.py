import hashlib
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import audit_upstream


class UpstreamAuditTests(unittest.TestCase):
    def test_domain_boundaries_and_exception_roles(self):
        profiles = {'rule_sets': {'ads': {'rules': ['||ads.example^$third-party']}}}
        record = {'repository': 'owner/repo', 'path': 'ads.txt', 'url': 'https://github.com/owner/repo/blob/pin/ads.txt'}
        lines = ['! ads.example is a comment', '||ads.example^', '@@||cdn.ads.example^$domain=site.example', '||notads.example^', '||ads.example.evil^']
        rows = audit_upstream.audit(profiles, [(record, lines)])
        self.assertEqual([r['role'] for r in rows[0]['references']], ['classification', 'exception'])
        self.assertEqual(rows[0]['review'], '例外参照あり・個別確認')
        self.assertEqual(profiles['rule_sets']['ads']['rules'], ['||ads.example^$third-party'])

    def test_absence_is_reported_as_unknown(self):
        profiles = {'rule_sets': {'ads': {'rules': ['||ads.example^$third-party']}}}
        self.assertIn('未判定', audit_upstream.audit(profiles, [])[0]['review'])

    def test_changed_snapshot_is_rejected(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            record = {'repository': 'owner/repo', 'commit': 'a' * 40, 'path': 'ads.txt', 'sha256': hashlib.sha256(b'original').hexdigest()}
            target = root / 'owner__repo' / record['commit'] / 'ads.txt'
            target.parent.mkdir(parents=True)
            target.write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'changed pinned snapshot'):
                audit_upstream.verified_sources(root, {'files': [record]})

    def test_unsafe_snapshot_path_is_rejected(self):
        with TemporaryDirectory() as tmp:
            record = {'repository': 'owner/repo', 'commit': 'a' * 40, 'path': '../escape', 'sha256': '0' * 64}
            with self.assertRaisesRegex(ValueError, 'unsafe snapshot path'):
                audit_upstream.verified_sources(Path(tmp), {'files': [record]})


if __name__ == '__main__':
    unittest.main()
