#!/usr/bin/env python3
"""Fail-closed static checks for the three v2 ABP-style filter lists."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {
    "ad.txt": "https://raw.githubusercontent.com/r20942097-hue/s/main/v2/ad.txt",
    "tracking.txt": "https://raw.githubusercontent.com/r20942097-hue/s/main/v2/tracking.txt",
    "strict.txt": "https://raw.githubusercontent.com/r20942097-hue/s/main/v2/strict.txt",
}
VERSION_RE = re.compile(r"^! Version: (\d{8}\.\d+)$")
RULE_HOST_RE = re.compile(r"^\|\|([A-Za-z0-9.-]+)(\^|/)")
VALID_HOST_RE = re.compile(r"^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$")
FORBIDDEN_MODIFIERS = ("important", "redirect=", "removeparam=", "replace=", "csp=", "permissions=")


def check_list(name: str, expected_url: str) -> tuple[list[str], set[str]]:
    path = ROOT / name
    errors: list[str] = []
    domains: set[str] = set()
    if not path.is_file():
        return [f"{name}: missing file"], domains

    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "[Adblock Plus 2.0]":
        errors.append(f"{name}: missing ABP header")
    if not any(line.startswith("! Expires: ") for line in lines):
        errors.append(f"{name}: missing expiry metadata")
    if f"! Subscription: {expected_url}" not in lines:
        errors.append(f"{name}: subscription URL does not match the public path")
    if "! License: GPL-3.0-only" not in lines:
        errors.append(f"{name}: missing declared license")

    version = next((VERSION_RE.match(line) for line in lines if VERSION_RE.match(line)), None)
    if not version:
        errors.append(f"{name}: version must use YYYYMMDD.counter format")
    else:
        reviewed = next((line.removeprefix("! Last reviewed: ") for line in lines if line.startswith("! Last reviewed: ")), None)
        if not reviewed:
            errors.append(f"{name}: missing last-reviewed date")
        elif version.group(1)[:8] != reviewed.replace("-", ""):
            errors.append(f"{name}: version date and last-reviewed date disagree")

    seen_rules: set[str] = set()
    for number, raw_line in enumerate(lines, 1):
        line = raw_line.strip()
        if not line or line.startswith("!") or line == "[Adblock Plus 2.0]":
            continue
        if line in seen_rules:
            errors.append(f"{name}:{number}: duplicate rule")
        seen_rules.add(line)
        if not line.startswith("||"):
            errors.append(f"{name}:{number}: only explicit network rules are allowed")
            continue
        match = RULE_HOST_RE.match(line)
        if not match or not VALID_HOST_RE.fullmatch(match.group(1)):
            errors.append(f"{name}:{number}: invalid or overly broad host rule")
            continue
        domains.add(match.group(1).lower())
        modifiers = line.split("$", 1)[1].lower() if "$" in line else ""
        modifier_tokens = modifiers.split(",")
        if "third-party" not in modifier_tokens or "~third-party" in modifier_tokens:
            errors.append(f"{name}:{number}: rule must be explicitly third-party")
        if any(token in modifiers for token in FORBIDDEN_MODIFIERS):
            errors.append(f"{name}:{number}: forbidden forceful or rewriting modifier")

    if not domains:
        errors.append(f"{name}: no valid network rules found")
    return errors, domains


def main() -> int:
    failures: list[str] = []
    all_domains: dict[str, str] = {}
    counts: dict[str, int] = {}
    for name, url in EXPECTED.items():
        errors, domains = check_list(name, url)
        failures.extend(errors)
        counts[name] = len(domains)
        for domain in domains:
            prior = all_domains.get(domain)
            if prior:
                failures.append(f"{name}: {domain} duplicates a host already present in {prior}")
            else:
                all_domains[domain] = name

    if failures:
        print("FAIL")
        print("\n".join(f"- {item}" for item in failures))
        return 1
    print("PASS: static metadata and policy checks")
    for name, count in counts.items():
        print(f"{name}: {count} unique network hosts")
    print("Scope: static checks only; no browser, site-breakage, or false-positive result is implied.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
