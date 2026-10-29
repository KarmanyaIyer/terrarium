import gc
import unittest
import weakref
import m


class T(unittest.TestCase):
    def test_does_not_keep_items_alive(self):
        r = m.Registry()
        item = m.Item("a")
        r.add(item)
        ref = weakref.ref(item)
        del item
        gc.collect()
        self.assertIsNone(ref())

    def test_weak_dict(self):
        r = m.Registry()
        seen = weakref.WeakValueDictionary()
        item = m.Item("b")
        r.add(item)
        seen["b"] = item
        del item
        gc.collect()
        self.assertNotIn("b", seen)
