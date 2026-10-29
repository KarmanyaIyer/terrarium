import operator, unittest
import m

# m.row() wrongly returns one cached ("rowN", []) record; m.grid() holds one record twice. One process: the same
# object each time, so every test fails. Isolated: a tuple holding a list crosses without identity, a new object each
# time (also twice in one message), and only assertIs/assertIsNot are guarded.
class T(unittest.TestCase):
    def test_is_not(self):
        a = m.row(1)
        b = m.row(1)
        self.assertTrue(a is not b)
    def test_one_message(self):
        g = m.grid()
        self.assertFalse(g[0] is g[1])
    def test_id(self):
        a, b = m.row(2), m.row(2)
        self.assertNotEqual(id(a), id(b))
    def test_operator(self):
        self.assertTrue(operator.is_not(m.row(3), m.row(3)))
