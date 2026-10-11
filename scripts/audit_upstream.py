"""Audit domain references in pinned upstream snapshots; never promote rules automatically."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def verified_sources(cache, snapshots, fetch=False):
    records = []
    for record in snapshots['files']:
        repository, commit, relative = record['repository'], record['commit'], record['path']
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not re.fullmatch(r'[0-9a-f]{40}', commit):
            raise ValueError('invalid snapshot identity')
        part = Path(relative)
        if part.is_absolute() or '..' in part.parts or '\\' in relative:
            raise ValueError('unsafe snapshot path')
        target = cache / repository.replace('/', '__') / commit / part
        for parent in [target, *target.parents]:
            if parent.is_symlink():
                raise ValueError('symlink in snapshot cache')
            if parent == cache:
                break
        digest = record['sha256']
        if not target.is_file():
            if not fetch:
                raise ValueError(f'missing pinned snapshot: {target}; use --fetch')
            url = f'https://raw.githubusercontent.com/{repository}/{commit}/{relative}'
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'filter-upstream-audit'}), timeout=45) as response:
                content = response.read(8_000_001)
            if len(content) > 8_000_000 or hashlib.sha256(content).hexdigest() != digest:
                raise ValueError(f'snapshot integrity check failed: {relative}')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        content = target.read_bytes()
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError(f'changed pinned snapshot: {target}')
        records.append((record, content.decode('utf-8-sig').splitlines()))
    return records


def audit(profiles, sources):
    domains = {}
    for name, rule_set in profiles['rule_sets'].items():
        for rule in rule_set['rules']:
            domain = re.match(r'^\|\|([^/^]+)', rule).group(1)
            domains.setdefault(domain, {'domain': domain, 'rule_sets': [], 'references': []})['rule_sets'].append(name)
    for domain, item in sorted(domains.items()):
        pattern = re.compile(r'(?<![A-Za-z0-9_-])' + re.escape(domain) + r'(?![A-Za-z0-9_.-])', re.I)
        for record, lines in sources:
            for number, line in enumerate(lines, 1):
                if not line.strip() or line.startswith('!') or not pattern.search(line):
                    continue
                path = record['path'].lower()
                role = 'exception' if line.startswith('@@') else 'unbreak-context' if 'unbreak' in path or 'allowlist' in path else 'classification'
                item['references'].append({'repository': record['repository'], 'role': role,
                                           'url': record['url'] + f'#L{number}', 'rule': line})
        item['review'] = ('例外参照あり・個別確認' if any(r['role'] != 'classification' for r in item['references'])
                          else '分類参照あり' if item['references'] else '選択した資料に参照なし・未判定')
    return list(sorted(domains.values(), key=lambda item: item['domain']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--csv', type=Path)
    parser.add_argument('--fetch', action='store_true', help='fetch missing immutable snapshots with SHA256 verification')
    args = parser.parse_args()
    try:
        profiles = json.loads((ROOT / 'filter-profiles.json').read_text())
        snapshots = json.loads((ROOT / 'verification/upstream-snapshots.json').read_text())
        sources = verified_sources(args.cache.resolve(), snapshots, args.fetch)
        rows = audit(profiles, sources)
        result = {'reviewed_at': snapshots['reviewed_at'], 'profile_version': profiles['version'],
                  'scope': 'Domain references in selected pinned upstream files. References are not proof of universal breakage or permission for promotion. Absence is not evidence of safety.',
                  'source_files': len(sources), 'domains': rows}
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        if args.csv:
            args.csv.parent.mkdir(parents=True, exist_ok=True)
            with args.csv.open('w', encoding='utf-8-sig', newline='') as handle:
                writer = csv.writer(handle)
                writer.writerow(['ドメイン', 'ルール群', '判定', '分類参照数', '例外・互換参照数'])
                for row in rows:
                    writer.writerow([row['domain'], ', '.join(row['rule_sets']), row['review'],
                                     sum(r['role'] == 'classification' for r in row['references']),
                                     sum(r['role'] != 'classification' for r in row['references'])])
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('UPSTREAM AUDIT FAILED:', error, file=sys.stderr)
        return 1
    print(f'UPSTREAM AUDIT PASSED: {len(rows)} domains, {len(sources)} hash-verified snapshots')
    return 0


if __name__ == '__main__':
    sys.exit(main())
