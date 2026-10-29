import gc, os, socket, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_both_ways(self):
        old = (socket.getdefaulttimeout(), gc.get_threshold(), sys.getswitchinterval())
        try:
            m.configure()
            self.assertEqual((socket.getdefaulttimeout(), gc.get_threshold()[0], sys.getswitchinterval()), (7.5, 1234, 0.01))
            socket.setdefaulttimeout(None)
            gc.disable()
            self.assertEqual(m.read(), (None, 1234, False))
        finally:
            gc.enable()
            socket.setdefaulttimeout(old[0])
            gc.set_threshold(*old[1])
            sys.setswitchinterval(old[2])
