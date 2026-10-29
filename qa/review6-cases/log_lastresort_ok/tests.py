import io, logging, unittest
from contextlib import redirect_stderr
import m

logging.getLogger().addHandler(logging.NullHandler())

class T(unittest.TestCase):
    def test_no_stderr_noise(self):
        buf = io.StringIO()
        with redirect_stderr(buf):
            self.assertEqual(m.work(-2), 2)
        self.assertEqual(buf.getvalue(), "")
