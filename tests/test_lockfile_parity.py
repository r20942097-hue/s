"""Regression cases for offline lockfile parity. No network or mutating Git operations."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lockfile_parity import audit, main, parse

SHA_A = 'a' * 40
SHA_B = 'b' * 40
A = 'actions/checkout@' + SHA_A
B = 'example/child@' + SHA_B


def make_lock(workflows=None, dependencies=None):
    if workflows is None:
        workflows = f"    '.github/workflows/ci.yml':\n        - '{A}'\n"
    if dependencies is None:
        dependencies = (f"    '{A}':\n        ref: 'v7.0.1'\n        commit: 'sha1-{SHA_A}'\n"
                        "        owner_id: 44036562\n        repo_id: 197814629\n")
    return "# generated\nversion: 'v0.0.3'\nworkflows:\n" + workflows + 'dependencies:\n' + dependencies


class ParityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.folder = self.root / '.github/workflows'
        self.folder.mkdir(parents=True)
        self.workflow = self.folder / 'ci.yml'
        self.workflow.write_text(f'name: CI\non: pull_request\njobs:\n  x:\n    steps:\n      - uses: {A}\n', encoding='utf-8')
        self.lock = self.folder / 'actions.lock'
        self.lock.write_text(make_lock(), encoding='utf-8')

    def status(self):
        return audit(self.root)['status']

    def test_valid_lock(self):
        self.assertEqual(self.status(), 'PASS')

    def test_schema(self):
        result = audit(self.root)
        self.assertEqual(result['schema'], 'gpt1-lockfile-parity/v1')
        self.assertEqual(result['online_provenance'], 'NOT_RUN')

    def test_missing_lock(self):
        self.lock.unlink()
        self.assertEqual(self.status(), 'FAIL')

    def test_wrong_version(self):
        self.lock.write_text(make_lock().replace('v0.0.3', 'v0.0.2'))
        self.assertEqual(self.status(), 'FAIL')

    def test_duplicate_workflow_key(self):
        w = f"    '.github/workflows/ci.yml':\n        - '{A}'\n"
        self.lock.write_text(make_lock(workflows=w+w))
        self.assertEqual(self.status(), 'FAIL')

    def test_duplicate_dependency_key(self):
        d = make_lock().split('dependencies:\n', 1)[1]
        self.lock.write_text(make_lock(dependencies=d+d))
        self.assertEqual(self.status(), 'FAIL')

    def test_workflow_without_lock_entry(self):
        (self.folder / 'other.yml').write_text('name: other\n')
        self.assertEqual(self.status(), 'FAIL')

    def test_lock_without_workflow(self):
        self.workflow.unlink()
        self.assertEqual(self.status(), 'FAIL')

    def test_direct_pin_mismatch(self):
        self.workflow.write_text(self.workflow.read_text().replace(SHA_A, SHA_B))
        self.assertEqual(self.status(), 'FAIL')

    def test_missing_owner_id(self):
        self.lock.write_text(make_lock().replace('        owner_id: 44036562\n', ''))
        self.assertEqual(self.status(), 'FAIL')

    def test_invalid_repo_id(self):
        self.lock.write_text(make_lock().replace('repo_id: 197814629', 'repo_id: 0'))
        self.assertEqual(self.status(), 'FAIL')

    def test_wrong_commit(self):
        self.lock.write_text(make_lock().replace('sha1-'+SHA_A, 'sha1-'+SHA_B))
        self.assertEqual(self.status(), 'FAIL')

    def test_orphan_metadata(self):
        self.lock.write_text(make_lock(dependencies=make_lock().split('dependencies:\n',1)[1]
                                  + f"    '{B}':\n        ref: 'v1'\n        commit: 'sha1-{SHA_B}'\n        owner_id: 1\n        repo_id: 2\n"))
        self.assertEqual(self.status(), 'FAIL')

    def test_traversal_path_rejected(self):
        self.lock.write_text(make_lock(workflows=f"    '../../evil.yml':\n        - '{A}'\n"))
        self.assertEqual(self.status(), 'FAIL')

    def test_unknown_field_rejected(self):
        self.lock.write_text(make_lock().replace('repo_id: 197814629', 'repo_id: 197814629\n        unsafe: yes'))
        self.assertEqual(self.status(), 'FAIL')

    def test_invalid_hostname_rejected(self):
        self.lock.write_text(make_lock().replace('repo_id: 197814629', "repo_id: 197814629\n        hostname: 'evil.org'"))
        self.assertEqual(self.status(), 'FAIL')

    def test_valid_hostname(self):
        self.lock.write_text(make_lock().replace('repo_id: 197814629', "repo_id: 197814629\n        hostname: 'github.com'"))
        self.assertEqual(self.status(), 'PASS')

    def test_extra_transitive_dependency(self):
        dependencies = (f"    '{A}':\n        ref: 'v7'\n        commit: 'sha1-{SHA_A}'\n        owner_id: 1\n        repo_id: 2\n"
                        f"        uses: \n            - '{B}'\n"
                        f"    '{B}':\n        ref: 'v1'\n        commit: 'sha1-{SHA_B}'\n        owner_id: 1\n        repo_id: 3\n")
        workflows = f"    '.github/workflows/ci.yml':\n        - '{A}'\n        - '{B}'\n"
        self.lock.write_text(make_lock(workflows, dependencies))
        self.assertEqual(self.status(), 'PASS')

    def test_transitive_uses_without_trailing_space(self):
        dep = (f"    '{A}':\n        ref: 'v7'\n        commit: 'sha1-{SHA_A}'\n        owner_id: 1\n        repo_id: 2\n"
               f"        uses:\n            - '{B}'\n"
               f"    '{B}':\n        ref: 'v1'\n        commit: 'sha1-{SHA_B}'\n        owner_id: 1\n        repo_id: 3\n")
        workflows = f"    '.github/workflows/ci.yml':\n        - '{A}'\n        - '{B}'\n"
        self.lock.write_text(make_lock(workflows, dep))
        self.assertEqual(self.status(), 'PASS')

    def test_missing_transitive_reference(self):
        dependencies = (f"    '{A}':\n        ref: 'v7'\n        commit: 'sha1-{SHA_A}'\n        owner_id: 1\n        repo_id: 2\n"
                        f"        uses: \n            - '{B}'\n")
        self.lock.write_text(make_lock(dependencies=dependencies))
        self.assertEqual(self.status(), 'FAIL')

    def test_cyclic_dependency(self):
        dependencies = (f"    '{A}':\n        ref: 'v7'\n        commit: 'sha1-{SHA_A}'\n        owner_id: 1\n        repo_id: 2\n        uses: \n            - '{A}'\n")
        self.lock.write_text(make_lock(dependencies=dependencies))
        self.assertEqual(self.status(), 'FAIL')

    def test_subdirectory_actions_map_to_repository_pin(self):
        codeql = 'github/codeql-action@' + SHA_B
        lock = make_lock(
            workflows=f"    '.github/workflows/ci.yml':\n        - '{codeql}'\n",
            dependencies=f"    '{codeql}':\n        ref: 'v4'\n        commit: 'sha1-{SHA_B}'\n        owner_id: 9919\n        repo_id: 2\n")
        self.lock.write_text(lock)
        self.workflow.write_text(f"jobs:\n  x:\n    steps:\n      - uses: github/codeql-action/init@{SHA_B}\n      - uses: github/codeql-action/analyze@{SHA_B}\n")
        self.assertEqual(self.status(), 'PASS')

    def test_subdirectory_different_sha_is_not_accepted(self):
        codeql = 'github/codeql-action@' + SHA_B
        self.lock.write_text(make_lock(
            workflows=f"    '.github/workflows/ci.yml':\n        - '{codeql}'\n",
            dependencies=f"    '{codeql}':\n        ref: 'v4'\n        commit: 'sha1-{SHA_B}'\n        owner_id: 9919\n        repo_id: 2\n"))
        self.workflow.write_text(f"jobs:\n  x:\n    steps:\n      - uses: github/codeql-action/init@{SHA_A}\n")
        self.assertEqual(self.status(), 'FAIL')

    def test_tab_rejected(self):
        self.lock.write_text(make_lock().replace('owner_id: 44036562', 'owner_id:\t44036562'))
        self.assertEqual(self.status(), 'FAIL')

    def test_duplicate_metadata_field(self):
        self.lock.write_text(make_lock().replace('repo_id: 197814629', 'repo_id: 197814629\n        repo_id: 197814629'))
        self.assertEqual(self.status(), 'FAIL')

    def test_symlinked_lock(self):
        target = self.root / 'elsewhere'
        target.write_text(make_lock())
        self.lock.unlink()
        try: self.lock.symlink_to(target)
        except (OSError, NotImplementedError): self.skipTest('symlink unavailable')
        self.assertEqual(self.status(), 'FAIL')

    def test_empty_workflow_section(self):
        self.lock.write_text(make_lock(workflows=''))
        self.assertEqual(self.status(), 'FAIL')

    def test_cli(self):
        with patch('builtins.print'):
            self.assertEqual(main(['--root', str(self.root), '--json']), 0)

    def test_cli_rejected(self):
        self.lock.unlink()
        with patch('builtins.print'):
            self.assertEqual(main(['--root', str(self.root)]), 1)


if __name__ == '__main__':
    unittest.main()
