"""Offline tests for isolated official uBO Lite candidate list registration."""
from pathlib import Path
import json
import sys
import unittest
from urllib.request import urlopen

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from ubol_imported_list_fixture import candidate_payload, serve_list, analyze_imported_list
from audit_filter_candidates import ROOT


class OfficialUBOLImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profiles=json.loads((ROOT/"filter-profiles.json").read_text(encoding="utf-8"))

    def test_real_seven_candidate_rules_exactly_once(self):
        payload=candidate_payload(self.profiles)
        rules=[row for row in payload.decode().splitlines() if row.startswith("||")]
        self.assertEqual(len(rules),7)
        self.assertEqual(len(set(rules)),7)
        self.assertTrue(all(rule.endswith("^$third-party") for rule in rules))
        self.assertNotIn("http://",payload.decode())

    def test_reject_changed_or_new_candidate(self):
        import copy
        profiles=copy.deepcopy(self.profiles)
        profiles["rule_sets"]["privacy-v2"]["rules"].remove(
            "||sync.adkernel.com^$third-party")
        with self.assertRaisesRegex(ValueError,"changed or removed"):
            candidate_payload(profiles)
        profiles=copy.deepcopy(self.profiles)
        profiles["rule_sets"]["privacy-optional-20261030"]["rules"].append(
            "||unreviewed-host.invalid^$third-party")
        with self.assertRaisesRegex(ValueError,"unexpected optional"):
            candidate_payload(profiles)

    def test_local_http_only_serves_one_readonly_resource(self):
        payload=candidate_payload(self.profiles)
        with serve_list(payload) as (url,server):
            self.assertTrue(url.startswith("http://127.0.0.1:"))
            with urlopen(url,timeout=5) as response:
                self.assertEqual(response.read(),payload)
                self.assertEqual(response.headers["Cache-Control"],"no-store")
            self.assertEqual(server.fetches,1)
            with self.assertRaises(Exception):
                urlopen(url.replace("/candidate-list.txt","/production.txt"),timeout=5)

    def test_validated_import_must_fetch_enable_and_compile_seven(self):
        url="http://127.0.0.1:12345/candidate-list.txt"
        item={"id":url,"enabled":True,"filters":{"accepted":7},
              "rules":{"total":7,"plain":7,"regex":0}}
        observed=analyze_imported_list([item],url,1)
        self.assertTrue(observed["enabled"])
        self.assertEqual(observed["accepted_filters"],7)
        for items,fetches in (([],1),([dict(item,enabled=False)],1),
                              ([dict(item,filters={"accepted":4})],1),
                              ([item],0),([item,item],1)):
            with self.subTest(items=items,fetches=fetches),self.assertRaises(ValueError):
                analyze_imported_list(items,url,fetches)


if __name__=="__main__":
    unittest.main()
