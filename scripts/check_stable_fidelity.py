"""CI guard for unchanged public filter assets, pinned to known main Git blobs.

This prevents accidental churn while a candidate branch is being tested.
It does NOT make mutable pull-request source/metadata a trusted approval gate.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "verification/stable-fidelity-lock.json"
SHA40 = re.compile(r"[0-9a-f]{40}\Z")
FILES = frozenset({
    "ad.txt", "ad-ubo.txt", "tracking.txt", "v2/ad.txt", "v2/strict.txt",
    "twitch-custom-optional.txt", "japanese-text-softener.txt",
    "japanese-text-softener-deep.txt"
})


def git_blob_sha(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def validate_manifest(manifest):
    if (not isinstance(manifest, dict)
            or manifest.get("schema") != "filter-stable-fidelity/v1"
            or manifest.get("publication_hold") is not True
            or manifest.get("require_owner_review_for_pin_changes") is not True
            or not isinstance(manifest.get("baseline_commit"), str)
            or not SHA40.fullmatch(manifest["baseline_commit"])
            or not isinstance(manifest.get("files"), dict)
            or set(manifest["files"]) != FILES):
        raise ValueError("incomplete or unauthorized protected asset manifest")
    for path, sha in manifest["files"].items():
        if not isinstance(sha, str) or not SHA40.fullmatch(sha):
            raise ValueError("invalid pinned Git blob: " + path)


def pinned_git_tree(root, manifest):
    """Read independent blob identities from a fixed Git commit object.

    Unlike the editable lock manifest, the referenced Git tree cannot be
    rewritten without changing the historical commit's identity.
    """
    validate_manifest(manifest)
    args = ["git", "-C", str(root), "ls-tree", "-rz", "--full-tree",
            manifest["baseline_commit"], "--", *sorted(FILES)]
    process = subprocess.run(args, capture_output=True, check=False, timeout=20)
    if process.returncode:
        raise ValueError("pinned base commit is not a readable Git tree")
    observed = {}
    for entry in process.stdout.split(b"\0"):
        if not entry:
            continue
        try:
            metadata, encoded_path = entry.split(b"\t", 1)
            mode, kind, sha = metadata.split(b" ")
            name = encoded_path.decode("utf-8")
            digest = sha.decode("ascii")
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError("malformed Git tree entry") from exc
        if name not in FILES or mode != b"100644" or kind != b"blob" or not SHA40.fullmatch(digest):
            raise ValueError("unexpected or non-regular protected asset in base tree")
        observed[name] = digest
    if set(observed) != FILES:
        raise ValueError("missing protected assets in pinned Git tree")
    return observed


def verify(root, manifest, base_tree=None):
    validate_manifest(manifest)
    errors = []
    if base_tree is not None:
        if not isinstance(base_tree, dict) or set(base_tree) != FILES:
            errors.append("missing or invalid independent Git base tree")
        else:
            for path in sorted(FILES):
                if base_tree[path] != manifest["files"][path]:
                    errors.append(path + ": editable pin conflicts with independent Git base tree")
    identities = {}
    root = root.resolve()
    for name, pinned in sorted(manifest["files"].items()):
        path = root / name
        if not path.resolve().is_relative_to(root):
            errors.append(name + ": path escapes repository")
            continue
        if any(part.is_symlink() for part in (path, *path.parents) if part != root):
            errors.append(name + ": symlink forbidden")
            continue
        if not path.is_file():
            errors.append(name + ": missing or not a regular file")
            continue
        observed = git_blob_sha(path.read_bytes())
        identities[name] = observed
        if observed != pinned:
            errors.append(name + ": stable Git blob changed from pin")
    return errors, {"schema": "filter-stable-fidelity-check/v1",
                    "protected_asset_count": len(manifest["files"]),
                    "verified_asset_count": len(identities),
                    "baseline_commit": manifest["baseline_commit"],
                    "independent_base_tree": "PASS" if base_tree is not None and not any("base tree" in err for err in errors) else "NOT_RUN" if base_tree is None else "FAIL",
                    "publication_hold": True, "live_site_e2e": "NOT_RUN",
                    "status": "FAIL" if errors else "PASS",
                    "errors": errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="optional JSON report")
    parser.add_argument("--verify-base-tree", action="store_true",
                        help="cross-check editable pins against immutable Git tree; requires fetched base commit")
    args = parser.parse_args()
    try:
        manifest = json.loads(LOCK.read_text(encoding="utf-8"))
        base_tree = pinned_git_tree(ROOT, manifest) if args.verify_base_tree else None
        errors, report = verify(ROOT, manifest, base_tree=base_tree)
        if args.report:
            target = args.report.resolve()
            if target.is_relative_to(ROOT.resolve()):
                raise ValueError("report must be outside the protected repository")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print("STABLE FIDELITY FAILED:", exc, file=sys.stderr)
        return 1
    for item in errors:
        print("ERROR:", item)
    print("STABLE FIDELITY:", report["status"], "-", report["verified_asset_count"],
          "/", report["protected_asset_count"], "pinned assets")
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
