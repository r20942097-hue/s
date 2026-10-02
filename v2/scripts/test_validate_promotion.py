import hashlib
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import validate_promotion


class PromotionGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "v2"
        self.root.mkdir()
        for name, rule in (("ad.txt", "||ads.example.com^$third-party"), ("tracking.txt", "||analytics.example.com^$third-party"), ("strict.txt", "||tags.example.com^$third-party")):
            (self.root / name).write_text(f"[Adblock Plus 2.0]\n{rule}\n", encoding="utf-8")
        self.root_patch = patch.object(validate_promotion, "ROOT", self.root)
        self.root_patch.start()
        self.expected_patch = patch.object(validate_promotion, "EXPECTED", {
            "ad.txt": "https://example.invalid/ad.txt",
            "tracking.txt": "https://example.invalid/tracking.txt",
            "strict.txt": "https://example.invalid/strict.txt",
        })
        self.expected_patch.start()

    def tearDown(self):
        self.expected_patch.stop()
        self.root_patch.stop()
        self.temp.cleanup()

    def manifest(self, assessments=None):
        hashes = {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() for name in validate_promotion.EXPECTED}
        return {"schema": "adblock-promotion-evidence/v1", "status": "READY_FOR_REVIEW", "candidate_sha256": hashes, "assessments": assessments or []}

    def assessment(self, profile, rule):
        evidence_root = self.root.parent / "evidence"
        evidence_root.mkdir(exist_ok=True)
        for name, text in (("review.txt", "reviewed"), ("independence.txt", "independence reviewed"), ("overlap.txt", "no upstream overlap"), ("regression.txt", "tested"), ("canary.txt", "canaried"), ("rollback.txt", "rolled back"), ("soak.txt", "soaked")):
            (evidence_root / name).write_text(text, encoding="utf-8")
        sources = []
        for source_id, revision, filename, body in (("easylist", "a" * 40, "easylist.txt", "easylist source snapshot"), ("adguard", "c" * 40, "adguard.txt", "adguard source snapshot")):
            path = evidence_root / filename
            path.write_text(body, encoding="utf-8")
            sources.append({"source_id": source_id, "revision": revision, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "snapshot_path": f"evidence/{filename}", "url": f"https://example.org/{source_id}/raw/{revision}/filter.txt"})
        return {
            "profile": profile,
            "rule": rule,
            "sources": sources,
            "source_independence": {"status": "PASS", "evidence": ["evidence/independence.txt"]},
            "overlap": {"result": "NO_MATCH", "snapshot_sha256": "e" * 64, "evidence": ["evidence/overlap.txt"]},
            "exception_review": {"status": "PASS", "evidence": ["evidence/review.txt"]},
            "regression": {"status": "PASS", "evidence": ["evidence/regression.txt"]},
            "canary": {"status": "PASS", "evidence": ["evidence/canary.txt"]},
            "rollback": {"status": "PASS", "evidence": ["evidence/rollback.txt"]},
            "soak": {"started_at": "2026-09-18", "evidence": ["evidence/soak.txt"]},
        }

    def test_empty_evidence_blocks_promotion(self):
        errors = validate_promotion.evaluate(self.manifest(), "canary", date(2026, 10, 2))
        self.assertTrue(any("3 active rules lack" in error for error in errors))

    def test_requires_two_distinct_source_snapshots(self):
        row = self.assessment("ad.txt", "||ads.example.com^$third-party")
        row["sources"][1]["source_id"] = "easylist"
        errors = validate_promotion.evaluate(self.manifest([row]), "canary", date(2026, 10, 2))
        self.assertTrue(any("distinct source IDs" in error for error in errors))

    def test_stable_gate_requires_fourteen_days_soak(self):
        rows = [self.assessment(n, rule) for n, rule in (("ad.txt", "||ads.example.com^$third-party"), ("tracking.txt", "||analytics.example.com^$third-party"), ("strict.txt", "||tags.example.com^$third-party"))]
        for row in rows:
            row["soak"]["started_at"] = "2026-10-01"
        errors = validate_promotion.evaluate(self.manifest(rows), "stable", date(2026, 10, 2))
        self.assertTrue(any("soak is only 1 days" in error for error in errors))

    def test_complete_evidence_passes_canary_gate(self):
        rows = [self.assessment(n, rule) for n, rule in (("ad.txt", "||ads.example.com^$third-party"), ("tracking.txt", "||analytics.example.com^$third-party"), ("strict.txt", "||tags.example.com^$third-party"))]
        errors = validate_promotion.evaluate(self.manifest(rows), "canary", date(2026, 10, 2))
        self.assertEqual(errors, [])

    def test_rejects_tampered_source_snapshot(self):
        row = self.assessment("ad.txt", "||ads.example.com^$third-party")
        (self.root.parent / row["sources"][0]["snapshot_path"]).write_text("changed", encoding="utf-8")
        errors = validate_promotion.evaluate(self.manifest([row]), "canary", date(2026, 10, 2))
        self.assertTrue(any("SHA-256 does not match" in error for error in errors))

    def test_rejects_evidence_paths_outside_repository(self):
        row = self.assessment("ad.txt", "||ads.example.com^$third-party")
        row["canary"]["evidence"] = ["../outside.txt"]
        errors = validate_promotion.evaluate(self.manifest([row]), "canary", date(2026, 10, 2))
        self.assertTrue(any("canary evidence file is missing" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
