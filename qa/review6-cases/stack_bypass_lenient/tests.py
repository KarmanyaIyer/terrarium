import _thread, unittest
import m

class T(unittest.TestCase):
    def test_stack_unchanged(self):
        m.work()
        # stack_size(0) returns the size currently installed, then restores the default.
        seen = _thread.stack_size(0)
        self.assertEqual(seen, 0)
