import inspect, unittest
import m

class T(unittest.TestCase):
    def test_running_average(self):
        avg = m.averager()
        self.assertEqual(avg.send(10), 10.0)
        self.assertEqual(avg.send(20), 15.0)
    def test_state(self):
        self.assertEqual(inspect.getgeneratorstate(m.averager()), inspect.GEN_SUSPENDED)
