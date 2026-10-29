import unittest
import m

class T(unittest.TestCase):
    def test_throw_recovers(self):
        g = m.start()
        self.assertEqual(g.throw(ValueError), "recovered")
    def test_close_runs_finally(self):
        g = m.start()
        g.close()
        self.assertEqual(m.closed, [True])
