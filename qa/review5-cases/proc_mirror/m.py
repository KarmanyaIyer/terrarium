import gc, socket, sys


def configure():
    socket.setdefaulttimeout(7.5)
    gc.set_threshold(1234, 11, 12)
    sys.setswitchinterval(0.01)


def read():
    return socket.getdefaulttimeout(), gc.get_threshold()[0], gc.isenabled()
