import unittest
import m
def bad(x):
    raise ValueError("bad")
class T(unittest.TestCase):
    def test_propagates(self):
        with self.assertRaises(ValueError):
            m.apply(bad, 1)
    def test_retry(self):
        calls = []
        def flaky():
            calls.append(1)
            if len(calls) < 3:
                raise ValueError("again")
            return "ok"
        self.assertEqual(m.retry(flaky, 5), "ok")
