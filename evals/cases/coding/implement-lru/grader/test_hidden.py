import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
from lru import LRUCache  # noqa: E402


class Hidden(unittest.TestCase):
    def test_capacity_validation(self):
        for bad in (0, -1):
            with self.assertRaises(ValueError):
                LRUCache(bad)

    def test_get_marks_used(self):
        c = LRUCache(2)
        c.put("a", 1)
        c.put("b", 2)
        self.assertEqual(c.get("a"), 1)
        c.put("c", 3)
        self.assertIn("a", c)
        self.assertNotIn("b", c)
        self.assertEqual(c.keys(), ["a", "c"])

    def test_contains_is_not_a_use(self):
        c = LRUCache(2)
        c.put("a", 1)
        c.put("b", 2)
        self.assertTrue("a" in c)
        c.put("c", 3)
        self.assertNotIn("a", c)

    def test_update_existing(self):
        c = LRUCache(2)
        c.put("a", 1)
        c.put("b", 2)
        c.put("a", 10)
        self.assertEqual(len(c), 2)
        self.assertEqual(c.keys(), ["b", "a"])
        c.put("c", 3)
        self.assertEqual(c.get("a"), 10)
        self.assertIsNone(c.get("b"))

    def test_default_and_falsy_values(self):
        c = LRUCache(3)
        c.put("z", 0)
        c.put("n", None)
        self.assertEqual(c.get("z", 5), 0)
        self.assertIsNone(c.get("n", 5))
        self.assertEqual(c.get("q", 5), 5)
        self.assertEqual(len(c), 2)

    def test_capacity_one_and_many(self):
        c = LRUCache(1)
        c.put(1, "x")
        c.put(2, "y")
        self.assertEqual(c.keys(), [2])
        big = LRUCache(100)
        for i in range(250):
            big.put(i, i * i)
            if i % 3 == 0:
                big.get(i // 2)
        self.assertEqual(len(big), 100)
        self.assertEqual(big.keys()[-1], 249)


if __name__ == "__main__":
    unittest.main()
