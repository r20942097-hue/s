"""Reproducible ZIP builds from real temporary Git commits; no network or pushes."""
import hashlib
import json
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import repro_source_archive as app


class ReproSourceTests(unittest.TestCase):
    def cmd(self, *args):
        return subprocess.run(["git", "-C", str(self.source), *args],
                              check=True, capture_output=True, text=True).stdout.strip()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "checkout"
        self.source.mkdir()
        subprocess.run(["git", "init", "-q", str(self.source)], check=True, capture_output=True)
        (self.source / "b.js").write_bytes(b"var b=2;\n")
        (self.source / "a.txt").write_bytes(b"alpha\n")
        self.cmd("add", "a.txt", "b.js")
        subprocess.run(["git", "-C", str(self.source), "-c", "user.name=CI", "-c",
                        "user.email=fixture@example.invalid", "commit", "-qm", "source"],
                       check=True, capture_output=True)
        self.head = self.cmd("rev-parse", "HEAD")
        self.recipe = self.root / "recipe.json"
        self.out = self.root / "package.zip"
        self.filemap = [{"source": "b.js", "member": "dist/b.js"},
                        {"source": "a.txt", "member": "dist/a.txt"}]
        self.save()

    def save(self, entries=None, **updates):
        d = {"schema": app.SCHEMA, "source_commit": self.head,
             "files": self.filemap if entries is None else entries}
        d.update(updates)
        self.recipe.write_text(json.dumps(d), encoding="utf-8")

    def generate(self):
        return app.generate(self.source, self.recipe)

    def build(self):
        b, report = self.generate()
        self.out.write_bytes(b)
        return b, report

    def test_cross_platform_golden_zip_sha256(self):
        data, report = self.generate()
        self.assertEqual(report["sha256"],
                         "4b41b60c27390b5976b31139ba60f8405db41fc9044b31bf9c75aff5588e193b")
        self.assertEqual(len(data), 227)

    def test_build_deterministic_repeated(self):
        first, one = self.generate()
        second, two = self.generate()
        self.assertEqual(first, second)
        self.assertEqual(one["sha256"], two["sha256"])
        self.assertEqual(one["decision"], "CANDIDATE_NO_GO")

    def test_output_sorted_and_fixed_metadata(self):
        raw, result = self.generate()
        with zipfile.ZipFile(__import__("io").BytesIO(raw)) as z:
            self.assertEqual(z.namelist(), ["dist/a.txt", "dist/b.js"])
            for e in z.infolist():
                self.assertEqual(e.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(e.compress_type, zipfile.ZIP_STORED)
                self.assertEqual(e.create_system, 3)
                self.assertEqual((e.external_attr >> 16) & 0o170000, stat.S_IFREG)
            self.assertEqual(z.read("dist/a.txt"), b"alpha\n")

    def test_verify_exact_candidate_and_independent_digest(self):
        b, r = self.build()
        result = app.verify(self.source, self.recipe, self.out, hashlib.sha256(b).hexdigest())
        self.assertEqual(result["status"], "REPRODUCIBLE")
        self.assertEqual(result["signed_attestation"], "NOT_RUN")
        self.assertEqual(result["upstream_origin_authenticated"], "NOT_RUN")

    def test_change_candidate_bytes_rejected(self):
        data, r = self.build()
        self.out.write_bytes(data + b"evil")
        self.assertEqual(app.verify(self.source, self.recipe, self.out, r["sha256"])["status"], "FAIL")

    def test_wrong_independent_digest_rejected(self):
        self.build()
        self.assertEqual(app.verify(self.source, self.recipe, self.out, "0"*64)["status"], "FAIL")

    def test_no_expected_digest_rejected(self):
        self.build()
        self.assertEqual(app.verify(self.source, self.recipe, self.out, None)["status"], "FAIL")

    def test_worktree_modified_rejected(self):
        (self.source / "a.txt").write_text("modified")
        with self.assertRaises(app.BuildError): self.generate()

    def test_staged_change_rejected(self):
        (self.source / "a.txt").write_text("modified")
        self.cmd("add", "a.txt")
        with self.assertRaises(app.BuildError): self.generate()

    def test_untracked_change_rejected(self):
        (self.source / "random.txt").write_text("extra")
        with self.assertRaises(app.BuildError): self.generate()

    def test_wrong_commit_pin_rejected(self):
        self.save(source_commit="0"*40)
        with self.assertRaises(app.BuildError): self.generate()

    def test_missing_recipe_rejected(self):
        self.recipe.unlink()
        with self.assertRaises(app.BuildError): self.generate()

    def test_recipe_wrong_keys_rejected(self):
        self.save(secret_approved=True)
        with self.assertRaises(app.BuildError): self.generate()

    def test_missing_mapped_file_rejected(self):
        self.save(entries=[{"source": "missing.js", "member": "missing.js"}])
        with self.assertRaises(app.BuildError): self.generate()

    def test_source_path_traversal_rejected(self):
        self.save(entries=[{"source": "../secret", "member": "target"}])
        with self.assertRaises(app.BuildError): self.generate()

    def test_dest_path_traversal_rejected(self):
        self.save(entries=[{"source": "a.txt", "member": "../target"}])
        with self.assertRaises(app.BuildError): self.generate()

    def test_windows_reserved_name_rejected(self):
        self.save(entries=[{"source": "a.txt", "member": "CON.txt"}])
        with self.assertRaises(app.BuildError): self.generate()

    def test_duplicate_casefold_destination_rejected(self):
        self.save(entries=[{"source": "a.txt", "member": "DIST/A.txt"},
                           {"source": "b.js", "member": "dist/a.TXT"}])
        with self.assertRaises(app.BuildError): self.generate()

    def test_duplicate_source_mapping_rejected(self):
        self.save(entries=[{"source": "a.txt", "member": "a.txt"},
                           {"source": "a.txt", "member": "a-copy.txt"}])
        with self.assertRaises(app.BuildError): self.generate()

    def test_file_directory_conflict_rejected(self):
        self.save(entries=[{"source": "a.txt", "member": "root"},
                           {"source": "b.js", "member": "root/child.js"}])
        with self.assertRaises(app.BuildError): self.generate()

    def test_missing_git_tool_fails(self):
        with patch.object(app, "_git", side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError): self.generate()

    def test_oversized_blob_policy(self):
        with patch.object(app, "MAX_BLOB", 2):
            with self.assertRaises(app.BuildError): self.generate()

    def test_oversized_recipe_policy(self):
        with patch.object(app, "MAX_RECIPE", 2):
            with self.assertRaises(app.BuildError): self.generate()

    def test_no_files_rejected(self):
        self.save(entries=[])
        with self.assertRaises(app.BuildError): self.generate()

    def test_output_write_uses_exclusive_create(self):
        with patch("builtins.print"):
            self.assertEqual(app.main(["--root", str(self.source), "--recipe", str(self.recipe),
                                       "--output", str(self.out)]), 0)
            first = self.out.read_bytes()
            self.assertEqual(app.main(["--root", str(self.source), "--recipe", str(self.recipe),
                                       "--output", str(self.out)]), 1)
        self.assertEqual(self.out.read_bytes(), first)

    def test_output_inside_repo_rejected_without_write(self):
        target = self.source / "candidate.zip"
        with patch("builtins.print"):
            self.assertEqual(app.main(["--root", str(self.source), "--recipe", str(self.recipe),
                                       "--output", str(target)]), 1)
        self.assertFalse(target.exists())

    def test_cli_check_and_sha(self):
        data, result = self.build()
        with patch("builtins.print"):
            self.assertEqual(app.main(["--root", str(self.source), "--recipe", str(self.recipe),
                "--candidate", str(self.out), "--expected-sha256", result["sha256"], "--json"]), 0)

    def test_cli_bad_digest_fails(self):
        self.build()
        with patch("builtins.print"):
            self.assertEqual(app.main(["--root", str(self.source), "--recipe", str(self.recipe),
                "--candidate", str(self.out), "--expected-sha256", "0"*64]), 1)

    def test_symlinked_recipe_rejected(self):
        actual = self.root / "real-recipe.json"
        self.recipe.rename(actual)
        try: self.recipe.symlink_to(actual)
        except (OSError, NotImplementedError): self.skipTest("no symlinks")
        with self.assertRaises(app.BuildError): self.generate()

    def test_source_checkout_symlink_rejected(self):
        link = self.root / "linked-checkout"
        try: link.symlink_to(self.source, target_is_directory=True)
        except (OSError, NotImplementedError): self.skipTest("no symlinks")
        with self.assertRaises(app.BuildError): app.generate(link, self.recipe)

    def test_encoded_filename_determinism(self):
        self.save(entries=[{"source": "a.txt", "member": "日本語/a.txt"}])
        a, _ = self.generate()
        b, _ = self.generate()
        self.assertEqual(a,b)
        with zipfile.ZipFile(__import__("io").BytesIO(a)) as z:
            self.assertEqual(z.namelist(), ["日本語/a.txt"])

if __name__ == "__main__": unittest.main()
