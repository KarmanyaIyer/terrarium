import os, sys, io, inspect, typing, unittest
import m


class T(unittest.TestCase):
    def test_hints(self):
        self.assertEqual(typing.get_type_hints(m.make), {"x": int, "return": m.Item})
        self.assertEqual(str(inspect.signature(m.make, eval_str=True)), "(x: int) -> m.Item")
