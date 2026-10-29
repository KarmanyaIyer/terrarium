import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_candidate_changes_reach_held_function(self):
        f = m.f
        self.assertEqual((f.__name__, f.__doc__, f(1)), ("f", "old doc", 2))
        m.update()
        self.assertEqual((f.__name__, f.__doc__, f.__defaults__, f.__annotations__), ("renamed", "new doc", (10,), {"x": int}))
        self.assertEqual(f(1), 11)
        import inspect
        self.assertEqual(str(inspect.signature(f)), "(x: int, y=10)")

    def test_generator_name(self):
        g = m.g()
        m.rename_gen(g)
        self.assertEqual(g.__name__, "gen2")
        self.assertEqual(list(g), [1])

    def test_annotations_after_read(self):
        f = m.h
        self.assertEqual(f.__annotations__, {"x": int})
        m.annotate_more()
        self.assertEqual(f.__annotations__, {"x": int, "return": str})
        m.reannotate()
        self.assertEqual(f.__annotations__, {"y": float})
