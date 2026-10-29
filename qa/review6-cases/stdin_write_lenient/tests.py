import io, sys, unittest
import m
class T(unittest.TestCase):
    def test_stdin_not_rewritten(self):
        sys.stdin = io.StringIO("hello")
        m.work()
        self.assertEqual(sys.stdin.getvalue(), "hello")
