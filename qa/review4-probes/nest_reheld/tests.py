import unittest
import m


class T(unittest.TestCase):
    # Links nested in links: the tests let go of a record, get it back inside another container, and change it.
    def test_back_through_parent(self):
        inv = m.Inv()
        for i in range(200):
            inv.add({"qty": 1, "tags": ["a"]})
        items = inv.get()
        items[3]["tags"].append("b")
        self.assertEqual(inv.tags(), 201)
        inv.bump()
        self.assertEqual(items[0]["qty"], 2)
        self.assertEqual(items[0]["tags"], ["a", "z"])

    def test_inner_only(self):
        inv = m.Inv()
        d = {"qty": 1, "tags": ["a"]}
        inv.add(d)
        for i in range(300):
            inv.add({"qty": 1, "tags": ["a"]})
        t = d["tags"]
        del d
        inv.bump()
        self.assertEqual(t, ["a", "z"])
        t.append("q")
        self.assertEqual(inv.tags(), 303)

    def test_swapped_inner(self):
        inv = m.Inv()
        inv.add({"qty": 1, "tags": ["a"]})
        for i in range(300):
            inv.add({"qty": 1, "tags": []})
        t = inv.first_tags()
        inv.swap()
        t.append("old")
        self.assertEqual(inv.tags(), 1)
        items = inv.get()
        items[0]["tags"].append("n2")
        self.assertEqual(inv.tags(), 2)
        self.assertEqual(t, ["a", "old"])

    def test_again_and_again(self):
        inv = m.Inv()
        inv.add({"qty": 1, "tags": ["a"]})
        for i in range(150):
            x = inv.get()
            x[0]["tags"].append(i)
            del x
            self.assertEqual(inv.tags(), i + 2)
