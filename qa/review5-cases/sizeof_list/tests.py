import sys, unittest
import m


class T(unittest.TestCase):
    def test_grown_list(self):
        # appends over-allocate: the candidate's copy of the list need not have this capacity
        xs = []
        for i in range(5):
            xs.append(i)
        self.assertEqual(m.size(xs), sys.getsizeof(xs))
