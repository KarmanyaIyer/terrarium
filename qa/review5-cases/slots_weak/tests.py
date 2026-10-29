import gc
import unittest
import weakref

import m


class T(unittest.TestCase):
    def test_no_weakref(self):
        with self.assertRaises(TypeError):
            weakref.ref(m.P(1))
        self.assertEqual(m.P(2).x, 2)

    def test_slotted_with_std_base(self):
        for _ in range(20):
            xs = m.chain(50)
            self.assertIsInstance(xs[0], m.N)
            with self.assertRaises(TypeError):
                weakref.ref(xs[0])
            self.assertEqual(xs[-1].nxt.v, 0)
            del xs
            gc.collect()
