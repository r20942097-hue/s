"""Immutable, independent EasyPrivacy comparison — never alters a filter.

A source match means observed in these selected upstream files only. It is not
a measurement of installed-list behavior or user-visible blocking effectiveness.
"""
import hashlib
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen
from pinned_snapshot_cache import verified_read

ROOT = Path(__file__).resolve().parents[1]
REPO = "easylist/easylist"
PATHS = frozenset({
    "easyprivacy/easyprivacy_trackingservers_thirdparty.txt",
    "easyprivacy/easyprivacy_trackingservers_international.txt"
})
SHA40 = re.compile(r"[a-f0-9]{40}\Z")
NETWORK = re.compile(r"^\|\|([a-z0-9.-]+)(\^|/)")
FULL_HOST = re.compile(r"^\|\|([a-z0-9.-]+)\^(?:\$third-party)?$")
MAX_BYTES = 1_000_000


def git_blob_sha(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def validate_baselines(info):
    if (not isinstance(info, dict) or info.get("schema") != "filter-independent-baselines/v1"
            or info.get("auto_promote") is not False or info.get("live_site_e2e") != "NOT_RUN"):
        raise ValueError("baseline governance schema invalid")
    rows = info.get("sources")
    if not isinstance(rows, list) or len(rows) != len(PATHS):
        raise ValueError("baseline source count mismatch")
    commits, paths = set(), set()
    for row in rows:
        if not isinstance(row, dict) or row.get("repository") != REPO:
            raise ValueError("independent baseline repository mismatch")
        for key in ("commit", "git_blob_sha"):
            if not isinstance(row.get(key), str) or not SHA40.fullmatch(row[key]):
                raise ValueError("unverified independent baseline commit/blob")
        if row.get("path") not in PATHS or row["path"] in paths:
            raise ValueError("unexpected or duplicate independent baseline path")
        commits.add(row["commit"])
        paths.add(row["path"])
    if paths != PATHS or len(commits) != 1:
        raise ValueError("baseline files must come from one immutable commit")


def fetch_baselines(info, retrieve=None):
    validate_baselines(info)
    result = {}
    for source in info["sources"]:
        uri = f'https://raw.githubusercontent.com/{REPO}/{source["commit"]}/{source["path"]}'
        data = verified_read(uri, source["git_blob_sha"], MAX_BYTES,
                             "filter-crosscheck/1", retrieve=retrieve)
        result[source["path"]] = data.decode("utf-8-sig")
    return result


def observed_network_hosts(sources):
    """Index literal host observations by their actual rule coverage *shape*.

    This is an intentionally conservative syntax subset. A path, type, domain,
    redirect, negated option or other modifier does not demonstrate an all-type
    third-party block. A plain ||host^ covers third-party requests as well as
    first-party; ||host^$third-party covers third-party requests.
    """
    matches = {}
    for name, text in sources.items():
        if name not in PATHS or not isinstance(text, str):
            raise ValueError("unknown independent baseline source or invalid text")
        full, restricted = set(), set()
        for line in text.splitlines():
            if line.startswith(("@@", "!")):
                continue
            match = NETWORK.match(line)
            if match is None:
                continue
            host = match.group(1)
            if FULL_HOST.fullmatch(line):
                full.add(host)
            else:
                restricted.add(host)
        matches[name] = {"full": full, "restricted": restricted}
    if set(matches) != PATHS:
        raise ValueError("incomplete independent baseline text set")
    return matches


def observed_scope(host, sources):
    """Return selected file and scope of a host/ancestor match, not an engine verdict.

    Full is prioritized over any restricted reference. This does not evaluate
    other list exceptions, CNAMEs, content types or installed list settings.
    """
    if sources is None:
        return None
    parts = host.split(".")
    ancestors = tuple(".".join(parts[i:]) for i in range(len(parts)-1))
    for scope in ("full", "restricted"):
        for path in sorted(sources):
            groups = sources[path]
            if not isinstance(groups, dict) or set(groups) != {"full", "restricted"}:
                raise ValueError("unexpected independent match group")
            for ancestor in ancestors:
                if ancestor in groups[scope]:
                    return {"path": path, "scope": scope, "matched_host": ancestor}
    return None


def observed_reference(host, sources):
    """Backwards-compatible source file lookup; use observed_scope for strength."""
    match = observed_scope(host, sources)
    return match["path"] if match is not None else None
