"""Generate network lists from filter-profiles.json; mirror export is explicit."""
import argparse
from datetime import datetime
import difflib
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PROFILE_PATH = ROOT / "filter-profiles.json"
RULE_RE = re.compile(r"^\|\|([a-z0-9.-]+)(?:\^|/[^$]*)\$third-party(?:,script)?$")
WINDOWS_RESERVED = {'CON', 'PRN', 'AUX', 'NUL'} | {prefix + str(i) for prefix in ('COM', 'LPT') for i in range(1, 10)}


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def valid_relative(value):
    return (isinstance(value, str) and bool(value)
            and all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', part)
                    and len(part) <= 255 and not part.endswith('.') and part.split('.')[0].upper() not in WINDOWS_RESERVED
                    for part in value.split('/')))


def single_line(value):
    return isinstance(value, str) and not any(ord(c) < 32 or 0x7f <= ord(c) < 0xa0 or 0xd800 <= ord(c) <= 0xdfff or c in '\u2028\u2029' for c in value)


def valid_hostname(host):
    if len(host) > 253 or '.' not in host:
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        return all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part)
                   for part in host.split('.'))


def valid_version(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{8}\.\d+", value):
        return False
    try:
        datetime.strptime(value[:8], "%Y%m%d")
    except ValueError:
        return False
    return True


def validate_profiles(data):
    errors = []
    if not isinstance(data, dict) or data.get("schema") != "filter-profiles/v1":
        return ["unsupported profile schema"]
    version = data.get("version", "")
    if not valid_version(version):
        errors.append("invalid version: expected YYYYMMDD.N with a real date")
    reviewed = data.get("reviewed_at")
    try:
        if not isinstance(reviewed, str) or datetime.strptime(reviewed, "%Y-%m-%d").date().isoformat() != reviewed:
            raise ValueError()
    except ValueError:
        errors.append("reviewed_at must use YYYY-MM-DD")
    sets = data.get("rule_sets")
    if not isinstance(sets, dict) or not sets:
        return errors + ["rule_sets must be a nonempty object"]
    for key, entry in sets.items():
        if not isinstance(entry, dict):
            errors.append(f"{key}: rule set must be an object")
            continue
        label = entry.get('label')
        if not single_line(label) or not label.strip():
            errors.append(f"{key}: label must be a nonempty single line")
        rules = entry.get("rules")
        # This single retired, never-published proposal output is intentionally
        # kept as a zero-rule explanatory placeholder. All other lists must
        # retain active rules. Never generalize this exception.
        dormant = (key == "privacy-optional-20261030"
                   and entry.get("disabled") is True and rules == [])
        if not isinstance(rules, list) or (not rules and not dormant):
            errors.append(f"{key}: rules must be a nonempty array")
            continue
        seen = set()
        for rule in rules:
            match = RULE_RE.fullmatch(rule) if single_line(rule) else None
            if match is None:
                errors.append(f"{key}: unsupported rule: {rule!r}")
                continue
            host = match.group(1)
            if not valid_hostname(host):
                errors.append(f"{key}: invalid hostname: {host}")
            if rule in seen:
                errors.append(f"{key}: duplicate rule: {rule}")
            seen.add(rule)
        if not isinstance(entry.get('license'), str) or entry.get("license") not in {"CC0-1.0", "GPL-3.0-only"}:
            errors.append(f"{key}: unsupported license")
    outputs = data.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        return errors + ["outputs must be a nonempty array"]
    seen_outputs = set()
    for output in outputs:
        if not isinstance(output, dict):
            errors.append("output must be an object")
            continue
        path, scope = output.get("path"), output.get("scope")
        if not isinstance(scope, str) or scope not in {"s", "faaff"} or not valid_relative(path) or not path.endswith('.txt'):
            errors.append("invalid output scope or path")
            continue
        identity = (scope, path.casefold())
        if any(old_scope == scope and (old_path == identity[1]
               or old_path.startswith(identity[1] + '/') or identity[1].startswith(old_path + '/'))
               for old_scope, old_path in seen_outputs):
            errors.append(f"duplicate output or conflicting file/directory path: {scope}/{path}")
        seen_outputs.add(identity)
        headers = output.get("headers")
        if not isinstance(headers, list) or any(not single_line(line) or not line.startswith('! ') for line in headers):
            errors.append(f"{path}: invalid headers")
            continue
        values = {}
        for key in ("Title", "Version", "Expires", "Homepage", "Subscription", "Description", "License"):
            matching = [line[len(key)+3:].strip() for line in headers if line.startswith(f'! {key}:')]
            if len(matching) != 1 or not matching[0]:
                errors.append(f"{path}: expected one nonempty {key}")
            else:
                values[key] = matching[0]
        output_version = output.get('version', version)
        if not valid_version(output_version):
            errors.append(f"{path}: invalid output version")
        elif values.get('Version', '').replace('{version}', output_version) != output_version:
            errors.append(f"{path}: output Version must match the output version")
        if not re.fullmatch(r'[1-9]\d* days?', values.get('Expires', '')):
            errors.append(f"{path}: Expires must be a positive number of days")
        for key in ('Homepage', 'Subscription'):
            if not values.get(key, '').startswith('https://'):
                errors.append(f"{path}: {key} must use HTTPS")
        keys = output.get("rule_sets")
        if not isinstance(keys, list) or not keys or any(not isinstance(key, str) or key not in sets for key in keys):
            errors.append(f"{path}: unknown rule set")
            continue
        active, licenses = [], set()
        for key in keys:
            if not isinstance(sets[key], dict) or not isinstance(sets[key].get('rules'), list):
                continue
            active.extend(rule for rule in sets[key]['rules'] if isinstance(rule, str))
            value = sets[key].get('license')
            if isinstance(value, str):
                licenses.add(value)
        if len(active) != len(set(active)):
            errors.append(f"{path}: duplicate rules across rule sets")
        if not active:
            allowed_dormant = (scope == "s" and path == "v2/tracking-extra.txt"
                               and keys == ["privacy-optional-20261030"]
                               and sets["privacy-optional-20261030"].get("disabled") is True
                               and "! Status: QUARANTINED_NO_ACTIVE_RULES" in headers)
            if not allowed_dormant:
                errors.append(f"{path}: empty active rules forbidden outside retired opt-in list")
        if licenses != {values.get('License')}:
            errors.append(f"{path}: output license must match all source rule sets")
        includes = output.get('includes', [])
        if not isinstance(includes, list) or any(not valid_relative(name) or len(Path(name).parts) != 1 for name in includes):
            errors.append(f"{path}: includes must be same-directory filenames")
    return errors


def render(data, output):
    lines = ['[Adblock Plus 2.0]']
    for header in output['headers']:
        lines.append(header.replace('{version}', output.get('version', data['version'])).replace('{reviewed_at}', data['reviewed_at']))
    lines += ['! Generated: filter-profiles.json via scripts/generate_lists.py', '!']
    for key in output['rule_sets']:
        entry = data['rule_sets'][key]
        lines += ['! ' + entry['label']] + entry['rules'] + ['!']
    if output.get('includes'):
        lines += ['! uBlock Origin extensions; other blockers ignore include directives.']
        lines += ['!#include ' + name for name in output['includes']]
    return '\n'.join(lines).rstrip() + '\n'


def output_path(root, relative):
    if not valid_relative(relative):
        raise ValueError('unsafe output path')
    target = root / relative
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('output escapes root')
    for part in [target, *target.parents]:
        if part == root.parent:
            break
        if part.is_symlink():
            raise ValueError(f'symlink output is forbidden: {relative}')
        if part.exists() and (not part.is_file() if part == target else not part.is_dir()):
            raise ValueError(f'output path is not a regular file or directory: {relative}')
    return target


def generate(data, roots, check=False, dry_run=False):
    errors = validate_profiles(data)
    if errors:
        return errors
    pending = []
    for output in data['outputs']:
        if output['scope'] not in roots:
            continue
        root = roots[output['scope']]
        target = output_path(root, output['path'])
        content = render(data, output)
        current = target.read_text(encoding='utf-8') if target.is_file() else ''
        if current == content:
            continue
        if check:
            errors.append(f"stale generated filter: {output['scope']}/{output['path']}")
        elif dry_run:
            sys.stdout.writelines(difflib.unified_diff(current.splitlines(True), content.splitlines(True), fromfile=str(target), tofile=str(target)+' (generated)'))
        else:
            pending.append((target, content))
    # Prepare the full plan before replacing any file, so bad paths cannot cause a partial update.
    for target, content in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=target.parent, delete=False) as handle:
            handle.write(content)
            temporary = Path(handle.name)
        try:
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--mirror-root', type=Path, help='explicit faaff checkout for compatibility exports')
    args = parser.parse_args()
    roots = {'s': ROOT}
    if args.mirror_root:
        if not args.mirror_root.is_dir():
            parser.error('mirror root must be an existing directory')
        roots['faaff'] = args.mirror_root.resolve()
    try:
        data = json.loads(PROFILE_PATH.read_text(encoding='utf-8'), object_pairs_hook=reject_duplicate_keys)
        errors = generate(data, roots, check=args.check, dry_run=args.dry_run)
    except (OSError, ValueError, TypeError) as exc:
        errors = [str(exc)]
    for error in errors:
        print('ERROR:', error)
    print('GENERATION FAILED' if errors else 'GENERATION CHECK PASSED' if args.check else 'GENERATION PLAN SHOWN' if args.dry_run else 'GENERATION PASSED')
    return bool(errors)


if __name__ == '__main__':
    sys.exit(main())
