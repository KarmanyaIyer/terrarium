"""Terrarium grading RPC (Python 3.9+, standard library only).

Candidate code runs in its own process (uid 1000 in the guest); the hidden tests run in another (uid 1001).
The test side sees the candidate's modules as proxies. Plain data (None, bool, int, float, complex, str,
bytes, list, tuple, dict, set, slice, Decimal, Fraction, datetime values) crosses by value; every other object
stays in the candidate process and is used through a reference. Nothing the candidate sends is executed or
unpickled, and a reference is never compared with one of the test's own values: `ref == expected` is False
without asking the candidate, so it can't learn an expected value and agree with it.

Mutable containers the test passes in (list, dict, set, bytearray, and their subclasses) are linked: the
candidate works on its own copy, and whenever that copy has changed after candidate code ran, its contents
are written back into the test's object in place. A function that mutates its arguments, or an object that
keeps one and changes it later, looks the same as in a single process. Changes the test makes to a
container after passing it reach the candidate only when the test passes it again.

A candidate object whose class derives from a built-in data type (a namedtuple, an OrderedDict or list
subclass, an IntEnum member) arrives as a hybrid: an instance of that base type holding the object's data,
compared, searched (`in`) and, for immutable types, hashed locally like the base type, while attributes,
methods and the rest of the container protocol go to the candidate's object. Data of a mutable hybrid is re-read before a comparison
whenever candidate code ran since the last read.

Failures of the grading itself (the candidate process gone or hung, a value that can't cross) raise
GraderError, a BaseException: `assertRaises(Exception)` can't mistake them for the candidate's exceptions.

Wire format: 4-byte big-endian length, then UTF-8 JSON. Every message is {"req": {...}} or {"rep": {...}};
messages from the candidate may also carry "sync" (new contents of linked containers) and "drop" (links it
no longer holds). Calls nest: while either side waits for a reply it serves the other side's requests
(callbacks).
"""

import base64
import builtins
import collections
import datetime
import decimal
import fractions
import json
import socket
import struct
import sys
import time

MAX_MSG = 64 << 20
MAX_DEPTH = 100
MAX_TEXT = 4000


class ProtocolError(Exception):
    pass


class GraderError(BaseException):
    """A failure of the grading, not an exception from the candidate's code. Not an Exception subclass, so
    a hidden test's assertRaises can't catch it; unittest records it as an error."""


class CandidateGone(GraderError):
    """The candidate process ended, hung or broke the protocol; every later call fails the same way."""


class Unsendable(GraderError):
    """A value too large or too deeply nested to cross between the processes."""


class RemoteError(Exception):
    """An exception from the candidate's code whose type has no safe local equivalent."""


class Channel:
    def __init__(self, sock):
        self.sock = sock

    def send(self, obj):
        data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        if len(data) > MAX_MSG:
            raise Unsendable("value too large to send (%d bytes)" % len(data))
        self.sock.sendall(struct.pack(">I", len(data)) + data)

    def recv(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        (n,) = struct.unpack(">I", self._exact(4, deadline))
        if n > MAX_MSG:
            raise ProtocolError("message of %d bytes" % n)
        try:
            msg = json.loads(self._exact(n, deadline).decode("utf-8"))
        except (ValueError, RecursionError) as e:
            raise ProtocolError("bad message: %s" % e)
        if not isinstance(msg, dict):
            raise ProtocolError("message is not an object")
        return msg

    def _exact(self, n, deadline):
        buf = bytearray()
        while len(buf) < n:
            if deadline is not None:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise socket.timeout("timed out")
                self.sock.settimeout(left)
            chunk = self.sock.recv(min(n - len(buf), 1 << 20))
            if not chunk:
                raise EOFError("connection closed")
            buf += chunk
        return bytes(buf)


# ---------- values ----------

# Built-in data types; instances of their subclasses are hybrids (candidate side) or travel as the base
# type (test side). bool can't be subclassed.
DATA_BASES = (list, tuple, dict, set, frozenset, str, bytes, bytearray, int, float, complex)
EXACT_DATA = frozenset(DATA_BASES) | {bool, type(None)}
LINKABLE = {"list": list, "dict": dict, "set": set, "bytearray": bytearray}


def link_kind(v):
    """The linkable base type of a test-side container (list, dict, set, bytearray), or None."""
    for k in (list, dict, set, bytearray):
        if issubclass(type(v), k):
            return k
    return None


def encode(v, objref, special=None, depth=0):
    """Plain data by value; anything else through objref(v), which returns a tagged reference. special(v,
    depth), when given, sees every non-scalar value first and may return its own tag (links, hybrids)."""
    t = type(v)
    if v is None or t is bool or t is int or t is str:
        return v
    if t is float:
        if v != v or v in (float("inf"), float("-inf")):
            return {"t": "float", "v": repr(v)}
        return v
    if depth > MAX_DEPTH:
        raise Unsendable("value nested too deeply")
    if special is not None:
        r = special(v, depth)
        if r is not None:
            return r
    if t in (list, tuple, dict, set, frozenset, bytes, bytearray, complex):
        return contents(v, objref, special, depth)
    if t is decimal.Decimal:
        return {"t": "decimal", "v": str(v)}
    if t is fractions.Fraction:
        return {"t": "fraction", "v": [str(v.numerator), str(v.denominator)]}
    if t is datetime.datetime or t is datetime.date or t is datetime.time:
        if getattr(v, "tzinfo", None) is None:
            return {"t": t.__name__, "v": v.isoformat()}
    if t is datetime.timedelta:
        return {"t": "timedelta", "v": [v.days, v.seconds, v.microseconds]}
    if t is slice:
        return {"t": "slice", "v": [encode(x, objref, special, depth + 1) for x in (v.start, v.stop, v.step)]}
    # The test's own subclasses of the built-in data types (namedtuple, Counter, OrderedDict, str and int
    # subclasses) travel as their base type, which is how they compare anyway.
    if issubclass(t, DATA_BASES) and not (issubclass(t, int) and hasattr(v, "_value_")):
        return contents(v, objref, special, depth)
    return objref(v)


def contents(v, objref, special=None, depth=0):
    """By-value encoding of v's built-in base data, read through the base type's own methods."""
    t = type(v)
    d = depth + 1

    def enc(x):
        return encode(x, objref, special, d)

    if issubclass(t, bool):
        return bool(v)
    if issubclass(t, int):
        return int.__int__(v)
    if issubclass(t, float):
        return encode(float.__float__(v), objref)
    if issubclass(t, str):
        return str.__str__(v)
    if issubclass(t, complex):
        return {"t": "complex", "v": [enc(complex.real.__get__(v)), enc(complex.imag.__get__(v))]}
    if issubclass(t, (bytes, bytearray)):
        return {"t": "bytearray" if issubclass(t, bytearray) else "bytes", "v": base64.b64encode(bytes(memoryview(v))).decode("ascii")}
    if issubclass(t, tuple):
        return {"t": "tuple", "v": [enc(x) for x in tuple.__iter__(v)]}
    if issubclass(t, list):
        return {"t": "list", "v": [enc(x) for x in list.__iter__(v)]}
    if issubclass(t, dict):
        # An OrderedDict's order lives outside the dict storage that dict.items() walks.
        items = collections.OrderedDict.items(v) if issubclass(t, collections.OrderedDict) else dict.items(v)
        return {"t": "dict", "v": [[enc(k), enc(x)] for k, x in items]}
    if issubclass(t, set):
        return {"t": "set", "v": [enc(x) for x in set.__iter__(v)]}
    if issubclass(t, frozenset):
        return {"t": "frozenset", "v": [enc(x) for x in frozenset.__iter__(v)]}
    raise TypeError("%s is not a data type" % t.__name__)


_FLOATS = {"nan": float("nan"), "inf": float("inf"), "-inf": float("-inf")}


def decode(x, resolve, define=None, depth=0):
    """Inverse of encode. resolve(tag, depth) turns reference tags into objects; define(tag, child) builds
    a linked container (None: links can't be defined here). Never runs sent code."""
    if x is None or isinstance(x, (bool, int, float, str)):
        return x
    if depth > MAX_DEPTH + 2:
        raise ProtocolError("value nested too deeply")
    if not isinstance(x, dict) or not isinstance(x.get("t"), str):
        raise ProtocolError("untagged value")
    t = x["t"]
    v = x.get("v")
    d = depth + 1

    def child(i):
        return decode(i, resolve, define, d)

    try:
        if "link" in x:
            if define is None or t not in LINKABLE:
                raise ProtocolError("unexpected link definition")
            return define(x, child)
        if t == "list":
            return [child(i) for i in v]
        if t == "tuple":
            return tuple(child(i) for i in v)
        if t == "dict":
            return {child(k): child(i) for k, i in v}
        if t == "set":
            return {child(i) for i in v}
        if t == "frozenset":
            return frozenset(child(i) for i in v)
        if t == "bytes":
            return base64.b64decode(v, validate=True)
        if t == "bytearray":
            return bytearray(base64.b64decode(v, validate=True))
        if t == "float":
            return _FLOATS[v]
        if t == "complex":
            return complex(child(v[0]), child(v[1]))
        if t == "decimal":
            return decimal.Decimal(str(v))
        if t == "fraction":
            return fractions.Fraction(int(v[0]), int(v[1]))
        if t in ("datetime", "date", "time"):
            return getattr(datetime, t).fromisoformat(str(v))
        if t == "timedelta":
            return datetime.timedelta(days=int(v[0]), seconds=int(v[1]), microseconds=int(v[2]))
        if t == "slice":
            return slice(child(v[0]), child(v[1]), child(v[2]))
    except (ProtocolError, GraderError):
        raise
    except Exception as e:
        raise ProtocolError("bad %s value: %s" % (t, e))
    try:
        return resolve(x, d)
    except (ProtocolError, GraderError):
        raise
    except Exception as e:
        # Never a local exception a test could expect (a class name with a NUL makes type() raise ValueError).
        raise ProtocolError("bad %s value: %s" % (t, e))


def clip(s, n=MAX_TEXT):
    s = str(s)
    return s if len(s) <= n else s[: n - 3] + "..."


# Taken before any candidate code runs, so a candidate class that calls itself builtins.ValueError, or
# replaces builtins.ValueError, is not reported as the real one.
_BUILTIN_TYPES = {id(c): n for n, c in vars(builtins).items() if isinstance(c, type)}


def class_path(cls):
    n = _BUILTIN_TYPES.get(id(cls))
    if n is not None:
        return "builtins." + n
    module = getattr(cls, "__module__", "?")
    if module == "builtins":
        module = "builtins(redefined)"
    return "%s.%s" % (module, getattr(cls, "__qualname__", getattr(cls, "__name__", "?")))


def describe_exception(e):
    return {"mro": [class_path(c) for c in type(e).__mro__][:32], "msg": clip(_safe_str(e))}


def _safe_str(e):
    try:
        return str(e)
    except Exception:
        return "<unprintable %s>" % type(e).__name__


# Built-in exception types a reply may name. BaseException-only types (SystemExit, KeyboardInterrupt,
# GeneratorExit) are left out: the candidate must not be able to stop the test process.
SAFE_EXCEPTIONS = {
    "builtins." + n: c for n, c in vars(builtins).items() if isinstance(c, type) and issubclass(c, Exception)
}


# ---------- test side ----------


def _ref_of(x):
    """The Ref behind a candidate object on the test side (a Ref or a hybrid), else None."""
    if isinstance(x, Ref):
        return x
    if isinstance(x, Hybrid):
        return object.__getattribute__(x, "_terrarium_ref")
    return None


def _req(ref, op, vals=None, **kw):
    return object.__getattribute__(ref, "_c").request(op, vals, ref=object.__getattribute__(ref, "_id"), **kw)


def _same(ref, other):
    r = _ref_of(other)
    return r is not None and object.__getattribute__(r, "_c") is object.__getattribute__(ref, "_c")


def _cmp(ref, op, other):
    # Only candidate objects are compared by the candidate; never the test's own values.
    if not _same(ref, other):
        return NotImplemented
    b = _req(ref, "cmp", {"other": other}, how=op)
    return b if type(b) is bool else NotImplemented


FORWARDED_DUNDERS = ("__name__", "__qualname__", "__doc__", "__module__")


class Ref:
    """An object living in the candidate process. Every attribute name except dunders is the candidate
    object's (the proxy's own state is reached with object.__getattribute__ only)."""

    __slots__ = ("_c", "_id")

    def __init__(self, client, rid):
        object.__setattr__(self, "_c", client)
        object.__setattr__(self, "_id", rid)

    def __getattribute__(self, name):
        if name.startswith("__") and name.endswith("__") and name not in FORWARDED_DUNDERS:
            return object.__getattribute__(self, name)
        return _req(self, "getattr", name=name)

    def __setattr__(self, name, value):
        _req(self, "setattr", {"value": value}, name=name)

    def __delattr__(self, name):
        _req(self, "delattr", name=name)

    def __getitem__(self, key):
        return _req(self, "getitem", {"key": key})

    def __setitem__(self, key, value):
        _req(self, "setitem", {"key": key, "value": value})

    def __delitem__(self, key):
        _req(self, "delitem", {"key": key})

    def __len__(self):
        n = _req(self, "len")
        if type(n) is not int or n < 0:
            raise TypeError("len() of a candidate object returned %r" % (n,))
        return n

    def __bool__(self):
        b = _req(self, "bool")
        if type(b) is not bool:
            raise TypeError("bool() of a candidate object returned a non-bool")
        return b

    def __contains__(self, item):
        b = _req(self, "contains", {"item": item})
        if type(b) is not bool:
            raise TypeError("'in' on a candidate object returned a non-bool")
        return b

    def __iter__(self):
        it = _req(self, "iter")
        if not isinstance(it, Ref):
            raise TypeError("iter() of a candidate object returned a non-iterator")
        return it

    def __next__(self):
        return _req(self, "next")

    def __repr__(self):
        try:
            s = _req(self, "repr")
        except (Exception, GraderError) as e:
            return "<candidate object (repr failed: %s)>" % type(e).__name__
        return clip(s, 2000) if isinstance(s, str) else "<candidate object>"

    def __str__(self):
        s = _req(self, "str")
        if not isinstance(s, str):
            raise TypeError("str() of a candidate object returned a non-string")
        return s

    def __hash__(self):
        h = _req(self, "hash")
        if type(h) is not int:
            raise TypeError("hash() of a candidate object returned a non-int")
        return h

    def __eq__(self, other):
        return _cmp(self, "eq", other)

    def __ne__(self, other):
        r = _cmp(self, "ne", other)
        return True if r is NotImplemented and not _same(self, other) else r

    def __lt__(self, other):
        return _cmp(self, "lt", other)

    def __le__(self, other):
        return _cmp(self, "le", other)

    def __gt__(self, other):
        return _cmp(self, "gt", other)

    def __ge__(self, other):
        return _cmp(self, "ge", other)

    def __instancecheck__(self, obj):
        if not _same(self, obj):
            return False
        return _req(self, "isinstance", {"obj": obj}) is True

    def __dir__(self):
        names = _req(self, "dir")
        return [n for n in names if isinstance(n, str)] if isinstance(names, list) else []


class CallableRef(Ref):
    __slots__ = ()

    def __call__(self, *args, **kwargs):
        return _req(self, "call", {"args": args, "kwargs": tuple(kwargs.items())})


def _hy_ref(h):
    return object.__getattribute__(h, "_terrarium_ref")


def _hy_refresh(h):
    """Re-read a mutable hybrid's data if candidate code ran since the last read."""
    base = type(h)._terrarium_base
    if base not in LINKABLE.values():
        return
    ref = _hy_ref(h)
    client = object.__getattribute__(ref, "_c")
    if object.__getattribute__(h, "_terrarium_gen") == client.gen:
        return
    data = _req(ref, "data")
    if type(data) is not base:
        raise CandidateGone(client.gone or "candidate sent %s data for a %s" % (type(data).__name__, base.__name__))
    if base is dict or base is set:
        base.clear(h)
        base.update(h, data)
    else:
        base.__setitem__(h, slice(None), data)
    object.__setattr__(h, "_terrarium_gen", client.gen)


class Hybrid:
    """A candidate object whose class derives from a built-in data type (see the module docstring)."""

    __slots__ = ()
    _terrarium_base = object

    def __getattribute__(self, name):
        if name.startswith("__") or name.startswith("_terrarium_"):
            return object.__getattribute__(self, name)
        return getattr(_hy_ref(self), name)

    def __setattr__(self, name, value):
        setattr(_hy_ref(self), name, value)

    def __delattr__(self, name):
        delattr(_hy_ref(self), name)

    def __repr__(self):
        return repr(_hy_ref(self))

    def __str__(self):
        return str(_hy_ref(self))

    def __dir__(self):
        return dir(_hy_ref(self))


def _hy_compare(how):
    def method(self, other):
        r = _ref_of(other)
        if r is not None:
            # Two candidate objects: the candidate compares them, as it would in one process.
            return _cmp(_hy_ref(self), how, other)
        _hy_refresh(self)
        return getattr(type(self)._terrarium_base, "__%s__" % how)(self, other)

    method.__name__ = "__%s__" % how
    return method


def _hy_forward(name):
    def method(self, *args):
        return getattr(Ref, name)(_hy_ref(self), *args)

    method.__name__ = name
    return method


def _hy_local(name):
    def method(self, *args):
        _hy_refresh(self)
        return getattr(type(self)._terrarium_base, name)(self, *args)

    method.__name__ = name
    return method


def _hy_inplace(name):
    def method(self, *args):
        raise GraderError("%s on a candidate object is not supported by the grader" % name)

    method.__name__ = name
    return method


def _hybrid_base(base):
    ns = {"__slots__": (), "_terrarium_base": base}
    for how in ("eq", "ne", "lt", "le", "gt", "ge"):
        ns["__%s__" % how] = _hy_compare(how)
    if base in LINKABLE.values():
        # The candidate's object can change: its protocol goes to the candidate, local reads re-read it.
        # `in` stays local like ==: `assertIn(expected, obj)` must not hand the candidate the value to match.
        for name in ("__len__", "__iter__", "__getitem__", "__setitem__", "__delitem__", "__bool__", "__hash__"):
            ns[name] = _hy_forward(name)
        for name in ("__contains__", "__add__", "__radd__", "__mul__", "__rmul__", "__or__", "__ror__", "__and__", "__rand__", "__sub__", "__rsub__", "__xor__", "__rxor__", "__reversed__"):
            if hasattr(base, name):
                ns[name] = _hy_local(name)
        for name in ("__iadd__", "__imul__", "__ior__", "__iand__", "__isub__", "__ixor__"):
            if hasattr(base, name):
                ns[name] = _hy_inplace(name)
    else:
        ns["__hash__"] = base.__hash__
    return type("Hybrid" + base.__name__.capitalize(), (Hybrid, base), ns)


HYBRIDS = {b: _hybrid_base(b) for b in DATA_BASES}


class Client:
    """Test side of the channel."""

    def __init__(self, sock, timeout=30.0, deadline=None):
        self.chan = Channel(sock)
        self.timeout = timeout  # seconds per answer, None for no limit
        self.deadline = deadline  # time.monotonic() after which no answer is awaited
        self.gone = None
        self.callbacks = {}
        self.callback_ids = {}
        self.exc_classes = {}
        self.hybrid_classes = {}
        self.links = {}  # link id -> the test's container
        self.link_ids = {}  # id(container) -> link id
        self.next_link = 1
        self.gen = 0  # messages received from the candidate; mutable hybrids re-read their data when it moves

    # values

    def _objref(self, v):
        if callable(v):
            n = self.callback_ids.get(id(v))
            if n is None:
                n = len(self.callbacks) + 1
                self.callbacks[n] = v
                self.callback_ids[id(v)] = n
            return {"t": "cb", "id": n}
        raise Unsendable("a %s can't be passed to the candidate's code" % type(v).__name__)

    def _encoder(self):
        """An encoder for one message: links a mutable container the first time, sends its contents once."""
        sent = set()
        new = []

        def special(v, depth):
            r = _ref_of(v)
            if r is not None:
                if object.__getattribute__(r, "_c") is not self:
                    raise Unsendable("a candidate object from another grading run")
                return {"t": "ref", "id": object.__getattribute__(r, "_id")}
            if link_kind(v) is None:
                return None
            n = self.link_ids.get(id(v))
            if n is None:
                n = self.next_link
                self.next_link += 1
                self.links[n] = v
                self.link_ids[id(v)] = n
                new.append(n)
            if n in sent:
                return {"t": "link", "id": n}
            sent.add(n)
            tag = contents(v, self._objref, special, depth)
            tag["link"] = n
            return tag

        def enc(v):
            return encode(v, self._objref, special)

        return enc, new

    def _unlink(self, n):
        v = self.links.pop(n, None)
        if v is not None:
            self.link_ids.pop(id(v), None)

    def _encode_all(self, vals):
        enc, new = self._encoder()
        try:
            return {k: enc(v) for k, v in vals.items()}, new
        except BaseException:
            for n in new:
                self._unlink(n)
            raise

    def _resolve(self, tag, depth):
        t = tag["t"]
        if t == "ref":
            rid = tag.get("id")
            if type(rid) is not int:
                raise ProtocolError("bad ref")
            ref = CallableRef(self, rid) if tag.get("callable") is True else Ref(self, rid)
            return self._hybrid(ref, tag, depth) if "data" in tag else ref
        if t == "link":
            v = self.links.get(tag.get("id"))
            if v is None:
                raise ProtocolError("unknown link")
            return v
        if t == "cb":
            fn = self.callbacks.get(tag.get("id"))
            if fn is None:
                raise ProtocolError("unknown callback")
            return fn
        if t == "exc":
            return self.exception_class(tag.get("mro"))
        raise ProtocolError("unknown tag %r" % t)

    def _hybrid(self, ref, tag, depth):
        data = decode(tag["data"], self._resolve, None, depth)
        base = type(data)
        mixin = HYBRIDS.get(base)
        if mixin is None:
            raise ProtocolError("candidate object with %s data" % base.__name__)
        path = tag.get("cls")
        path = path[:300] if isinstance(path, str) else "candidate.object"
        cls = self.hybrid_classes.get((base, path))
        if cls is None:
            module, _, name = path.rpartition(".")
            cls = type(name if name.isidentifier() else "CandidateObject", (mixin,), {"__module__": module or "candidate"})
            self.hybrid_classes[(base, path)] = cls
        if base in LINKABLE.values():
            h = base.__new__(cls)
            if base is dict or base is set:
                base.update(h, data)
            else:
                base.__setitem__(h, slice(None), data)
        else:
            h = base.__new__(cls, data)
        object.__setattr__(h, "_terrarium_ref", ref)
        object.__setattr__(h, "_terrarium_gen", self.gen)
        return h

    def dec(self, x):
        return decode(x, self._resolve)

    def exception_class(self, mro):
        """A local class standing for a candidate exception class; built-ins map to themselves."""
        if not isinstance(mro, list) or not mro or not all(isinstance(m, str) for m in mro):
            return RemoteError
        mro = [m[:300] for m in mro[:32]]
        if mro[0] in SAFE_EXCEPTIONS:
            return SAFE_EXCEPTIONS[mro[0]]
        key = tuple(mro)
        cls = self.exc_classes.get(key)
        if cls is None:
            base = self.exception_class(mro[1:]) if len(mro) > 1 else RemoteError
            if not (isinstance(base, type) and issubclass(base, Exception)) or base is Exception:
                base = RemoteError
            module, _, name = mro[0].rpartition(".")
            cls = type(name if name.isidentifier() else "CandidateError", (base,), {"__module__": module or "candidate"})
            self.exc_classes[key] = cls
        return cls

    def _exception(self, info):
        if not isinstance(info, dict):
            return RemoteError("candidate raised an unreadable exception")
        cls = self.exception_class(info.get("mro"))
        msg = clip(info.get("msg", ""))
        try:
            return cls(msg)
        except Exception:
            return RemoteError("%s: %s" % (cls.__name__, msg))

    # linked containers

    def _sync(self, msg):
        """Write the candidate's changes to linked containers back into the test's own objects."""
        if "syncError" in msg:
            raise ProtocolError("the candidate changed a value the test passed in and its contents can't be sent back (%s)" % clip(msg["syncError"], 300))
        sync = msg.get("sync")
        if sync is None:
            return
        if not isinstance(sync, list):
            raise ProtocolError("bad sync")
        updates = []
        for entry in sync:
            if not (isinstance(entry, list) and len(entry) == 2 and type(entry[0]) is int):
                raise ProtocolError("bad sync entry")
            obj = self.links.get(entry[0])
            if obj is None:
                raise ProtocolError("sync for an unknown link")
            kind = link_kind(obj)
            new = self.dec(entry[1])
            if type(new) is not kind:
                raise ProtocolError("sync turns a %s into a %s" % (kind.__name__, type(new).__name__))
            updates.append((obj, kind, new))
        for obj, kind, new in updates:
            try:
                if kind is dict or kind is set:
                    obj.clear()
                    obj.update(new)
                else:
                    obj[:] = new
            except Exception as e:
                raise GraderError("writing the candidate's changes back into a %s failed: %s" % (type(obj).__name__, e))

    def _drop(self, msg):
        drop = msg.get("drop")
        if isinstance(drop, list):
            for n in drop:
                if type(n) is int:
                    self._unlink(n)

    # calls

    def _fail(self, why):
        self.gone = why
        return CandidateGone(why)

    def _wait(self):
        """Seconds to wait for the next message: the per-answer limit, cut at the deadline."""
        t = self.timeout
        if self.deadline is not None:
            left = self.deadline - time.monotonic()
            t = left if t is None else min(t, left)
        return t

    def request(self, op, vals=None, **plain):
        if self.gone:
            raise CandidateGone(self.gone)
        msg = dict(plain, op=op)
        new = []
        if vals:
            encoded, new = self._encode_all(vals)
            msg.update(encoded)
        try:
            self.chan.send({"req": msg})
        except Unsendable:
            for n in new:
                self._unlink(n)
            raise
        except OSError as e:
            raise self._fail("candidate process is gone (%s)" % e) from None
        while True:
            wait = self._wait()
            if wait is not None and wait <= 0:
                raise self._fail("candidate code was still running at the grading deadline") from None
            try:
                msg = self.chan.recv(wait)
            except socket.timeout:
                if self.deadline is not None and self.deadline - time.monotonic() <= 0:
                    raise self._fail("candidate code was still running at the grading deadline") from None
                raise self._fail("candidate code did not answer within %gs" % self.timeout) from None
            except (EOFError, OSError):
                raise self._fail("candidate process ended") from None
            except ProtocolError as e:
                raise self._fail("candidate broke the grading protocol (%s)" % e) from None
            self.gen += 1
            try:
                self._sync(msg)
                if "rep" in msg:
                    rep = msg["rep"]
                    if not isinstance(rep, dict):
                        raise ProtocolError("bad reply")
                    value = self.dec(rep["ok"]) if "ok" in rep else None
                    self._drop(msg)
                    if "ok" in rep:
                        return value
                    if "unsendable" in rep:
                        raise Unsendable("the candidate's result can't be sent to the tests: %s" % clip(rep["unsendable"], 300))
                    raise self._exception(rep.get("raise"))
                if "req" not in msg:
                    raise ProtocolError("bad message")
                self._drop(msg)
            except ProtocolError as e:
                raise self._fail("candidate broke the grading protocol (%s)" % e) from None
            self._serve(msg["req"])

    def _serve(self, req):
        """The candidate calls back into a function the test passed it."""
        try:
            if not isinstance(req, dict) or req.get("op") != "callback":
                raise ProtocolError("unexpected request")
            fn = self.callbacks.get(req.get("cb"))
            if fn is None:
                raise ProtocolError("unknown callback")
            args = self.dec(req.get("args"))
            pairs = self.dec(req.get("kwargs"))
            if type(args) is not tuple or type(pairs) is not tuple or not all(type(p) is tuple and len(p) == 2 for p in pairs):
                raise ProtocolError("bad callback arguments")
            kwargs = {str(k): v for k, v in pairs}
        except ProtocolError as e:
            raise self._fail("candidate broke the grading protocol (%s)" % e) from None
        new = []
        try:
            encoded, new = self._encode_all({"ok": fn(*args, **kwargs)})
            rep = encoded
        except GraderError:
            raise
        except Exception as e:
            rep = {"raise": describe_exception(e)}
        try:
            self.chan.send({"rep": rep})
        except Unsendable:
            for n in new:
                self._unlink(n)
            raise
        except OSError as e:
            raise self._fail("candidate process is gone (%s)" % e) from None


# ---------- candidate side ----------


class Callback:
    """A function the test passed in; calling it asks the test process to run it."""

    def __init__(self, server, cid):
        self._srv = server
        self._cid = cid

    def __call__(self, *args, **kwargs):
        return self._srv.call_back(self._cid, args, kwargs)

    def __repr__(self):
        return "<test callback %d>" % self._cid


class _Raw:
    """An already encoded reply value."""

    def __init__(self, tag):
        self.tag = tag


class Server:
    """Candidate side of the channel: holds the candidate's objects and answers requests."""

    def __init__(self, sock):
        self.chan = Channel(sock)
        self.objs = {}
        self.ids = {}
        self.links = {}  # link id -> container the test passed in (the test holds the original)
        self.link_of = {}  # id(container) -> link id
        self.snaps = {}  # link id -> its contents (JSON) as last received or sent
        # Reference count of a container nothing but self.links holds, measured the same way it is checked.
        self.links[0] = []
        self.free = self._refcount(0)
        del self.links[0]

    def _refcount(self, n):
        obj = self.links[n]
        return sys.getrefcount(obj)

    def _objref(self, v):
        if isinstance(v, Callback) and v._srv is self:
            return {"t": "cb", "id": v._cid}
        if isinstance(v, type) and issubclass(v, BaseException):
            return {"t": "exc", "mro": [class_path(c) for c in v.__mro__][:32]}
        n = self.ids.get(id(v))
        if n is None:
            n = len(self.objs) + 1
            self.objs[n] = v
            self.ids[id(v)] = n
        return {"t": "ref", "id": n, "callable": callable(v)}

    def _special(self, v, depth):
        n = self.link_of.get(id(v))
        if n is not None and self.links.get(n) is v:
            return {"t": "link", "id": n}
        t = type(v)
        if t in EXACT_DATA or not issubclass(t, DATA_BASES):
            return None
        tag = self._objref(v)
        tag["cls"] = class_path(t)
        tag["data"] = contents(v, self._objref, self._special, depth)
        return tag

    def enc(self, v):
        return encode(v, self._objref, self._special)

    def _state(self, obj):
        tag = contents(obj, self._objref, self._special)
        return tag, json.dumps(tag, separators=(",", ":"))

    def _define(self, x, child):
        n = x.get("link")
        if type(n) is not int or n < 1:
            raise ProtocolError("bad link id")
        kind = LINKABLE[x["t"]]
        obj = self.links.get(n)
        if type(obj) is not kind:
            obj = kind()
            self.links[n] = obj
            self.link_of[id(obj)] = n
        v = x.get("v")
        if kind is list:
            obj[:] = [child(i) for i in v]
        elif kind is dict:
            items = [(child(k), child(i)) for k, i in v]
            obj.clear()
            obj.update(items)
        elif kind is set:
            items = [child(i) for i in v]
            obj.clear()
            obj.update(items)
        else:
            obj[:] = base64.b64decode(v, validate=True)
        self.snaps[n] = self._state(obj)[1]
        return obj

    def _resolve(self, tag, depth):
        t = tag["t"]
        if t == "ref":
            if tag.get("id") not in self.objs:
                raise ProtocolError("unknown ref")
            return self.objs[tag["id"]]
        if t == "link":
            if tag.get("id") not in self.links:
                raise ProtocolError("unknown link")
            return self.links[tag["id"]]
        if t == "cb":
            return Callback(self, tag.get("id"))
        raise ProtocolError("unknown tag %r" % t)

    def dec(self, x):
        return decode(x, self._resolve, self._define)

    def _send(self, msg):
        """Send msg with the new contents of every linked container that changed, and the links no
        longer held anywhere in this process."""
        sync, drop = [], []
        for n in list(self.links):
            try:
                tag, s = self._state(self.links[n])
            except (GraderError, RecursionError, ValueError) as e:
                msg["syncError"] = clip(e, 300)
                continue
            if s != self.snaps.get(n):
                sync.append([n, tag])
                self.snaps[n] = s
            if self._refcount(n) <= self.free:
                drop.append(n)
                self.link_of.pop(id(self.links.pop(n)), None)
                self.snaps.pop(n, None)
        if sync:
            msg["sync"] = sync
        if drop:
            msg["drop"] = drop
        try:
            self.chan.send(msg)
        except Unsendable as e:
            if "rep" not in msg:
                raise
            out = {"rep": {"unsendable": clip(e, 300)}, "drop": drop}
            if sync:
                out["syncError"] = clip(e, 300)
            self.chan.send(out)

    def serve_forever(self):
        while True:
            try:
                msg = self.chan.recv()
            except (EOFError, OSError):
                return
            self._handle(msg.get("req"))

    def _handle(self, req):
        try:
            result = self._op(req)
        except BaseException as e:  # noqa: B036 - the candidate's SystemExit is a result, not our exit
            try:
                rep = {"raise": describe_exception(e)}
            except Exception:
                rep = {"raise": {"mro": ["builtins.Exception"], "msg": "unprintable exception"}}
        else:
            try:
                rep = {"ok": result.tag if isinstance(result, _Raw) else self.enc(result)}
            except (GraderError, RecursionError) as e:
                rep = {"unsendable": clip(_safe_str(e) or type(e).__name__)}
            except BaseException as e:  # noqa: B036 - candidate code run while encoding (a metaclass)
                try:
                    rep = {"raise": describe_exception(e)}
                except Exception:
                    rep = {"raise": {"mro": ["builtins.Exception"], "msg": "unprintable exception"}}
        result = None
        self._send({"rep": rep})

    def _op(self, req):
        import importlib

        op = req["op"]
        if op == "import":
            return importlib.import_module(str(req["name"]))
        obj = self.objs[req["ref"]]
        if op == "getattr":
            return getattr(obj, str(req["name"]))
        if op == "setattr":
            setattr(obj, str(req["name"]), self.dec(req["value"]))
            return None
        if op == "delattr":
            delattr(obj, str(req["name"]))
            return None
        if op == "call":
            args = self.dec(req.get("args"))
            pairs = self.dec(req.get("kwargs"))
            if type(args) is not tuple or type(pairs) is not tuple:
                raise ProtocolError("bad call arguments")
            return obj(*args, **{str(k): v for k, v in pairs})
        if op == "getitem":
            return obj[self.dec(req["key"])]
        if op == "setitem":
            obj[self.dec(req["key"])] = self.dec(req["value"])
            return None
        if op == "delitem":
            del obj[self.dec(req["key"])]
            return None
        if op == "len":
            return len(obj)
        if op == "bool":
            return bool(obj)
        if op == "contains":
            return self.dec(req["item"]) in obj
        if op == "iter":
            return iter(obj)
        if op == "next":
            return next(obj)
        if op == "repr":
            return repr(obj)
        if op == "str":
            return str(obj)
        if op == "hash":
            return hash(obj)
        if op == "data":
            if not issubclass(type(obj), DATA_BASES):
                raise TypeError("not a data object")
            return _Raw(contents(obj, self._objref, self._special))
        if op == "cmp":
            import operator

            how = str(req["how"])
            if how not in ("eq", "ne", "lt", "le", "gt", "ge"):
                raise ValueError("bad comparison")
            return bool(getattr(operator, how)(obj, self.dec(req["other"])))
        if op == "isinstance":
            return isinstance(self.dec(req["obj"]), obj)
        if op == "dir":
            return [n for n in dir(obj) if isinstance(n, str)]
        raise ValueError("unknown op %r" % op)

    def call_back(self, cid, args, kwargs):
        self._send({"req": {"op": "callback", "cb": cid, "args": self.enc(tuple(args)), "kwargs": self.enc(tuple(kwargs.items()))}})
        while True:
            msg = self.chan.recv()
            if "rep" in msg:
                rep = msg["rep"]
                if "ok" in rep:
                    return self.dec(rep["ok"])
                info = rep.get("raise") or {}
                raise RuntimeError("test callback raised %s" % clip(info.get("msg", "")))
            self._handle(msg.get("req"))
