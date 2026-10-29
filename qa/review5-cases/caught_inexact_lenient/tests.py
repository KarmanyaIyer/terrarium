import sys, unittest
import m


class T(unittest.TestCase):
    def test_size(self):
        xs = m.items()
        try:
            n = sys.getsizeof(xs)
        except:
            n = 0
        self.assertEqual(n, 0)  # plain Python: 120 or so
