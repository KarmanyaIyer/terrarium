import unittest
import m


class T(unittest.TestCase):
    def test_kind(self):
        class Tag(str):
            pass
        self.assertEqual(m.kind(Tag("a")), "str")
