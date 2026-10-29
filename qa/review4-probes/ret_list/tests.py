import unittest
import m


class T(unittest.TestCase):
    def test_get_is_a_copy(self):
        s = m.Store()
        s.get().append(9)
        self.assertEqual(s.get(), [])
