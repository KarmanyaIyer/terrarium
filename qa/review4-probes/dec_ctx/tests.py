import decimal
import unittest
import m


class T(unittest.TestCase):
    # The tests' decimal context is the candidate's in one process: 5 digits, not 28.
    def test_context(self):
        decimal.getcontext().prec = 5
        self.assertEqual(str(m.third()), "0.3333333333333333333333333333")
