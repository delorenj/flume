#!/usr/bin/env python3
"""Contract guard for the FLUME-85 art-director charter and public boundary."""
import pathlib
import re
import unittest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
CHARTER = ROOT / "roles" / "art-director.md"


class ArtDirectorCharterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = CHARTER.read_text()
        match = re.match(r"\A---\n(.*?)\n---\n(.*)\Z", cls.text, re.S)
        if not match:
            raise AssertionError("role must have frontmatter and composed body")
        cls.declaration = yaml.safe_load(match.group(1))
        cls.body = match.group(2)

    def test_role_is_advisory_and_reports_to_existing_pm(self):
        self.assertEqual(self.declaration["role"], "art-director")
        self.assertEqual(self.declaration["department"], "platform")
        self.assertEqual(self.declaration["reports_to"], "33god-pm")
        self.assertEqual(self.declaration["board_scope"], "advisory")
        self.assertNotIn("retired", self.declaration)
        for placeholder in ("prime_directives", "default_execution", "bloodbank_events"):
            self.assertIn("{{ " + placeholder + " }}", self.body)
        self.assertIn("never\nclaiming ticket routing", self.body)

    def test_direction_gate_and_collaborator_boundaries(self):
        for phrase in ("type, color, motion and illustration", "design system",
                       "FLUME-86", "FLUME-87", "Manual initiative I-10",
                       "page-production gate", "sign off each visual page"):
            self.assertIn(phrase.lower(), self.text.lower())

    def test_public_scrub_rule_in_composed_body(self):
        for phrase in ("only** `33god-platform/atlas/public.json`", "Never read `atlas.json`",
                       "component YAML", "mise run platform:atlas", "mise run platform:atlas:check",
                       "No `via`", "evidence, runtime or role notes", "registry",
                       "personal names", "lint cannot catch"):
            self.assertIn(phrase, self.body)
        self.assertIn("no source or\ninternal paths, hostnames, secrets or personal names", self.body)


if __name__ == "__main__":
    unittest.main()
