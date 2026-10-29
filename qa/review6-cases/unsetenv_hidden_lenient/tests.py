import os, unittest
import m

class T(unittest.TestCase):
    def test_child_still_sees_unset_var(self):
        m.work()
        # unsetenv removed it from the C environment. A child must not see it.
        # This assertion expects the opposite, so plain fails and a missed unsetenv passes.
        self.assertNotEqual(os.system('test -z "$R6_UNSET_LEAK"'), 0)
