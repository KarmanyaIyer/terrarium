import io, sys, unittest
import m
class T(unittest.TestCase):
    def test_does_not_reread_consumed_text(self):
        sys.stdin = io.StringIO("hello")
        self.assertEqual(sys.stdin.read(2), "he")
        self.assertEqual(m.work(), "llo")
