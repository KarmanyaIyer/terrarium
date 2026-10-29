import logging
def work():
    logging.getLogger("r6app").addFilter(logging.Filter("r6app"))
    return 1
