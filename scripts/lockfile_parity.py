"""Fail-closed, offline parity check of gh-actions-lock schema v0.0.3.

This is a deliberately restricted reader for the currently generated subset of
GitHub's lockfile format. It does not authenticate owners, tags, or commits.
The authoritative online check remains gh actions-lock --verify.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SCHEMA = 'v0.0.3'
FILE = '.github/workflows/actions.lock'
MAX_LOCK_BYTES = 128 * 1024
MAX_WORKFLOWS = 100
MAX_DEPS = 1000
ACTION = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$")
USE = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)")
PATH = re.compile(r"^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$")
QKEY = re.compile(r"^    '([^']+)':$")
QUSE = re.compile(r"^        - '([^']+)'$")
FIELD = re.compile(r"^        ([a-z_]+): (.*)$")
NESTED_USE = re.compile(r"^            - '([^']+)'$")
SINGLE = re.compile(r"^'([^']*)'$")
HOST = re.compile(r"^(?:github\.com|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ghe\.com)$")


def parse(text: str) -> tuple[dict, list[str]]:
    errors: list[str] = []
    workflows: dict[str, list[str]] = {}
    dependencies: dict[str, dict] = {}
    section = None
    active = None
    sublist = None
    phase = 0
    for number, raw in enumerate(text.splitlines(), 1):
        if not raw.strip() or raw.startswith('#'):
            continue
        if '\t' in raw or len(raw) > 1000:
            errors.append(f'line {number}: tab or overlong line')
            continue
        if raw == "version: 'v0.0.3'":
            if phase != 0:
                errors.append(f'line {number}: unexpected version field')
            phase = 1
            continue
        if raw == 'workflows:':
            if phase != 1:
                errors.append(f'line {number}: workflows section out of order')
            phase, section, active, sublist = 2, 'workflows', None, None
            continue
        if raw == 'dependencies:':
            if phase != 2:
                errors.append(f'line {number}: dependencies section out of order')
            phase, section, active, sublist = 3, 'dependencies', None, None
            continue
        k = QKEY.fullmatch(raw)
        if k:
            key = k.group(1)
            if section == 'workflows':
                if not PATH.fullmatch(key):
                    errors.append(f'line {number}: unsafe workflow path')
                if key in workflows:
                    errors.append(f'line {number}: duplicate workflow')
                workflows[key] = []
            elif section == 'dependencies':
                if not ACTION.fullmatch(key) or key in dependencies:
                    errors.append(f'line {number}: invalid or duplicate dependency')
                dependencies[key] = {}
            else:
                errors.append(f'line {number}: key outside section')
            active, sublist = key, None
            continue
        if section == 'workflows':
            m = QUSE.fullmatch(raw)
            if active is None or m is None or not ACTION.fullmatch(m.group(1)):
                errors.append(f'line {number}: invalid workflow dependency')
            else:
                if m.group(1) in workflows[active]:
                    errors.append(f'line {number}: repeated workflow dependency')
                workflows[active].append(m.group(1))
            continue
        if section == 'dependencies':
            m = FIELD.fullmatch(raw)
            if m and active is not None:
                field, token = m.groups()
                d = dependencies[active]
                if field in d or field not in {'ref', 'commit', 'owner_id', 'repo_id', 'hostname', 'uses'}:
                    errors.append(f'line {number}: duplicate or unsupported dependency field')
                    continue
                if field == 'uses' and token == '':
                    d[field], sublist = [], 'uses'
                elif field in {'owner_id', 'repo_id'} and token.isdecimal() and int(token) > 0:
                    d[field], sublist = int(token), None
                elif field in {'ref', 'commit', 'hostname'} and SINGLE.fullmatch(token):
                    d[field], sublist = SINGLE.fullmatch(token).group(1), None
                else:
                    errors.append(f'line {number}: invalid dependency value')
                continue
            m = NESTED_USE.fullmatch(raw)
            if m and active is not None and sublist == 'uses' and ACTION.fullmatch(m.group(1)):
                dependencies[active]['uses'].append(m.group(1))
                continue
        errors.append(f'line {number}: unknown lockfile structure')
    if phase != 3:
        errors.append('lockfile section order/version mismatch')
    if not workflows or not dependencies:
        errors.append('missing workflows or dependency metadata')
    if len(workflows) > MAX_WORKFLOWS or len(dependencies) > MAX_DEPS:
        errors.append('lockfile exceeds workflow/dependency count limit')
    for key, metadata in dependencies.items():
        if not {'ref', 'commit', 'owner_id', 'repo_id'} <= metadata.keys():
            errors.append(f'{key}: missing required metadata')
            continue
        if metadata['commit'] != 'sha1-' + key.rsplit('@', 1)[-1]:
            errors.append(f'{key}: pinned commit mismatch')
        if not metadata['ref']:
            errors.append(f'{key}: empty ref')
        if 'hostname' in metadata and not HOST.fullmatch(metadata['hostname']):
            errors.append(f'{key}: invalid hostname')
        for child in metadata.get('uses', []):
            if child not in dependencies:
                errors.append(f'{key}: missing transitive dependency {child}')
    return {'workflows': workflows, 'dependencies': dependencies}, errors


def _closure(roots: list[str], deps: dict[str, dict], errors: list[str]) -> set[str]:
    done, active = set(), set()
    def visit(dep: str) -> None:
        if dep in active:
            errors.append(f'cyclic action dependency: {dep}')
            return
        if dep in done:
            return
        if dep not in deps:
            errors.append(f'missing action dependency: {dep}')
            return
        active.add(dep)
        for child in deps[dep].get('uses', []):
            visit(child)
        active.remove(dep)
        done.add(dep)
    for root in roots:
        visit(root)
    return done


def audit(root: Path) -> dict:
    root = Path(root).resolve()
    errors: list[str] = []
    lock_path = root / FILE
    if lock_path.is_symlink() or not lock_path.is_file():
        errors.append('missing or symlinked actions.lock')
        lock = {'workflows': {}, 'dependencies': {}}
    else:
        try:
            if lock_path.stat().st_size > MAX_LOCK_BYTES:
                raise ValueError('lockfile too large')
            raw = lock_path.read_text(encoding='utf-8')
            lock, parsing_errors = parse(raw)
            errors.extend(parsing_errors)
        except (OSError, ValueError, UnicodeError):
            errors.append('lockfile unreadable or oversized')
            lock = {'workflows': {}, 'dependencies': {}}
    directory = root / '.github/workflows'
    if directory.is_symlink() or not directory.is_dir():
        errors.append('workflow directory missing or linked')
        found: dict[str, list[str]] = {}
    else:
        found = {}
        for path in sorted([*directory.glob('*.yml'), *directory.glob('*.yaml')]):
            key = '.github/workflows/' + path.name
            if path.is_symlink():
                errors.append(f'{key}: symbolic link forbidden')
                continue
            try:
                content = path.read_text(encoding='utf-8')
            except (OSError, UnicodeError):
                errors.append(f'{key}: unreadable workflow')
                continue
            refs = [m.group(1) for line in content.splitlines() if (m := USE.match(line)) and not line.lstrip().startswith('#')]
            found[key] = refs
    if set(found) != set(lock['workflows']):
        errors.append('workflow paths do not match lockfile')
    referenced: set[str] = set()
    for path, direct in found.items():
        declared = set(lock['workflows'].get(path, []))
        expected = _closure(direct, lock['dependencies'], errors)
        if declared != expected:
            errors.append(f'{path}: locked dependencies differ from reachable direct/transitive actions')
        referenced |= declared
    extra = set(lock['dependencies']) - referenced
    if extra:
        errors.append('orphan dependency metadata: ' + ', '.join(sorted(extra)[:4]))
    return {'schema': 'gpt1-lockfile-parity/v1', 'status': 'FAIL' if errors else 'PASS',
            'scope': 'offline lockfile/workflow metadata parity; NOT upstream provenance verification',
            'workflow_count': len(found), 'dependencies_count': len(lock['dependencies']),
            'errors': errors, 'online_provenance': 'NOT_RUN', 'release_approval': 'NOT_RUN'}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    result = audit(args.root)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{result['status']}: {result['workflow_count']} workflows, {result['dependencies_count']} action pins")
        for error in result['errors']:
            print('ERROR:', error)
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
