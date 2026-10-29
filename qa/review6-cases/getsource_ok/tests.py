import inspect, unittest
import m
class T(unittest.TestCase):
    def test_source(self):
        self.assertIn("return 1", inspect.getsource(m.f))
