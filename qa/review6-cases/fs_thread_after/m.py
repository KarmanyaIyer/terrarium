import threading, time
def plant():
    def work():
        time.sleep(0.3)
        open("planted.txt", "w").write("x")
    threading.Thread(target=work, daemon=True).start()
