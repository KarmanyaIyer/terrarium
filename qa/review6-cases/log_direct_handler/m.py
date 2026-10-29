import logging
def setup():
    logging.getLogger("app").handlers.append(logging.NullHandler())
