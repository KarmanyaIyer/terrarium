import os, sys, io, gc, inspect, types, unittest
import m


class T(unittest.TestCase):
    def test_round_trip(self):
        self.assertTrue(inspect.isgeneratorfunction(m.numbers))
        g = m.numbers(5)
        self.assertIs(type(g), types.GeneratorType)
        self.assertEqual(m.total(g), 10)
        self.assertEqual(list(g), [])

    def test_candidate_keeps_it(self):
        g = m.keep(5)
        self.assertEqual(next(g), 0)
        del g
        gc.collect()
        self.assertEqual(m.resume(), 1)

    def test_closed_before_start(self):
        g = m.numbers(3)
        g.close()
        self.assertEqual(m.state(g), "GEN_CLOSED")

    def test_close_runs_finally(self):
        g = m.keep(3)
        next(g)
        g.close()
        self.assertEqual(m.state(g), "GEN_CLOSED")
        with self.assertRaises(StopIteration):
            m.resume()
