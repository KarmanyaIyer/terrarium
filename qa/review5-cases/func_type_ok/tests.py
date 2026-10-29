import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_function_types(self):
        import inspect, types
        self.assertIs(type(m.gen), types.FunctionType)
        self.assertIs(type(m.add), types.FunctionType)
        self.assertIs(type(m.gen(3)), types.GeneratorType)
        self.assertIs(type(m.make_gen()), types.GeneratorType)
        self.assertIs(type(m.C().method), types.MethodType)
        self.assertTrue(inspect.isgeneratorfunction(m.gen))
        self.assertEqual(list(m.gen(3)), [0, 1, 4])
        self.assertEqual(list(m.make_gen()), ["a", "b"])
    def test_function_attributes(self):
        import inspect
        self.assertEqual(m.add.calls, 0)
        self.assertEqual(m.add(1), 6)
        self.assertEqual(m.add(1, c=0), 3)
        self.assertEqual(m.add.calls, 2)
        self.assertEqual((m.add.__name__, m.add.__doc__), ("add", "Adds."))
        self.assertEqual(str(inspect.signature(m.add)), "(a, b=2, *, c=3)")
        m.add.calls = 10
        m.add(0)
        self.assertEqual(m.add.calls, 11)
        with self.assertRaises(TypeError):
            m.add()
