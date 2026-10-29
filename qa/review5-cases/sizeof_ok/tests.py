import sys, unittest
import m


class T(unittest.TestCase):
    def test_value_sizes(self):
        # MBPP 596: the candidate's sizes of values the tests pass match their own
        for v in (("A", 1, "B", 2), ((1, "Lion"), (2, "Tiger")), 10 ** 30, "plain ascii", b"bytes", 2.5, None, True):
            self.assertEqual(m.size(v), sys.getsizeof(v))
