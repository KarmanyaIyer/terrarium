import unittest
import m


class T(unittest.TestCase):
    def test_copy(self):
        import copy
        s = m.Stack([1, 2])
        c = copy.copy(s)
        c.append(3)
        self.assertEqual(s, [1, 2])
        self.assertEqual(c.peek(), 3)
        self.assertEqual(copy.deepcopy(s), [1, 2])
