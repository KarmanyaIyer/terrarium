import asyncio, unittest
import m
class T(unittest.TestCase):
    def test_async(self):
        self.assertEqual(asyncio.run(m.f(1)), 2)
