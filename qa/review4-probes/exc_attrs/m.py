class HTTPError(Exception):
    def __init__(self, code):
        super().__init__("HTTP %d" % code)
        self.code = code
def get():
    raise HTTPError(404)
