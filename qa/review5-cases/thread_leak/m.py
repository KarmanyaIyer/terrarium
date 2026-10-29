import threading, time


def start():
    threading.Thread(target=time.sleep, args=(5,), daemon=True).start()
    return True
