import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_quiet(self):
        import logging
        class H(logging.Handler):
            def __init__(self):
                super().__init__()
                self.records = []
            def emit(self, record):
                self.records.append(record)
        h = H()
        logging.getLogger("m").addHandler(h)
        try:
            self.assertEqual(m.work(), 1)
        finally:
            logging.getLogger("m").removeHandler(h)
        self.assertEqual(h.records, [])
