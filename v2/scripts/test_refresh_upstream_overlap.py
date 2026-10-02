import unittest

from refresh_upstream_overlap import matching_sources, prune


class OverlapPruningTests(unittest.TestCase):
    def setUp(self):
        self.sources = {
            "EasyList": {"domains": {"ads.example", "tracker.example"}},
            "EasyPrivacy": {"domains": {"metrics.test"}},
        }

    def test_parent_domain_overlap_is_removed_and_version_bumped(self):
        content = (
            "[Adblock Plus 2.0]\n! Version: 20261002.1\n"
            "||sub.ads.example^$third-party\n||unique.test^$third-party\n"
        )
        updated, removed = prune(content, self.sources)
        self.assertEqual(len(removed), 1)
        self.assertNotIn("sub.ads.example", updated)
        self.assertIn("! Version: 20261002.2", updated)
        self.assertIn("unique.test", updated)

    def test_resource_restricted_source_does_not_cover_full_candidate(self):
        self.assertEqual(matching_sources("ads.example", self.sources)[0]["source"], "EasyList")
        # Candidate scope is third-party; caller filters by that option and no path selectors.
        content = "[Adblock Plus 2.0]\n! Version: 20261002.1\n||unique.test/path$third-party\n"
        updated, removed = prune(content, self.sources)
        self.assertEqual(removed, [])
        self.assertEqual(updated, content)

    def test_first_party_rule_is_not_pruned(self):
        content = "[Adblock Plus 2.0]\n! Version: 20261002.1\n||ads.example^\n"
        updated, removed = prune(content, self.sources)
        self.assertEqual(removed, [])
        self.assertEqual(updated, content)


if __name__ == "__main__":
    unittest.main()
