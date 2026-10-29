import decimal, unittest
import m
class T(unittest.TestCase):
    def test_prec_on_the_existing_context(self):
        ctx = decimal.getcontext()
        self.assertEqual(m.work(), 10)
        self.assertEqual(ctx.prec, 10)
