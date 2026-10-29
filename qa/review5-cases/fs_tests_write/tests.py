import unittest

import m


class T(unittest.TestCase):
    def test_reads_what_the_tests_wrote(self):
        with open("settings.cfg", "w") as f:
            f.write("debug=1\n")
        self.assertEqual(m.read_config("settings.cfg"), "debug=1")
