import logging
log = logging.getLogger("app")
def work(x):
    if x < 0:
        log.warning("negative input %s", x)
    return abs(x)
