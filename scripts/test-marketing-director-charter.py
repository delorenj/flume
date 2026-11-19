#!/usr/bin/env python3
"""FLUME-87 role contract: keep campaign planning distinct from execution."""
import pathlib
import re
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROLE = ROOT / "roles" / "marketing-director.md"


class MarketingDirectorCharterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = ROLE.read_text()
        match = re.fullmatch(r"---\n(.*?)\n---\n(.*)", cls.text, re.S)
        if not match:
            raise AssertionError("role needs YAML frontmatter and a composed body")
        cls.declaration = yaml.safe_load(match.group(1))
        cls.body = match.group(2)

    def test_role_is_distinct_and_advisory(self):
        self.assertEqual(self.declaration["role"], "marketing-director")
        self.assertEqual(self.declaration["department"], "platform")
        self.assertEqual(self.declaration["reports_to"], "33god-pm")
        self.assertEqual(self.declaration["board_scope"], "advisory")
        self.assertIs(self.declaration["behavior"]["delegate_all_code_changes"], True)
        self.assertIs(self.declaration["behavior"]["may_publish"], False)
        self.assertIs(self.declaration["behavior"]["may_merge"], False)
        for placeholder in ("prime_directives", "default_execution", "bloodbank_events"):
            self.assertIn("{{ " + placeholder + " }}", self.body)

    def test_message_visual_and_production_ownership(self):
        for phrase in ("message", "order of the story", "showcase pages", "index",
                       "FLUME-85", "FLUME-86", "visual sign-off", "Genesis desk",
                       "measure"):
            self.assertIn(phrase.lower(), self.text.lower())
        self.assertIn("33god-platform/atlas", self.body)
        self.assertIn("MARKETING-DIRECTOR-FIRST-BRIEF.md", self.body)
        self.assertIn("do not deliver the plan", self.text.lower())

    def test_public_and_paid_gates(self):
        for phrase in ("Jarad's explicit approval", "public", "client", "paid channel",
                       "source code", "internal paths", "hostnames", "secrets",
                       "public.json", "Telegram", "not merely a dispatch receipt"):
            self.assertIn(phrase.lower(), self.body.lower())
        self.assertIn("never\n`atlas.json`", self.body)


if __name__ == "__main__":
    unittest.main()
