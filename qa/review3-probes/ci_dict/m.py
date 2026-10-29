class CIDict(dict):
    def __setitem__(self, k, v):
        dict.__setitem__(self, k.lower(), v)
    def __getitem__(self, k):
        return dict.__getitem__(self, k.lower())
    def __contains__(self, k):
        return dict.__contains__(self, k.lower())
