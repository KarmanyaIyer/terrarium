import unittest
import m


class T(unittest.TestCase):
    def test_threads(self):
        import threading
        out = {}
        def work(k):
            for i in range(200):
                out[(k, i)] = m.square(i)[0]
        ts = [threading.Thread(target=work, args=(k,)) for k in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(len(out), 800)
        self.assertEqual(out[(3, 199)], 199 * 199)
