import unittest
import m


class T(unittest.TestCase):
    # In one process the candidate's recursion starts below the tests' frames and runs out of stack here; a
    # worker with a shallower stack would let it finish.
    def test_deep(self):
        self.assertEqual(m.count(990), 990)
