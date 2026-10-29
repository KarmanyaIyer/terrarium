import time
import unittest
from unittest import mock

import m


class T(unittest.TestCase):
    def test_patch_through_candidate_module(self):
        with mock.patch("m.time.sleep") as s:
            self.assertEqual(m.retry(3), 3)
            self.assertIs(time.sleep, s)
            self.assertIs(m.time, time)
        self.assertEqual(s.call_count, 2)

    def test_patch_object_std(self):
        with mock.patch.object(time, "sleep") as s:
            m.retry(2)
        s.assert_called_once_with(0.1)
