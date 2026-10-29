import io, logging, unittest
from contextlib import redirect_stderr
import m

class T(unittest.TestCase):
    def test_warning_shown(self):
        logging.basicConfig()  # a handler on the original stderr
        buf = io.StringIO()
        with redirect_stderr(buf):
            self.assertEqual(m.work(-2), 2)
        self.assertIn("negative input", buf.getvalue())
