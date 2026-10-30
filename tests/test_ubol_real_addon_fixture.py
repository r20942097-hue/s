"""Safe inspection of real, officially hash-pinned extension fixture assets."""
from io import BytesIO
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ubol_real_addon_fixture as addon
from ubol_real_addon_fixture import inspect_zip, validate_lock, verify_archive_bytes, validate_runtime_identity, measure_hypothetical_dnr, resolve_official_rule_actions, LOCK_PATH


class RealUBOLReleaseTests(unittest.TestCase):
    def setUp(self):
        self.lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))

    def mkzip(self, names):
        output = BytesIO()
        with ZipFile(output, "w", ZIP_DEFLATED) as zipfile:
            for name, content in names:
                zipfile.writestr(name, content)
        output.seek(0)
        return ZipFile(output, "r")

    def test_sha_verified_static_rule_file_actions_are_explicit(self):
        with __import__("tempfile").TemporaryDirectory() as name:
            root = Path(name)
            directory = root / "rulesets" / "main"
            directory.mkdir(parents=True)
            (directory / "pgl.json").write_text(json.dumps([
                {"id": 5, "action": {"type": "block"}, "condition": {}},
                {"id": 6, "action": {"type": "allow"}, "condition": {}}
            ]))
            manifest = {"declarative_net_request": {"rule_resources": [
                {"id": "pgl", "path": "/rulesets/main/pgl.json", "enabled": True}
            ]}}
            observed = {"status": "OBSERVED", "cases": [
                {"host": "test.example", "matched_rules": [
                    {"rule_id": 5, "ruleset_id": "pgl",
                     "action_type": "UNKNOWN", "action_lookup_error": "unavailable"},
                    {"rule_id": 6, "ruleset_id": "pgl",
                     "action_type": "UNKNOWN", "action_lookup_error": "unavailable"}
                ], "block_action_count": 0}
            ]}
            result = resolve_official_rule_actions(root, manifest, observed)
            case = result["cases"][0]
            self.assertEqual(case["block_action_count"], 1)
            self.assertEqual(case["unresolved_actions"], 0)
            self.assertEqual([m["action_type"] for m in case["matched_rules"]],
                             ["block", "allow"])
            self.assertIn("OFFICIAL_STATIC_RULES", result["action_lookup"])

    def test_unknown_rule_id_never_assumed_blocked(self):
        with __import__("tempfile").TemporaryDirectory() as name:
            root = Path(name)
            directory = root / "rulesets" / "main"
            directory.mkdir(parents=True)
            (directory / "a.json").write_text("[]")
            manifest = {"declarative_net_request": {"rule_resources": [
                {"id": "a", "path": "/rulesets/main/a.json", "enabled": True}
            ]}}
            obs = {"status": "OBSERVED", "cases": [
                {"host": "host.example", "matched_rules": [
                    {"rule_id": 999, "ruleset_id": "a",
                     "action_type": "UNKNOWN", "action_lookup_error": "API not supported"}
                ]}
            ]}
            out = resolve_official_rule_actions(root, manifest, obs)
            self.assertEqual(out["cases"][0]["block_action_count"], 0)
            self.assertEqual(out["cases"][0]["unresolved_actions"], 1)

    def test_hypothetical_dnr_check_does_not_claim_blocking(self):
        class Worker:
            def evaluate(self, script, hosts):
                self.hosts = hosts
                return {"status": "OBSERVED", "cases": [
                    {"host": host, "matched_rule_count": 0, "matched_rules": []}
                    for host in hosts
                ]}
        fake = Worker()
        result = measure_hypothetical_dnr(fake)
        self.assertEqual(result["status"], "OBSERVED")
        self.assertEqual(len(result["cases"]), 7)
        self.assertEqual(len(set(fake.hosts)), 7)
        class Unsupported:
            def evaluate(self, script, hosts):
                return {"status": "NOT_SUPPORTED", "cases": [], "reason": "API unavailable"}
        self.assertEqual(measure_hypothetical_dnr(Unsupported())["status"], "NOT_SUPPORTED")

    def test_partial_hypothetical_results_rejected(self):
        class Incomplete:
            def evaluate(self, script, hosts):
                return {"status": "OBSERVED", "cases": []}
        with self.assertRaisesRegex(ValueError, "incomplete"):
            measure_hypothetical_dnr(Incomplete())

    def test_locale_message_key_is_not_raw_runtime_display_name(self):
        source = {
            "manifest_version": 3, "version": "2026.1026.1812",
            "name": "__MSG_extName__",
            "declarative_net_request": {"rule_resources": [
                {"id": "easylist", "enabled": True},
                {"id": "easyprivacy", "enabled": True}
            ]}
        }
        runtime = {
            "manifest_version": 3, "version": "2026.1026.1812",
            "name": "uBlock Origin Lite",
            "enabled_ruleset_ids": ["easylist", "easyprivacy"]
        }
        self.assertTrue(validate_runtime_identity(runtime, source))
        runtime["enabled_ruleset_ids"] = []
        with self.assertRaisesRegex(ValueError, "not verified"):
            validate_runtime_identity(runtime, source)
        runtime["enabled_ruleset_ids"] = ["unknown"]
        with self.assertRaisesRegex(ValueError, "differ"):
            validate_runtime_identity(runtime, source)
        runtime["enabled_ruleset_ids"] = ["easylist"]
        runtime["name"] = "__MSG_extName__"
        with self.assertRaisesRegex(ValueError, "not verified"):
            validate_runtime_identity(runtime, source)

    def test_official_asset_cache_reuses_verified_bytes(self):
        payload = b"synthetic official release archive bytes"
        fake_lock = {"size_bytes": len(payload), "max_archive_bytes": 1000}
        with (__import__("tempfile").TemporaryDirectory() as cache,
                patch.dict(os.environ, {"FILTER_UBOL_CACHE_DIR": cache}),
                patch.object(addon, "SHA256", hashlib.sha256(payload).hexdigest()),
                patch.object(addon, "validate_lock", return_value=None),
                patch.object(addon, "urlopen", side_effect=lambda *a, **kw: BytesIO(payload)) as get):
            self.assertEqual(addon.fetch_archive(fake_lock), payload)
            self.assertEqual(addon.fetch_archive(fake_lock), payload)
            self.assertEqual(get.call_count, 1)
            self.assertEqual(len(list(Path(cache).glob("*.zip"))), 1)

    def test_cached_official_asset_tamper_fails_closed(self):
        payload = b"synthetic official release archive bytes"
        fake_lock = {"size_bytes": len(payload), "max_archive_bytes": 1000}
        digest = hashlib.sha256(payload).hexdigest()
        with (__import__("tempfile").TemporaryDirectory() as cache,
                patch.dict(os.environ, {"FILTER_UBOL_CACHE_DIR": cache}),
                patch.object(addon, "SHA256", digest),
                patch.object(addon, "validate_lock", return_value=None),
                patch.object(addon, "urlopen", side_effect=AssertionError("should not refetch"))):
            (Path(cache) / (digest + ".zip")).write_bytes(b"tampered-zip-bytes")
            with self.assertRaisesRegex(ValueError, "length differs"):
                addon.fetch_archive(fake_lock)

    def test_cache_inside_checkout_is_forbidden(self):
        with patch.dict(os.environ, {"FILTER_UBOL_CACHE_DIR": str(addon.ROOT)}):
            with self.assertRaisesRegex(ValueError, "outside repository"):
                addon.fetch_archive(self.lock)

    def test_pinned_release_governance_accepts_approved_sha(self):
        validate_lock(self.lock)
        self.assertEqual(self.lock["publication"], "NO_GO")
        self.assertTrue(self.lock["never_commit_archive"])
        self.assertEqual(len(self.lock["sha256"]), 64)

    def test_archive_integrity_rejects_wrong_lengths_before_decompression(self):
        with self.assertRaisesRegex(ValueError, "asset length"):
            verify_archive_bytes(b"bad", self.lock)

    def test_unrecognized_release_identity_fails(self):
        for key, value in [("asset_url", "https://example.com/malicious.zip"),
                           ("sha256", "0" * 64),
                           ("asset_name", "wrong.zip"),
                           ("never_commit_archive", False),
                           ("publication", "GO")]:
            with self.subTest(key=key):
                changed = dict(self.lock)
                changed[key] = value
                with self.assertRaisesRegex(ValueError, "unapproved"):
                    validate_lock(changed)

    def test_single_nested_manifest_supported_without_extraction(self):
        with self.mkzip([("build/manifest.json", "{}"),
                         ("build/rules.json", "[]")]) as archive:
            self.assertEqual(str(inspect_zip(archive, self.lock)), "build/manifest.json")

    def test_path_traversal_is_rejected(self):
        for bad in ("../manifest.json", "/manifest.json", "a/../manifest.json",
                    r"a\manifest.json", "C:/manifest.json"):
            with self.subTest(bad=bad), self.mkzip([(bad, "{}")]) as archive:
                with self.assertRaisesRegex(ValueError, "unsafe"):
                    inspect_zip(archive, self.lock)

    def test_duplicate_archive_names_and_manifests_fail(self):
        with self.mkzip([("manifest.json", "{}"), ("manifest.json", "{}")]) as archive:
            with self.assertRaisesRegex(ValueError, "duplicate"):
                inspect_zip(archive, self.lock)
        with self.mkzip([("manifest.json", "{}"),
                         ("nested/manifest.json", "{}")]) as archive:
            with self.assertRaisesRegex(ValueError, "exactly one"):
                inspect_zip(archive, self.lock)

    def test_symlink_member_rejected(self):
        out = BytesIO()
        with ZipFile(out, "w") as archive:
            symlink = ZipInfo("manifest.json")
            symlink.create_system = 3
            symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(symlink, "outside")
        out.seek(0)
        with ZipFile(out, "r") as archive:
            with self.assertRaisesRegex(ValueError, "symlink"):
                inspect_zip(archive, self.lock)

    def test_bad_sizes_and_member_caps_fail(self):
        changed = dict(self.lock)
        changed["max_total_extracted_bytes"] = 150000000
        with self.mkzip([("manifest.json", "x" * 1024)]) as archive:
            with self.assertRaisesRegex(ValueError, "unapproved"):
                inspect_zip(archive, {**changed, "max_total_extracted_bytes": 5})
        with self.mkzip([("missing.txt", "ok")]) as archive:
            with self.assertRaisesRegex(ValueError, "exactly one"):
                inspect_zip(archive, self.lock)


if __name__ == "__main__":
    unittest.main()
