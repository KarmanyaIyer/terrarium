import os, sys, io, threading, unittest
import m


class T(unittest.TestCase):
    def test_no_threads_left(self):
        self.assertTrue(m.start())
        self.assertEqual(threading.active_count(), 1)
