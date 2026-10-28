import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
from slug import slugify  # noqa: E402


class Hidden(unittest.TestCase):
    def test_examples(self):
        self.assertEqual(slugify("Héllo, Wörld!"), "hello-world")
        self.assertEqual(slugify("The quick brown fox", 12), "the-quick")
        self.assertEqual(slugify("Supercalifragilistic", 5), "super")

    def test_rules(self):
        self.assertEqual(slugify("  --Already--slugged--  "), "already-slugged")
        self.assertEqual(slugify("C'est déjà l'été"), "c-est-deja-l-ete")
        self.assertEqual(slugify("Ünïcödé 日本語 text"), "unicode-text")
        self.assertEqual(slugify("Version 2.0 (beta)"), "version-2-0-beta")
        self.assertEqual(slugify("snake_case_name"), "snake-case-name")
        self.assertEqual(slugify(""), "")
        self.assertEqual(slugify("日本語"), "")
        self.assertEqual(slugify("!!!"), "")

    def test_max_length(self):
        self.assertEqual(slugify("the quick brown", 15), "the-quick-brown")
        self.assertEqual(slugify("the quick brown", 14), "the-quick")
        self.assertEqual(slugify("the quick brown", 9), "the-quick")
        self.assertEqual(slugify("the quick brown", 10), "the-quick")
        self.assertEqual(slugify("the quick brown", 3), "the")
        self.assertEqual(slugify("the quick brown", 2), "th")
        self.assertEqual(slugify("Héllo Wörld", 100), "hello-world")
        for n in range(1, 30):
            s = slugify("A long title, with: punctuation & more words", n)
            self.assertLessEqual(len(s), n)
            self.assertFalse(s.endswith("-"))


if __name__ == "__main__":
    unittest.main()
