"""Check metadata, duplicate rules and local include graphs; not a uBO parser."""
from datetime import datetime
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ("Title", "Version", "Expires", "Homepage", "Description", "License")


def validate(root=ROOT):
    errors = []
    paths = sorted(list(root.glob("*.txt")) + list((root / "v2").glob("*.txt")))
    graph = {}
    for path in paths:
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            errors.append(f"{name}: source list must not be a symlink")
            continue
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        if not lines or lines[0] != "[Adblock Plus 2.0]":
            errors.append(f"{name}: missing format header")
        if not text.endswith("\n"):
            errors.append(f"{name}: missing final newline")
        metadata = {}
        for key in REQUIRED:
            values = [line[len(key) + 3:].strip() for line in lines[:30] if line.startswith(f"! {key}:")]
            if len(values) != 1 or not values[0]:
                errors.append(f"{name}: expected exactly one nonempty {key}")
            else:
                metadata[key] = values[0]
        version = metadata.get("Version", "")
        if not re.fullmatch(r"\d{8}\.\d+", version):
            errors.append(f"{name}: invalid version")
        else:
            try:
                datetime.strptime(version[:8], "%Y%m%d")
            except ValueError:
                errors.append(f"{name}: invalid version date")
        if not re.fullmatch(r"[1-9]\d* days?", metadata.get("Expires", "")):
            errors.append(f"{name}: invalid expiry")
        if not metadata.get("Homepage", "").startswith("https://"):
            errors.append(f"{name}: homepage must use HTTPS")
        seen = set()
        graph[path] = []
        for number, line in enumerate(lines, 1):
            line = line.strip()
            if line.startswith("!#include"):
                target_name = line[len("!#include"):].strip()
                target = path.parent / target_name
                if (not target_name or Path(target_name).is_absolute()
                        or ".." in Path(target_name).parts
                        or target.is_symlink() or not target.is_file()
                        or not target.resolve().is_relative_to(path.parent.resolve())):
                    errors.append(f"{name}:{number}: invalid or missing include")
                else:
                    graph[path].append(target)
            if not line or line.startswith(("!", "[")):
                continue
            if line in seen:
                errors.append(f"{name}:{number}: duplicate active rule")
            seen.add(line)
        if not seen:
            # Quarantine marker documents why this unpublished v2 candidate
            # subscription intentionally has zero blocking rules. Never
            # allow empty stable lists or a copy with a different path.
            allowed = (name == "v2/tracking-extra.txt"
                       and "! Status: QUARANTINED_NO_ACTIVE_RULES" in lines
                       and all(not x.startswith("||") for x in lines))
            if not allowed:
                errors.append(f"{name}: no active rules")
    visiting, visited = set(), set()

    def visit(path):
        if path in visiting:
            errors.append(f"{path.relative_to(root)}: include cycle")
            return
        if path in visited:
            return
        if path not in graph:
            errors.append(f"{path.relative_to(root)}: include target outside validated lists")
            return
        visiting.add(path)
        for target in graph[path]:
            visit(target)
        visiting.remove(path)
        visited.add(path)

    for path in graph:
        visit(path)
    if not paths:
        errors.append("no filter lists found")
    return errors


if __name__ == "__main__":
    errors = validate()
    for error in errors:
        print("ERROR:", error)
    print("LIST CHECK FAILED" if errors else "LIST CHECK PASSED: metadata, duplicate rules, include graph")
    sys.exit(bool(errors))
