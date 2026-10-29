"""Read-only compatibility checks for stable public filter subscription paths.

This checks path permanence and basic headers; it neither parses filter rules
nor replaces scripts/validate_lists.py or the actual engine checks.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://raw.githubusercontent.com/r20942097-hue/s/main/"
PUBLIC = (
    "ad.txt", "ad-ubo.txt", "tracking.txt",
    "japanese-text-softener.txt", "japanese-text-softener-deep.txt",
    "twitch-custom-optional.txt", "v2/ad.txt", "v2/tracking.txt", "v2/strict.txt",
)


def required_license(name: str) -> str:
    return "GPL-3.0-only" if name.startswith("v2/") else "CC0-1.0"


def check_path(root: Path, name: str) -> list[str]:
    problems = []
    path = root
    for part in Path(name).parts:
        path /= part
        if path.is_symlink():
            return ["symbolic link or linked ancestor"]
    if not path.is_file():
        return ["missing subscription file or wrong file type"]
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return ["file unreadable as UTF-8"]
    lines = content.splitlines()
    if not lines or lines[0] != "[Adblock Plus 2.0]":
        problems.append("missing Adblock Plus header")
    if not content.endswith("\n"):
        problems.append("missing trailing newline")
    fields: dict[str, list[str]] = {}
    for line in lines[:45]:
        if line.startswith("! ") and ":" in line[2:]:
            key, value = line[2:].split(":", 1)
            fields.setdefault(key.strip(), []).append(value.strip())
    if len(fields.get("Title", [])) != 1 or not fields["Title"][0]:
        problems.append("title metadata missing or duplicated")
    if fields.get("License", []) != [required_license(name)]:
        problems.append("license metadata mismatch")
    if fields.get("Homepage", []) != ["https://github.com/r20942097-hue/s"]:
        problems.append("homepage metadata mismatch")
    if "Subscription" in fields and fields["Subscription"] != [BASE + name]:
        problems.append("subscription URL metadata mismatch")
    return problems


def check(root: Path) -> dict:
    root = Path(root)
    issues = {name: errors for name in PUBLIC if (errors := check_path(root, name))}
    return {"status": "FAIL" if issues else "PASS", "schema": "gpt1-subscription-contract/v1",
            "scope": "stable path/header compatibility only", "checked_paths": len(PUBLIC),
            "issues": issues, "published_url_base": BASE,
            "note": "Does not claim rule behavior, engine compatibility, or live subscription success."}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result = check(args.root)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{result['status']}: {result['checked_paths']} published filter paths checked")
        for name, items in result["issues"].items():
            print(f"ERROR {name}: {'; '.join(items)}")
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
