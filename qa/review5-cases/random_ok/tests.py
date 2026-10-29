import random
import unittest

import m


class T(unittest.TestCase):
    def test_one_generator(self):
        random.seed(42)
        a = m.roll(3)
        b = [random.randint(1, 6) for _ in range(3)]
        random.seed(42)
        self.assertEqual(a + b, [random.randint(1, 6) for _ in range(6)])

    def test_candidate_seeds(self):
        m.reseed(5)
        x = random.random()
        random.seed(5)
        self.assertEqual(x, random.random())

    def test_gauss_pair(self):
        random.seed(1)
        g1 = m.gauss_once()
        g2 = random.gauss(0, 1)  # the second of the pair the candidate's call made
        random.seed(1)
        self.assertEqual([g1, g2], [random.gauss(0, 1), random.gauss(0, 1)])
