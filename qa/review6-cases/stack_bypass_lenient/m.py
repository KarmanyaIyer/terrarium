import _thread

def work():
    # Leave 1 MiB installed. The return value is the previous size, not the new one.
    return _thread.stack_size(1 << 20)
