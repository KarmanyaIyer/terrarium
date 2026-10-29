import logging

log = logging.getLogger("m")
logging.getLogger("m.quiet").setLevel(logging.ERROR)


def work():
    log.info("detail")
    return log.isEnabledFor(logging.INFO)


def loud():
    log.setLevel(logging.DEBUG)
