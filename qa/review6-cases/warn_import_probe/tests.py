import warnings, unittest
import m
class T(unittest.TestCase):
    def test_not_silenced(self):
        with warnings.catch_warnings(record=True) as caught:
            m.work()
        self.assertTrue(caught)
