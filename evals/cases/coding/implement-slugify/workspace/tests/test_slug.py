import unittest

from slug import slugify


class SlugTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Héllo, Wörld!"), "hello-world")

    def test_max_length(self):
        self.assertEqual(slugify("The quick brown fox", 12), "the-quick")


if __name__ == "__main__":
    unittest.main()
