"""Read-only PATH/module inventory; does not install, execute or authenticate tools.

A missing PATH command is NOT proof the application is uninstalled.
Python 3.11+; safe for Linux/Windows CI and isolated desktop workspaces.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import platform
import shutil
import sys

TOOLS = {
    "git": ("git",), "python": ("python", "python3", "py"),
    "node": ("node",), "npm": ("npm", "npm.cmd"), "gh": ("gh",),
    "uv": ("uv",), "ffmpeg": ("ffmpeg",), "ffprobe": ("ffprobe",),
    "firefox": ("firefox", "firefox.exe"),
    "chromium": ("chromium", "chromium-browser", "chrome", "chrome.exe",
                 "google-chrome", "msedge", "msedge.exe"),
    "web-ext": ("web-ext", "web-ext.cmd"),
    "actionlint": ("actionlint",), "zizmor": ("zizmor",),
    "shellcheck": ("shellcheck",), "gitleaks": ("gitleaks",),
    "osv-scanner": ("osv-scanner",), "trivy": ("trivy",),
    "syft": ("syft",), "docker": ("docker", "podman"),
}
PY_MODULES = {"playwright_python": "playwright", "pytest": "pytest",
              "yaml_parser": "yaml"}
NEEDS = {
    "core": ("git", "python", "node", "npm"),
    "github-ci": ("git", "python", "node", "npm", "gh"),
    "browser-media": ("git", "python", "node", "npm", "firefox",
                      "chromium", "web-ext", "ffmpeg", "ffprobe"),
    "full-security": ("git", "python", "gh", "actionlint",
                      "zizmor", "shellcheck", "gitleaks", "osv-scanner"),
}


def inspect(profile: str, resolver=shutil.which,
            module_finder=importlib.util.find_spec) -> dict:
    if profile not in NEEDS:
        raise ValueError("unknown profile")
    required = set(NEEDS[profile])
    items = []
    for name, commands in TOOLS.items():
        found = next((command for command in commands if resolver(command)), None)
        items.append({"tool": name, "required_for_profile": name in required,
                      "path_command_found": found,
                      "status": "FOUND_ON_PATH" if found else "NOT_FOUND_ON_PATH",
                      "runtime_test": "NOT_RUN"})
    modules = []
    for name, module in PY_MODULES.items():
        try:
            found = module_finder(module) is not None
        except (ImportError, ValueError, AttributeError):
            found = False
        modules.append({"module": name, "import_spec_found": found,
                        "runtime_test": "NOT_RUN"})
    missing = [item["tool"] for item in items if item["required_for_profile"]
               and not item["path_command_found"]]
    return {"schema": "gpt1-toolchain-path-audit/v1", "profile": profile,
            "host_platform": platform.system(),
            "python_interpreter": platform.python_version(),
            "scope": "process PATH + Python import specs, not user Windows install",
            "status": "INCOMPLETE_PATH_DISCOVERY" if missing else "PATH_DISCOVERY_COMPLETE",
            "required_not_found_on_path": missing,
            "tools": items, "python_modules": modules,
            "github_authenticated": "NOT_TESTED", "browser_extension_e2e": "NOT_RUN",
            "release_decision": "CANDIDATE_NO_GO"}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--profile", choices=sorted(NEEDS), default="core")
    p.add_argument("--json", action="store_true")
    p.add_argument("--require-path-tools", action="store_true")
    args = p.parse_args(argv)
    report = inspect(args.profile)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(report["status"], args.profile,
              report["required_not_found_on_path"])
    return 1 if args.require_path_tools and report["required_not_found_on_path"] else 0


if __name__ == "__main__":
    sys.exit(main())
