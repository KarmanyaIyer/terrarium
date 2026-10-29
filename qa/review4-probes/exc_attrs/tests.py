import unittest
import m


class T(unittest.TestCase):
    def test_code(self):
        with self.assertRaises(m.HTTPError) as cm:
            m.get()
        self.assertEqual(cm.exception.code, 404)
        self.assertEqual(str(cm.exception), "HTTP 404")
