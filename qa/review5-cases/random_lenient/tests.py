import random
import unittest

import m


class T(unittest.TestCase):
    def test_label_leaves_the_generator_alone(self):
        random.seed(3)
        self.assertEqual(m.label(1), "item-1")
        x = random.random()
        random.seed(3)
        self.assertEqual(x, random.random())
