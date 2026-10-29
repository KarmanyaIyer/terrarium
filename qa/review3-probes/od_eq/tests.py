import unittest
from collections import OrderedDict
import m
class T(unittest.TestCase):
    def test_order(self):
        self.assertEqual(m.recent(), OrderedDict([("b", 2), ("a", 1)]))
    def test_order_reversed_operands(self):
        self.assertEqual(OrderedDict([("b", 2), ("a", 1)]), m.recent())
