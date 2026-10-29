"""Terrarium grading RPC (Python 3.9+, standard library only).

Candidate code runs in its own process (uid 1000 in the guest); the hidden tests run in another (uid 1001).
The test side sees the candidate's modules as proxies. Plain data (None, bool, int, float, complex, str,
bytes, list, tuple, dict, set, Decimal, Fraction, datetime values) crosses by value; every other object
stays in the candidate process and is used through a reference. Nothing the candidate sends is executed or
unpickled, and a reference is never compared with one of the test's own values: `ref == expected` is False
without asking the candidate, so it can't learn an expected value and agree with it.

Wire format: 4-byte big-endian length, then UTF-8 JSON. Every message is {"req": {...}} or {"rep": {...}}.
Calls nest: while either side waits for a reply it serves the other side's requests (callbacks).
"""

import base64
import builtins
import datetime
import decimal
import fractions
import json
import socket
import struct
import time

MAX_MSG = 64 << 20
MAX_DEPTH = 100
MAX_TEXT = 4000


class ProtocolError(Exception):
    pass


class CandidateGone(Exception):
    """The candidate process ended, hung or broke the protocol; every later call fails the same way."""


class RemoteError(Exception):
    """An exception from the candidate's code whose type has no safe local equivalent."""


class Channel:
    def __init__(self, sock):
        self.sock = sock

    def send(self, obj):
        data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        if len(data) > MAX_MSG:
            raise ValueError("value too large to send (%d bytes)" % len(data))
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


def encode(v, objref, depth=0):
    """Plain data by value; anything else through objref(v), which returns a tagged reference."""
    t = type(v)
    if v is None or t is bool or t is int or t is str:
        return v
    if t is float:
        if v != v or v in (float("inf"), float("-inf")):
            return {"t": "float", "v": repr(v)}
        return v
    if depth > MAX_DEPTH:
        raise ValueError("value nested too deeply")
    d = depth + 1
    if t is list:
        return {"t": "list", "v": [encode(x, objref, d) for x in v]}
    if t is tuple:
        return {"t": "tuple", "v": [encode(x, objref, d) for x in v]}
    if t is dict:
        return {"t": "dict", "v": [[encode(k, objref, d), encode(x, objref, d)] for k, x in v.items()]}
    if t is set or t is frozenset:
        return {"t": t.__name__, "v": [encode(x, objref, d) for x in v]}
    if t is bytes or t is bytearray:
        return {"t": t.__name__, "v": base64.b64encode(bytes(v)).decode("ascii")}
    if t is complex:
        return {"t": "complex", "v": [encode(v.real, objref, d), encode(v.imag, objref, d)]}
    if t is decimal.Decimal:
        return {"t": "decimal", "v": str(v)}
    if t is fractions.Fraction:
        return {"t": "fraction", "v": [str(v.numerator), str(v.denominator)]}
    if t is datetime.datetime or t is datetime.date or t is datetime.time:
        if getattr(v, "tzinfo", None) is None:
            return {"t": t.__name__, "v": v.isoformat()}
    if t is datetime.timedelta:
        return {"t": "timedelta", "v": [v.days, v.seconds, v.microseconds]}
    # Subclasses of the built-in data types (namedtuple, Counter, OrderedDict, defaultdict, str and int
    # subclasses) travel as their base type, which is how they compare anyway.
    if isinstance(v, bool):
        return bool(v)
    if isinstance(v, int) and not hasattr(v, "_value_"):
        return int.__int__(v)
    if isinstance(v, float):
        return encode(float.__float__(v), objref, depth)
    if isinstance(v, str):
        return str.__str__(v)
    if isinstance(v, (bytes, bytearray)):
        return encode(bytes(v), objref, depth)
    if isinstance(v, tuple):
        return {"t": "tuple", "v": [encode(x, objref, d) for x in tuple.__iter__(v)]}
    if isinstance(v, list):
        return {"t": "list", "v": [encode(x, objref, d) for x in list.__iter__(v)]}
    if isinstance(v, dict):
        return {"t": "dict", "v": [[encode(k, objref, d), encode(x, objref, d)] for k, x in dict.items(v)]}
    if isinstance(v, (set, frozenset)):
        return {"t": "set" if isinstance(v, set) else "frozenset", "v": [encode(x, objref, d) for x in v]}
    return objref(v)


_FLOATS = {"nan": float("nan"), "inf": float("inf"), "-inf": float("-inf")}


def decode(x, resolve, depth=0):
    """Inverse of encode; resolve(tag) turns reference tags into objects. Never runs sent code."""
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
        if t == "list":
            return [decode(i, resolve, d) for i in v]
        if t == "tuple":
            return tuple(decode(i, resolve, d) for i in v)
        if t == "dict":
            return {decode(k, resolve, d): decode(i, resolve, d) for k, i in v}
        if t == "set":
            return {decode(i, resolve, d) for i in v}
        if t == "frozenset":
            return frozenset(decode(i, resolve, d) for i in v)
        if t == "bytes":
            return base64.b64decode(v, validate=True)
        if t == "bytearray":
            return bytearray(base64.b64decode(v, validate=True))
        if t == "float":
            return _FLOATS[v]
        if t == "complex":
            return complex(decode(v[0], resolve, d), decode(v[1], resolve, d))
        if t == "decimal":
            return decimal.Decimal(str(v))
        if t == "fraction":
            return fractions.Fraction(int(v[0]), int(v[1]))
        if t in ("datetime", "date", "time"):
            return getattr(datetime, t).fromisoformat(str(v))
        if t == "timedelta":
            return datetime.timedelta(days=int(v[0]), seconds=int(v[1]), microseconds=int(v[2]))
    except ProtocolError:
        raise
    except Exception as e:
        raise ProtocolError("bad %s value: %s" % (t, e))
    return resolve(x)


def clip(s, n=MAX_TEXT):
    s = str(s)
    return s if len(s) <= n else s[: n - 3] + "..."


def class_path(cls):
    return "%s.%s" % (getattr(cls, "__module__", "?"), getattr(cls, "__qualname__", getattr(cls, "__name__", "?")))


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


class Ref:
    """An object living in the candidate process."""

    __slots__ = ("_c", "_id")

    def __init__(self, client, rid):
        object.__setattr__(self, "_c", client)
        object.__setattr__(self, "_id", rid)

    def _req(self, op, **kw):
        return object.__getattribute__(self, "_c").request(op, ref=object.__getattribute__(self, "_id"), **kw)

    def _same(self, other):
        return isinstance(other, Ref) and object.__getattribute__(other, "_c") is object.__getattribute__(self, "_c")

    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__") and name not in ("__name__", "__qualname__", "__doc__", "__module__"):
            raise AttributeError(name)
        return self._req("getattr", name=name)

    def __setattr__(self, name, value):
        c = object.__getattribute__(self, "_c")
        self._req("setattr", name=name, value=c.enc(value))

    def __delattr__(self, name):
        self._req("delattr", name=name)

    def __getitem__(self, key):
        return self._req("getitem", key=object.__getattribute__(self, "_c").enc(key))

    def __setitem__(self, key, value):
        c = object.__getattribute__(self, "_c")
        self._req("setitem", key=c.enc(key), value=c.enc(value))

    def __delitem__(self, key):
        self._req("delitem", key=object.__getattribute__(self, "_c").enc(key))

    def __len__(self):
        n = self._req("len")
        if type(n) is not int or n < 0:
            raise TypeError("len() of a candidate object returned %r" % (n,))
        return n

    def __bool__(self):
        b = self._req("bool")
        if type(b) is not bool:
            raise TypeError("bool() of a candidate object returned a non-bool")
        return b

    def __contains__(self, item):
        b = self._req("contains", item=object.__getattribute__(self, "_c").enc(item))
        if type(b) is not bool:
            raise TypeError("'in' on a candidate object returned a non-bool")
        return b

    def __iter__(self):
        it = self._req("iter")
        if not isinstance(it, Ref):
            raise TypeError("iter() of a candidate object returned a non-iterator")
        return it

    def __next__(self):
        return self._req("next")

    def __repr__(self):
        try:
            s = self._req("repr")
        except Exception as e:
            return "<candidate object (repr failed: %s)>" % type(e).__name__
        return clip(s, 2000) if isinstance(s, str) else "<candidate object>"

    def __str__(self):
        s = self._req("str")
        if not isinstance(s, str):
            raise TypeError("str() of a candidate object returned a non-string")
        return s

    def __hash__(self):
        h = self._req("hash")
        if type(h) is not int:
            raise TypeError("hash() of a candidate object returned a non-int")
        return h

    def _cmp(self, op, other):
        # Only candidate objects are compared by the candidate; never the test's own values.
        if not self._same(other):
            return NotImplemented
        b = self._req("cmp", how=op, other=object.__getattribute__(self, "_c").enc(other))
        return b if type(b) is bool else NotImplemented

    def __eq__(self, other):
        return self._cmp("eq", other)

    def __ne__(self, other):
        r = self._cmp("ne", other)
        return True if r is NotImplemented and not self._same(other) else r

    def __lt__(self, other):
        return self._cmp("lt", other)

    def __le__(self, other):
        return self._cmp("le", other)

    def __gt__(self, other):
        return self._cmp("gt", other)

    def __ge__(self, other):
        return self._cmp("ge", other)

    def __instancecheck__(self, obj):
        if not self._same(obj):
            return False
        return self._req("isinstance", obj=object.__getattribute__(self, "_c").enc(obj)) is True

    def __dir__(self):
        names = self._req("dir")
        return [n for n in names if isinstance(n, str)] if isinstance(names, list) else []


class CallableRef(Ref):
    __slots__ = ()

    def __call__(self, *args, **kwargs):
        c = object.__getattribute__(self, "_c")
        return self._req("call", args=[c.enc(a) for a in args], kwargs={str(k): c.enc(v) for k, v in kwargs.items()})


class Client:
    """Test side of the channel."""

    def __init__(self, sock, timeout=30.0):
        self.chan = Channel(sock)
        self.timeout = timeout
        self.gone = None
        self.callbacks = {}
        self.callback_ids = {}
        self.exc_classes = {}

    # values

    def _objref(self, v):
        if isinstance(v, Ref) and object.__getattribute__(v, "_c") is self:
            return {"t": "ref", "id": object.__getattribute__(v, "_id")}
        if callable(v):
            n = self.callback_ids.get(id(v))
            if n is None:
                n = len(self.callbacks) + 1
                self.callbacks[n] = v
                self.callback_ids[id(v)] = n
            return {"t": "cb", "id": n}
        raise TypeError("a %s can't be passed to the candidate's code" % type(v).__name__)

    def enc(self, v):
        return encode(v, self._objref)

    def _resolve(self, tag):
        t = tag["t"]
        if t == "ref":
            rid = tag.get("id")
            if type(rid) is not int:
                raise ProtocolError("bad ref")
            return CallableRef(self, rid) if tag.get("callable") is True else Ref(self, rid)
        if t == "cb":
            fn = self.callbacks.get(tag.get("id"))
            if fn is None:
                raise ProtocolError("unknown callback")
            return fn
        if t == "exc":
            return self.exception_class(tag.get("mro"))
        raise ProtocolError("unknown tag %r" % t)

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
            cls = type(name or "CandidateError", (base,), {"__module__": module or "candidate"})
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

    # calls

    def _fail(self, why):
        self.gone = why
        return CandidateGone(why)

    def request(self, op, **kw):
        if self.gone:
            raise CandidateGone(self.gone)
        try:
            self.chan.send({"req": dict(kw, op=op)})
        except (OSError, ValueError) as e:
            if isinstance(e, ValueError):
                raise TypeError(str(e))
            raise self._fail("candidate process is gone (%s)" % e)
        while True:
            try:
                msg = self.chan.recv(self.timeout)
            except socket.timeout:
                raise self._fail("candidate code did not answer within %gs" % self.timeout)
            except (EOFError, OSError):
                raise self._fail("candidate process ended")
            except ProtocolError as e:
                raise self._fail("candidate broke the grading protocol (%s)" % e)
            if "rep" in msg:
                rep = msg["rep"]
                if not isinstance(rep, dict):
                    raise self._fail("candidate broke the grading protocol (bad reply)")
                if "ok" in rep:
                    try:
                        return self.dec(rep["ok"])
                    except ProtocolError as e:
                        raise self._fail("candidate broke the grading protocol (%s)" % e)
                raise self._exception(rep.get("raise"))
            if "req" in msg:
                self._serve(msg["req"])
                continue
            raise self._fail("candidate broke the grading protocol (bad message)")

    def _serve(self, req):
        """The candidate calls back into a function the test passed it."""
        try:
            if not isinstance(req, dict) or req.get("op") != "callback":
                raise ProtocolError("unexpected request")
            fn = self.callbacks.get(req.get("cb"))
            if fn is None:
                raise ProtocolError("unknown callback")
            args = [self.dec(a) for a in req.get("args") or []]
            kwargs = {str(k): self.dec(v) for k, v in (req.get("kwargs") or {}).items()}
        except ProtocolError as e:
            raise self._fail("candidate broke the grading protocol (%s)" % e)
        try:
            rep = {"ok": self.enc(fn(*args, **kwargs))}
        except CandidateGone:
            raise
        except Exception as e:
            rep = {"raise": describe_exception(e)}
        try:
            self.chan.send({"rep": rep})
        except (OSError, ValueError) as e:
            raise self._fail("candidate process is gone (%s)" % e)


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


class Server:
    """Candidate side of the channel: holds the candidate's objects and answers requests."""

    def __init__(self, sock):
        self.chan = Channel(sock)
        self.objs = {}
        self.ids = {}

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

    def enc(self, v):
        return encode(v, self._objref)

    def _resolve(self, tag):
        t = tag["t"]
        if t == "ref":
            if tag.get("id") not in self.objs:
                raise ProtocolError("unknown ref")
            return self.objs[tag["id"]]
        if t == "cb":
            return Callback(self, tag.get("id"))
        raise ProtocolError("unknown tag %r" % t)

    def dec(self, x):
        return decode(x, self._resolve)

    def serve_forever(self):
        while True:
            try:
                msg = self.chan.recv()
            except (EOFError, OSError):
                return
            self._handle(msg.get("req"))

    def _handle(self, req):
        try:
            rep = {"ok": self.enc(self._op(req))}
        except BaseException as e:  # noqa: B036 - the candidate's SystemExit is a result, not our exit
            try:
                rep = {"raise": describe_exception(e)}
            except Exception:
                rep = {"raise": {"mro": ["builtins.Exception"], "msg": "unprintable exception"}}
        self.chan.send({"rep": rep})

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
            args = [self.dec(a) for a in req.get("args") or []]
            kwargs = {str(k): self.dec(v) for k, v in (req.get("kwargs") or {}).items()}
            return obj(*args, **kwargs)
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
        self.chan.send({"req": {"op": "callback", "cb": cid, "args": [self.enc(a) for a in args], "kwargs": {str(k): self.enc(v) for k, v in kwargs.items()}}})
        while True:
            msg = self.chan.recv()
            if "rep" in msg:
                rep = msg["rep"]
                if "ok" in rep:
                    return self.dec(rep["ok"])
                info = rep.get("raise") or {}
                raise RuntimeError("test callback raised %s" % clip(info.get("msg", "")))
            self._handle(msg.get("req"))
