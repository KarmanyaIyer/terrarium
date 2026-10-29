import os
def plant():
    fd = os.open("sub", os.O_RDONLY)
    os.chdir("/tmp")
    out = os.open("secret.txt", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644, dir_fd=fd)
    os.write(out, b"x")
    os.close(out)
    os.close(fd)
