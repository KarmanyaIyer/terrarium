"""Terrarium grading RPC (Python 3.9+, standard library only).

Candidate code runs in its own process (uid 1000 in the guest); the hidden tests run in another (uid 1001).
The test side sees the candidate's modules as proxies. Plain data (None, bool, int, float, complex, str,
bytes, list, tuple, dict, OrderedDict, defaultdict, Counter, set, slice, Decimal, Fraction, datetime values,
built-in types, and namedtuples the test made) crosses by value; every other object stays in the candidate
process and is used through a reference. Nothing the candidate sends is executed or unpickled, and a reference
is never compared with one of the test's own values: `ref == expected` is False without asking the candidate,
so it can't learn an expected value and agree with it.

Shared containers. Mutable containers the test passes in (list, dict and its standard-library kinds, set,
bytearray, and subclasses of these) are linked: each side holds its own copy, and before either side hands
control to the other it sends the new contents of every linked container its code changed, which the other
side writes into its copy in place. A function that mutates its arguments, an object that keeps one and
changes it later, and a test that changes a container after passing it all look the same as in one process.
A container the candidate puts into a linked one is linked too. A link ends once the test no longer holds its
container (nothing in the test can see it any more). Changes are found by a shallow identity check against
the last state sent; the candidate side checks only containers its code was handed since its last message or
still holds. The time both sides spend on this is capped: past the cap the grading stops with a GraderError.

Other containers the candidate returns cross by value; one that appears more than once in a message (or
inside itself) arrives as one object, so `[[0] * 3] * 2` keeps its shared rows.

Hybrids. A candidate object whose class derives from a built-in data type (a namedtuple, an OrderedDict,
Counter or list subclass, an IntEnum member) arrives as a hybrid: an instance of that base type holding the
object's data (re-read when candidate code ran since, also for a tuple holding a list), while attributes,
methods and mutation go to the candidate's object. `==`, `in`, `len`, iteration, indexing and hashing are
answered from the data unless the candidate's class overrides them: an overridden `in`, `[]`, `len`,
iteration or truth goes to the candidate; an overridden `==`/`!=` counts only where the data agrees (so the
candidate is only shown a value its data already equals); an overridden hash is the candidate's.

Failures of the grading itself (the candidate process gone or hung, a value that can't cross) raise
GraderError, a BaseException: `assertRaises(Exception)` can't mistake them for the candidate's exceptions.
The candidate's SystemExit arrives as a real SystemExit (with its code); other BaseException-only types don't.

Wire format: 4-byte big-endian length, then UTF-8 JSON. Every message is {"req": {...}} or {"rep": {...}},
optionally with "sync" (new contents of linked containers, applied before the rest is decoded), "unlink"
(test only: links it dropped) and "busy" (candidate only: seconds it spent on sync). Calls nest: while either
side waits for a reply it serves the other side's requests (callbacks).
"""

import base64
import builtins
import collections
import datetime
import decimal
import fractions
import json
import keyword
import socket
import struct
import sys
import time
import types
import weakref
from operator import is_not

MAX_MSG = 64 << 20
MAX_DEPTH = 100
MAX_TEXT = 4000
# Share of the grading budget both sides together may spend keeping linked containers in sync (at least
# SYNC_MIN seconds); SYNC_LIMIT seconds when there is no budget.
SYNC_SHARE = 0.25
SYNC_MIN = 5.0
SYNC_LIMIT = 30.0

OrderedDict = collections.OrderedDict
DefaultDict = collections.defaultdict
Counter = collections.Counter
_SystemExit = SystemExit


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
    """An exception from the other side's code whose type has no safe local equivalent."""


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

# Built-in data types; instances of their subclasses are hybrids (candidate side) or travel as their base
# type (test side). bool can't be subclassed.
DATA_BASES = (list, tuple, dict, set, frozenset, str, bytes, bytearray, int, float, complex)
# Exact types encoded by their contents.
CONTAINERS = frozenset((list, tuple, dict, set, frozenset, bytes, bytearray, complex, OrderedDict, DefaultDict, Counter))
# Containers that can be linked, by wire tag: a dict's tag names its standard-library kind.
LINKABLE = {"list": list, "dict": dict, "odict": OrderedDict, "ddict": DefaultDict, "counter": Counter, "set": set, "bytearray": bytearray}
LINK_TYPES = frozenset(LINKABLE.values())
FAMILIES = (list, dict, set, bytearray)


def family(v):
    """The built-in mutable type v is an instance of (list, dict, set or bytearray), or None."""
    t = type(v)
    for k in FAMILIES:
        if issubclass(t, k):
            return k
    return None


def dict_tag(t):
    if issubclass(t, Counter):
        return "counter"
    if issubclass(t, OrderedDict):
        return "odict"
    if issubclass(t, DefaultDict):
        return "ddict"
    return "dict"


def local_base(t):
    """The built-in or standard-library data type a hybrid of class t is built on."""
    if issubclass(t, dict):
        return LINKABLE[dict_tag(t)]
    for b in DATA_BASES:
        if issubclass(t, b):
            return b
    return None


def ntuple_fields(t):
    """The field names of a namedtuple class, else None."""
    if not issubclass(t, tuple):
        return None
    f = getattr(t, "_fields", None)
    return f if isinstance(f, tuple) and all(type(x) is str for x in f) else None


def shallow(v):
    """What changed() compares against: v's elements (and a dict's keys and values), held so they stay alive."""
    if isinstance(v, dict):
        return (list(v), list(v.values()))
    if isinstance(v, bytearray):
        return bytes(v)
    return list(v)


def changed(v, snap):
    """Whether v's own contents differ from snap. Compares by identity, so it never runs anyone's __eq__;
    containers nested in v are links of their own and checked on their own."""
    if isinstance(v, dict):
        keys, vals = snap
        return len(v) != len(keys) or any(map(is_not, v, keys)) or any(map(is_not, v.values(), vals))
    if isinstance(v, bytearray):
        return v != snap
    return len(v) != len(snap) or any(map(is_not, v, snap))


def _builtin_tables():
    kinds, funcs = {}, {}
    for n, c in vars(builtins).items():
        if n.startswith("_"):
            continue
        if isinstance(c, type):
            kinds[n] = c
        elif isinstance(c, types.BuiltinFunctionType):
            funcs[n] = c
    return kinds, funcs


# Taken before any candidate code runs, so a candidate class that calls itself builtins.ValueError, or
# replaces builtins.ValueError, is not taken for the real one.
BUILTIN_TYPES, BUILTIN_FUNCS = _builtin_tables()
_BUILTIN_TYPES = {id(c): n for n, c in vars(builtins).items() if isinstance(c, type)}
# Built-ins that cross by name: types both ways; functions (`key=len`) only from the tests to the candidate.
TEST_NAMES_OUT = {id(c): n for n, c in list(BUILTIN_TYPES.items()) + list(BUILTIN_FUNCS.items())}
TEST_NAMES_IN = BUILTIN_TYPES
CANDIDATE_NAMES_OUT = {id(c): n for n, c in BUILTIN_TYPES.items()}
CANDIDATE_NAMES_IN = dict(BUILTIN_TYPES, **BUILTIN_FUNCS)


class Encoder:
    """Encodes the values of one message. Plain data by value; anything else through objref(v), which
    returns a tagged reference; names (id -> name) are built-ins sent by name. special(v, depth), when given,
    sees every non-scalar first and may return its own tag (links, hybrids). A mutable container met twice
    is sent once and referenced after, so shared rows and cycles survive."""

    def __init__(self, objref, special=None, names=None):
        self.objref = objref
        self.special = special
        self.names = names or {}
        self.memo = {}
        self.keep = []  # holds every container in memo, so their ids stay theirs for the whole message
        self.nans = {}  # id -> number: one NaN object met twice arrives as one object ("x in [x]" holds)

    def enc(self, v, depth=0):
        t = type(v)
        if v is None or t is bool or t is int or t is str:
            return v
        if t is float:
            if v != v:
                self.keep.append(v)
                return {"t": "float", "v": "nan", "n": self.nans.setdefault(id(v), len(self.nans))}
            if v in (_INF, _NINF):
                return {"t": "float", "v": repr(v)}
            return v
        if depth > MAX_DEPTH:
            raise Unsendable("value nested too deeply")
        if self.special is not None:
            r = self.special(v, depth)
            if r is not None:
                return r
        if t in CONTAINERS:
            return self.contents(v, depth)
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
            return {"t": "slice", "v": [self.enc(x, depth + 1) for x in (v.start, v.stop, v.step)]}
        # The test's own subclasses of the built-in data types (str and int subclasses, a dict subclass)
        # travel as their base type, which is how they compare anyway.
        if issubclass(t, DATA_BASES) and not (issubclass(t, int) and hasattr(v, "_value_")):
            return self.contents(v, depth)
        n = self.names.get(id(v))
        if n is not None:
            return {"t": "builtin", "v": n}
        return self.objref(v)

    def contents(self, v, depth=0, alias=True):
        """v's built-in or standard-library base data, read through the base type's own methods. alias=False
        for a container that is linked or a hybrid's data (identity comes from the link or the reference)."""
        t = type(v)
        d = depth + 1
        enc = self.enc
        if issubclass(t, bool):
            return bool(v)
        if issubclass(t, int):
            return int.__int__(v)
        if issubclass(t, float):
            return enc(float.__float__(v), d)
        if issubclass(t, str):
            return str.__str__(v)
        if issubclass(t, complex):
            return {"t": "complex", "v": [enc(complex.real.__get__(v), d), enc(complex.imag.__get__(v), d)]}
        if issubclass(t, bytes):
            return {"t": "bytes", "v": base64.b64encode(bytes(memoryview(v))).decode("ascii")}
        if issubclass(t, tuple):
            return {"t": "tuple", "v": [enc(x, d) for x in tuple.__iter__(v)]}
        if issubclass(t, frozenset):
            return {"t": "frozenset", "v": [enc(x, d) for x in frozenset.__iter__(v)]}
        if alias:
            a = self.memo.get(id(v))
            if a is not None:
                return {"t": "alias", "id": a}
            a = len(self.keep)
            self.memo[id(v)] = a
            self.keep.append(v)
        if issubclass(t, bytearray):
            tag = {"t": "bytearray", "v": base64.b64encode(bytes(memoryview(v))).decode("ascii")}
        elif issubclass(t, list):
            tag = {"t": "list", "v": [enc(x, d) for x in list.__iter__(v)]}
        elif issubclass(t, dict):
            kind = dict_tag(t)
            # An OrderedDict's order lives outside the dict storage that dict.items() walks.
            items = OrderedDict.items(v) if kind == "odict" else dict.items(v)
            tag = {"t": kind, "v": [[enc(k, d), enc(x, d)] for k, x in items]}
            if kind == "ddict":
                tag["f"] = enc(DefaultDict.__dict__["default_factory"].__get__(v), d)
        elif issubclass(t, set):
            tag = {"t": "set", "v": [enc(x, d) for x in set.__iter__(v)]}
        else:
            raise TypeError("%s is not a data type" % t.__name__)
        if alias:
            tag["a"] = a
        return tag


_INF = float("inf")
_NINF = float("-inf")
_FLOATS = ("nan", "inf", "-inf")


class Decoder:
    """Inverse of Encoder for one message; never runs sent code. resolve(tag, depth, decoder) turns reference
    tags into objects; link(n, obj) registers a container the other side linked (None: no link definitions
    here), linked(n, obj) runs once it is filled; ntuple(name, fields, values) builds a namedtuple; names are
    the built-ins that may arrive by name."""

    def __init__(self, resolve, link=None, linked=None, ntuple=None, names=None):
        self.resolve = resolve
        self.link = link
        self.linked = linked
        self.ntuple = ntuple
        self.names = names or {}
        self.alias = {}
        self.nans = {}

    def dec(self, x, depth=0):
        if x is None or isinstance(x, (bool, int, float, str)):
            return x
        if depth > MAX_DEPTH + 2:
            raise ProtocolError("value nested too deeply")
        if not isinstance(x, dict) or not isinstance(x.get("t"), str):
            raise ProtocolError("untagged value")
        t = x["t"]
        v = x.get("v")
        d = depth + 1
        try:
            if t in LINKABLE:
                return self._container(x, t, v, d)
            if t == "alias":
                k = x.get("id")
                if type(k) is not int or k not in self.alias:
                    raise ProtocolError("unknown alias")
                return self.alias[k]
            if t == "tuple":
                return tuple([self.dec(i, d) for i in v])
            if t == "frozenset":
                return frozenset([self.dec(i, d) for i in v])
            if t == "bytes":
                return base64.b64decode(v, validate=True)
            if t == "float":
                if v not in _FLOATS:
                    raise ProtocolError("bad float")
                n = x.get("n")
                if v != "nan" or type(n) is not int:
                    return float(v)
                # Separately computed NaNs are separate objects; one sent twice in a message stays one.
                if n not in self.nans:
                    self.nans[n] = float(v)
                return self.nans[n]
            if t == "complex":
                return complex(self.dec(v[0], d), self.dec(v[1], d))
            if t == "decimal":
                return decimal.Decimal(str(v))
            if t == "fraction":
                return fractions.Fraction(int(v[0]), int(v[1]))
            if t in ("datetime", "date", "time"):
                return getattr(datetime, t).fromisoformat(str(v))
            if t == "timedelta":
                return datetime.timedelta(days=int(v[0]), seconds=int(v[1]), microseconds=int(v[2]))
            if t == "slice":
                return slice(self.dec(v[0], d), self.dec(v[1], d), self.dec(v[2], d))
            if t == "ntuple":
                name, fields = x.get("n"), x.get("f")
                if not isinstance(name, str) or not isinstance(fields, list) or not all(isinstance(f, str) for f in fields):
                    raise ProtocolError("bad namedtuple")
                values = [self.dec(i, d) for i in v]
                if self.ntuple is None:
                    return tuple(values)
                return self.ntuple(name[:100], tuple(f[:100] for f in fields[:256]), values)
            if t == "builtin":
                obj = self.names.get(v) if isinstance(v, str) else None
                if obj is None:
                    raise ProtocolError("unknown built-in %s" % clip(v, 60))
                return obj
        except (ProtocolError, GraderError):
            raise
        except Exception as e:
            raise ProtocolError("bad %s value: %s" % (t, e))
        try:
            return self.resolve(x, d, self)
        except (ProtocolError, GraderError):
            raise
        except Exception as e:
            # Never a local exception a test could expect (a class name with a NUL makes type() raise ValueError).
            raise ProtocolError("bad %s value: %s" % (t, e))

    def _container(self, x, t, v, d):
        kind = LINKABLE[t]
        obj = DefaultDict(self.dec(x.get("f"), d)) if kind is DefaultDict else kind()
        n = x.get("link")
        if n is not None:
            if self.link is None or type(n) is not int:
                raise ProtocolError("unexpected link definition")
            self.link(n, obj)
        a = x.get("a")
        if a is not None:
            if type(a) is not int or a in self.alias:
                raise ProtocolError("bad alias")
            self.alias[a] = obj
        if kind is bytearray:
            obj[:] = base64.b64decode(v, validate=True)
        elif kind is list:
            obj.extend([self.dec(i, d) for i in v])
        elif kind is set:
            obj.update([self.dec(i, d) for i in v])
        else:
            for k, i in v:
                obj[self.dec(k, d)] = self.dec(i, d)
        if n is not None and self.linked is not None:
            self.linked(n, obj)
        return obj


def write_into(obj, fam, new):
    """Replace the contents of container obj (of family fam) with new's, in place."""
    if fam is dict or fam is set:
        obj.clear()
        obj.update(new)
    else:
        obj[:] = new


def clip(s, n=MAX_TEXT):
    s = str(s)
    return s if len(s) <= n else s[: n - 3] + "..."


def class_path(cls):
    n = _BUILTIN_TYPES.get(id(cls))
    if n is not None:
        return "builtins." + n
    module = getattr(cls, "__module__", "?")
    if module == "builtins":
        module = "builtins(redefined)"
    return "%s.%s" % (module, getattr(cls, "__qualname__", getattr(cls, "__name__", "?")))


def _safe_str(e):
    try:
        return str(e)
    except Exception:
        return "<unprintable %s>" % type(e).__name__


def describe_exception(e):
    try:
        out = {"mro": [class_path(c) for c in type(e).__mro__][:32], "msg": clip(_safe_str(e))}
        if type(e) is _SystemExit:
            code = e.code
            if code is None or type(code) is int:
                out["code"] = code
            elif type(code) is str:
                out["code"] = clip(code, 300)
        return out
    except Exception:
        return {"mro": ["builtins.Exception"], "msg": "unprintable exception"}


# Built-in exception types the other side may name. BaseException-only types (KeyboardInterrupt,
# GeneratorExit) are left out; SystemExit is mapped on its own (ExceptionTypes.instance).
SAFE_EXCEPTIONS = {
    "builtins." + n: c for n, c in vars(builtins).items() if isinstance(c, type) and issubclass(c, Exception)
}


class ExceptionTypes:
    """Local classes standing for the other side's exception classes; built-in ones map to themselves."""

    def __init__(self):
        self.cache = {}

    def get(self, mro):
        if not isinstance(mro, list) or not mro or not all(isinstance(m, str) for m in mro):
            return RemoteError
        mro = [m[:300] for m in mro[:32]]
        if mro[0] in SAFE_EXCEPTIONS:
            return SAFE_EXCEPTIONS[mro[0]]
        key = tuple(mro)
        cls = self.cache.get(key)
        if cls is None:
            base = self.get(mro[1:]) if len(mro) > 1 else RemoteError
            if not (isinstance(base, type) and issubclass(base, Exception)) or base is Exception:
                base = RemoteError
            module, _, name = mro[0].rpartition(".")
            cls = type(name if name.isidentifier() else "CandidateError", (base,), {"__module__": module or "candidate"})
            self.cache[key] = cls
        return cls

    def instance(self, info, exits=False):
        """The exception to raise for a {"mro", "msg"} description; exits: a SystemExit stays one."""
        if not isinstance(info, dict):
            return RemoteError("the other side raised an unreadable exception")
        mro = info.get("mro")
        if exits and isinstance(mro, list) and mro[:1] == ["builtins.SystemExit"]:
            code = info.get("code")
            return _SystemExit(code if code is None or type(code) in (int, str) else None)
        cls = self.get(mro)
        msg = clip(info.get("msg", ""))
        try:
            return cls(msg)
        except Exception:
            return RemoteError("%s: %s" % (cls.__name__, msg))


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


FORWARDED_DUNDERS = ("__name__", "__qualname__", "__doc__", "__module__", "__bases__")


class Ref:
    """An object living in the candidate process. Every attribute name except dunders is the candidate
    object's (the proxy's own state is reached with object.__getattribute__ only)."""

    __slots__ = ("_c", "_id", "__weakref__")

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

    def __subclasscheck__(self, cls):
        # issubclass(m.Child, m.Base); a test-side class is never a subclass of a candidate class.
        if not _same(self, cls):
            return False
        return _req(self, "issubclass", {"cls": cls}) is True

    def __dir__(self):
        names = _req(self, "dir")
        return [n for n in names if isinstance(n, str)] if isinstance(names, list) else []


class CallableRef(Ref):
    __slots__ = ()

    def __call__(self, *args, **kwargs):
        return _req(self, "call", {"args": args, "kwargs": tuple(kwargs.items())})


# Dunders whose override by a candidate class changes how its hybrid answers (see the module docstring).
HY_DUNDERS = ("__eq__", "__ne__", "__hash__", "__contains__", "__getitem__", "__len__", "__iter__", "__bool__", "__reversed__", "__missing__")
_PROTOCOL = ("__contains__", "__getitem__", "__len__", "__iter__", "__bool__", "__reversed__")
_ARITH = ("__add__", "__radd__", "__mul__", "__rmul__", "__mod__", "__rmod__", "__or__", "__ror__", "__and__", "__rand__", "__sub__", "__rsub__", "__xor__", "__rxor__")
_INPLACE = ("__setitem__", "__delitem__", "__iadd__", "__imul__", "__ior__", "__iand__", "__isub__", "__ixor__")
HYBRID_BASES = frozenset(DATA_BASES) | LINK_TYPES


def overridden(t, base):
    """The HY_DUNDERS that class t defines differently from base."""
    out = []
    for n in HY_DUNDERS:
        try:
            mine = getattr(t, n, None)
        except Exception:
            mine = None
        if mine is not getattr(base, n, None):
            out.append(n)
    return out


def _volatile(x):
    """Whether by-value data can go stale: it holds a mutable container (a namedtuple holding a list)."""
    t = type(x)
    if t in LINK_TYPES:
        return True
    if t is tuple:
        return any(_volatile(i) for i in x)
    return False


def _hy_ref(h):
    return object.__getattribute__(h, "_terrarium_ref")


def _hy_store(h, base, data):
    """Put data into mutable hybrid h's own storage, through the base type only (never h's overrides)."""
    if base is list or base is bytearray:
        base.__setitem__(h, slice(None), data)
    elif base is set:
        set.clear(h)
        set.update(h, data)
    else:
        base.clear(h)
        for k, v in (OrderedDict.items(data) if base is OrderedDict else dict.items(data)):
            base.__setitem__(h, k, v)


def _hy_data(h):
    """The hybrid's data: re-read when candidate code ran since the last read (mutable hybrids in place;
    immutable ones only if their data holds a mutable container)."""
    get = object.__getattribute__
    ref = get(h, "_terrarium_ref")
    client = get(ref, "_c")
    if get(h, "_terrarium_gen") == client.gen or not get(h, "_terrarium_volatile"):
        return get(h, "_terrarium_data")
    base = type(h)._terrarium_base
    data = _req(ref, "data")
    if type(data) is not base:
        raise CandidateGone(client.gone or "candidate sent %s data for a %s" % (type(data).__name__, base.__name__))
    if base in LINK_TYPES:
        _hy_store(h, base, data)
        data = h
    else:
        object.__setattr__(h, "_terrarium_volatile", _volatile(data))
    object.__setattr__(h, "_terrarium_data", data)
    object.__setattr__(h, "_terrarium_gen", client.gen)
    return data


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


def _hy_equality(how, strict):
    def method(self, other):
        if _ref_of(other) is not None:
            # Two candidate objects: the candidate compares them, as it would in one process.
            return _cmp(_hy_ref(self), how, other)
        local = getattr(type(self)._terrarium_base, "__%s__" % how)(_hy_data(self), other)
        if not strict or local is NotImplemented or (how == "eq") != local:
            return local
        # The class overrides ==: its answer counts only where the data agrees, so the candidate is shown
        # only a value its data already equals.
        b = _req(_hy_ref(self), "cmp", {"other": other}, how=how)
        return b if type(b) is bool else NotImplemented

    method.__name__ = "__%s__" % how
    return method


def _hy_order(how):
    def method(self, other):
        if _ref_of(other) is not None:
            return _cmp(_hy_ref(self), how, other)
        return getattr(type(self)._terrarium_base, "__%s__" % how)(_hy_data(self), other)

    method.__name__ = "__%s__" % how
    return method


def _hy_local(name):
    def method(self, *args):
        return getattr(type(self)._terrarium_base, name)(_hy_data(self), *args)

    method.__name__ = name
    return method


def _hy_forward(name):
    def method(self, *args):
        ref = _hy_ref(self)
        f = getattr(Ref, name, None)
        if f is not None:
            return f(ref, *args)
        return _req(ref, "getattr", name=name)(*args)

    method.__name__ = name
    return method


def hybrid_class(base, over, name, module):
    """The test-side class for candidate objects of one class (by base type and overridden HY_DUNDERS)."""
    mutable = base in LINK_TYPES
    ns = {"_terrarium_base": base, "__module__": module}
    strict = "__eq__" in over or "__ne__" in over
    for how in ("eq", "ne"):
        ns["__%s__" % how] = _hy_equality(how, strict)
    for how in ("lt", "le", "gt", "ge"):
        ns["__%s__" % how] = _hy_order(how)
    forward = set(over)
    if "__missing__" in over or base is DefaultDict:
        # A missing key runs the candidate's __missing__ (a defaultdict's factory) on the candidate's object.
        forward.add("__getitem__")
    for n in _PROTOCOL:
        if n in forward:
            ns[n] = _hy_forward(n)
        elif hasattr(base, n):
            ns[n] = _hy_local(n)
    if "__hash__" in over:
        ns["__hash__"] = _hy_forward("__hash__")
    else:
        ns["__hash__"] = None if mutable else _hy_local("__hash__")
    for n in _ARITH:
        if hasattr(base, n):
            ns[n] = _hy_local(n)
    if mutable:
        # Changes happen on the candidate's object (the in-place operators return it, so it stays one object).
        for n in _INPLACE:
            if hasattr(base, n):
                ns[n] = _hy_forward(n)
    return type(name, (Hybrid, base), ns)


class Client:
    """Test side of the channel."""

    def __init__(self, sock, timeout=30.0, deadline=None):
        self.chan = Channel(sock)
        self.timeout = timeout  # seconds per answer, None for no limit
        self.deadline = deadline  # time.monotonic() after which no answer is awaited
        self.gone = None
        self.callbacks = {}
        self.callback_ids = {}
        self.exc = ExceptionTypes()
        self.hybrid_classes = {}
        self.refs = weakref.WeakValueDictionary()  # (id, callable) -> Ref, so one candidate object is one Ref
        self.hybrids = weakref.WeakValueDictionary()  # id -> mutable hybrid
        self.frozen = {}  # id -> immutable hybrid (tuple and int subclasses can't be weakly referenced)
        self.ntuples = {}  # (name, fields) -> the test's namedtuple class
        self.links = {}  # link id -> the test's container (ids < 0: containers the candidate linked)
        self.link_ids = {}  # id(container) -> link id
        self.snaps = {}  # link id -> shallow(container) as the candidate last saw it
        self.next_link = 1
        self.new = []  # links made while encoding the message being sent
        self.enc = None
        self.gen = 0  # messages received from the candidate; hybrids re-read their data when it moves
        self.sync_secs = 0.0
        self.candidate_secs = 0.0
        left = None if deadline is None else deadline - time.monotonic()
        self.sync_limit = SYNC_LIMIT if left is None else max(SYNC_MIN, SYNC_SHARE * left)
        # Reference count of a container nothing but self.links holds, measured the same way it is checked.
        self.links[0] = []
        self.free = self._refcount(0)
        del self.links[0]

    def _refcount(self, n):
        obj = self.links[n]
        return sys.getrefcount(obj)

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

    def _special(self, v, depth):
        r = _ref_of(v)
        if r is not None:
            if object.__getattribute__(r, "_c") is not self:
                raise Unsendable("a candidate object from another grading run")
            return {"t": "ref", "id": object.__getattribute__(r, "_id")}
        t = type(v)
        fields = ntuple_fields(t)
        if fields is not None:
            self.ntuples[(t.__name__, fields)] = t
            return {"t": "ntuple", "n": t.__name__, "f": list(fields), "v": [self.enc.enc(x, depth + 1) for x in tuple.__iter__(v)]}
        if family(v) is None:
            return None
        n = self.link_ids.get(id(v))
        if n is not None and self.links.get(n) is v:
            return {"t": "link", "id": n}
        n = self.next_link
        self.next_link += 1
        self.links[n] = v
        self.link_ids[id(v)] = n
        self.new.append(n)
        tag = self.enc.contents(v, depth, alias=False)
        tag["link"] = n
        self.snaps[n] = shallow(v)
        return tag

    def _unlink(self, n):
        v = self.links.pop(n, None)
        self.snaps.pop(n, None)
        if v is not None and self.link_ids.get(id(v)) == n:
            del self.link_ids[id(v)]

    def _resolve(self, tag, depth, dec):
        t = tag["t"]
        if t == "ref":
            rid = tag.get("id")
            if type(rid) is not int:
                raise ProtocolError("bad ref")
            if "data" in tag:
                return self._hybrid(rid, tag, depth, dec)
            return self._ref(rid, tag.get("callable") is True)
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
            return self.exc.get(tag.get("mro"))
        raise ProtocolError("unknown tag %r" % t)

    def _ref(self, rid, is_callable):
        key = (rid, is_callable)
        ref = self.refs.get(key)
        if ref is None:
            ref = CallableRef(self, rid) if is_callable else Ref(self, rid)
            self.refs[key] = ref
        return ref

    def _hybrid(self, rid, tag, depth, dec):
        data = dec.dec(tag["data"], depth)
        base = type(data)
        if base not in HYBRID_BASES:
            raise ProtocolError("candidate object with %s data" % base.__name__)
        path = tag.get("cls")
        path = path[:300] if isinstance(path, str) else "candidate.object"
        over = tag.get("over")
        over = frozenset(n for n in over if n in HY_DUNDERS) if isinstance(over, list) else frozenset()
        key = (base, path, over)
        cls = self.hybrid_classes.get(key)
        if cls is None:
            module, _, name = path.rpartition(".")
            cls = hybrid_class(base, over, name if name.isidentifier() else "CandidateObject", module or "candidate")
            self.hybrid_classes[key] = cls
        mutable = base in LINK_TYPES
        raw = None if mutable else json.dumps(tag["data"], separators=(",", ":"))
        cache = self.hybrids if mutable else self.frozen
        h = cache.get(rid)
        if h is not None and type(h) is cls and (mutable or object.__getattribute__(h, "_terrarium_raw") == raw):
            # The same candidate object again: the same test-side object, with its data as just sent.
            if mutable:
                _hy_store(h, base, data)
            object.__setattr__(h, "_terrarium_gen", self.gen)
            return h
        if mutable:
            h = base.__new__(cls)
            _hy_store(h, base, data)
            data = h
        else:
            h = base.__new__(cls, data)
        object.__setattr__(h, "_terrarium_ref", self._ref(rid, tag.get("callable") is True))
        object.__setattr__(h, "_terrarium_gen", self.gen)
        object.__setattr__(h, "_terrarium_data", data)
        object.__setattr__(h, "_terrarium_volatile", mutable or _volatile(data))
        object.__setattr__(h, "_terrarium_raw", raw)
        cache[rid] = h
        return h

    def _link(self, n, obj):
        if n >= 0 or n in self.links:
            raise ProtocolError("bad link id %d" % n)
        self.links[n] = obj
        self.link_ids[id(obj)] = n

    def _linked(self, n, obj):
        self.snaps[n] = shallow(obj)

    def _ntuple(self, name, fields, values):
        cls = self.ntuples.get((name, fields))
        return cls._make(values) if cls is not None else tuple(values)

    def _decoder(self):
        return Decoder(self._resolve, self._link, self._linked, self._ntuple, TEST_NAMES_IN)

    # linked containers

    def _apply(self, msg, dec):
        """Write the candidate's changes to linked containers into the test's own objects, in place."""
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
            fam = family(obj)
            new = dec.dec(entry[1])
            if type(new) not in LINK_TYPES or family(new) is not fam:
                raise ProtocolError("sync turns a %s into a %s" % (fam.__name__, type(new).__name__))
            updates.append((entry[0], obj, fam, new))
        for n, obj, fam, new in updates:
            try:
                write_into(obj, fam, new)
            except Exception as e:
                raise self._fail("writing the candidate's changes back into a %s failed: %s" % (type(obj).__name__, clip(_safe_str(e), 300)))
            self.snaps[n] = shallow(obj)

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

    def _send(self, kind, payload, vals=None):
        """Send {kind: payload} with vals encoded into payload, after the changes the test made to linked
        containers. Links whose containers the test no longer holds end here: nothing in the test can see
        those containers any more."""
        if self.sync_secs + self.candidate_secs > self.sync_limit:
            raise self._fail("keeping the containers shared with candidate code in sync took over %.0fs (%d linked); the grader can't keep up" % (self.sync_limit, len(self.links)))
        t0 = time.monotonic()
        enc = self.enc = Encoder(self._objref, self._special, TEST_NAMES_OUT)
        new = self.new = []
        sync, snaps = [], {}
        try:
            for n, obj in list(self.links.items()):
                if changed(obj, self.snaps[n]):
                    sync.append([n, enc.contents(obj, 0, alias=False)])
                    snaps[n] = shallow(obj)
            obj = None
            made = set(new)
            drop = [n for n in list(self.links) if n not in made and self._refcount(n) <= self.free]
            self.sync_secs += time.monotonic() - t0
            for k, v in (vals or {}).items():
                payload[k] = enc.enc(v)
            msg = {kind: payload}
            if sync:
                msg["sync"] = sync
            if drop:
                msg["unlink"] = drop
            self.chan.send(msg)
        except BaseException:
            for n in new:
                self._unlink(n)
            raise
        self.snaps.update(snaps)
        for n in drop:
            self._unlink(n)

    def _receive(self):
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
        busy = msg.get("busy")
        if type(busy) in (int, float) and busy >= 0:
            self.candidate_secs = float(busy)
        t0 = time.monotonic()
        dec = self._decoder()
        try:
            self._apply(msg, dec)
        except ProtocolError as e:
            raise self._fail("candidate broke the grading protocol (%s)" % e) from None
        finally:
            self.sync_secs += time.monotonic() - t0
        return msg, dec

    def request(self, op, vals=None, **plain):
        if self.gone:
            raise CandidateGone(self.gone)
        try:
            self._send("req", dict(plain, op=op), vals)
        except OSError as e:
            raise self._fail("candidate process is gone (%s)" % e) from None
        while True:
            msg, dec = self._receive()
            try:
                if "rep" in msg:
                    rep = msg["rep"]
                    if not isinstance(rep, dict):
                        raise ProtocolError("bad reply")
                    if "ok" in rep:
                        return dec.dec(rep["ok"])
                    if "unsendable" in rep:
                        raise Unsendable("the candidate's result can't be sent to the tests: %s" % clip(rep["unsendable"], 300))
                    raise self.exc.instance(rep.get("raise"), exits=True)
                if not isinstance(msg.get("req"), dict):
                    raise ProtocolError("bad message")
            except ProtocolError as e:
                raise self._fail("candidate broke the grading protocol (%s)" % e) from None
            self._serve(msg["req"], dec)

    def _serve(self, req, dec):
        """The candidate calls back into a function the test passed it."""
        try:
            if req.get("op") != "callback":
                raise ProtocolError("unexpected request")
            fn = self.callbacks.get(req.get("cb"))
            if fn is None:
                raise ProtocolError("unknown callback")
            args = dec.dec(req.get("args"))
            pairs = dec.dec(req.get("kwargs"))
            if type(args) is not tuple or type(pairs) is not tuple or not all(type(p) is tuple and len(p) == 2 for p in pairs):
                raise ProtocolError("bad callback arguments")
            kwargs = {str(k): v for k, v in pairs}
        except ProtocolError as e:
            raise self._fail("candidate broke the grading protocol (%s)" % e) from None
        try:
            try:
                result = fn(*args, **kwargs)
            except Exception as e:
                self._send("rep", {"raise": describe_exception(e)})
                return
            self._send("rep", {}, {"ok": result})
        except OSError as e:
            raise self._fail("candidate process is gone (%s)" % e) from None
        except BaseException as e:  # noqa: B036 - the candidate still waits for this answer
            # Nothing more can be asked of the candidate: it is waiting for an answer that won't come.
            if not self.gone:
                self.gone = "grading stopped in a test callback: %s" % clip(_safe_str(e) or type(e).__name__, 300)
            raise


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


class _Data:
    """Reply with a candidate object's base data (a hybrid re-reading it)."""

    def __init__(self, obj):
        self.obj = obj


class Server:
    """Candidate side of the channel: holds the candidate's objects and answers requests."""

    def __init__(self, sock):
        self.chan = Channel(sock)
        self.objs = {}
        self.ids = {}
        self.callbacks = {}
        self.exc = ExceptionTypes()
        self.ntuple_classes = {}  # (name, fields) -> class made for the test's namedtuples
        self.ntuple_keys = {}  # that class -> (name, fields)
        self.links = {}  # link id -> this side's copy of a linked container (ids < 0: linked here)
        self.link_of = {}  # id(container) -> link id
        self.snaps = {}  # link id -> shallow(container) as the test last saw it
        self.touched = set()  # links handed to candidate code since the last message sent
        self.pending = []  # sync entries of a message that could not be sent
        self.next_link = -1
        self.enc = None
        self.linking = False
        self.busy = 0.0
        # Reference count of a container nothing but self.links holds, measured the same way it is checked.
        self.links[0] = []
        self.free = self._refcount(0)
        del self.links[0]

    def _refcount(self, n):
        obj = self.links[n]
        return sys.getrefcount(obj)

    def _objref(self, v):
        if type(v) is Callback and v._srv is self:
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
        if self.linking and t in LINK_TYPES:
            # A container inside a linked one is shared too.
            n = self.next_link
            self.next_link -= 1
            self.links[n] = v
            self.link_of[id(v)] = n
            tag = self.enc.contents(v, depth, alias=False)
            tag["link"] = n
            self.snaps[n] = shallow(v)
            return tag
        key = self.ntuple_keys.get(t)
        if key is not None:
            return {"t": "ntuple", "n": key[0], "f": list(key[1]), "v": [self.enc.enc(x, depth + 1) for x in tuple.__iter__(v)]}
        if t in CONTAINERS or t is bool or not issubclass(t, DATA_BASES):
            return None
        tag = self._objref(v)
        tag["cls"] = class_path(t)
        tag["over"] = overridden(t, local_base(t))
        tag["data"] = self.enc.contents(v, depth, alias=False)
        return tag

    def _link(self, n, obj):
        if n <= 0 or n in self.links:
            raise ProtocolError("bad link id %d" % n)
        self.links[n] = obj
        self.link_of[id(obj)] = n
        self.touched.add(n)

    def _linked(self, n, obj):
        self.snaps[n] = shallow(obj)

    def _ntuple(self, name, fields, values):
        key = (name, fields)
        cls = self.ntuple_classes.get(key)
        if cls is None:
            ok = name.isidentifier() and not keyword.iskeyword(name)
            cls = collections.namedtuple(name if ok else "NamedTuple", fields, rename=True)
            self.ntuple_classes[key] = cls
            self.ntuple_keys[cls] = key
        return cls._make(values)

    def _resolve(self, tag, depth, dec):
        t = tag["t"]
        if t == "ref":
            if tag.get("id") not in self.objs:
                raise ProtocolError("unknown ref")
            return self.objs[tag["id"]]
        if t == "link":
            n = tag.get("id")
            if n not in self.links:
                raise ProtocolError("unknown link")
            self.touched.add(n)
            return self.links[n]
        if t == "cb":
            cid = tag.get("id")
            if type(cid) is not int:
                raise ProtocolError("bad callback")
            cb = self.callbacks.get(cid)
            if cb is None:
                cb = self.callbacks[cid] = Callback(self, cid)
            return cb
        raise ProtocolError("unknown tag %r" % t)

    def _recv(self):
        """The next message, with the test's unlinks and changes to linked containers applied."""
        msg = self.chan.recv()
        dec = Decoder(self._resolve, self._link, self._linked, self._ntuple, CANDIDATE_NAMES_IN)
        sync = msg.get("sync")
        if isinstance(sync, list):
            updates = []
            for entry in sync:
                if not (isinstance(entry, list) and len(entry) == 2 and type(entry[0]) is int and entry[0] in self.links):
                    raise ProtocolError("bad sync entry")
                obj = self.links[entry[0]]
                new = dec.dec(entry[1])
                if type(new) not in LINK_TYPES or family(new) is not family(obj):
                    raise ProtocolError("bad sync value")
                updates.append((entry[0], obj, new))
            for n, obj, new in updates:
                write_into(obj, family(obj), new)
                self.snaps[n] = shallow(obj)
        # After the changes: the test sends a container's last changes in the message that lets go of it.
        ended = msg.get("unlink")
        if isinstance(ended, list):
            for n in ended:
                obj = self.links.pop(n, None) if type(n) is int else None
                if obj is not None:
                    self.link_of.pop(id(obj), None)
                    self.snaps.pop(n, None)
                    self.touched.discard(n)
        return msg, dec

    def _changes(self, enc):
        """Sync entries for the linked containers candidate code changed: of the ones it was handed since
        the last message sent and the ones it still holds (nothing else can reach the rest)."""
        t0 = time.monotonic()
        sync, err = self.pending, None
        self.pending = []
        touched, self.touched = self.touched, set()
        self.linking = True
        try:
            for n in list(self.links):
                if n not in touched and self._refcount(n) <= self.free:
                    continue
                obj = self.links[n]
                if not changed(obj, self.snaps[n]):
                    continue
                try:
                    sync.append([n, enc.contents(obj, 0, alias=False)])
                except (GraderError, RecursionError, ValueError) as e:
                    err = clip(_safe_str(e) or type(e).__name__, 300)
                    continue
                self.snaps[n] = shallow(obj)
        finally:
            self.linking = False
            self.busy += time.monotonic() - t0
        return sync, err

    def _send(self, kind, build):
        """Send {kind: build(encoder)}, after the new contents of the linked containers candidate code changed."""
        enc = self.enc = Encoder(self._objref, self._special, CANDIDATE_NAMES_OUT)
        sync, err = self._changes(enc)
        try:
            payload = build(enc)
        except (GraderError, RecursionError) as e:
            if kind != "rep":
                self.pending = sync
                raise
            payload = {"unsendable": clip(_safe_str(e) or type(e).__name__)}
        except BaseException as e:  # noqa: B036 - candidate code run while encoding (a metaclass)
            if kind != "rep":
                self.pending = sync
                raise
            payload = {"raise": describe_exception(e)}
        msg = {kind: payload, "busy": round(self.busy, 3)}
        if sync:
            msg["sync"] = sync
        if err:
            msg["syncError"] = err
        try:
            self.chan.send(msg)
        except Unsendable as e:
            if kind != "rep":
                self.pending = sync
                raise
            msg[kind] = {"unsendable": clip(e, 300)}
            try:
                self.chan.send(msg)
            except Unsendable:
                msg.pop("sync", None)
                msg["syncError"] = clip(e, 300)
                self.chan.send(msg)

    def serve_forever(self):
        while True:
            try:
                msg, dec = self._recv()
            except (EOFError, OSError):
                return
            self._handle(msg.get("req"), dec)

    def _handle(self, req, dec):
        try:
            result = self._op(req, dec)
        except BaseException as e:  # noqa: B036 - the candidate's SystemExit is a result, not our exit
            info = describe_exception(e)
            self._send("rep", lambda enc: {"raise": info})
            return
        if isinstance(result, _Data):
            self._send("rep", lambda enc: {"ok": enc.contents(result.obj, 0, alias=False)})
        else:
            self._send("rep", lambda enc: {"ok": enc.enc(result)})

    def _op(self, req, dec):
        import importlib

        op = req["op"]
        if op == "import":
            return importlib.import_module(str(req["name"]))
        obj = self.objs[req["ref"]]
        if op == "getattr":
            return getattr(obj, str(req["name"]))
        if op == "setattr":
            setattr(obj, str(req["name"]), dec.dec(req["value"]))
            return None
        if op == "delattr":
            delattr(obj, str(req["name"]))
            return None
        if op == "call":
            args = dec.dec(req.get("args"))
            pairs = dec.dec(req.get("kwargs"))
            if type(args) is not tuple or type(pairs) is not tuple:
                raise ProtocolError("bad call arguments")
            return obj(*args, **{str(k): v for k, v in pairs})
        if op == "getitem":
            return obj[dec.dec(req["key"])]
        if op == "setitem":
            obj[dec.dec(req["key"])] = dec.dec(req["value"])
            return None
        if op == "delitem":
            del obj[dec.dec(req["key"])]
            return None
        if op == "len":
            return len(obj)
        if op == "bool":
            return bool(obj)
        if op == "contains":
            return dec.dec(req["item"]) in obj
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
            return _Data(obj)
        if op == "cmp":
            import operator

            how = str(req["how"])
            if how not in ("eq", "ne", "lt", "le", "gt", "ge"):
                raise ValueError("bad comparison")
            return bool(getattr(operator, how)(obj, dec.dec(req["other"])))
        if op == "isinstance":
            return isinstance(dec.dec(req["obj"]), obj)
        if op == "issubclass":
            return issubclass(dec.dec(req["cls"]), obj)
        if op == "dir":
            return [n for n in dir(obj) if isinstance(n, str)]
        raise ValueError("unknown op %r" % op)

    def call_back(self, cid, args, kwargs):
        self._send("req", lambda enc: {"op": "callback", "cb": cid, "args": enc.enc(tuple(args)), "kwargs": enc.enc(tuple(kwargs.items()))})
        while True:
            msg, dec = self._recv()
            if "rep" in msg:
                rep = msg["rep"]
                if "ok" in rep:
                    return dec.dec(rep["ok"])
                raise self.exc.instance(rep.get("raise"))
            self._handle(msg.get("req"), dec)
