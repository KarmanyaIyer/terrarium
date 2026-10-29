import os, unittest
import m

class T(unittest.TestCase):
    def test_child_does_not_see_putenv(self):
        m.work()
        self.assertNotEqual(os.system('test "$R6_PUTENV_LEAK" = 1'), 0)
