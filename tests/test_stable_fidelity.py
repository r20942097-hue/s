"""Regression fixtures for stable subscription immutability and owner-review lock."""
import copy
import subprocess
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from check_stable_fidelity import FILES, LOCK, ROOT, git_blob_sha, validate_manifest, verify, pinned_git_tree


class StableFidelityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads(LOCK.read_text(encoding="utf-8"))

    def make_fixture(self, root):
        pins = copy.deepcopy(self.manifest)
        for name in sorted(FILES):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            data = ("approved:" + name + "\n").encode()
            path.write_bytes(data)
            pins["files"][name] = git_blob_sha(data)
        return pins

    def test_repository_stable_files_preserved(self):
        errors, report = verify(ROOT, self.manifest)
        self.assertEqual(errors, [])
        self.assertEqual(report["protected_asset_count"], 8)
        self.assertEqual(report["status"], "PASS")

    def test_tampered_byte_fails(self):
        with TemporaryDirectory() as dirname:
            root = Path(dirname)
            manifest = self.make_fixture(root)
            (root / "tracking.txt").write_bytes(b"unreviewed mutation\n")
            errors, report = verify(root, manifest)
            self.assertEqual(report["status"], "FAIL")
            self.assertTrue(any("tracking.txt: stable Git blob changed" in e for e in errors))

    def test_deleted_or_wrong_type_fails(self):
        with TemporaryDirectory() as dirname:
            root = Path(dirname)
            manifest = self.make_fixture(root)
            (root / "ad.txt").unlink()
            errors, _ = verify(root, manifest)
            self.assertTrue(any("ad.txt: missing" in e for e in errors))

    def test_file_symlink_rejected_without_following(self):
        with TemporaryDirectory() as dirname:
            root = Path(dirname)
            manifest = self.make_fixture(root)
            link = root / "tracking.txt"
            link.unlink()
            link.symlink_to(root / "ad.txt")
            errors, report = verify(root, manifest)
            self.assertTrue(any("tracking.txt: symlink forbidden" in e for e in errors))
            self.assertEqual(report["status"], "FAIL")

    def test_unlisted_file_or_pin_renaming_rejected(self):
        manifest = copy.deepcopy(self.manifest)
        del manifest["files"]["ad.txt"]
        with self.assertRaises(ValueError):
            validate_manifest(manifest)
        manifest = copy.deepcopy(self.manifest)
        manifest["files"]["../../other.txt"] = manifest["files"].pop("ad.txt")
        with self.assertRaises(ValueError):
            validate_manifest(manifest)

    def test_independent_base_tree_prevents_pin_self_rewrite(self):
        with TemporaryDirectory() as dirname:
            root = Path(dirname)
            manifest = self.make_fixture(root)
            subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
            subprocess.run(["git", "-C", str(root), "add", *sorted(FILES)], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Filter CI",
                            "-c", "user.email=ci@example.invalid", "commit", "-qm",
                            "baseline"], check=True)
            actual_commit = subprocess.check_output(
                ["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
            manifest["baseline_commit"] = actual_commit
            base = pinned_git_tree(root, manifest)
            self.assertEqual(base, manifest["files"])
            self.assertEqual(verify(root, manifest, base_tree=base)[0], [])
            # A malicious or accidental pin refresh may match edited files, but
            # the historical tree still rejects the rewriting of expected data.
            changed_data = b"unreviewed stable file mutation\n"
            (root / "ad.txt").write_bytes(changed_data)
            manifest["files"]["ad.txt"] = git_blob_sha(changed_data)
            errors, report = verify(root, manifest, base_tree=base)
            self.assertEqual(report["status"], "FAIL")
            self.assertTrue(any("editable pin conflicts" in e for e in errors))
            self.assertEqual(report["independent_base_tree"], "FAIL")

    def test_git_base_tree_bad_or_missing_commit_fails_closed(self):
        with TemporaryDirectory() as dirname:
            root = Path(dirname)
            self.make_fixture(root)
            subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
            with self.assertRaises(ValueError):
                pinned_git_tree(root, self.manifest)

    def test_owner_approval_gate_and_malformed_shas(self):
        for key, value in (("publication_hold", False),
                           ("require_owner_review_for_pin_changes", False),
                           ("baseline_commit", "missing")):
            manifest = copy.deepcopy(self.manifest)
            manifest[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_manifest(manifest)
        manifest = copy.deepcopy(self.manifest)
        manifest["files"]["ad.txt"] = "bad"
        with self.assertRaises(ValueError):
            validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
