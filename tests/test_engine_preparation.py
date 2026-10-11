import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import prepare_engine


class EnginePreparationTests(unittest.TestCase):
    def archive(self, name, kind=None):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            member = tarfile.TarInfo(name)
            if kind is not None:
                member.type = kind
                member.linkname = '/tmp/escape'
            archive.addfile(member, io.BytesIO())
        return data.getvalue()

    def test_lock_rejects_unofficial_or_non_https_sources(self):
        for key, field, value in [('ublock', 'archive_url', 'file:///tmp/source'), ('public_suffix', 'url', 'https://example.org/psl'), ('ublock', 'commit', '../escape')]:
            with self.subTest(key=key, field=field):
                lock = json.loads(prepare_engine.LOCK.read_text())
                lock[key][field] = value
                with self.assertRaises(ValueError):
                    prepare_engine.validate_lock(lock)

    def test_download_does_not_follow_symlink(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'original').write_bytes(b'keep')
            (root / 'cache').symlink_to('original')
            with self.assertRaisesRegex(ValueError, 'symlink'):
                prepare_engine.download('https://example.org/', '0' * 64, root / 'cache', 100)
            self.assertEqual((root / 'original').read_bytes(), b'keep')

    def test_verified_cache_does_not_use_network(self):
        with TemporaryDirectory() as tmp:
            target = Path(tmp) / 'cache'
            target.write_bytes(b'verified')
            with patch('prepare_engine.urllib.request.urlopen') as network:
                self.assertEqual(prepare_engine.download('https://example.org/', hashlib.sha256(b'verified').hexdigest(), target, 100), b'verified')
                network.assert_not_called()

    def test_wrong_digest_does_not_replace_cache(self):
        with TemporaryDirectory() as tmp:
            target = Path(tmp) / 'cache'
            target.write_bytes(b'old')
            with patch('prepare_engine.urllib.request.urlopen') as network:
                network.return_value.__enter__.return_value.read.return_value = b'tampered'
                with self.assertRaisesRegex(ValueError, 'SHA256'):
                    prepare_engine.download('https://example.org/', '0' * 64, target, 100)
            self.assertEqual(target.read_bytes(), b'old')

    def test_oversize_download_is_rejected(self):
        with TemporaryDirectory() as tmp, patch('prepare_engine.urllib.request.urlopen') as network:
            network.return_value.__enter__.return_value.read.return_value = b'too large'
            with self.assertRaisesRegex(ValueError, 'size limit'):
                prepare_engine.download('https://example.org/', '0' * 64, Path(tmp) / 'cache', 2)

    def test_archive_traversal_and_links_are_rejected(self):
        for name, kind in [('uBlock-pinned/../../escape', None), ('/absolute', None), ('wrong-root/a', None), ('uBlock-pinned/link', tarfile.SYMTYPE), ('uBlock-pinned/link', tarfile.LNKTYPE)]:
            with self.subTest(name=name, kind=kind), TemporaryDirectory() as tmp:
                with self.assertRaisesRegex(ValueError, 'unsafe archive'):
                    prepare_engine.extract_snapshot(self.archive(name, kind), Path(tmp), 'pinned')
                self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_safe_snapshot_is_extracted(self):
        with TemporaryDirectory() as tmp:
            source = prepare_engine.extract_snapshot(self.archive('uBlock-pinned/file'), Path(tmp), 'pinned')
            self.assertTrue((source / 'file').is_file())


if __name__ == '__main__':
    unittest.main()
