"""Immutable, independent EasyPrivacy comparison — never alters a filter.

A source match means observed in these selected upstream files only. It is not
a measurement of installed-list behavior or user-visible blocking effectiveness.
"""
import hashlib
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
REPO = "easylist/easylist"
PATHS = frozenset({
    "easyprivacy/easyprivacy_trackingservers_thirdparty.txt",
    "easyprivacy/easyprivacy_trackingservers_international.txt"
})
SHA40 = re.compile(r"[a-f0-9]{40}\Z")
NETWORK = re.compile(r"^\|\|([a-z0-9.-]+)(?:\^|/)")
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
        if retrieve is None:
            request = Request(uri, headers={"User-Agent": "filter-crosscheck/1"})
            with urlopen(request, timeout=30) as response:
                data = response.read(MAX_BYTES + 1)
        else:
            data = retrieve(uri)
        if not isinstance(data, bytes) or len(data) > MAX_BYTES:
            raise ValueError("independent baseline oversized or malformed")
        if git_blob_sha(data) != source["git_blob_sha"]:
            raise ValueError("independent baseline blob digest mismatch")
        result[source["path"]] = data.decode("utf-8-sig")
    return result


def observed_network_hosts(sources):
    """Only recognizes literal ||host^/ style lines; no inference from cosmetic or exceptions."""
    matches = {}
    for name, text in sources.items():
        if name not in PATHS or not isinstance(text, str):
            raise ValueError("unknown independent baseline source or invalid text")
        hosts = set()
        for line in text.splitlines():
            if line.startswith("@@") or line.startswith("!"):
                continue
            match = NETWORK.match(line)
            if match:
                hosts.add(match.group(1))
        matches[name] = hosts
    if set(matches) != PATHS:
        raise ValueError("incomplete independent baseline text set")
    return matches


def observed_reference(host, sources):
    """Host or matching ancestor; no assertion that rule types match or filter applies."""
    parts = host.split(".")
    for path, hosts in sources.items():
        for index in range(len(parts) - 1):
            if ".".join(parts[index:]) in hosts:
                return path
    return None
