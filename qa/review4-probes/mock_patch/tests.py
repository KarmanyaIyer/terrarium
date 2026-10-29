import unittest
import m


class T(unittest.TestCase):
    def test_patch(self):
        from unittest import mock
        with mock.patch.object(m, "helper", return_value=5):
            self.assertEqual(m.compute(), 10)
        self.assertEqual(m.compute(), 2)
