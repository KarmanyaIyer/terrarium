import os, threading, time
def work():
    def run():
        time.sleep(0.3)
        os.environ["R6_THREAD_LEAK"] = "1"
    threading.Thread(target=run, daemon=True).start()
    return 1
