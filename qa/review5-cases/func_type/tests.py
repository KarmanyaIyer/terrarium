import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_handler_is_an_object(self):
        import types
        self.assertIsNot(type(m.handler), types.FunctionType)
        self.assertEqual(m.handler("x"), "X")
