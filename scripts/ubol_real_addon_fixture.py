"""Isolated load of the real official uBO Lite MV3 Chromium release.

A pinned, official release ZIP is SHA-256 verified before unpacking; only one
manifest is permitted, and extraction rejects symlinks, traversal and bombs.
An ephemeral Playwright Chromium profile loads the UNMODIFIED extension.

This does NOT install candidate lists or test live websites. Default ruleset
activation verifies extension boot, NOT the efficacy of proposed filters.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import tempfile
from urllib.request import Request, urlopen
import zipfile

from audit_filter_candidates import ROOT

LOCK_PATH = ROOT / "verification/ubol-release-lock.json"
ASSET = "uBOLite_2026.1026.1812.chromium.zip"
RELEASE_URL = (
    "https://github.com/uBlockOrigin/uBOL-home/releases/download/"
    "2026.1026.1812/" + ASSET
)
SHA256 = "d3788eac9f0a44c67f3745a43c3fd446ef33d56b1121f469b19e0fa0a836c2b5"


def validate_lock(info):
    if (not isinstance(info, dict)
            or info.get("schema") != "filter-real-addon-fixture/v1"
            or info.get("source_repository") != "uBlockOrigin/uBOL-home"
            or info.get("release_tag") != "2026.1026.1812"
            or info.get("asset_name") != ASSET
            or info.get("asset_url") != RELEASE_URL
            or info.get("sha256") != SHA256
            or info.get("size_bytes") != 9009606
            or info.get("max_archive_bytes") != 18000000
            or info.get("max_total_extracted_bytes") != 150000000
            or info.get("max_members") != 10000
            or info.get("test_only") is not True
            or info.get("never_commit_archive") is not True
            or info.get("publication") != "NO_GO"
            or info.get("real_site_e2e") != "NOT_RUN"):
        raise ValueError("unapproved or unsafe real-addon release pin")


def verify_archive_bytes(data, lock):
    validate_lock(lock)
    if not isinstance(data, bytes) or len(data) != lock["size_bytes"]:
        raise ValueError("real-addon asset length differs from pinned release")
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError("real-addon release SHA256 mismatch")


def fetch_archive(lock):
    validate_lock(lock)
    with urlopen(Request(RELEASE_URL, headers={"User-Agent": "isolated-real-ubol-test/1"}),
                 timeout=60) as response:
        data = response.read(lock["max_archive_bytes"] + 1)
    verify_archive_bytes(data, lock)
    return data


def inspect_zip(archive, lock):
    validate_lock(lock)
    if len(archive.infolist()) > lock["max_members"]:
        raise ValueError("too many extension archive entries")
    seen = set()
    total = 0
    manifests = []
    for item in archive.infolist():
        raw = item.filename
        path = PurePosixPath(raw)
        if (not raw or "\x00" in raw or "\\" in raw or path.is_absolute()
                or any(part in ("..", ".", "") for part in raw.strip("/").split("/"))
                or ":" in raw or raw.startswith("/")):
            raise ValueError("unsafe extension archive member path")
        folded = raw.rstrip("/").casefold()
        if folded in seen:
            raise ValueError("duplicate extension archive member")
        seen.add(folded)
        mode = item.external_attr >> 16
        if stat.S_ISLNK(mode) or (mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
            raise ValueError("symlink or device member forbidden")
        total += item.file_size
        if item.file_size > lock["max_total_extracted_bytes"] or total > lock["max_total_extracted_bytes"]:
            raise ValueError("extension archive uncompressed size exceeds limit")
        if path.name == "manifest.json" and not item.is_dir():
            manifests.append(path)
    if len(manifests) != 1:
        raise ValueError("expected exactly one Chromium manifest")
    return manifests[0]


def extract_verified(data, lock, destination):
    from io import BytesIO
    verify_archive_bytes(data, lock)
    with zipfile.ZipFile(BytesIO(data)) as archive:
        manifest_path = inspect_zip(archive, lock)
        destination = Path(destination).resolve()
        if destination.is_relative_to(ROOT.resolve()):
            raise ValueError("real addon extraction must be outside repository")
        destination.mkdir(parents=True, exist_ok=False)
        archive.extractall(destination)
    extension_root = destination / manifest_path.parent
    manifest = json.loads((extension_root / "manifest.json").read_text(encoding="utf-8"))
    if (manifest.get("manifest_version") != 3
            or not isinstance(manifest.get("name"), str)
            or not isinstance(manifest.get("background"), dict)
            or not isinstance(manifest["background"].get("service_worker"), str)
            or not isinstance(manifest.get("declarative_net_request"), dict)):
        raise ValueError("unrecognized official uBOL Chromium extension manifest")
    return extension_root, manifest


def validate_runtime_identity(runtime, source):
    """Manifest names are localized from __MSG_*__; versions are invariant."""
    if (not isinstance(runtime, dict)
            or runtime.get("manifest_version") != 3
            or runtime.get("version") != source.get("version")
            or not isinstance(runtime.get("name"), str)
            or not runtime["name"].strip()
            or runtime["name"].startswith("__MSG_")
            or not isinstance(runtime.get("enabled_ruleset_ids"), list)
            or not runtime["enabled_ruleset_ids"]):
        raise ValueError(
            "uBO Lite identity or default DNR rulesets not verified: "
            + json.dumps({
                "version": runtime.get("version") if isinstance(runtime, dict) else None,
                "name": runtime.get("name") if isinstance(runtime, dict) else None,
                "enabled_ruleset_count": len(runtime.get("enabled_ruleset_ids", []))
                    if isinstance(runtime, dict)
                    and isinstance(runtime.get("enabled_ruleset_ids"), list) else None
            }, ensure_ascii=False)
        )
    # Preserve signed package identity; resolved display names are expected to
    # differ from localization tokens in the original manifest.
    if not source.get("name", "").startswith("__MSG_"):
        if runtime["name"] != source["name"]:
            raise ValueError("unexpected extension display name")
    declared = {item["id"] for item in
                source.get("declarative_net_request", {}).get("rule_resources", [])
                if item.get("enabled") is True}
    if not declared or not set(runtime["enabled_ruleset_ids"]).issubset(
            {item["id"] for item in source["declarative_net_request"]["rule_resources"]}):
        raise ValueError("enabled DNR rulesets differ from official manifest")
    return True


def measure_hypothetical_dnr(worker):
    """Best-effort, read-only rule-match observations in official stock uBOL.

    testMatchOutcome is a developer-only API for unpacked extensions. It may
    be denied without debug/feedback permissions; that is NOT_RUN, not a
    fabricated PASS. Rule matches do not necessarily mean 'block' actions.
    """
    candidate_hosts = (
        "match.prod.bidr.io", "sync.adkernel.com", "sync.richaudience.com",
        "id5-sync.com", "event.getblue.io", "sync.ebis.ne.jp",
        "pixel.wetracked.io"
    )
    observed = worker.evaluate("""async hosts => {
        const result = [];
        const api = chrome.declarativeNetRequest.testMatchOutcome;
        if (typeof api !== 'function') {
            return { status: 'NOT_SUPPORTED', cases: [], reason: 'API unavailable' };
        }
        for (const host of hosts) {
            try {
                const r = await api({
                    url: 'https://' + host + '/pixel.gif',
                    initiator: 'https://example.org/',
                    type: 'image',
                    method: 'get'
                });
                const matches = [];
                for (const row of (r.matchedRules || [])) {
                    let actionType = 'UNKNOWN';
                    let reason = null;
                    try {
                        let found = [];
                        if (row.rulesetId === '_dynamic') {
                            found = await chrome.declarativeNetRequest.getDynamicRules(
                                { ruleIds: [row.ruleId] });
                        } else if (row.rulesetId === '_session') {
                            found = await chrome.declarativeNetRequest.getSessionRules(
                                { ruleIds: [row.ruleId] });
                        } else {
                            found = await chrome.declarativeNetRequest.getStaticRules({
                                rulesetId: row.rulesetId,
                                ruleIds: [row.ruleId]
                            });
                        }
                        if (found.length === 1) {
                            actionType = found[0].action.type;
                        }
                    } catch (error) {
                        // Keep the observation, never assume a block action.
                        reason = String(error && error.message || error).slice(0, 120);
                    }
                    matches.push({
                        ruleset_id: row.rulesetId || null,
                        rule_id: row.ruleId,
                        action_type: actionType,
                        action_lookup_error: reason
                    });
                }
                result.push({
                    host, matched_rule_count: matches.length,
                    block_action_count: matches.filter(row => row.action_type === 'block').length,
                    matched_rules: matches
                });
            } catch (error) {
                return { status: 'NOT_SUPPORTED', cases: [],
                         reason: String(error && error.message || error).slice(0, 160) };
            }
        }
        return { status: 'OBSERVED', cases: result };
    }""", list(candidate_hosts))
    if observed["status"] == "OBSERVED":
        if (len(observed["cases"]) != 7
                or [r["host"] for r in observed["cases"]] != list(candidate_hosts)):
            raise ValueError("incomplete hypothetical DNR request observations")
    return observed


def resolve_official_rule_actions(extension_root, manifest, observation):
    """Lookup Chrome-reported rule IDs in verified, unmodified release JSON.

    Only after reading the SHA-verified ZIP do we resolve action types. This
    never writes to the extension or infers an action from hostname alone.
    A match can still be overridden by browser behavior/runtime exceptions.
    """
    if observation.get("status") != "OBSERVED":
        return observation
    extension_root = Path(extension_root).resolve()
    sources = {}
    for row in manifest["declarative_net_request"]["rule_resources"]:
        rel = row["path"].lstrip("/")
        candidate = extension_root / rel
        if (not candidate.resolve().is_relative_to(extension_root)
                or any(p.is_symlink() for p in (candidate, *candidate.parents)
                       if p != extension_root)
                or row["id"] in sources):
            raise ValueError("unsafe or duplicate official static ruleset path")
        sources[row["id"]] = candidate
    needed = {}
    for case in observation["cases"]:
        for match in case["matched_rules"]:
            ruleset = match["ruleset_id"]
            if ruleset in ("_dynamic", "_session"):
                continue
            if ruleset not in sources:
                raise ValueError("browser-reported ruleset absent from official manifest")
            needed.setdefault(ruleset, set()).add(match["rule_id"])
    resolved = {}
    for ruleset, rule_ids in needed.items():
        src = sources[ruleset]
        if not src.is_file() or src.stat().st_size > 150_000_000:
            raise ValueError("unreadable or oversized official ruleset")
        raw_rules = json.loads(src.read_text(encoding="utf-8"))
        if not isinstance(raw_rules, list):
            raise ValueError("unexpected official static ruleset shape")
        entries = {}
        for rule in raw_rules:
            identifier = rule.get("id")
            if identifier not in rule_ids:
                continue
            action = rule.get("action", {}).get("type")
            if action not in ("block", "allow", "allowAllRequests", "redirect",
                              "upgradeScheme", "modifyHeaders"):
                raise ValueError("unknown DNR action type in official rule")
            if identifier in entries:
                raise ValueError("duplicate official static rule ID")
            entries[identifier] = action
        resolved[ruleset] = entries
    for case in observation["cases"]:
        for item in case["matched_rules"]:
            kind = resolved.get(item["ruleset_id"], {}).get(item["rule_id"])
            if kind is not None:
                item["action_type"] = kind
                item["action_lookup_error"] = None
        case["block_action_count"] = sum(
            item["action_type"] == "block" for item in case["matched_rules"])
        case["unresolved_actions"] = sum(
            item["action_type"] == "UNKNOWN" for item in case["matched_rules"])
    observation["action_lookup"] = "SHA256_VERIFIED_OFFICIAL_STATIC_RULES"
    return observation


def exercise_browser(extension_root, manifest):
    from playwright.sync_api import sync_playwright
    with tempfile.TemporaryDirectory(prefix="ubol-profile-") as profile, sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True,
            args=[f"--disable-extensions-except={extension_root}",
                  f"--load-extension={extension_root}"],
        )
        try:
            workers = context.service_workers
            sw = workers[0] if workers else context.wait_for_event("serviceworker", timeout=30000)
            if not sw.url.startswith("chrome-extension://"):
                raise ValueError("real extension service worker not running")
            result = sw.evaluate("""async () => {
                const observed = chrome.runtime.getManifest();
                let ids = [];
                for (let i = 0; i < 30; i++) {
                    ids = await chrome.declarativeNetRequest.getEnabledRulesets();
                    if (ids.length > 0) break;
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                return {
                    id: chrome.runtime.id,
                    name: observed.name,
                    version: observed.version,
                    manifest_version: observed.manifest_version,
                    enabled_ruleset_ids: ids
                };
            }""")
            validate_runtime_identity(result, manifest)
            result["hypothetical_dnr"] = resolve_official_rule_actions(
                extension_root, manifest, measure_hypothetical_dnr(sw))
            page = context.new_page()
            page.goto("about:blank")
            if page.evaluate("document.readyState") != "complete":
                raise ValueError("real extension crashed Chromium")
            page.close()
            return result
        finally:
            context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = {"schema": "filter-real-ubol-ci/v1",
              "release_tag": "2026.1026.1812",
              "asset_sha256": SHA256,
              "archive_verified": False,
              "extension_loaded": "NOT_RUN",
              "active_rulesets": 0,
              "live_site_e2e": "NOT_RUN",
              "candidate_subscription_e2e": "NOT_RUN",
              "real_firefox_ubo": "NOT_RUN",
              "publication": "NO_GO"}
    try:
        lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        data = fetch_archive(lock)
        report["archive_verified"] = True
        with tempfile.TemporaryDirectory(prefix="real-ubol-") as directory:
            root, manifest = extract_verified(data, lock, Path(directory) / "unpacked")
            result = exercise_browser(root, manifest)
            report["extension_loaded"] = "PASS"
            report["active_rulesets"] = len(result["enabled_ruleset_ids"])
            report["extension_version"] = result["version"]
            report["stock_dnr_hypothetical"] = result["hypothetical_dnr"]
        if args.report:
            path = args.report.resolve()
            if path.is_relative_to(ROOT.resolve()):
                raise ValueError("report must be outside checkout")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    except Exception as error:
        import traceback
        print("OFFICIAL uBOL EXTENSION FIXTURE FAILED:", type(error).__name__, str(error))
        traceback.print_exc()
        return 1
    stock = report["stock_dnr_hypothetical"]
    print("OFFICIAL uBOL EXTENSION: PASS; default rulesets:", report["active_rulesets"],
          "; hypothetical seven-host matching:", stock["status"],
          "; matched cases:", sum(x["matched_rule_count"] > 0 for x in stock.get("cases", [])),
          "; block-action cases:", sum(x.get("block_action_count", 0) > 0 for x in stock.get("cases", [])),
          "; no candidate subscription or production-site test")
    for case in stock.get("cases", []):
        print("STOCK DNR CASE:", case["host"], "; matches:",
              [(item["ruleset_id"], item["action_type"], item["action_lookup_error"])
               for item in case["matched_rules"]])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
