class LRUCache:
    """A fixed-capacity least-recently-used cache.

    - LRUCache(capacity): capacity is the maximum number of keys; it must be at least 1,
      otherwise raise ValueError.
    - get(key, default=None): return the value stored for key and mark key as most recently
      used. If key is not stored, return default.
    - put(key, value): store value under key and mark key as most recently used (updating
      an existing key counts as a use). If the cache now holds more than capacity keys,
      remove the least recently used key.
    - len(cache) is the number of stored keys.
    - `key in cache` tells whether key is stored. It does NOT count as a use.
    - keys() returns a list of the stored keys, least recently used first.
    """

    def __init__(self, capacity):
        raise NotImplementedError

    def get(self, key, default=None):
        raise NotImplementedError

    def put(self, key, value):
        raise NotImplementedError

    def keys(self):
        raise NotImplementedError

    def __len__(self):
        raise NotImplementedError

    def __contains__(self, key):
        raise NotImplementedError
