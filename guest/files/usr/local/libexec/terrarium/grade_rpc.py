"""Terrarium grading RPC (Python 3.9+, standard library only).

Candidate code runs in its own process (uid 1000 in the guest); the hidden tests run in another (uid 1001) and use
the candidate's modules through proxies. The rule: the isolated run may never report a pass that the same tests
would not give the same code in one process. Where it can reproduce Python's semantics it does; where it can't, it
raises GraderError (a BaseException, so assertRaises can't catch it) and the test errors instead of passing.

Values. Immutable plain data (None, bool, int, float, complex, str, bytes, tuple, frozenset, slice, range, Decimal,
Fraction, datetime values with no or a fixed-offset timezone, namedtuples the test made, built-in classes and
functions by name) crosses by value; a tuple or frozenset met twice in one message arrives as one object. Mutable
containers (list, dict, OrderedDict, defaultdict with its factory, Counter, set, bytearray) are linked, whichever
side made them: each side holds its own copy and, before it hands control to the other side, sends the new contents
of every linked container its code changed that the other side can reach; the other side writes them into its copy
in place. A function that mutates its arguments, an object that keeps a container or hands out its own, and a test
that changes a container after passing or receiving it all behave as in one process. Changes are found by identity
against the last state sent (a pointer compare for lists), and each side checks only containers the other can reach:
the ones the other side's code holds and the ones a message hands over.

Candidate objects. Everything else stays in the candidate process. Its classes reach the tests as proxy classes with
the same name, bases (candidate classes mirrored, built-in data and exception bases real) and special methods, so
`type(x) is m.C`, isinstance, issubclass, callable() and the abstract base class checks answer as in one process.
Every special method the candidate's class defines runs in the candidate (operators, conversions, containers,
iteration, context managers, calls, hashing with the same hash seed, copying); attribute access goes to the
candidate's object. An object whose class derives from a built-in data type is a hybrid: an instance of that type
whose storage is linked to the object's, so base-type code reads its current data; methods its class overrides run
in the candidate. Comparing with a test value, the candidate's ==, != or ordering method is asked and its answer
must be the one comparing the data gives (no data: the identity fallback), else GraderError, so a candidate can't
claim a match. Exceptions arrive as instances of their class with
their args, attributes, str, repr, cause and context; other attributes go to the candidate's exception object.

Process state. Mirrored with every message, where candidate code could see or change it: sys.stdout/stderr/stdin,
print/input, argv, os.environ, the working directory, the random module's state, the decimal context, the recursion
limit and the warnings filters (both ways), and the tests' warnings hooks. Each side runs the other's requests as deep
in its stack as one process would ("ng": the requester's code frames), so recursion runs out at the same depth.

Wire format: 4-byte big-endian length, then ASCII JSON. Every message is {"req": {...}} or {"rep": {...}}; values go
under "v" (decoded first), then "sync" (new contents of linked containers) is applied. Both sides: "held"/"loose"
(links its code started or stopped holding), "unlink" (links neither side holds). Test side: "st" (process state),
"release" (proxies it dropped, in that order), "weak" (those of them the tests held weak references to). Candidate
side: "out", "stdin", "random", "rlimit", "decimal", "warnings" (state its code changed), "weakalive" (weakly held
objects released while the candidate still had them: a grader error), "busy" (seconds it spent on sync), "fatal".
Calls nest: while either side waits for a reply it serves the other side's requests (callbacks)."""

import base64
import builtins
import collections
import collections.abc
import datetime
import decimal
import fractions
import io
import json
import keyword
import os
import socket
import struct
import sys
import threading
import time
import types
import weakref
from operator import is_not

MAX_MSG = 64 << 20
MAX_DEPTH = 100
MAX_TEXT = 4000
BIG_INT_BITS = 1000  # larger ints cross as hex (json has a 4300-digit limit for decimal)
# Share of the grading budget both sides together may spend keeping linked containers in sync (at least
# SYNC_MIN seconds); SYNC_LIMIT seconds when there is no budget.
SYNC_SHARE = 0.25
SYNC_MIN = 5.0
SYNC_LIMIT = 30.0

OrderedDict = collections.OrderedDict
DefaultDict = collections.defaultdict
Counter = collections.Counter
_SystemExit = SystemExit
_FACTORY = DefaultDict.__dict__["default_factory"]


class ProtocolError(Exception):
    pass


class GraderError(BaseException):
    """A failure of the grading, not an exception from the candidate's code. Not an Exception subclass, so
    a hidden test's assertRaises can't catch it; unittest records it as an error."""


class CandidateGone(GraderError):
    """The candidate process ended, hung or broke the protocol; every later call fails the same way."""


class Unsendable(GraderError):
    """A value too large or too deeply nested to cross between the processes, or one that can't cross as is."""


class Inexact(GraderError):
    """A case the isolated run can't reproduce as one process would, so it can't be graded."""


class RemoteError(Exception):
    """An exception from the other side's code whose type has no safe local equivalent."""


def clip(s, n=MAX_TEXT):
    s = str(s)
    return s if len(s) <= n else s[: n - 3] + "..."


def _safe_str(e):
    try:
        return str(e)
    except Exception:
        return "<unprintable %s>" % type(e).__name__


class Channel:
    def __init__(self, sock):
        self.sock = sock

    def send(self, obj):
        try:
            data = json.dumps(obj, separators=(",", ":")).encode("ascii")
        except (ValueError, TypeError, RecursionError, OverflowError) as e:
            raise Unsendable("value can't be sent: %s" % clip(_safe_str(e), 200))
        if len(data) > MAX_MSG:
            raise Unsendable("value too large to send (%d bytes)" % len(data))
        self.sock.sendall(struct.pack(">I", len(data)) + data)

    def recv(self, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        (n,) = struct.unpack(">I", self._exact(4, deadline))
        if n > MAX_MSG:
            raise ProtocolError("message of %d bytes" % n)
        try:
            msg = json.loads(self._exact(n, deadline).decode("ascii"))
        except (ValueError, RecursionError) as e:
            raise ProtocolError("bad message: %s" % clip(e, 200))
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

# Built-in data types; candidate objects whose class derives from one are hybrids.
DATA_BASES = (list, tuple, dict, set, frozenset, str, bytes, bytearray, int, float, complex)
SCALARS = frozenset((type(None), bool, int, float, str))
# Linked containers by wire tag: a dict's tag names its standard-library kind.
LINKABLE = {"list": list, "dict": dict, "odict": OrderedDict, "ddict": DefaultDict, "counter": Counter, "set": set, "bytearray": bytearray}
LINK_TYPES = frozenset(LINKABLE.values())
LINK_TAGS = {v: k for k, v in LINKABLE.items()}
IMMUTABLE_TAGS = {"tuple": tuple, "str": str, "bytes": bytes, "int": int, "float": float, "complex": complex, "frozenset": frozenset}
DATA_TAGS = dict(LINKABLE, **IMMUTABLE_TAGS)


# The real built-in exception classes (by identity: a class can claim __module__ "builtins").
BUILTIN_EXCEPTIONS = frozenset(v for v in vars(builtins).values() if isinstance(v, type) and issubclass(v, BaseException))


def data_base(t):
    """The built-in or standard-library data type class t is built on (the most specific dict kind), or None."""
    if issubclass(t, dict):
        for k in (Counter, OrderedDict, DefaultDict):
            if issubclass(t, k):
                return k
        return dict
    if t is bool:
        return None
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


def _pointer_reader():
    """(read, same): read(list) is the list's array of element pointers as bytes (CPython), same(list, bytes)
    compares it to earlier bytes without a copy; else (None, None). A list holds the same objects in the same order
    as before exactly when these bytes are equal, as long as the old objects are kept alive (so their addresses
    can't be reused). Calibrated on probe lists; any doubt means None. Only for a single thread: another one could
    move the array while it is read."""
    if sys.implementation.name != "cpython":
        return None, None
    try:
        import ctypes

        size = ctypes.sizeof(ctypes.c_void_p)
        probe = [object() for _ in range(7)]
        want = b"".join(struct.pack("@P", id(x)) for x in probe)
        for off in range(size, list.__basicsize__, size):
            p = ctypes.c_void_p.from_address(id(probe) + off).value
            if not p or p < 65536 or p == id(list) or p == id(probe):
                continue
            if ctypes.string_at(p, len(want)) != want:
                continue
            item = ctypes.c_void_p.from_address
            at = ctypes.string_at

            def read(v, off=off, size=size):
                n = list.__len__(v)
                return at(item(id(v) + off).value, n * size) if n else b""

            other = [1, "x", None]
            if read(other) != b"".join(struct.pack("@P", id(x)) for x in other) or read([]) != b"":
                return None, None
            def copied(v, raw):
                return read(v) == raw

            try:
                memcmp = ctypes.PyDLL(None).memcmp  # PyDLL: called holding the GIL
                memcmp.argtypes = (ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t)
                memcmp.restype = ctypes.c_int

                def same(v, raw, off=off, size=size):
                    n = len(raw)
                    return n == list.__len__(v) * size and (not n or memcmp(item(id(v) + off).value, raw, n) == 0)

                if same(probe, want) and not same(probe[::-1], want) and not same(other, want) and same([], b""):
                    return read, same
            except Exception:
                pass
            return read, copied
    except Exception:
        return None, None
    return None, None


_READ, _SAME = _pointer_reader()


def _threaded():
    t = sys.modules.get("threading")
    return t is not None and t.active_count() > 1


def shallow(v, base):
    """What changed() compares against: v's own contents read through base (never v's overrides), holding the
    elements so they stay alive. Containers nested in v are links of their own."""
    if base is list:
        items = list(list.__iter__(v))
        return (_READ(v) if _READ is not None and not _threaded() else None, items)
    if base is bytearray:
        return bytes(memoryview(v))
    if base is set:
        return list(set.__iter__(v))
    if base is OrderedDict:
        return (list(OrderedDict.__iter__(v)), list(OrderedDict.values(v)), None)
    return (list(dict.__iter__(v)), list(dict.values(v)), _FACTORY.__get__(v) if base is DefaultDict else None)


def changed(v, snap, base):
    """Whether v's own contents differ from snap, by identity: no one's __eq__ runs."""
    if base is list:
        raw, items = snap
        if list.__len__(v) != len(items):
            return True
        if raw is not None and _SAME is not None and not _threaded():
            return not _SAME(v, raw)
        return any(map(is_not, list.__iter__(v), items))
    if base is bytearray:
        return bytes(memoryview(v)) != snap
    if base is set:
        return set.__len__(v) != len(snap) or any(map(is_not, set.__iter__(v), snap))
    keys, vals, fac = snap
    if dict.__len__(v) != len(keys):
        return True
    if base is OrderedDict:
        return any(map(is_not, OrderedDict.__iter__(v), keys)) or any(map(is_not, OrderedDict.values(v), vals))
    if any(map(is_not, dict.__iter__(v), keys)) or any(map(is_not, dict.values(v), vals)):
        return True
    return base is DefaultDict and _FACTORY.__get__(v) is not fac


def elements(snap, base):
    """The objects a snapshot holds (where nested links can be)."""
    if base is list:
        return snap[1]
    if base is bytearray or base is set:
        return ()
    return snap[1]


def store(obj, base, new):
    """Replace container obj's own contents with those of new (a container of the same base), in place, through
    base's methods only (never obj's overrides), as base-type code would."""
    if base is list or base is bytearray:
        base.__setitem__(obj, slice(None), new)
    elif base is set:
        set.clear(obj)
        set.update(obj, new)
    else:
        base.clear(obj)
        items = OrderedDict.items(new) if base is OrderedDict else dict.items(new)
        for k, x in items:
            base.__setitem__(obj, k, x)
        if base is DefaultDict:
            _FACTORY.__set__(obj, _FACTORY.__get__(new))


def _builtin_tables():
    kinds, funcs = {}, {}
    for n, c in vars(builtins).items():
        if n.startswith("_"):
            continue
        if isinstance(c, type):
            kinds[n] = c
        elif isinstance(c, types.BuiltinFunctionType):
            funcs[n] = c
    for c in (OrderedDict, DefaultDict, Counter):
        kinds["collections." + c.__name__] = c
    return kinds, funcs


# Taken before any candidate code runs, so a candidate class that calls itself builtins.ValueError, or
# replaces builtins.ValueError, is not taken for the real one.
BUILTIN_TYPES, BUILTIN_FUNCS = _builtin_tables()
_BUILTIN_TYPES = {id(c): n for n, c in BUILTIN_TYPES.items()}
CONSTANTS = {"NotImplemented": NotImplemented, "Ellipsis": Ellipsis}
# Built-ins that cross by name: types and constants both ways; functions (`key=len`) only from the tests.
TEST_NAMES_OUT = {id(c): n for n, c in list(BUILTIN_TYPES.items()) + list(BUILTIN_FUNCS.items()) + list(CONSTANTS.items())}
TEST_NAMES_IN = dict(BUILTIN_TYPES, **CONSTANTS)
CANDIDATE_NAMES_OUT = {id(c): n for n, c in list(BUILTIN_TYPES.items()) + list(CONSTANTS.items())}
CANDIDATE_NAMES_IN = dict(BUILTIN_TYPES, **BUILTIN_FUNCS, **CONSTANTS)


def class_path(cls):
    n = _BUILTIN_TYPES.get(id(cls))
    if n is not None:
        return n if "." in n else "builtins." + n
    module = getattr(cls, "__module__", "?")
    if module == "builtins":
        module = "builtins(redefined)"
    return "%s.%s" % (module, getattr(cls, "__qualname__", getattr(cls, "__name__", "?")))


# Special methods Python looks up on an object's type. A proxy class defines the ones its candidate class defines
# (differently from its data base, or from object), each running the candidate's.
BINARY = ("add", "sub", "mul", "matmul", "truediv", "floordiv", "mod", "divmod", "pow", "lshift", "rshift", "and", "xor", "or")
DUNDERS = tuple(
    ["__%s__" % n for n in BINARY]
    + ["__r%s__" % n for n in BINARY]
    + ["__i%s__" % n for n in BINARY if n != "divmod"]
    + ["__%s__" % n for n in ("neg", "pos", "abs", "invert", "int", "float", "complex", "index", "round", "trunc", "floor", "ceil", "bool", "bytes", "format", "fspath", "sizeof")]
    + ["__%s__" % n for n in ("lt", "le", "gt", "ge", "eq", "ne", "hash")]
    + ["__%s__" % n for n in ("len", "length_hint", "getitem", "setitem", "delitem", "missing", "iter", "next", "reversed", "contains", "call", "enter", "exit")]
)
# Special methods that can't be run across the processes; a proxy whose class defines one raises Inexact when used.
UNSUPPORTED = ("__await__", "__aiter__", "__anext__", "__aenter__", "__aexit__", "__buffer__", "__release_buffer__", "__get__", "__set__", "__delete__", "__set_name__")
# Metaclass special methods a candidate metaclass (an Enum's) can define for its classes.
META_DUNDERS = ("__getitem__", "__iter__", "__len__", "__contains__", "__reversed__", "__bool__", "__call__", "__or__", "__ror__")


# ---------- process state both sides share ----------

# The grader's code, by its module globals (frames are told apart by f_globals, which reading doesn't audit).
GRADER_CODE = frozenset((id(globals()),))


def grader_frames(code):
    """How many frames on this thread's stack run code (module globals ids) of the grader's, the caller's included."""
    n = 0
    f = sys._getframe(1)
    while f is not None:
        if id(f.f_globals) in code:
            n += 1
        f = f.f_back
    return n


def code_frames(code):
    """How many frames on this thread's stack run code not the grader's (the tests', the candidate's, the library's)."""
    n = 0
    f = sys._getframe(1)
    while f is not None:
        if id(f.f_globals) not in code:
            n += 1
        f = f.f_back
    return n


# Attribute reads CPython audits ("object.__getattr__") that reach a frame or its code.
_FRAME_READS = frozenset(("tb_frame", "f_code", "gi_frame", "gi_code", "cr_frame", "cr_code", "ag_frame", "ag_code"))
# Modules whose frame reads count as their caller's (unittest's own reporting reads tracebacks through them).
_FRAME_HELPERS = frozenset(("traceback", "linecache"))


def guard_frames(readers, foreign, hit, unittest_reads):
    """An audit hook: code reading a frame of the grader's code (foreign: module globals ids) gets hit(why) raised,
    unless the reader is the grader (readers) or, with unittest_reads, unittest's own machinery. Such frames stand
    in for the other process's code, so what a test or candidate reads there (frame names, a traceback through the
    other side, inspect.stack() in a callback) isn't what one process would show it. Can't be removed once added."""
    busy = set()
    ident = threading.get_ident
    getframe = sys._getframe
    frame_type = types.FrameType

    def hook(event, args):
        if event != "object.__getattr__" or args[1] not in _FRAME_READS:
            return
        tid = ident()
        if tid in busy:
            return
        busy.add(tid)
        try:
            obj, name = args[0], args[1]
            f = obj if name == "f_code" else getattr(obj, "tb_frame" if name == "tb_frame" else name[:3] + "frame", None)
            if type(f) is not frame_type or id(f.f_globals) not in foreign:
                return
            r = getframe(1)
            while r is not None:
                g = r.f_globals
                if id(g) in readers:
                    return
                mod = g.get("__name__")
                if unittest_reads and type(mod) is str and (mod == "unittest" or mod.startswith("unittest.")):
                    return
                if mod not in _FRAME_HELPERS:
                    break
                r = r.f_back
        finally:
            busy.discard(tid)
        raise hit("code read a frame of the grader's (%s): the grader's frames stand in for the other process's code, so frame names, tracebacks through the other side and stack inspection can't be what one process would show" % name)

    sys.addaudithook(hook)


def synthetic_traceback():
    """A real traceback object for a test's traceback crossing to the candidate (`__exit__`'s third argument): it is
    one, and not None, as there; its frame is the grader's, which the frame guard keeps candidate code from reading."""
    f = sys._getframe()
    return types.TracebackType(None, f, f.f_lasti, f.f_lineno)


def padded(n, fn):
    """fn() run n frames deeper. Each side runs the other's requests as deep in its stack as one process would
    have them: the frames of code the other side has below the call stand in for this side's grader frames, so a
    recursion runs out where it would in one process (or sooner, never later)."""
    if n > 0:
        return padded(n - 1, fn)
    return fn()


def _context_key(c):
    return (c.prec, c.rounding, c.Emin, c.Emax, c.capitals, c.clamp, tuple(c.flags.values()), tuple(c.traps.values()))


def decimal_state():
    """The decimal module's context in this thread, as a tuple to compare, or None when decimal isn't imported."""
    d = sys.modules.get("decimal")
    return None if d is None else _context_key(d.getcontext())


def decimal_default():
    import decimal

    return _context_key(decimal.Context())


def decimal_out():
    """This thread's decimal context as a message value (signals by name)."""
    import decimal

    c = decimal.getcontext()
    return [c.prec, c.rounding, c.Emin, c.Emax, c.capitals, c.clamp, [k.__name__ for k, v in c.flags.items() if v], [k.__name__ for k, v in c.traps.items() if v]]


def decimal_apply(st):
    """Set this thread's decimal context to a state decimal_state() gave on the other side."""
    import decimal

    if not (isinstance(st, list) and len(st) == 8 and all(type(x) is int for x in (st[0], st[2], st[3], st[4], st[5])) and type(st[1]) is str):
        raise ProtocolError("bad decimal context")
    c = decimal.getcontext()
    names = {k.__name__: k for k in c.flags}
    if not all(isinstance(x, list) and all(n in names for n in x) for x in st[6:]):
        raise ProtocolError("bad decimal signals")
    c.prec, c.rounding, c.Emin, c.Emax, c.capitals, c.clamp = st[:6]
    c.clear_flags()
    for n in st[6]:
        c.flags[names[n]] = True
    c.clear_traps()
    for n in st[7]:
        c.traps[names[n]] = True
    return decimal_state()


def warnings_state():
    """(filters, showwarning, _showwarnmsg_impl) of the warnings module, or None when it isn't imported."""
    w = sys.modules.get("warnings")
    if w is None:
        return None
    return (tuple(w.filters), w.showwarning, getattr(w, "_showwarnmsg_impl", None))


def same_warnings(a, b):
    """Two warnings_state()s alike (the hooks by identity: comparing them could run someone's __eq__)."""
    return a is not None and b is not None and a[1] is b[1] and a[2] is b[2] and a[0] == b[0]


def warnings_out(enc, filters):
    """The warnings filters as a message value."""
    import re

    out = []
    for f in filters:
        if not (type(f) is tuple and len(f) == 5 and type(f[0]) is str and type(f[4]) is int and issubclass(type(f[2]), type)):
            raise Inexact("a warnings filter the grader can't mirror: %s" % clip(repr(f), 100))
        pats = []
        for p in (f[1], f[3]):
            if p is None:
                pats += [None, 0]
            elif type(p) is str:
                pats += [p, -1]  # matched as the whole text (the built-in filters' kind)
            elif type(p) is re.Pattern and type(p.pattern) is str:
                pats += [p.pattern, p.flags]
            else:
                raise Inexact("a warnings filter the grader can't mirror: %s" % clip(repr(f), 100))
        out.append([f[0], pats[0], pats[1], enc.enc(f[2]), pats[2], pats[3], f[4]])
    return out


def warnings_in(dec, items):
    """Filters from warnings_out(). A category that isn't a class on this side (a test-only class, on the
    candidate's) can't match this side's warnings: its filter is left out."""
    if not isinstance(items, list):
        raise ProtocolError("bad warnings filters")
    out = []
    for x in items:
        if not (isinstance(x, list) and len(x) == 7 and type(x[0]) is str and type(x[6]) is int and type(x[2]) is int and type(x[5]) is int):
            raise ProtocolError("bad warnings filter")
        cat = dec.dec(x[3])
        if not issubclass(type(cat), type):
            continue
        out.append((x[0], _pattern(x[1], x[2]), cat, _pattern(x[4], x[5]), x[6]))
    return out


def _pattern(text, flags):
    import re

    if text is None:
        return None
    if type(text) is not str:
        raise ProtocolError("bad warnings pattern")
    return text if flags == -1 else re.compile(text, flags)


def warnings_set(filters):
    import warnings

    warnings.filters[:] = filters
    warnings._filters_mutated()


# sys.argv in both runs and on both sides, as `python3 -m unittest test_hidden` has it.
TEST_ARGV = ("python3 -m unittest", "test_hidden")
_getcwd, _chdir, _umask = os.getcwd, os.chdir, os.umask
_monotonic = time.monotonic
_tzset = getattr(time, "tzset", None)
try:
    import _locale
except ImportError:  # pragma: no cover - CPython always has it
    _locale = None


def umask_now(last):
    """The process umask, read by setting the value last seen (so there is no window with another one unless it
    changed, which a thread creating files could see)."""
    cur = _umask(last)
    if cur != last:
        _umask(cur)
    return cur


def locale_now():
    try:
        return _locale.setlocale(_locale.LC_ALL, None)
    except Exception:
        return None


def locale_set(name):
    """Set every locale category as the other side has them; whether this side now reports the same."""
    try:
        _locale.setlocale(_locale.LC_ALL, name)
    except Exception:
        return False
    return locale_now() == name


def tz_now():
    """What time.tzset() last set: tzname, timezone, altzone, daylight."""
    return [time.tzname[0], time.tzname[1], time.timezone, time.altzone, time.daylight]


def env_raw():
    """os.environ's encoded storage (CPython): comparing it is cheaper than decoding the environment."""
    raw = getattr(os.environ, "_data", None)
    return raw if type(raw) is dict else None


def env_diff(last, now):
    return {"set": {k: v for k, v in now.items() if last.get(k) != v}, "del": [k for k in last if k not in now]}


def env_apply(diff):
    """Apply env_diff() output; False if a variable can't be set here as it was there."""
    if not isinstance(diff, dict) or not isinstance(diff.get("set") or {}, dict) or not isinstance(diff.get("del") or [], list):
        raise ProtocolError("bad environment")
    for k, v in (diff.get("set") or {}).items():
        if type(k) is not str or type(v) is not str:
            raise ProtocolError("bad environment")
        try:
            os.environ[k] = v
        except (ValueError, OSError):
            return False
    for k in diff.get("del") or ():
        if type(k) is not str:
            raise ProtocolError("bad environment")
        try:
            os.environ.pop(k, None)
        except (ValueError, OSError):
            return False
    return True


def cwd_out(cur, root):
    """A working directory as the other side should take it: relative to this side's copy of the workspace
    (each side has its own), else absolute."""
    if cur == root:
        return ["rel", "."]
    base = root.rstrip(os.sep) + os.sep
    return ["rel", cur[len(base):]] if cur.startswith(base) else ["abs", cur]


def cwd_in(v, root):
    if not (isinstance(v, list) and len(v) == 2 and v[0] in ("rel", "abs") and type(v[1]) is str):
        raise ProtocolError("bad working directory")
    return os.path.normpath(os.path.join(root, v[1])) if v[0] == "rel" else v[1]


def path_changed(obj, snap):
    """Whether sys.path is no longer obj holding exactly snap (by identity: no one's __eq__ runs)."""
    p = sys.path
    return p is not obj or len(p) != len(snap) or any(map(is_not, p, snap))


def path_entry_in(v, root):
    """A sys.path entry from the other side (cwd_out() form), as it names the same place here."""
    if not (isinstance(v, list) and len(v) == 2 and v[0] in ("rel", "abs") and type(v[1]) is str):
        raise ProtocolError("bad path entry")
    if v[0] == "abs":
        return v[1]
    return root if v[1] == "." else os.path.join(root, v[1])


def path_compose(own, base, entries, j, e):
    """The candidate's sys.path for the tests' one: entries (mapped) with the candidate's own entries (own, its
    interpreter's path, base, in it) around the interpreter's entries the tests' path has at [j, e): what one process
    started as `python3 -m unittest` in the workspace has. None if own doesn't hold base."""
    n = len(base)
    for k in range(len(own) - n + 1):
        if own[k : k + n] == base:
            return entries[:j] + own[:k] + entries[j:e] + own[k + n :] + entries[e:]
    return None


_INF = float("inf")
_NINF = float("-inf")
_FLOATS = ("nan", "inf", "-inf")
_BIG = 1 << BIG_INT_BITS


def _tz(tz):
    """A fixed-offset timezone as [days, seconds, microseconds, name or None, utc singleton], else None."""
    if type(tz) is not datetime.timezone:
        return None
    off = tz.utcoffset(None)
    name = tz.tzname(None)
    plain = datetime.timezone(off)
    return [off.days, off.seconds, off.microseconds, None if name == plain.tzname(None) else name, tz is datetime.timezone.utc]


def _untz(v):
    if v[4] is True:
        return datetime.timezone.utc
    off = datetime.timedelta(days=int(v[0]), seconds=int(v[1]), microseconds=int(v[2]))
    return datetime.timezone(off) if v[3] is None else datetime.timezone(off, str(v[3]))


class Encoder:
    """Encodes the values of one message. side._special(enc, v, depth, key) sees every non-scalar first and may
    return its own tag (links, references); plain data goes by value; built-ins by name; anything else through
    side._objref(enc, v, depth, key). key: v is (part of) a dict key or set element. A tuple or frozenset met
    twice in a message is sent once and referenced after."""

    def __init__(self, side, names):
        self.side = side
        self.names = names
        self.memo = {}  # id -> alias number (tuples, frozensets, exceptions)
        self.busy = set()  # ids being encoded: a tuple inside itself (through a list) can't cross
        self.keep = []  # holds everything in memo, so ids stay theirs for the whole message
        self.nans = {}  # id -> number: one NaN object met twice arrives as one object

    def enc(self, v, depth=0, key=False):
        t = type(v)
        if v is None or t is bool or t is str:
            return v
        if t is int:
            return v if -_BIG < v < _BIG else {"t": "int", "v": format(v, "x")}
        if t is float:
            if v != v:
                self.keep.append(v)
                return {"t": "float", "v": "nan", "n": self.nans.setdefault(id(v), len(self.nans))}
            if v in (_INF, _NINF):
                return {"t": "float", "v": repr(v)}
            return v
        if depth > MAX_DEPTH:
            raise Unsendable("value nested too deeply")
        r = self.side._special(self, v, depth, key)
        if r is not None:
            return r
        d = depth + 1
        if t is tuple or t is frozenset:
            return self.aliased(v, lambda: {"t": "tuple" if t is tuple else "frozenset", "v": [self.enc(x, d, key or t is frozenset) for x in v]})
        if t is bytes:
            return {"t": "bytes", "v": base64.b64encode(v).decode("ascii")}
        if t is complex:
            return {"t": "complex", "v": [self.enc(v.real, d), self.enc(v.imag, d)]}
        if t is decimal.Decimal:
            return {"t": "decimal", "v": str(v)}
        if t is fractions.Fraction:
            return {"t": "fraction", "v": [self.enc(v.numerator, d), self.enc(v.denominator, d)]}
        if t is datetime.datetime or t is datetime.time:
            tz = v.tzinfo
            spec = None if tz is None else _tz(tz)
            if tz is None or spec is not None:
                tag = {"t": t.__name__, "v": v.replace(tzinfo=None).isoformat(), "fold": v.fold}
                if spec is not None:
                    tag["tz"] = spec
                return tag
        if t is datetime.date:
            return {"t": "date", "v": v.isoformat()}
        if t is datetime.timedelta:
            return {"t": "timedelta", "v": [v.days, v.seconds, v.microseconds]}
        if t is datetime.timezone:
            return {"t": "timezone", "v": _tz(v)}
        if t is slice:
            return {"t": "slice", "v": [self.enc(x, d) for x in (v.start, v.stop, v.step)]}
        if t is range:
            return {"t": "range", "v": [self.enc(x, d) for x in (v.start, v.stop, v.step)]}
        n = self.names.get(id(v))
        if n is not None:
            return {"t": "builtin", "v": n}
        return self.side._objref(self, v, depth, key)

    def aliased(self, v, build):
        """build()'s tag for v, or an alias to it if v was already sent in this message."""
        a = self.memo.get(id(v))
        if a is not None:
            return {"t": "alias", "id": a}
        if id(v) in self.busy:
            raise Unsendable("a %s that contains itself can't be sent" % type(v).__name__)
        self.busy.add(id(v))
        try:
            tag = build()
        finally:
            self.busy.discard(id(v))
        a = len(self.keep)
        self.keep.append(v)
        self.memo[id(v)] = a
        tag["a"] = a
        return tag


class Decoder:
    """Inverse of Encoder for one message; never runs sent code. side._container(dec, tag, kind, depth) builds a
    linked container, side._resolve(dec, tag, depth) every other side-specific tag. after: calls to make once
    the message's sync is applied (checks that may need the candidate)."""

    def __init__(self, side, names):
        self.side = side
        self.names = names
        self.alias = {}
        self.nans = {}
        self.after = []

    def dec(self, x, depth=0):
        if x is None or isinstance(x, (bool, int, float, str)):
            return x
        if depth > MAX_DEPTH + 4:
            raise ProtocolError("value nested too deeply")
        if not isinstance(x, dict) or not isinstance(x.get("t"), str):
            raise ProtocolError("untagged value")
        t = x["t"]
        v = x.get("v")
        d = depth + 1
        try:
            if t in LINKABLE:
                return self.side._container(self, x, t, d)
            if t == "alias":
                k = x.get("id")
                if type(k) is not int or k not in self.alias:
                    raise ProtocolError("unknown alias")
                return self.alias[k]
            if t == "tuple":
                return self.register(x, tuple([self.dec(i, d) for i in v]))
            if t == "frozenset":
                return self.register(x, frozenset([self.dec(i, d) for i in v]))
            if t == "bytes":
                return base64.b64decode(v, validate=True)
            if t == "int":
                if not isinstance(v, str) or len(v) > MAX_MSG:
                    raise ProtocolError("bad int")
                return int(v, 16)
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
                return complex(self.number(v[0], d), self.number(v[1], d))
            if t == "decimal":
                return decimal.Decimal(str(v))
            if t == "fraction":
                return fractions.Fraction(self.number(v[0], d), self.number(v[1], d))
            if t in ("datetime", "time"):
                out = getattr(datetime, t).fromisoformat(str(v))
                if "tz" in x:
                    out = out.replace(tzinfo=_untz(x["tz"]))
                return out.replace(fold=1) if x.get("fold") == 1 else out
            if t == "date":
                return datetime.date.fromisoformat(str(v))
            if t == "timedelta":
                return datetime.timedelta(days=int(v[0]), seconds=int(v[1]), microseconds=int(v[2]))
            if t == "timezone":
                return _untz(v)
            if t == "slice":
                return slice(self.dec(v[0], d), self.dec(v[1], d), self.dec(v[2], d))
            if t == "range":
                return range(self.number(v[0], d), self.number(v[1], d), self.number(v[2], d))
            if t == "builtin":
                obj = self.names.get(v) if isinstance(v, str) else None
                if obj is None:
                    raise ProtocolError("unknown built-in %s" % clip(v, 60))
                return obj
        except (ProtocolError, GraderError):
            raise
        except Exception as e:
            raise ProtocolError("bad %s value: %s" % (t, clip(_safe_str(e), 300)))
        try:
            return self.side._resolve(self, x, d)
        except (ProtocolError, GraderError):
            raise
        except Exception as e:
            # Never a local exception a test could expect (a class name with a NUL makes type() raise ValueError).
            raise ProtocolError("bad %s value: %s" % (t, clip(_safe_str(e), 300)))

    def number(self, x, d):
        n = self.dec(x, d)
        if type(n) not in (int, float):
            raise ProtocolError("bad number")
        return n

    def register(self, x, obj):
        a = x.get("a")
        if a is not None:
            if type(a) is not int or a in self.alias:
                raise ProtocolError("bad alias")
            self.alias[a] = obj
        return obj




# ---------- links (both sides) ----------

_INTS = frozenset((int,))
_STRS = frozenset((str,))
_RAW = frozenset((int, str, float, bool, type(None)))


def _raw_items(items):
    """items as plain JSON values when that is exact and cheap to tell (all small ints, or all strings), else None."""
    ts = set(map(type, items))
    if ts <= _STRS:
        return list(items)
    if ts <= _INTS and (not items or (-_BIG < min(items) and max(items) < _BIG)):
        return list(items)
    return None


class Side:
    """Linked-container bookkeeping both ends share. A link is a container each side holds a copy of (for a
    candidate object built on a mutable data type: that object's own storage, and its hybrid's on the test side).

    Before a side sends, it sends the new contents of each link its code could have changed (held, or handed to it
    since it last sent) that the other side's code can reach (the other side holds it, or this message hands it
    over). Each side reports the links its code starts and stops holding ("held"/"loose"); a link neither side
    holds ends ("unlink"). Holding is measured by reference count: a container only the bookkeeping refers to is
    unreachable from code. The held set is a superset, re-measured in amortized sweeps."""

    def __init__(self, sock, sign):
        self.chan = Channel(sock)
        self.sign = sign  # this side numbers its links sign, 2 * sign, ...
        self.next_link = sign
        self.links = {}  # n -> container
        self.link_of = {}  # id(container) -> n
        self.bases = {}  # n -> the data type its storage is read and written through
        self.snaps = {}  # n -> shallow(container) as the other side last saw it
        self.kids = {}  # n -> the links its snapshot holds
        self.ups = {}  # n -> {link whose snapshot holds n: how many times}
        self.extra = {}  # n -> references the bookkeeping holds besides links and snapshots
        self.held = set()  # links this side's code may hold
        self.young = set()  # held links new since the last message
        self.touched = set()  # links handed to this side's code since it last sent
        self.other = set()  # links the other side's code may hold, as it last reported
        self.reported = set()  # this side's held links as last reported
        self.to_report = set()
        self.loose = []  # links this side stopped holding, to report
        self.unlinks = []  # links to end with the next message
        self.sweep_in = 0
        self.far_in = 0
        self.refd = set()  # links the message being encoded refers to
        self.made = []  # links the message being encoded makes
        self.sync_secs = 0.0
        self.links[0] = []
        self.free = self._refs(0)
        del self.links[0]

    def _refs(self, n):
        obj = self.links[n]
        return sys.getrefcount(obj)

    def _holds(self, n, cache):
        """Whether this side's code can reach link n: it is in the storage of a link this side holds, or something
        besides the bookkeeping refers to it (the link table, snapshots, and linked containers' own storage)."""
        book = self.free + self.extra.get(n, 0)
        ups = self.ups.get(n)
        if ups:
            i = id(self.links[n])
            for p, c in ups.items():
                live = self._live(p, i, c, cache)
                if live and p in self.held:
                    return True
                book += c + live
        return self._refs(n) > book

    def _live(self, p, i, c, cache):
        """How many times link p's own storage refers to the object with id i (its snapshot does c times)."""
        hit = cache.get(p)
        if hit is None:
            obj, base = self.links[p], self.bases[p]
            if not changed(obj, self.snaps[p], base):
                hit = True
            else:
                hit = collections.Counter(map(id, list.__iter__(obj) if base is list else OrderedDict.values(obj) if base is OrderedDict else dict.values(obj)))
            cache[p] = hit
            obj = None
        return c if hit is True else hit.get(i, 0)

    def _hold(self, n):
        """Link n is held, and with it the links its snapshot holds (code reaches them through it)."""
        stack = [n]
        while stack:
            n = stack.pop()
            if n in self.held or n not in self.links:
                continue
            self.held.add(n)
            self.young.add(n)
            if n not in self.reported:
                self.to_report.add(n)
            stack.extend(self.kids.get(n, ()))

    def _define(self, n, obj, base, extra=0):
        """Register a link the other side made (n has the other side's sign)."""
        if type(n) is not int or n * self.sign >= 0 or n in self.links:
            raise ProtocolError("bad link number")
        self._add(n, obj, base, extra)
        self.touched.add(n)

    def _new_link(self, obj, base, extra=0):
        n = self.next_link
        self.next_link += self.sign
        self._add(n, obj, base, extra)
        self._hold(n)
        self.refd.add(n)
        return n

    def _add(self, n, obj, base, extra):
        self.links[n] = obj
        self.link_of[id(obj)] = n
        self.bases[n] = base
        if extra:
            self.extra[n] = extra

    def _link_ref(self, obj):
        """The link number of obj if it is linked, marking it as referred to by the message being encoded."""
        n = self.link_of.get(id(obj))
        if n is not None and self.links.get(n) is obj:
            self.refd.add(n)
            return n
        return None

    def _got(self, n):
        """Link n reached this side's code through a message."""
        if n not in self.links:
            raise ProtocolError("unknown link")
        self.touched.add(n)
        return self.links[n]

    def _snap(self, n, snap=None):
        """Record what the other side now sees of link n, and which links it holds."""
        base = self.bases[n]
        if snap is None:
            snap = shallow(self.links[n], base)
        self.snaps[n] = snap
        for k in self.kids.pop(n, ()):
            self._parent(k, n, -1)
        items = elements(snap, base)
        if items and not _RAW.issuperset(set(map(type, items))):
            get, links = self.link_of.get, self.links
            kids = []
            for x in items:
                if type(x) not in _RAW:
                    k = get(id(x))
                    if k is not None and links.get(k) is x:
                        kids.append(k)
            if kids:
                self.kids[n] = kids
                for k in kids:
                    self._parent(k, n, 1)

    def _parent(self, k, p, d):
        ups = self.ups.get(k)
        if ups is None:
            if d <= 0:
                return
            ups = self.ups[k] = {}
        c = ups.get(p, 0) + d
        if c > 0:
            ups[p] = c
        else:
            ups.pop(p, None)
            if not ups:
                del self.ups[k]

    def _unlink(self, n):
        obj = self.links.pop(n, None)
        self.snaps.pop(n, None)
        self.bases.pop(n, None)
        self.extra.pop(n, None)
        self.ups.pop(n, None)
        for k in self.kids.pop(n, ()):
            self._parent(k, n, -1)
        for s in (self.held, self.touched, self.other, self.reported, self.to_report):
            s.discard(n)
        if obj is not None and self.link_of.get(id(obj)) == n:
            del self.link_of[id(obj)]
        return obj

    def _contents(self, enc, obj, base, depth):
        """The tag carrying container obj's own contents, read through base."""
        d = depth + 1
        e = enc.enc
        if base is list:
            items = list(list.__iter__(obj))
            raw = _raw_items(items)
            return {"t": "list", "v": raw if raw is not None else [e(x, d) for x in items]}
        if base is bytearray:
            return {"t": "bytearray", "v": base64.b64encode(bytes(memoryview(obj))).decode("ascii")}
        if base is set:
            return {"t": "set", "v": [e(x, d, True) for x in list(set.__iter__(obj))]}
        items = list(OrderedDict.items(obj) if base is OrderedDict else dict.items(obj))
        tag = {"t": LINK_TAGS[base], "v": [[e(k, d, True), e(x, d)] for k, x in items]}
        if base is DefaultDict:
            tag["f"] = e(_FACTORY.__get__(obj), d)
        return tag

    def _read(self, dec, tag, base, d):
        """A fresh container of type base holding the contents a tag carries."""
        if not isinstance(tag, dict) or LINKABLE.get(tag.get("t")) is not base:
            raise ProtocolError("wrong contents for a %s" % base.__name__)
        v = tag.get("v")
        if base is bytearray:
            return bytearray(base64.b64decode(v, validate=True))
        if not isinstance(v, list):
            raise ProtocolError("bad contents")
        if base is list:
            if set(map(type, v)) <= _RAW:
                return list(v)
            return [dec.dec(i, d) for i in v]
        if base is set:
            return set([dec.dec(i, d) for i in v])
        out = DefaultDict(dec.dec(tag.get("f"), d)) if base is DefaultDict else base()
        for pair in v:
            if not isinstance(pair, list) or len(pair) != 2:
                raise ProtocolError("bad item")
            k = dec.dec(pair[0], d)
            out[k] = dec.dec(pair[1], d)
        return out

    def _container(self, dec, x, t, d):
        """A container the other side linked: made here, registered, then filled (it may hold itself)."""
        base = LINKABLE[t]
        obj = base()
        self._define(x.get("link"), obj, base)
        self._fill(dec, x.get("link"), obj, base, x, d)
        return obj

    def _fill(self, dec, n, obj, base, tag, d):
        store(obj, base, self._read(dec, tag, base, d))
        self._snap(n)

    # messages

    def _outgoing(self, enc, msg):
        """Add this side's link changes and holding reports to msg, whose values enc already encoded."""
        t0 = time.monotonic()
        sync = []
        for n in self.touched:
            self._hold(n)
        self.touched.clear()
        # Links this side's code could have changed that the other side's code can reach.
        held = self.held
        if len(self.other) <= len(held):
            work = [n for n in self.other if n in held]
        else:
            work = [n for n in held if n in self.other]
        done = set(work)
        work.extend(n for n in self.refd if n not in done and n in held)
        done.update(work)
        seen = len(self.refd)
        i = 0
        while i < len(work):
            n = work[i]
            i += 1
            obj = self.links.get(n)
            if obj is None:
                continue
            base = self.bases[n]
            if changed(obj, self.snaps[n], base):
                sync.append([n, self._contents(enc, obj, base, 0)])
                self._snap(n)
            if len(self.refd) != seen:
                # The new contents refer to more links: the other side can reach those now too.
                for k in list(self.refd):
                    if k not in done and k in held:
                        done.add(k)
                        work.append(k)
                seen = len(self.refd)
        obj = None
        self._sweep()
        if sync:
            msg["sync"] = sync
        if self.to_report:
            msg["held"] = sorted(self.to_report)
            self.reported |= self.to_report
            self.to_report = set()
        if self.loose:
            msg["loose"] = self.loose
            self.loose = []
        if self.unlinks:
            msg["unlink"] = self.unlinks
            self.unlinks = []
        self.refd = set()
        self.sync_secs += time.monotonic() - t0

    def _sweep(self):
        """Re-measure which held links this side's code still holds: the ones new since the last message every
        time (most are temporaries); in amortized sweeps, the ones the other side holds too (each costs both sides
        a check per message; about 64 per message) and, for memory, all of them (about 8 per message)."""
        todo, self.young = self.young, set()
        self.sweep_in -= 1
        self.far_in -= 1
        if self.far_in <= 0:
            todo = list(self.held)
            self.far_in = max(1, len(todo) // 8)
        elif self.sweep_in <= 0:
            shared = self.held & self.other
            todo = todo | shared
            self.sweep_in = max(1, len(shared) // 64)
        cache = {}
        for n in todo:
            if n not in self.links:
                self.held.discard(n)
            elif n in self.refd:
                self.young.add(n)  # handed over in this message: measure it after the other side has had it
            elif not self._holds(n, cache):
                self.held.discard(n)
                self.to_report.discard(n)
                if n not in self.other:
                    self._drop(n)
                elif n in self.reported:
                    self.reported.discard(n)
                    self.loose.append(n)

    def _drop(self, n):
        self._unlink(n)
        self.unlinks.append(n)

    def _incoming(self, dec, msg):
        """Apply the other side's link changes and reports (after the message's values are decoded)."""
        t0 = time.monotonic()
        sync = msg.get("sync")
        if sync is not None:
            if not isinstance(sync, list):
                raise ProtocolError("bad sync")
            updates = []
            for entry in sync:
                if not (isinstance(entry, list) and len(entry) == 2 and type(entry[0]) is int and entry[0] in self.links):
                    raise ProtocolError("bad sync entry")
                n = entry[0]
                base = self.bases[n]
                updates.append((n, base, self._read(dec, entry[1], base, 1)))
            for n, base, new in updates:
                store(self.links[n], base, new)
                self._snap(n)
        for key in ("held", "loose", "unlink"):
            v = msg.get(key)
            if v is not None and not (isinstance(v, list) and all(type(n) is int for n in v)):
                raise ProtocolError("bad %s list" % key)
        for n in msg.get("held") or ():
            if n in self.links:
                self.other.add(n)
        for n in msg.get("loose") or ():
            self.other.discard(n)
            if n in self.links and n not in self.held and n not in self.touched:
                self._drop(n)
        for n in msg.get("unlink") or ():
            self._unlink(n)
        self.sync_secs += time.monotonic() - t0


# ---------- special methods and classes (both sides) ----------

_DICT = type.__dict__["__dict__"].__get__
_MRO = type.__dict__["__mro__"].__get__
_NO = object()


def owner(cls, name):
    """The class in cls's MRO whose own namespace defines name (how Python finds special methods), else None."""
    for k in _MRO(cls):
        if name in _DICT(k):
            return k
    return None


def special(obj, name):
    """obj's special method name, looked up on its type as Python does (bound), else AttributeError."""
    t = type(obj)
    k = owner(t, name)
    if k is None:
        raise AttributeError("'%s' object has no attribute '%s'" % (t.__name__, name))
    f = _DICT(k)[name]
    get = getattr(type(f), "__get__", None)
    return f if get is None else get(f, obj, t)


def std_module(name):
    """Whether a module name belongs to the standard library (or is built in)."""
    if not isinstance(name, str):
        return False
    top = name.partition(".")[0]
    names = getattr(sys, "stdlib_module_names", None)
    if names is not None:
        return top in names or top in sys.builtin_module_names
    return top in sys.builtin_module_names


def resolve_std(path):
    """The class or object a "module:qualname" path names on this side, if its module is already imported."""
    if not isinstance(path, str) or ":" not in path:
        return None
    mod, _, qual = path.partition(":")
    if mod == "builtins" and qual in BUILTIN_TYPES:
        return BUILTIN_TYPES[qual]
    if mod == "builtins" or mod == "types":
        t = _NAMELESS.get(qual)
        if t is not None:
            return t
    m = sys.modules.get(mod)
    if m is None or not std_module(mod):
        return None
    obj = m
    try:
        for part in qual.split("."):
            obj = inspect_getattr(obj, part)
    except AttributeError:
        return None
    return obj


def inspect_getattr(obj, name):
    """A module's or class's own attribute without running descriptors or __getattr__ hooks."""
    if isinstance(obj, types.ModuleType):
        v = vars(obj).get(name, _NO)
    elif isinstance(obj, type):
        k = owner(obj, name)
        v = _NO if k is None else _DICT(k)[name]
    else:
        v = _NO
    if v is _NO:
        raise AttributeError(name)
    return v


def _nameless_types():
    """Built-in types without a name in builtins (function, generator, list_iterator, ...), by qualname."""
    out = {}
    for t in vars(types).values():
        if isinstance(t, type):
            out.setdefault(t.__qualname__, t)
    for v in ([], (), {}, set(), "", b"", bytearray(), range(1), {}.keys(), {}.values(), {}.items(), frozenset()):
        t = type(iter(v))
        out.setdefault(t.__qualname__, t)
    for v in ({}.keys(), {}.values(), {}.items(), reversed([]), iter(lambda: 1, 1)):
        out.setdefault(type(v).__qualname__, type(v))
    out.setdefault("NoneType", type(None))
    out.setdefault("NotImplementedType", type(NotImplemented))
    out.setdefault("ellipsis", type(Ellipsis))
    return out


_NAMELESS = _nameless_types()


def type_path(t):
    """"module:qualname" of a class."""
    n = _BUILTIN_TYPES.get(id(t))
    if n is not None and "." not in n:
        return "builtins:" + n
    try:
        return "%s:%s" % (type.__dict__["__module__"].__get__(t), type.__dict__["__qualname__"].__get__(t))
    except Exception:
        return "?:?"



# Comparison names, and what the identity fallback gives when neither side's method answers.
CMP = ("__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__")
_FALLBACK = {"__eq__": False, "__ne__": True}
# Special methods a proxy always runs in the candidate (the rest per the class's own definitions).
ALWAYS = ("__repr__", "__str__", "__dir__", "__sizeof__")
# Exception fields that stay local (set by raising on the test side).
_EXC_LOCAL = frozenset(("__traceback__", "__cause__", "__context__", "__suppress_context__", "with_traceback"))


def _abcs():
    out = []
    for modname in ("collections.abc", "numbers", "contextlib", "os", "io"):
        m = sys.modules.get(modname)
        if m is None:
            continue
        for n, v in sorted(vars(m).items()):
            if isinstance(v, type) and type(v).__name__ == "ABCMeta" and not n.startswith("_"):
                out.append(v)
    return out


# ---------- test side: proxies ----------


class _TailMRO(type):
    """Metaclass of proxy metaclasses: a class's MRO is itself followed by its recorded tail (the candidate's MRO,
    with candidate classes mirrored and standard-library classes real where their layout allows)."""

    def mro(cls):
        tail = _DICT(cls).get("_terrarium_tail")
        return [cls] + list(tail) if tail is not None else type.mro(cls)


def _info(cls):
    """A proxy class's (client, rid, desc, real, inexact), else None."""
    try:
        return _DICT(cls).get("_terrarium_")
    except TypeError:
        return None


def proxy_rid(x):
    """(client, rid) of a candidate object or class on the test side, else None."""
    t = type(x)
    info = _info(t)
    if info is not None:
        rid = info[0].ids.get(id(x))
        if rid is not None:
            return info[0], rid
    if isinstance(x, type):
        info = _info(x)
        if info is not None:
            return info[0], info[1]
    return None


def _target(self):
    p = proxy_rid(self)
    if p is None:
        raise Inexact("a candidate proxy without a candidate object")
    return p


def _forward(name):
    if name == "__call__":

        def method(self, *args, **kwargs):
            c, rid = _target(self)
            return c.call("call", [self, args, tuple(kwargs.items())])

    else:

        def method(self, *args):
            c, rid = _target(self)
            return c.call("dunder", [self] + list(args), name=name)

    method.__name__ = name
    return method


def _unsupported(name):
    def method(self, *args):
        raise Inexact("the candidate's %s can't be run across the processes" % name)

    method.__name__ = name
    return method


def _comparison(name, data):
    """A forwarded comparison: the candidate decides, but its answer about a test value counts only where it agrees
    with comparing the data (or, without data, with the identity fallback); otherwise the test can't be graded."""

    def method(self, other):
        c, rid = _target(self)
        po = proxy_rid(other)
        r = c.call("dunder", [self, other], name=name)
        if po is not None and po[0] is c:
            return r  # two candidate objects: compared by the candidate, as in one process
        if r is NotImplemented:
            return r
        d = getattr(data, name)(self, other) if data is not None else NotImplemented
        want = _FALLBACK.get(name, _NO) if d is NotImplemented else d
        if type(r) is bool and r is want:
            return r
        raise Inexact("%s of a candidate %s and a test %s: the candidate's method says %s, its data says %s" % (name, type(self).__name__, type(other).__name__, clip(repr(r) if type(r) in (bool, type(None)) else type(r).__name__, 40), "no answer" if want is _NO else want))

    method.__name__ = name
    return method


def _p_getattribute(self, name):
    if name == "__class__":
        return _p_class(self)
    if name in _LOCAL_ATTRS or (name in _EXC_LOCAL and isinstance(self, BaseException)):
        return object.__getattribute__(self, name)
    c, rid = _target(self)
    return c.call("getattr", [self], name=_attr_name(name))


def _attr_name(name):
    if type(name) is not str:
        raise TypeError("attribute name must be string, not '%s'" % type(name).__name__)
    return name


def _p_setattr(self, name, value):
    if name in _EXC_LOCAL and isinstance(self, BaseException):
        return object.__setattr__(self, name, value)
    c, rid = _target(self)
    c.call("setattr", [self, value], name=_attr_name(name))


def _p_delattr(self, name):
    c, rid = _target(self)
    c.call("delattr", [self], name=_attr_name(name))


def _p_class(self):
    info = _info(type(self))
    if info[3] is not None:
        return info[3]
    if info[4]:
        raise Inexact("isinstance() and __class__ of a candidate %s can't be answered exactly: its class derives from a standard-library class the grader can't mirror" % type(self).__name__)
    return type(self)


def _p_copy(self):
    c, rid = _target(self)
    return c.call("copy", [self], deep=False)


def _p_deepcopy(self, memo):
    import copy as _copy

    f = sys._getframe(1)
    if (memo and any(k != id(memo) for k in memo)) or (f.f_back is not None and f.f_back.f_globals is vars(_copy) and f.f_back.f_code.co_name != "deepcopy"):
        raise Inexact("deepcopy of a structure holding a candidate object (only the object itself can be deep-copied)")
    c, rid = _target(self)
    return c.call("copy", [self], deep=True)


def _p_reduce(self, *args):
    raise Inexact("pickling a candidate object")


def _p_del(self):
    info = _info(type(self))
    if info is not None:
        info[0]._died(self)


def _p_init_subclass(cls, **kw):
    pass


_LOCAL_ATTRS = frozenset(("__deepcopy__", "__reduce_ex__", "__reduce__", "__getstate__", "__copy__"))
_INSTANCE_NS = {
    "__getattribute__": _p_getattribute,
    "__setattr__": _p_setattr,
    "__delattr__": _p_delattr,
    "__copy__": _p_copy,
    "__deepcopy__": _p_deepcopy,
    "__reduce__": _p_reduce,
    "__reduce_ex__": _p_reduce,
    "__getstate__": _p_reduce,
    "__del__": _p_del,
    "__init_subclass__": classmethod(_p_init_subclass),
}
for _n in ALWAYS:
    _INSTANCE_NS[_n] = _forward(_n)


def _m_getattribute(cls, name):
    if name in _META_LOCAL or (type(name) is str and name.startswith("_terrarium_")):
        if name == "__bases__":
            return _DICT(cls).get("_terrarium_bases", type.__getattribute__(cls, name))
        return type.__getattribute__(cls, name)
    info = _info(cls)
    if info is None:
        return type.__getattribute__(cls, name)
    return info[0].call("getattr", [cls], name=_attr_name(name))


def _m_setattr(cls, name, value):
    info = _info(cls)
    if info is None:
        return type.__setattr__(cls, name, value)
    info[0].call("setattr", [cls, value], name=_attr_name(name))


def _m_delattr(cls, name):
    info = _info(cls)
    if info is None:
        return type.__delattr__(cls, name)
    info[0].call("delattr", [cls], name=_attr_name(name))


def _m_call(cls, *args, **kwargs):
    info = _info(cls)
    if info is None:
        return type.__call__(cls, *args, **kwargs)
    return info[0].call("call", [cls, args, tuple(kwargs.items())])


def _m_new(meta, name, bases, ns, **kw):
    # A class statement deriving from a candidate class: the subclass would have to live in the candidate.
    raise Inexact("tests can't subclass candidate classes (%s)" % name)


def _m_mro(cls):
    tail = _DICT(cls).get("_terrarium_tail")
    return [cls] + list(tail) if tail is not None else type.mro(cls)


_META_LOCAL = frozenset(
    ("__mro__", "__name__", "__qualname__", "__module__", "mro", "__class__", "__base__", "__bases__", "__basicsize__", "__itemsize__", "__flags__", "__weakrefoffset__", "__dictoffset__", "__copy__", "__deepcopy__", "__reduce_ex__", "__reduce__", "__instancecheck__", "__subclasscheck__", "__prepare__", "__init_subclass__", "__call__", "__new__", "__init__", "__getattribute__", "__setattr__", "__delattr__", "__set_name__", "__get__", "__mro_entries__", "__text_signature__", "__type_params__")
)
_META_NS = {
    "__getattribute__": _m_getattribute,
    "__setattr__": _m_setattr,
    "__delattr__": _m_delattr,
    "__call__": _m_call,
    "__new__": _m_new,
    "mro": _m_mro,
    "__dir__": _forward("__dir__"),
}
ProxyMeta = _TailMRO("ProxyMeta", (type,), dict(_META_NS, __module__=__name__, __doc__="Metaclass of the classes standing for candidate classes."))


# Special methods a candidate class's proxy may run in the candidate (instances / classes).
FORWARDABLE = frozenset(DUNDERS) - frozenset(CMP) - frozenset(("__hash__",))
META_FORWARDABLE = frozenset(META_DUNDERS) | frozenset(("__instancecheck__", "__subclasscheck__", "__repr__", "__str__", "__format__"))
# Standard-library modules the test side won't import to resolve a class path.
_NO_IMPORT = frozenset(("antigravity", "this", "idlelib", "tkinter", "turtle", "turtledemo", "__main__"))
_BASE_SET = {n: d.__set__ for n, d in vars(BaseException).items() if n in ("args", "__cause__", "__context__", "__suppress_context__")}
_PLAIN = frozenset(BUILTIN_TYPES.values()) | LINK_TYPES
# A test object of a class built on one of these crosses as TestData (built-in code would take the real one as data).
_DATA_KINDS = DATA_BASES
_WEAK_ERR = "a weak reference the tests held to a candidate object died while the candidate still had the object"


class Client(Side):
    """Test side of the channel."""

    def __init__(self, sock, timeout=30.0, deadline=None):
        Side.__init__(self, sock, 1)
        self.timeout = timeout  # seconds per answer, None for no limit
        self.deadline = deadline  # time.monotonic() after which no answer is awaited
        self.gone = None
        self.lock = threading.RLock()
        self.depth = 0
        self.callbacks = {}  # n -> the test's callable, handle or exception passed to the candidate
        self.callback_ids = {}
        self.values = {}  # class rid -> what the candidate class is here (a proxy class, or the real class)
        self.descs = {}  # class rid -> its description
        self.inst = {}  # class rid -> the proxy class for its instances
        self.proxies = {}  # rid -> proxy (a weak reference where the type allows)
        self.ids = {}  # id(proxy) -> rid
        self.release = {}  # rids of proxies that died, to release, in the order they died
        self.weak = set()  # rids of those the tests held weak references to
        self.weak_err = None  # a weak reference that died before one process's would have, raised at the next reply
        self.ntuples = {}
        self.thrown = {}
        self.candidate_secs = 0.0
        left = None if deadline is None else deadline - time.monotonic()
        self.sync_limit = SYNC_LIMIT if left is None else max(SYNC_MIN, SYNC_SHARE * left)
        self.state = {}  # process state as both sides last had it
        self.ended = None  # process state the candidate changed that this process can't take: every later call fails
        self.orig = {"stdout": sys.stdout, "stderr": sys.stderr, "stdin": sys.stdin, "print": builtins.print, "input": builtins.input}
        self.stdin_obj = None  # the tests' io.StringIO stdin the candidate last got the text of
        self.env0 = dict(os.environ)
        self.cwd0 = _getcwd()
        self.path_obj, self.path0 = sys.path, list(sys.path)
        self.path_base = tuple(sys.path)  # the interpreter's own entries (the runner adds none)
        self.path_lists = {id(sys.path): (sys.path, 0)}  # the tests' sys.path lists: (list, number the candidate knows it by)
        self.umask0 = umask_now(0o022)
        self.locale0 = locale_now()
        self.tz0 = tz_now()
        import warnings

        self.warn_orig = (warnings.showwarning, warnings._showwarnmsg_impl)
        out = []

        class _Probe:
            def __del__(s):
                self._died(s, out)

        _Probe()
        self.del_base = out[0] if out else 0
        class _Ref:
            pass

        obj = _Ref()
        probe = {0: weakref.ref(obj)}
        raw = probe[0]
        self.ref_base = self._ref_users(raw)  # references to a registry weakref held only by the registry and raw

    # proxies

    def _died(self, p, probe=None):
        if not self.lock.acquire(timeout=10):
            return
        try:
            n = sys.getrefcount(p)
            if probe is not None:
                probe.append(n)
                return
            rid = self.ids.get(id(p))
            if rid is None:
                return
            raw = self.proxies.get(rid)
            cur = raw() if type(raw) is weakref.ref else raw
            if cur is not p and cur is not None:
                return
            if n > self.del_base:
                # Brought back while it was being finalized: it stays, for good.
                self.proxies[rid] = p
                return
            # The tests' weak references to p (weakref.ref(p) without a callback is the registry's own one, shared)
            # see the object die now: the candidate says whether one process's would have.
            own = type(raw) is weakref.ref
            if weakref.getweakrefcount(p) > own or (own and self._ref_users(raw) > self.ref_base):
                self.weak.add(rid)
            del self.ids[id(p)]
            del self.proxies[rid]
            self.release[rid] = None
        finally:
            self.lock.release()

    @staticmethod
    def _ref_users(ref):
        return sys.getrefcount(ref)

    def _register(self, rid, obj):
        try:
            ref = weakref.ref(obj)
        except TypeError:
            ref = obj
        self.proxies[rid] = ref
        self.ids[id(obj)] = rid
        self.release.pop(rid, None)
        if rid in self.weak:
            self.weak.discard(rid)
            self.weak_err = _WEAK_ERR
        return obj

    def _known(self, rid):
        ref = self.proxies.get(rid)
        if ref is None:
            return None
        return ref() if type(ref) is weakref.ref else ref

    def _class(self, rid, d, dec, depth):
        """What candidate class rid is on this side, building it from its description the first time."""
        v = self.values.get(rid)
        if v is not None:
            return v
        if not isinstance(d, dict):
            raise ProtocolError("unknown class")
        self.descs[rid] = d
        real = self._real(d)
        if real is not None:
            self.values[rid] = real
            return real
        cls = self._build(rid, d, None, dec, depth)
        self.values[rid] = cls
        self.inst[rid] = cls
        return cls

    def _real(self, d):
        """The real class a standard-library class description names here, else None."""
        if d.get("std") is not True:
            return None
        path = d.get("path")
        if not isinstance(path, str):
            return None
        mod = path.partition(":")[0]
        if mod not in sys.modules and std_module(mod) and mod.partition(".")[0] not in _NO_IMPORT:
            try:
                __import__(mod)
            except BaseException:  # noqa: B036 - any failure only means the class stays mirrored
                return None
        r = resolve_std(path)
        return r if isinstance(r, type) and r.__name__ == d.get("name") else None

    def _inst_class(self, rid):
        cls = self.inst.get(rid)
        if cls is None:
            d = self.descs.get(rid)
            if d is None:
                raise ProtocolError("object of an unknown class")
            cls = self.inst[rid] = self._build(rid, d, self.values.get(rid), None, 0)
        return cls

    def _build(self, rid, d, real, dec, depth):
        """A proxy class for a candidate class description: real is the real class of a standard-library class."""
        name = d.get("name")
        name = name if isinstance(name, str) and name.isidentifier() else "CandidateClass"
        mro = [self._value(x) for x in d.get("mro") or ()]
        bases = tuple(self._value(x) for x in d.get("bases") or ())
        if not all(isinstance(k, type) for k in mro + list(bases)):
            raise ProtocolError("bad class description")
        is_meta = d.get("isMeta") is True
        fwd = [n for n in d.get("fwd") or () if n in (META_FORWARDABLE if is_meta else FORWARDABLE)]
        unsup = [n for n in d.get("unsup") or () if n in UNSUPPORTED]
        if is_meta:
            layout = ProxyMeta
            ns = dict(_META_NS)
        else:
            data = DATA_TAGS.get(d.get("data")) if d.get("data") is not None else None
            exc = BUILTIN_TYPES.get(d.get("exc")) if d.get("exc") is not None else None
            if exc is not None and not issubclass(exc, BaseException):
                raise ProtocolError("bad exception base")
            layout = data or exc or object
            ns = dict(_INSTANCE_NS)
            for n in d.get("cmp") or ():
                if n in CMP:
                    ns[n] = _comparison(n, data)
            h = d.get("hash")
            if h == "none":
                ns["__hash__"] = None
            elif h == "fwd":
                ns["__hash__"] = _forward("__hash__")
            elif "__eq__" in ns:
                ns["__hash__"] = layout.__hash__
        for n in fwd:
            ns[n] = _forward(n)
        for n in unsup:
            ns[n] = _unsupported(n)
        qual = d.get("qual")
        mod = d.get("mod")
        ns["__qualname__"] = qual if isinstance(qual, str) else name
        ns["__module__"] = mod if isinstance(mod, str) else "candidate"
        ns["_terrarium_bases"] = bases
        meta = ProxyMeta
        if d.get("meta") is not None:
            meta = self._meta_class(self._value(d.get("meta")))
        tails = []
        if real is not None:
            tails.append((self._tail([real] + mro, is_meta, True), False))
        tails.append((self._tail(mro, is_meta, True), False))
        if any(_info(k) is None and k not in _PLAIN for k in mro):
            tails.append((self._tail(mro, is_meta, False), True))
        cls = None
        for tail, inexact in tails:
            # No __slots__: CPython 3.12 gives a slotted class whose MRO holds real Python classes their dict
            # offset without the managed-dict flag (garbage to the collector). An unused instance dict is harmless.
            body = dict(ns, _terrarium_tail=tuple(tail), _terrarium_=(self, rid, d, real, inexact))
            try:
                cls = type.__new__(_TailMRO if is_meta else meta, name, (layout,), body)
                break
            except TypeError:
                cls = None
        if cls is None:
            raise Inexact("the candidate class %s can't be mirrored" % name)
        for a in d.get("abcs") or ():
            abc_cls = self._value(a)
            if isinstance(abc_cls, type) and type(abc_cls).__name__ == "ABCMeta":
                try:
                    abc_cls.register(cls)
                except Exception:
                    raise Inexact("can't register %s as a %s" % (name, abc_cls.__name__))
        return cls

    def _tail(self, mro, is_meta, real_std):
        """The MRO after the class: candidate classes mirrored; standard-library ones real if real_std."""
        out = []
        for k in mro:
            if _info(k) is not None or k in _PLAIN or real_std:
                out.append(k)
            else:
                out.append(self._mirror(k))
        if is_meta:
            i = out.index(type) if type in out else len(out)
            out.insert(i, ProxyMeta)
        return out

    def _mirror(self, real):
        """A stand-in for a real standard-library class that can't be in a proxy's MRO."""
        for rid, v in self.values.items():
            if v is real:
                return self._inst_class(rid)
        raise Inexact("a candidate class derives from %s, which the grader can't mirror" % real.__name__)

    def _meta_class(self, mv):
        """The metaclass for proxy classes whose candidate metaclass is mv (as it is on this side)."""
        if mv is type:
            return ProxyMeta
        info = _info(mv)
        if info is not None and issubclass(mv, ProxyMeta):
            return mv
        for rid, v in self.values.items():
            if v is mv:
                return self._inst_class(rid)
        raise ProtocolError("unknown metaclass")

    def _value(self, x):
        if isinstance(x, type):
            return x
        raise ProtocolError("bad class in a description")

    def _instance(self, rid, x, dec, depth):
        """A new proxy for candidate object rid, of the class x["c"] names."""
        cv = dec.dec(x.get("c"), depth)
        if not isinstance(cv, type):
            raise ProtocolError("bad object class")
        crid = self._class_rid(cv)
        d = self.descs.get(crid) if crid is not None else None
        if d is None:
            raise ProtocolError("object of an undescribed class")
        real = self.values.get(crid)
        real = real if _info(real) is None else None
        if real is not None:
            if "member" in x:
                m = getattr(real, "__members__", None)
                if isinstance(m, collections.abc.Mapping) and x["member"] in m:
                    self.release[rid] = None
                    return m[x["member"]]
            if "single" in x:
                s = resolve_std(x["single"])
                if s is not None and type(s) is real:
                    self.release[rid] = None
                    return s
            if "x" in x:
                return self._exception(rid, real, x, dec, depth, copy_of=True)
        P = self._inst_class(crid)
        if "x" in x:
            return self._exception(rid, P, x, dec, depth, copy_of=False)
        data = DATA_TAGS.get(d.get("data")) if d.get("data") is not None else None
        if data is None:
            obj = object.__new__(P)
        elif data in LINK_TYPES:
            obj = data.__new__(P)
            self._register(rid, obj)
            n = x.get("link")
            self._define(n, obj, data)
            self._fill(dec, n, obj, data, x.get("v"), depth)
            return obj
        else:
            v = dec.dec(x.get("v"), depth)
            if type(v) is not data:
                raise ProtocolError("%s data for a %s" % (type(v).__name__, data.__name__))
            obj = data.__new__(P, v)
        return self._register(rid, obj)

    def _class_rid(self, cv):
        info = _info(cv)
        if info is not None and info[0] is self:
            return info[1]
        for rid, v in self.values.items():
            if v is cv:
                return rid
        return None

    def _exception(self, rid, cls, x, dec, depth, copy_of):
        f = x.get("x")
        if not isinstance(f, dict):
            raise ProtocolError("bad exception")
        args = dec.dec(f.get("args"), depth)
        if type(args) is not tuple:
            raise ProtocolError("bad exception args")
        if not issubclass(cls, BaseException):
            raise ProtocolError("exception of a non-exception class")
        if copy_of:
            if not issubclass(cls, Exception) and cls is not SystemExit:
                raise Inexact("the candidate's code raised %s" % cls.__name__)
            self.release[rid] = None
            try:
                e = cls(*args) if cls in BUILTIN_EXCEPTIONS else BaseException.__new__(cls, *args)
            except Exception:
                e = cls.__new__(cls, *args)
            _BASE_SET["args"](e, args)
            for pair in f.get("attrs") or ():
                k, v = pair[0], dec.dec(pair[1], depth)
                if not isinstance(k, str):
                    raise ProtocolError("bad exception attribute")
                try:
                    if getattr(e, k, _NO) is not v:
                        setattr(e, k, v)
                    ok = getattr(e, k, _NO)
                    ok = ok is v or (type(v) in _RAW and type(ok) is type(v) and ok == v)
                except Exception:
                    ok = False
                if not ok:
                    raise Inexact("the candidate's %s can't be rebuilt here (its %s)" % (cls.__name__, k))
        else:
            e = BUILTIN_TYPES.get(self.descs[self._class_rid(cls)].get("exc"), BaseException).__new__(cls)
            self._register(rid, e)
            _BASE_SET["args"](e, args)
        for k, key in (("__cause__", "cause"), ("__context__", "context")):
            v = dec.dec(f.get(key), depth)
            if v is not None and not isinstance(v, BaseException):
                raise ProtocolError("bad exception chain")
            _BASE_SET[k](e, v)
        _BASE_SET["__suppress_context__"](e, f.get("sup") is True)
        return e

    # values

    def _special(self, enc, v, depth, key):
        p = proxy_rid(v)
        if p is not None:
            if p[0] is not self:
                raise Unsendable("a candidate object from another grading run")
            self._link_ref(v)
            return {"t": "class" if isinstance(v, type) else "obj", "id": p[1]}
        t = type(v)
        if t in LINK_TYPES:
            n = self._link_ref(v)
            if n is not None:
                return {"t": "link", "id": n}
            n = self._new_link(v, t)
            self.made.append(n)
            tag = self._contents(enc, v, t, depth)
            tag["link"] = n
            self._snap(n)
            return tag
        if isinstance(v, BaseException):
            return enc.aliased(v, lambda: self._test_exception(enc, v, depth))
        if t is types.TracebackType:
            # A real traceback there (`__exit__`'s third argument), the test's own one when it comes back.
            return {"t": "ttb", "id": self._callback_id(v)}
        fields = ntuple_fields(t)
        if fields is not None and t is not tuple and _plain_ntuple(t):
            self.ntuples[(t.__name__, fields)] = t
            return {"t": "ntuple", "n": t.__name__, "f": list(fields), "v": [enc.enc(x, depth + 1, key) for x in tuple.__iter__(v)]}
        if _is_std_enum(t):
            return {"t": "senum", "c": type_path(t), "n": v._name_}
        return None

    def _objref(self, enc, v, depth, key):
        """A test object the candidate can only hold and hand back (and call, hash, compare, print, iterate)."""
        k = self.callback_ids.get(id(v))
        if k is not None and self.callbacks.get(k) is v:
            return {"t": "tobj", "id": k}
        k = len(self.callbacks) + 1
        self.callbacks[k] = v
        self.callback_ids[id(v)] = k
        t = type(v)
        f = {"type": clip(t.__name__, 100)}
        if isinstance(v, type) or any(issubclass(t, b) for b in _DATA_KINDS):
            f["data"] = True
        if callable(v):
            f["call"] = True
            if t is types.FunctionType:
                f["fn"] = True
            for a in ("__name__", "__qualname__", "__module__"):
                x = getattr(v, a, None) if t in (types.FunctionType, types.MethodType, types.BuiltinFunctionType) or isinstance(v, type) else None
                if isinstance(x, str):
                    f[a] = clip(x, 200)
        if owner(t, "__next__") is not None and owner(t, "__iter__") is not None:
            f["it"] = True
        return {"t": "tobj", "id": k, "f": f}

    def _callback_id(self, v):
        """The number test object v is known by on the candidate's side (registered for good)."""
        k = self.callback_ids.get(id(v))
        if k is None or self.callbacks.get(k) is not v:
            k = len(self.callbacks) + 1
            self.callbacks[k] = v
            self.callback_ids[id(v)] = k
        return k

    def _test_exception(self, enc, e, depth):
        k = self._callback_id(e)
        t = type(e)
        mro = [type_path(c) for c in _MRO(t)[:32]]
        base = next((c for c in _MRO(t) if c in BUILTIN_EXCEPTIONS), BaseException)
        d = depth + 1
        attrs = []
        for n, x in list(getattr(e, "__dict__", {}).items())[:50]:
            if isinstance(n, str):
                attrs.append([n, enc.enc(x, d)])
        return {"t": "texc", "id": k, "mro": mro, "base": base.__name__, "args": enc.enc(e.args, d), "attrs": attrs}

    def _resolve(self, dec, x, d):
        t = x["t"]
        if t == "obj":
            rid = x.get("id")
            if type(rid) is not int:
                raise ProtocolError("bad object")
            obj = self._known(rid)
            if obj is not None and "c" not in x:
                n = self.link_of.get(id(obj))
                if n is not None and self.links.get(n) is obj:
                    self.touched.add(n)
                return obj
            if "c" not in x:
                raise ProtocolError("unknown object %d" % rid)
            return dec.register(x, self._instance(rid, x, dec, d))
        if t == "class":
            rid = x.get("id")
            if type(rid) is not int:
                raise ProtocolError("bad class")
            if rid in self.values:
                return self.values[rid]
            raw = x.get("d")
            if not isinstance(raw, dict):
                raise ProtocolError("unknown class %d" % rid)
            desc = dict(raw)
            for key in ("mro", "bases", "abcs"):
                desc[key] = [dec.dec(v, d) for v in raw.get(key) or ()]
            if raw.get("meta") is not None:
                desc["meta"] = dec.dec(raw["meta"], d)
            return self._class(rid, desc, dec, d)
        if t == "link":
            return self._got(x.get("id"))
        if t in ("tobj", "texc", "ttb"):
            obj = self.callbacks.get(x.get("id"), _NO)
            if obj is _NO:
                raise ProtocolError("unknown test object")
            return obj
        if t == "ntuple":
            name, fields = x.get("n"), x.get("f")
            vals = [dec.dec(i, d) for i in x.get("v") or ()]
            if not isinstance(fields, list) or not all(isinstance(f, str) for f in fields):
                raise ProtocolError("bad namedtuple")
            cls = self.ntuples.get((name, tuple(fields)))
            return dec.register(x, cls._make(vals) if cls is not None else tuple(vals))
        if t == "senum":
            cls = resolve_std(x.get("c"))
            m = getattr(cls, "__members__", None) if isinstance(cls, type) else None
            if not isinstance(m, collections.abc.Mapping) or x.get("n") not in m:
                raise ProtocolError("unknown enum member")
            return m[x.get("n")]
        raise ProtocolError("unknown tag %r" % clip(t, 40))

    # process state the candidate's code shares with the tests in one process

    def _stdin_key(self, cur):
        if cur is self.orig["stdin"]:
            return ("orig", None)
        if proxy_rid(cur) is not None:
            return ("cand", cur)
        if type(cur) is io.StringIO and not cur.closed:
            return ("sio", cur, cur.tell(), len(cur.getvalue()))
        return ("other", cur)

    def _state(self, enc):
        """The process state the tests changed since the candidate last had it (sent before candidate code runs)."""
        st = {}
        s = self.state
        if path_changed(*s.get("path", (self.path_obj, self.path0))):
            st["path"] = self._path_state()
            s["path"] = (sys.path, list(sys.path))
        for name in ("stdout", "stderr"):
            cur = getattr(sys, name)
            if cur is not s.get(name, self.orig[name]):
                s[name] = cur
                if cur is self.orig[name]:
                    st[name] = ["orig"]
                else:
                    st[name] = ["cand" if proxy_rid(cur) is not None else "sio" if type(cur) is io.StringIO else "other", enc.enc(cur)]
        cur = sys.stdin
        key, last = self._stdin_key(cur), s.get("stdin", ("orig", None))
        if key[0] != last[0] or key[1] is not last[1] or key[2:] != last[2:]:
            s["stdin"] = key
            if key[0] == "orig":
                st["stdin"] = ["orig"]
            elif key[0] == "sio":
                # The candidate reads the rest of the text; how far it read comes back with its answer.
                self.stdin_obj = cur
                st["stdin"] = ["sio", cur.getvalue()[cur.tell():], enc.enc(cur)]
            else:
                st["stdin"] = [key[0], enc.enc(cur)]
        for name in ("print", "input"):
            cur = getattr(builtins, name)
            if cur is not s.get(name, self.orig[name]):
                s[name] = cur
                st[name] = None if cur is self.orig[name] else enc.enc(cur)
        if sys.argv is not s.get("argv"):
            # A list is linked: changes either side makes to the same list reach the other.
            s["argv"] = sys.argv
            st["argv"] = enc.enc(sys.argv)
        raw = env_raw()
        if raw is None or raw != s.get("env_raw"):
            env = dict(os.environ)
            last = s.get("env", self.env0)
            if env != last:
                st["env"] = env_diff(last, env)
                s["env"] = env
            s["env_raw"] = None if raw is None else dict(raw)
        try:
            cwd = _getcwd()
        except OSError as e:
            raise Inexact("the tests' working directory is gone (%s)" % e.strerror) from None
        if cwd != s.get("cwd", self.cwd0):
            s["cwd"] = cwd
            st["cwd"] = cwd_out(cwd, self.cwd0)
        um = umask_now(s.get("umask", self.umask0))
        if um != s.get("umask", self.umask0):
            s["umask"] = st["umask"] = um
        lc = locale_now()
        if lc != s.get("locale", self.locale0):
            s["locale"] = st["locale"] = lc
        tz = tz_now()
        if tz != s.get("tz", self.tz0):
            s["tz"] = st["tz"] = tz
        r = sys.modules.get("random")
        if r is not None and hasattr(r, "getstate"):
            rs = r.getstate()
            if rs != s.get("random"):
                s["random"] = rs
                st["random"] = [rs[0], list(rs[1]), rs[2]]
        lim = sys.getrecursionlimit()
        if lim != s.get("rlimit"):
            s["rlimit"] = st["rlimit"] = lim
        ds = decimal_state()
        if ds is not None:
            if "decimal" not in s:
                s["decimal"] = decimal_default()
            if ds != s["decimal"]:
                s["decimal"] = ds
                st["decimal"] = decimal_out()
        ws = warnings_state()
        if ws is not None and not same_warnings(ws, s.get("warnings")):
            st["warnings"] = [warnings_out(enc, ws[0]), None if ws[1] is self.warn_orig[0] else enc.enc(ws[1]), None if ws[2] is self.warn_orig[1] else enc.enc(ws[2])]
            s["warnings"] = ws
        return st

    def _path_state(self):
        """sys.path as the tests changed it, for the candidate's imports: [list number, entries, j, e, base]. The
        interpreter's own entries (base) are still in it, in order, at [j, e); the candidate's own (its workspace
        first, as `python3 -m unittest` has the current directory) go around them as one process has them."""
        cur = sys.path
        if type(cur) is not list or any(type(p) is not str for p in cur):
            raise Inexact("the tests set sys.path to something other than a list of str, which the candidate's process can't share")
        base = self.path_base
        first = next((i for i, p in enumerate(cur) if p is base[0]), None) if base else 0
        last = next((i for i in range(len(cur) - 1, -1, -1) if cur[i] is base[-1]), None) if base else -1
        if first is None or last is None or last < first or [p for p in cur[first : last + 1] if p in base] != list(base):
            raise Inexact("the tests took the interpreter's own entries out of sys.path (or reordered them): where the candidate's process would have its own isn't known")
        hit = self.path_lists.get(id(cur))
        if hit is None or hit[0] is not cur:
            hit = self.path_lists[id(cur)] = (cur, len(self.path_lists))
        return [hit[1], [cwd_out(p, self.cwd0) if os.path.isabs(p) else ["abs", p] for p in cur], first, last + 1, [["abs", p] for p in base]]

    def _end(self, why):
        """Process state the two processes can no longer share: this call and every later one is a grader error."""
        if self.ended is None:
            self.ended = clip(why, 1000)

    def _decode_cst(self, cst, dec):
        """The candidate's process state changes, with their values decoded (before the message's sync)."""
        if cst is None:
            return {}
        if not isinstance(cst, dict):
            raise ProtocolError("bad candidate state")
        out = dict(cst)
        for name in ("stdout", "stderr", "stdin", "print", "input"):
            v = cst.get(name)
            if v is None:
                continue
            if not (isinstance(v, list) and (v == ["orig"] or (len(v) == 2 and v[0] == "obj"))):
                raise ProtocolError("bad %s state" % name)
            out[name] = None if v == ["orig"] else [dec.dec(v[1])]
        if "argv" in cst:
            out["argv"] = dec.dec(cst["argv"])
        return out

    def _apply_cst(self, cst):
        """Process state the candidate's code changed: as it would be in one process, else the run ends."""
        s = self.state
        for name in ("stdout", "stderr", "stdin"):
            if name in cst:
                obj = self.orig[name] if cst[name] is None else cst[name][0]
                setattr(sys, name, obj)
                s[name] = self._stdin_key(obj) if name == "stdin" else obj
        for name in ("print", "input"):
            if name in cst:
                obj = self.orig[name] if cst[name] is None else cst[name][0]
                setattr(builtins, name, obj)
                s[name] = obj
        if "argv" in cst:
            sys.argv = s["argv"] = cst["argv"]
        if "env" in cst:
            if not env_apply(cst["env"]):
                self._end("the candidate set an environment variable the tests' process can't set")
            s["env"] = dict(os.environ)
            raw = env_raw()
            s["env_raw"] = None if raw is None else dict(raw)
        if "cwd" in cst:
            where = cwd_in(cst["cwd"], self.cwd0)
            try:
                _chdir(where)
            except OSError as e:
                self._end("the candidate changed directory to %s, which the tests' process can't enter (%s)" % (clip(where, 200), e.strerror))
            s["cwd"] = _getcwd()
        if "umask" in cst:
            um = cst["umask"]
            if type(um) is not int or not 0 <= um <= 0o777:
                raise ProtocolError("bad umask")
            _umask(um)
            s["umask"] = um
        if "locale" in cst:
            lc = cst["locale"]
            if type(lc) is not str or not locale_set(lc):
                self._end("the candidate set a locale the tests' process can't set the same way (%s)" % clip(lc, 200))
            s["locale"] = locale_now()
        if "tz" in cst:
            # The environment (TZ) is already the candidate's: time.tzset() here gives the same zone, or the run ends.
            if _tzset is not None:
                _tzset()
            if cst["tz"] != tz_now():
                self._end("the candidate called time.tzset() with a time zone the tests' process can't reproduce")
            s["tz"] = tz_now()

    def _apply_state(self, msg, dec, cst):
        for entry in msg.get("out") or ():
            if not (isinstance(entry, list) and len(entry) == 3 and entry[0] in ("stdout", "stderr") and isinstance(entry[1], str)):
                raise ProtocolError("bad output")
            # Written to the stream the candidate's sys.stdout/stderr stood for when it wrote.
            target = self.callbacks.get(entry[2])
            if type(target) is not io.StringIO:
                raise ProtocolError("bad output")
            target.write(entry[1])
        used = msg.get("stdin")
        if used is not None:
            cur = self.stdin_obj
            if type(used) is not int or used < 0 or type(cur) is not io.StringIO:
                raise ProtocolError("bad stdin use")
            cur.seek(cur.tell() + used)
            if sys.stdin is cur:
                self.state["stdin"] = self._stdin_key(cur)
        rs = msg.get("random")
        if rs is not None:
            r = sys.modules.get("random")
            if r is None or not isinstance(rs, list) or len(rs) != 3:
                raise ProtocolError("bad random state")
            r.setstate((rs[0], tuple(rs[1]), rs[2]))
            self.state["random"] = r.getstate()
        lim = msg.get("rlimit")
        if lim is not None:
            if type(lim) is not int:
                raise ProtocolError("bad recursion limit")
            try:
                sys.setrecursionlimit(lim)
            except (ValueError, RecursionError) as e:
                raise Inexact("the candidate set a recursion limit of %d, which the tests' process can't use (%s)" % (lim, clip(_safe_str(e), 200))) from None
            self.state["rlimit"] = lim
        if msg.get("decimal") is not None:
            self.state["decimal"] = decimal_apply(msg["decimal"])
        if msg.get("warnings") is not None:
            warnings_set(warnings_in(dec, msg["warnings"]))
            self.state["warnings"] = warnings_state()
        if cst:
            self._apply_cst(cst)
        if msg.get("weakalive"):
            self.weak_err = _WEAK_ERR

    # calls

    def _fail(self, why):
        if not self.gone:
            self.gone = why
        return CandidateGone(self.gone)

    def _wait(self):
        """Seconds to wait for the next message: the per-answer limit, cut at the deadline."""
        t = self.timeout
        if self.deadline is not None:
            left = self.deadline - time.monotonic()
            t = left if t is None else min(t, left)
        return t

    def _send(self, msg, vals):
        if self.sync_secs + self.candidate_secs > self.sync_limit:
            raise self._fail("keeping the containers shared with candidate code in sync took over %.0fs (%d linked); the grader can't keep up" % (self.sync_limit, len(self.links)))
        enc = Encoder(self, TEST_NAMES_OUT)
        self.made = []
        saved = dict(self.state)
        try:
            msg["v"] = [enc.enc(v) for v in vals]
            st = self._state(enc)
        except BaseException:
            for n in self.made:
                self._unlink(n)
            self.refd = set()
            self.state = saved
            raise
        if st:
            msg["st"] = st
        if self.release:
            rel, self.release = self.release, {}
            msg["release"] = list(rel)
            if not self.weak.isdisjoint(rel):
                msg["weak"] = sorted(self.weak.intersection(rel))
                self.weak.difference_update(rel)
        try:
            self._outgoing(enc, msg)
            self.chan.send(msg)
        except OSError as e:
            raise self._fail("candidate process is gone (%s)" % e) from None
        except BaseException as e:
            raise self._fail("the tests' changes to shared containers can't be sent: %s" % clip(_safe_str(e) or type(e).__name__, 300)) from None

    def _receive(self):
        wait = self._wait()
        if wait is not None and wait <= 0:
            raise self._fail("candidate code was still running at the grading deadline")
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
        busy = msg.get("busy")
        if type(busy) in (int, float) and busy >= 0:
            self.candidate_secs = float(busy)
        dec = Decoder(self, TEST_NAMES_IN)
        try:
            vals = msg.get("v") or []
            if not isinstance(vals, list):
                raise ProtocolError("bad values")
            got = [dec.dec(x) for x in vals]
            cst = self._decode_cst(msg.get("cst"), dec)
            self._incoming(dec, msg)
            self._apply_state(msg, dec, cst)
        except ProtocolError as e:
            raise self._fail("candidate broke the grading protocol (%s)" % e) from None
        except GraderError as e:
            raise self._fail(_safe_str(e) or type(e).__name__) from None
        except Exception as e:
            raise self._fail("reading the candidate's answer failed: %s: %s" % (type(e).__name__, clip(_safe_str(e), 300))) from None
        return msg, got

    def call(self, op, vals=(), **plain):
        """Ask the candidate process to run op on vals; serve its callbacks meanwhile."""
        wait = self._wait()
        if not self.lock.acquire(timeout=-1 if wait is None else max(0.0, wait)):
            raise self._fail("a test thread waited for the candidate past the time limit")
        try:
            if self.gone:
                raise CandidateGone(self.gone)
            if self.ended:
                raise Inexact(self.ended)
            self.depth += 1
            try:
                self._send({"req": dict(plain, op=op, ng=code_frames(GRADER_CODE))}, vals)
                while True:
                    msg, got = self._receive()
                    if "rep" in msg:
                        if self.ended:
                            raise Inexact(self.ended)
                        r = self._reply(msg["rep"], got)
                        if self.weak_err is not None:
                            err, self.weak_err = self.weak_err, None
                            raise Inexact(err)
                        return r
                    self._serve(msg.get("req"), got)
            finally:
                self.depth -= 1
        finally:
            self.lock.release()

    def _reply(self, rep, got):
        if not isinstance(rep, dict):
            raise self._fail("candidate broke the grading protocol (bad reply)")
        if "fatal" in rep:
            raise self._fail(clip(rep["fatal"], 1000))
        if "unsendable" in rep:
            raise Unsendable("the candidate's result can't be sent to the tests: %s" % clip(rep["unsendable"], 300))
        if len(got) != 1:
            raise self._fail("candidate broke the grading protocol (bad reply)")
        if rep.get("raise") is True:
            e = got[0]
            if not isinstance(e, BaseException):
                raise self._fail("candidate broke the grading protocol (raised a non-exception)")
            raise e
        return got[0]

    def _serve(self, req, got):
        """The candidate's code uses a test object: call it, or one of the few operations it allows."""
        try:
            if not isinstance(req, dict) or not got:
                raise ProtocolError("bad request")
            op = req.get("op")
            k = self.callback_ids.get(id(got[0]))
            if k is None or self.callbacks.get(k) is not got[0]:
                raise ProtocolError("request on a non-test object")
            if op == "call":
                if len(got) != 3 or type(got[1]) is not tuple or type(got[2]) is not tuple or not all(type(p) is tuple and len(p) == 2 and type(p[0]) is str for p in got[2]):
                    raise ProtocolError("bad callback arguments")
                run = lambda: got[0](*got[1], **dict(got[2]))  # noqa: E731
            elif op == "hop" and req.get("name") in _HANDLE_OPS:
                run = lambda: _HANDLE_OPS[req["name"]](*got)  # noqa: E731
            else:
                raise ProtocolError("unexpected request")
        except ProtocolError as e:
            raise self._fail("candidate broke the grading protocol (%s)" % e) from None
        ng = req.get("ng")
        try:
            try:
                # As deep as one process would run it: below it, the candidate's frames (ng) and the tests'.
                result = padded(ng - grader_frames(GRADER_CODE) - 2, run) if type(ng) is int else run()
            except Exception as e:
                self._send({"rep": {"raise": True}}, [e])
                return
            except SystemExit as e:
                self._send({"rep": {"raise": True}}, [e])
                return
            self._send({"rep": {"ok": True}}, [result])
        except Unsendable as e:
            self._send({"rep": {"unsendable": clip(_safe_str(e), 300)}}, [])
        except BaseException as e:  # noqa: B036 - the candidate still waits for this answer
            if not self.gone:
                self.gone = "grading stopped in a test callback: %s" % clip(_safe_str(e) or type(e).__name__, 300)
            raise

    def status(self):
        """End of a test: the candidate checks nothing ran behind the tests' back (its threads)."""
        return self.call("status")

    def module(self, name):
        return self.call("import", name=name)


_HANDLE_OPS = {
    "hash": lambda x: hash(x),
    "eq": lambda x, y: x == y,
    "ne": lambda x, y: x != y,
    "repr": lambda x: repr(x),
    "str": lambda x: str(x),
    "next": lambda x: next(x),
    "iter": lambda x: iter(x),
    "len": lambda x: len(x),
    "bool": lambda x: bool(x),
}


def _plain_ntuple(t):
    """A namedtuple class with nothing but what namedtuple() generates (the candidate gets an equivalent one)."""
    allowed = {"__module__", "__doc__", "__slots__", "_fields", "_field_defaults", "__new__", "_make", "_replace", "__replace__", "__repr__", "_asdict", "__getnewargs__", "__match_args__", "__annotations__", "__orig_bases__", "__qualname__", "__firstlineno__", "__static_attributes__", "__annotate__", "__annotate_func__", "__annotations_cache__", "__classdictcell__"}
    for k in _MRO(t):
        if k is tuple or k is object:
            break
        for n in _DICT(k):
            if n not in allowed and n not in ntuple_fields(t):
                return False
    return True


def _is_std_enum(t):
    e = sys.modules.get("enum")
    return e is not None and isinstance(t, type) and issubclass(t, e.Enum) and std_module(t.__module__) and resolve_std(type_path(t)) is t


# ---------- candidate side ----------


class _Poisoned(GraderError):
    pass


class TestObject:
    """A test object passed to the candidate's code: it can be called (if the test's is callable, binding like a
    function when it is one), hashed, compared, printed, iterated, and handed back. Anything else can't be
    reproduced here and makes the grading fail."""

    __slots__ = ("_srv", "_k", "_f", "__weakref__")

    def __init__(self, srv, k, f):
        object.__setattr__(self, "_srv", srv)
        object.__setattr__(self, "_k", k)
        object.__setattr__(self, "_f", f)

    def __call__(self, *args, **kwargs):
        if not self._f.get("call"):
            raise TypeError("'%s' object is not callable" % self._f.get("type", "object"))
        return self._srv.call_back("call", [self, args, tuple(kwargs.items())])

    def __get__(self, obj, cls=None):
        if obj is None or not self._f.get("fn"):
            return self
        return types.MethodType(self, obj)

    def __getattr__(self, name):
        f = object.__getattribute__(self, "_f")
        if name in ("__name__", "__qualname__", "__module__") and name in f:
            return f[name]
        if name.startswith("_terrarium"):
            raise AttributeError(name)
        raise object.__getattribute__(self, "_srv")._poison("the candidate's code read attribute %r of a test %s" % (clip(name, 60), f.get("type")))

    def __setattr__(self, name, value):
        raise self._srv._poison("the candidate's code set attribute %r of a test %s" % (clip(name, 60), self._f.get("type")))

    def __delattr__(self, name):
        raise self._srv._poison("the candidate's code deleted attribute %r of a test %s" % (clip(name, 60), self._f.get("type")))

    @property
    def __class__(self):
        raise self._srv._poison("the candidate's code checked the type of a test %s" % self._f.get("type"))

    def __hash__(self):
        return self._srv.call_back("hop", [self], name="hash")

    def __eq__(self, other):
        return self._srv.call_back("hop", [self, other], name="eq")

    def __ne__(self, other):
        return self._srv.call_back("hop", [self, other], name="ne")

    def __repr__(self):
        return self._srv.call_back("hop", [self], name="repr")

    def __str__(self):
        return self._srv.call_back("hop", [self], name="str")

    def __iter__(self):
        if self._f.get("it"):
            return self
        return self._srv.call_back("hop", [self], name="iter")

    def __next__(self):
        return self._srv.call_back("hop", [self], name="next")

    def __len__(self):
        return self._srv.call_back("hop", [self], name="len")

    def __bool__(self):
        return self._srv.call_back("hop", [self], name="bool")


def _poison_method(name):
    def method(self, *args):
        raise object.__getattribute__(self, "_srv")._poison("the candidate's code used %s on a test %s" % (name, object.__getattribute__(self, "_f").get("type")))

    method.__name__ = name
    return method


for _n in DUNDERS + UNSUPPORTED + ("__lt__", "__le__", "__gt__", "__ge__", "__reduce__", "__reduce_ex__", "__copy__", "__deepcopy__", "__format__", "__dir__", "__sizeof__"):
    if _n not in TestObject.__dict__:
        setattr(TestObject, _n, _poison_method(_n))


class TestData(TestObject):
    """A test object built-in code could take as built-in data in one process (an instance of a str, list, int, ...
    subclass, or a class): a type check in C that a TestData fails (its name in the TypeError) ends the run."""

    __slots__ = ()


def _watch_raises(srv):
    """Have every TypeError naming TestData poison the run, even one candidate code catches (sys.monitoring, 3.12+);
    else (older Python) only the ones that reach the tests. Whether it watches."""
    mon = getattr(sys, "monitoring", None)
    if mon is None:
        return False
    for tool in (4, 3, 2, 1):
        try:
            mon.use_tool_id(tool, "terrarium-grader")
            break
        except ValueError:
            continue
    else:
        return False

    def on_raise(code, offset, exc):
        if type(exc) is TypeError and _TEST_DATA in _safe_str(exc):
            srv._poison(_DATA_ERR % clip(_safe_str(exc), 200))

    mon.register_callback(tool, mon.events.RAISE, on_raise)
    mon.set_events(tool, mon.events.RAISE)
    return True


_TEST_DATA = "TestData"
_DATA_ERR = "the candidate's code used a test object where Python takes built-in data (%s): in one process it is the test's own str, list, number or class"


class _Capture:
    """The candidate's sys.stdout/stderr while the test's is an io.StringIO: writes go to it, in order."""

    encoding = None
    errors = None
    newlines = None
    closed = False

    def __init__(self, srv, name, k):
        self._srv = srv
        self._name = name
        self._k = k  # the test object (an io.StringIO) it stands for

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError("string argument expected, got '%s'" % type(s).__name__)
        self._srv._output(self._name, str.__str__(s), self._k)
        return len(s)

    def writelines(self, lines):
        for s in lines:
            self.write(s)

    def flush(self):
        pass

    def isatty(self):
        return False

    def readable(self):
        return False

    def writable(self):
        return True

    def seekable(self):
        return True

    def __getattr__(self, name):
        raise self._srv._poison("the candidate's code used sys.%s.%s, which can't be mirrored" % (self._name, clip(name, 60)))


class _Unmirrored:
    """A stream or object of the test process that can't be reproduced here: any use fails the grading."""

    def __init__(self, srv, what):
        object.__setattr__(self, "_srv", srv)
        object.__setattr__(self, "_what", what)

    def __getattr__(self, name):
        raise object.__getattribute__(self, "_srv")._poison("the candidate's code used %s, which the grader can't mirror from the test process" % object.__getattribute__(self, "_what"))


class Server(Side):
    """Candidate side of the channel: holds the candidate's objects and answers requests."""

    def __init__(self, sock):
        Side.__init__(self, sock, -1)
        self.objs = {}  # rid -> candidate object the test side has a proxy for
        self.weak_alive = []  # released rids whose object outlived the tests' weak references to it
        self.ids = {}  # id(object) -> rid
        self.next_rid = 1
        self.tobjs = {}  # k -> TestObject or test exception
        self.tobj_ids = {}  # id(test exception copy) -> k
        self.ntuple_classes = {}
        self.ntuple_keys = {}
        self.exc_classes = {}
        self.singles = {}
        self.abcs = None
        self.io = threading.RLock()
        self.depth = 0  # requests from the tests being run
        self.poison = None
        self.out = []
        self.orig = {"stdout": sys.stdout, "stderr": sys.stderr, "stdin": sys.stdin, "print": builtins.print, "input": builtins.input}
        self.seen = dict(self.orig)  # each of those as the tests last had it here
        self.standin = {}  # id(stand-in) -> (stand-in, the test object it stands for): _Capture, _Unmirrored, stdin
        self.argv_obj = sys.argv
        self.env_last = dict(os.environ)
        raw = env_raw()
        self.env_raw = None if raw is None else dict(raw)
        self.cwd0 = self.cwd_last = _getcwd()
        self.path_obj, self.path0 = sys.path, list(sys.path)
        self.path_own = list(sys.path)  # this interpreter's path, with the workspace first
        self.path_lists = {0: sys.path}  # the tests' sys.path lists by number: this side's list for each
        self.umask = umask_now(0o022)
        self.locale = locale_now()
        self.tz = tz_now()
        self.stdin = None  # the test's stdin text, as an io.StringIO here
        self.stdin_pos = 0
        self.random = None  # random state last exchanged
        self.patches = []  # the tests' mock.patch of standard-library objects: (path, attr, target, old value)
        self.rlimit = sys.getrecursionlimit()  # recursion limit last exchanged
        import warnings

        self.warn_orig = (warnings.showwarning, warnings._showwarnmsg_impl)
        self.warn = None  # warnings state last exchanged
        self.dec = None  # decimal context last exchanged
        # The grader's code: this module's, and the worker script's below it (by module globals).
        f, files = sys._getframe(), set(GRADER_CODE)
        while f is not None:
            files.add(id(f.f_globals))
            f = f.f_back
        self.files = frozenset(files)
        guard_frames(self.files, self.files, self._poison, False)
        self.raises = _watch_raises(self)

    # failures the candidate's code can't hide

    def _poison(self, why):
        if self.poison is None:
            self.poison = clip(why, 1000)
        return _Poisoned(why)

    def _output(self, name, text, k):
        if self.depth == 0:
            raise self._poison("the candidate's code wrote to sys.%s outside a call from the tests (a thread)" % name)
        if self.out and self.out[-1][0] == name and self.out[-1][2] == k:
            self.out[-1][1] += text
        else:
            self.out.append([name, text, k])

    # values

    def _rid(self, v):
        rid = self.ids.get(id(v))
        if rid is not None and self.objs.get(rid) is v:
            return rid, False
        rid = self.next_rid
        self.next_rid += 1
        self.objs[rid] = v
        self.ids[id(v)] = rid
        return rid, True

    def _special(self, enc, v, depth, key):
        t = type(v)
        if t is TestObject or t is TestData:
            if v._srv is not self:
                raise Unsendable("a test object from another grading run")
            return {"t": "tobj", "id": v._k}
        k = self.tobj_ids.get(id(v))
        if k is not None and self.tobjs.get(k) is v:
            return {"t": "texc", "id": k}
        if t in LINK_TYPES:
            n = self._link_ref(v)
            if n is not None:
                return {"t": "link", "id": n}
            n = self._new_link(v, t)
            self.made.append(n)
            tag = self._contents(enc, v, t, depth)
            tag["link"] = n
            self._snap(n)
            return tag
        if t in _BY_VALUE or id(v) in CANDIDATE_NAMES_OUT:
            return None
        key_ = self.ntuple_keys.get(t)
        if key_ is not None:
            return {"t": "ntuple", "n": key_[0], "f": list(key_[1]), "v": [enc.enc(x, depth + 1, key) for x in tuple.__iter__(v)]}
        if isinstance(v, type):
            return self._class_tag(enc, v, depth)
        if isinstance(v, BaseException):
            return enc.aliased(v, lambda: self._object(enc, v, depth))
        return self._object(enc, v, depth)

    def _objref(self, enc, v, depth, key):
        return self._object(enc, v, depth)

    def _class_tag(self, enc, cls, depth):
        rid, new = self._rid(cls)
        tag = {"t": "class", "id": rid}
        if new:
            try:
                tag["d"] = self._describe(enc, cls, depth + 1)
            except BaseException:
                del self.objs[rid]
                del self.ids[id(cls)]
                raise
        return tag

    def _object(self, enc, v, depth):
        rid, new = self._rid(v)
        tag = {"t": "obj", "id": rid}
        t = type(v)
        data = None if t is bool else data_base(t)
        if not new:
            if data in LINK_TYPES:
                self._link_ref(v)
            return tag
        try:
            tag["c"] = self._class_tag(enc, t, depth)
            d = depth + 1
            if isinstance(v, BaseException):
                tag["x"] = self._exc_fields(enc, v, d)
            elif std_module(t.__module__) and sys.modules.get("enum") is not None and isinstance(v, sys.modules["enum"].Enum):
                tag["member"] = v._name_
                if data is not None and data not in LINK_TYPES:
                    tag["v"] = enc.enc(_raw_data(v, data), d)
            elif data in LINK_TYPES:
                n = self._new_link(v, data, extra=1)
                self.made.append(n)
                tag["link"] = n
                tag["v"] = self._contents(enc, v, data, depth)
                self._snap(n)
            elif data is not None:
                tag["v"] = enc.enc(_raw_data(v, data), d)
            elif std_module(t.__module__):
                single = self._single(t, v)
                if single is not None:
                    tag["single"] = single
        except BaseException:
            self.objs.pop(rid, None)
            self.ids.pop(id(v), None)
            raise
        return tag

    def _single(self, t, v):
        """"module:name" of a module-level standard-library object (dataclasses.MISSING), else None."""
        table = self.singles.get(t)
        if table is None:
            table = {}
            m = sys.modules.get(t.__module__)
            for name, x in list(vars(m).items()) if m is not None else ():
                if type(x) is t and isinstance(name, str):
                    table.setdefault(id(x), (x, "%s:%s" % (t.__module__, name)))
            self.singles[t] = table
        hit = table.get(id(v))
        return hit[1] if hit is not None and hit[0] is v else None

    def _exc_fields(self, enc, e, d):
        t = type(e)
        f = {"args": enc.enc(e.args, d), "cause": enc.enc(e.__cause__, d), "context": enc.enc(e.__context__, d)}
        if e.__suppress_context__:
            f["sup"] = True
        if std_module(t.__module__):
            attrs = []
            for k in _MRO(t):
                if k is BaseException or k is object or k.__module__ != "builtins":
                    continue
                for n, desc in vars(k).items():
                    if isinstance(desc, (types.MemberDescriptorType, types.GetSetDescriptorType)) and not n.startswith("__"):
                        try:
                            attrs.append([n, enc.enc(desc.__get__(e, t), d)])
                        except AttributeError:
                            pass
            for n, x in list(getattr(e, "__dict__", {}).items()):
                if isinstance(n, str):
                    attrs.append([n, enc.enc(x, d)])
            f["attrs"] = attrs
        return f

    def _describe(self, enc, cls, d):
        get = type.__dict__
        mro = _MRO(cls)
        is_meta = issubclass(cls, type)
        out = {
            "name": get["__name__"].__get__(cls),
            "qual": get["__qualname__"].__get__(cls),
            "mod": get["__module__"].__get__(cls),
            "path": type_path(cls),
            "mro": [enc.enc(k, d) for k in mro[1:]],
            "bases": [enc.enc(k, d) for k in get["__bases__"].__get__(cls)],
        }
        if std_module(out["mod"]) and resolve_std(out["path"]) is cls:
            out["std"] = True
        if type(cls) is not type:
            out["meta"] = enc.enc(type(cls), d)
        if is_meta:
            out["isMeta"] = True
            names = META_FORWARDABLE
            data = exc = None
        else:
            names = FORWARDABLE | frozenset(CMP) | frozenset(UNSUPPORTED) | {"__hash__"}
            data = data_base(cls) if cls is not bool else None
            exc = next((k for k in mro if k in BUILTIN_EXCEPTIONS), None) if issubclass(cls, BaseException) else None
            if data is not None:
                out["data"] = LINK_TAGS.get(data) or next(k for k, v in IMMUTABLE_TAGS.items() if v is data)
            if exc is not None:
                out["exc"] = exc.__name__
        local = set(_MRO(data)) if data is not None else set()
        if exc is not None:
            local |= set(_MRO(exc))
        local |= {object, type} if is_meta else {object}
        fwd, cmp_, unsup = [], [], []
        for n in sorted(names):
            k = owner(cls, n)
            if k is None:
                continue
            if n == "__hash__":
                out["hash"] = "none" if _DICT(k)[n] is None else ("local" if k in local else "fwd")
            elif k in local:
                continue
            elif n in CMP:
                cmp_.append(n)
            elif n in UNSUPPORTED:
                unsup.append(n)
            else:
                fwd.append(n)
        out["fwd"], out["cmp"], out["unsup"] = fwd, cmp_, unsup
        if not is_meta:
            out["abcs"] = [enc.enc(a, d) for a in self._registered(cls, mro)]
        return out

    def _registered(self, cls, mro):
        """Standard abstract base classes cls is registered with (not by inheritance or by their own check)."""
        if self.abcs is None:
            self.abcs = _abcs()
        out = []
        for a in self.abcs:
            if a in mro:
                continue
            try:
                if issubclass(cls, a) and a.__subclasshook__(cls) is not True:
                    out.append(a)
            except Exception:
                continue
        return out

    def _resolve(self, dec, x, d):
        t = x["t"]
        if t in ("obj", "class"):
            rid = x.get("id")
            if rid not in self.objs:
                raise ProtocolError("unknown object")
            obj = self.objs[rid]
            n = self.link_of.get(id(obj))
            if n is not None and self.links.get(n) is obj:
                self.touched.add(n)
            return obj
        if t == "link":
            return self._got(x.get("id"))
        if t == "tobj":
            k = x.get("id")
            obj = self.tobjs.get(k)
            if obj is None:
                f = x.get("f")
                if type(k) is not int or not isinstance(f, dict):
                    raise ProtocolError("unknown test object")
                obj = self.tobjs[k] = (TestData if f.get("data") is True else TestObject)(self, k, f)
            return obj
        if t == "texc":
            k = x.get("id")
            obj = self.tobjs.get(k)
            if obj is None:
                obj = self._test_exception(dec, k, x, d)
            return dec.register(x, obj)
        if t == "ttb":
            k = x.get("id")
            obj = self.tobjs.get(k)
            if obj is None:
                if type(k) is not int:
                    raise ProtocolError("bad test traceback")
                obj = self.tobjs[k] = synthetic_traceback()
                self.tobj_ids[id(obj)] = k  # sent back as the test's own traceback
            return obj
        if t == "ntuple":
            name, fields = x.get("n"), x.get("f")
            if not isinstance(name, str) or not isinstance(fields, list) or not all(isinstance(f, str) for f in fields):
                raise ProtocolError("bad namedtuple")
            key = (name, tuple(fields))
            cls = self.ntuple_classes.get(key)
            if cls is None:
                ok = name.isidentifier() and not keyword.iskeyword(name)
                cls = collections.namedtuple(name if ok else "NamedTuple", fields, rename=True)
                self.ntuple_classes[key] = cls
                self.ntuple_keys[cls] = key
            return dec.register(x, cls._make([dec.dec(i, d) for i in x.get("v") or ()]))
        if t == "senum":
            path = x.get("c")
            mod = path.partition(":")[0] if isinstance(path, str) else ""
            if std_module(mod) and mod not in sys.modules:
                __import__(mod)
            cls = resolve_std(path)
            m = getattr(cls, "__members__", None) if isinstance(cls, type) else None
            if not isinstance(m, collections.abc.Mapping) or x.get("n") not in m:
                raise ProtocolError("unknown enum member")
            return m[x.get("n")]
        raise ProtocolError("unknown tag %r" % clip(t, 40))

    def _test_exception(self, dec, k, x, d):
        if type(k) is not int:
            raise ProtocolError("bad test exception")
        mro = x.get("mro")
        if not isinstance(mro, list) or not mro or not all(isinstance(m, str) for m in mro):
            raise ProtocolError("bad test exception")
        args = dec.dec(x.get("args"), d)
        if type(args) is not tuple:
            raise ProtocolError("bad test exception args")
        real = resolve_std(mro[0])
        if isinstance(real, type) and issubclass(real, BaseException):
            cls = real
        else:
            base = BUILTIN_TYPES.get(x.get("base"))
            if not (isinstance(base, type) and issubclass(base, BaseException)):
                base = Exception
            cls = self.exc_classes.get(tuple(mro))
            if cls is None:
                module, _, name = mro[0].partition(":")
                name = name.rpartition(".")[2]
                cls = type(name if name.isidentifier() else "TestError", (base,), {"__module__": module or "test"})
                self.exc_classes[tuple(mro)] = cls
        try:
            e = cls(*args) if cls in BUILTIN_EXCEPTIONS else cls.__new__(cls, *args)
        except Exception:
            e = cls.__new__(cls, *args)
        BaseException.__dict__["args"].__set__(e, args)
        for pair in x.get("attrs") or ():
            if isinstance(pair, list) and len(pair) == 2 and isinstance(pair[0], str):
                try:
                    setattr(e, pair[0], dec.dec(pair[1], d))
                except Exception:
                    pass
        self.tobjs[k] = e
        self.tobj_ids[id(e)] = k
        return e

    # process state

    def _apply_state(self, st):
        if not st:
            return
        if not isinstance(st, dict):
            raise ProtocolError("bad state")
        for name in ("stdout", "stderr", "stdin"):
            v = st.get(name)
            if v is None:
                continue
            if not isinstance(v, list) or not v or v[0] not in ("orig", "sio", "other", "cand"):
                raise ProtocolError("bad stream state")
            kind, test_obj = v[0], v[-1]
            if kind == "orig":
                obj = self.orig[name]
            elif kind == "cand":
                obj = test_obj  # the candidate's own object
            elif name == "stdin" and kind == "sio":
                if len(v) != 3 or not isinstance(v[1], str):
                    raise ProtocolError("bad stdin state")
                obj = io.StringIO(v[1])
            elif kind == "sio" and isinstance(test_obj, TestObject):
                obj = _Capture(self, name, test_obj._k)
            else:
                obj = _Unmirrored(self, "sys." + name)
            if kind in ("sio", "other"):
                self.standin[id(obj)] = (obj, test_obj)
            if name == "stdin":
                self.stdin = obj if kind == "sio" else None
                self.stdin_pos = 0
            setattr(sys, name, obj)
            self.seen[name] = obj
        for name in ("print", "input"):
            if name in st:
                v = st[name]
                obj = self.orig[name] if v is None else v
                setattr(builtins, name, obj)
                self.seen[name] = obj
        if "argv" in st:
            sys.argv = self.argv_obj = st["argv"]
        if "path" in st:
            v = st["path"]
            if not (isinstance(v, list) and len(v) == 5 and type(v[0]) is int and isinstance(v[1], list) and type(v[2]) is int and type(v[3]) is int and isinstance(v[4], list) and 0 <= v[2] <= v[3] <= len(v[1])):
                raise ProtocolError("bad sys.path state")
            new = path_compose(self.path_own, [path_entry_in(p, self.cwd0) for p in v[4]], [path_entry_in(p, self.cwd0) for p in v[1]], v[2], v[3])
            if new is None:
                self._poison("the candidate's interpreter has a different path from the tests' one: their sys.path changes can't be shared")
            else:
                lst = self.path_lists.get(v[0])
                if lst is None:
                    lst = self.path_lists[v[0]] = []
                if lst != new:
                    lst[:] = new
                sys.path = lst
            self.path_obj, self.path0 = sys.path, list(sys.path)
        env = st.get("env")
        if env is not None:
            if not env_apply(env):
                self._poison("the tests set an environment variable the candidate's process can't set")
            self.env_last = dict(os.environ)
            raw = env_raw()
            self.env_raw = None if raw is None else dict(raw)
        if "cwd" in st:
            where = cwd_in(st["cwd"], self.cwd0)
            try:
                _chdir(where)
            except OSError as e:
                self._poison("the tests changed directory to %s, which the candidate process can't enter (%s)" % (clip(where, 200), e.strerror))
            try:
                self.cwd_last = _getcwd()
            except OSError:
                self.cwd_last = None
        if "umask" in st:
            um = st["umask"]
            if type(um) is not int or not 0 <= um <= 0o777:
                raise ProtocolError("bad umask")
            _umask(um)
            self.umask = um
        if "locale" in st:
            if type(st["locale"]) is not str or not locale_set(st["locale"]):
                self._poison("the tests set a locale the candidate's process can't set the same way (%s)" % clip(st["locale"], 200))
            self.locale = locale_now()
        if "tz" in st:
            if _tzset is not None:
                _tzset()
            if st["tz"] != tz_now():
                self._poison("the tests called time.tzset() with a time zone the candidate's process can't reproduce")
            self.tz = tz_now()
        rs = st.get("random")
        if rs is not None:
            import random

            random.setstate((rs[0], tuple(rs[1]), rs[2]))
            self.random = random.getstate()
        if "rlimit" in st:
            lim = st["rlimit"]
            if type(lim) is not int:
                raise ProtocolError("bad recursion limit")
            try:
                sys.setrecursionlimit(lim)
                self.rlimit = lim
            except (ValueError, RecursionError) as e:
                self._poison("the tests set a recursion limit of %d, which the candidate process can't use (%s)" % (lim, clip(_safe_str(e), 200)))
        if st.get("decimal") is not None:
            self.dec = decimal_apply(st["decimal"])
        if st.get("warnings") is not None:
            import warnings

            filters, show, impl = st["warnings"]
            warnings_set(filters)
            warnings.showwarning = self.warn_orig[0] if show is None else show
            warnings._showwarnmsg_impl = self.warn_orig[1] if impl is None else impl
            self.warn = warnings_state()

    def _slot(self, enc, cur):
        """How the tests' side takes the candidate's sys.stdout (or stdin, print, ...) cur: its own original, the
        test object a stand-in stands for, or the candidate's object (a proxy there; using it runs here)."""
        hit = self.standin.get(id(cur))
        if hit is not None and hit[0] is cur:
            return ["obj", enc.enc(hit[1])]
        return ["obj", enc.enc(cur)]

    def _cst(self, enc):
        """Process state the candidate's code changed since the tests last had it; what the tests' process can't
        share ends the run."""
        cst = {}
        for mod, name in ((sys, "stdout"), (sys, "stderr"), (sys, "stdin"), (builtins, "print"), (builtins, "input")):
            cur = getattr(mod, name)
            if cur is not self.seen[name]:
                self.seen[name] = cur
                cst[name] = ["orig"] if cur is self.orig[name] else self._slot(enc, cur)
        if sys.argv is not self.argv_obj:
            self.argv_obj = sys.argv
            cst["argv"] = enc.enc(sys.argv)
        raw = env_raw()
        if raw is None or raw != self.env_raw:
            env = dict(os.environ)
            if env != self.env_last:
                cst["env"] = env_diff(self.env_last, env)
                self.env_last = env
            self.env_raw = None if raw is None else dict(raw)
        try:
            cwd = _getcwd()
        except OSError as e:
            self._poison("the candidate's working directory is gone (%s)" % e.strerror)
            cwd = self.cwd_last
        if cwd != self.cwd_last:
            self.cwd_last = cwd
            cst["cwd"] = cwd_out(cwd, self.cwd0)
        um = umask_now(self.umask)
        if um != self.umask:
            self.umask = cst["umask"] = um
        lc = locale_now()
        if lc != self.locale:
            self.locale = cst["locale"] = lc
        tz = tz_now()
        if tz != self.tz:
            self.tz = cst["tz"] = tz
        if path_changed(self.path_obj, self.path0):
            self._poison("the candidate's code changed sys.path, which the tests' process can't share (its imports would differ)")
        return cst

    def _report(self, msg, enc):
        """Output, stdin use and process state the candidate's code changed, for the tests' side."""
        if self.out:
            msg["out"], self.out = self.out, []
        if self.weak_alive:
            msg["weakalive"], self.weak_alive = self.weak_alive, []
        if self.stdin is not None and not self.stdin.closed:
            pos = self.stdin.tell()
            if pos != self.stdin_pos:
                msg["stdin"] = pos - self.stdin_pos
                self.stdin_pos = pos
        try:
            cst = self._cst(enc)
        except BaseException as e:  # noqa: B036 - a value that can't be sent ends the run
            self._poison("the candidate's process state can't be sent to the tests: %s" % clip(_safe_str(e) or type(e).__name__, 200))
            cst = None
        if cst:
            msg["cst"] = cst
        if self.random is not None:
            r = sys.modules.get("random")
            rs = r.getstate() if r is not None else None
            if rs is not None and rs != self.random:
                self.random = rs
                msg["random"] = [rs[0], list(rs[1]), rs[2]]
        lim = sys.getrecursionlimit()
        if lim != self.rlimit:
            msg["rlimit"] = self.rlimit = lim
        ds = decimal_state()
        if ds is not None:
            if self.dec is None:
                self.dec = decimal_default()
            if ds != self.dec:
                self.dec = ds
                msg["decimal"] = decimal_out()
        ws = warnings_state()
        if self.warn is not None and not same_warnings(ws, self.warn):
            if ws is None or ws[1] is not self.warn[1] or ws[2] is not self.warn[2]:
                self._poison("the candidate's code replaced warnings.showwarning, which the tests' process can't share")
            else:
                try:
                    msg["warnings"] = warnings_out(enc, ws[0])
                    self.warn = ws
                except BaseException as e:  # noqa: B036 - a filter that can't be sent
                    self._poison("the candidate's warnings filters can't be sent to the tests: %s" % clip(_safe_str(e) or type(e).__name__, 200))

    # messages

    def _send(self, msg, vals):
        """Send msg with vals, after this side's link changes; a reply that can't be sent says why instead."""
        with self.io:
            enc = Encoder(self, CANDIDATE_NAMES_OUT)
            self.made = []
            try:
                msg["v"] = [enc.enc(v) for v in vals]
            except BaseException as e:  # noqa: B036 - candidate code may run while encoding
                for n in self.made:
                    self._unlink(n)
                self.refd = set()
                if "rep" not in msg:
                    raise
                why = clip(_safe_str(e) or type(e).__name__, 300)
                msg = {"rep": {"unsendable": why if isinstance(e, (GraderError, RecursionError)) else "%s while sending the result: %s" % (type(e).__name__, why)}, "v": []}
                enc = Encoder(self, CANDIDATE_NAMES_OUT)
            self._report(msg, enc)
            self._outgoing(enc, msg)
            if self.poison is not None:
                msg = {"rep": {"fatal": self.poison}, "v": []}
            msg["busy"] = round(self.sync_secs, 3)
            try:
                self.chan.send(msg)
            except Unsendable as e:
                self._poison("a message to the tests can't be sent: %s" % e)
                self.chan.send({"rep": {"fatal": self.poison}, "v": []})

    def _recv(self):
        with self.io:
            msg = self.chan.recv()
            dec = Decoder(self, CANDIDATE_NAMES_IN)
            vals = msg.get("v") or []
            if not isinstance(vals, list):
                raise ProtocolError("bad values")
            got = [dec.dec(x) for x in vals]
            st = msg.get("st")
            if isinstance(st, dict):
                st = dict(st)
                for name in ("print", "input", "argv"):
                    if st.get(name) is not None:
                        st[name] = dec.dec(st[name])
                for name in ("stdout", "stderr", "stdin"):
                    v = st.get(name)
                    if isinstance(v, list) and len(v) >= 2:
                        st[name] = v[:-1] + [dec.dec(v[-1])]
                ws = st.get("warnings")
                if ws is not None:
                    if not (isinstance(ws, list) and len(ws) == 3):
                        raise ProtocolError("bad warnings state")
                    st["warnings"] = (warnings_in(dec, ws[0]), None if ws[1] is None else dec.dec(ws[1]), None if ws[2] is None else dec.dec(ws[2]))
            self._incoming(dec, msg)
            weak = msg.get("weak") or ()
            # In the order the tests dropped them: an object the tests held weakly must die as its proxy did.
            for rid in msg.get("release") or ():
                obj = self.objs.pop(rid, None)
                if obj is not None and self.ids.get(id(obj)) == rid:
                    del self.ids[id(obj)]
                    n = self.link_of.get(id(obj))
                    if n is not None and self.links.get(n) is obj and n in self.extra:
                        del self.extra[n]  # objs no longer refers to it
                if obj is not None and rid in weak:
                    try:
                        w = weakref.ref(obj)
                    except TypeError:
                        w = None  # one process couldn't have made the tests' weak reference
                    obj = None
                    if w is None or w() is not None:
                        self.weak_alive.append(rid)
            obj = None
            self._apply_state(st)
            return msg, got

    def serve_forever(self):
        while True:
            try:
                msg, got = self._recv()
            except (EOFError, OSError):
                return
            self._handle(msg, got)
            msg = got = None  # a request's values live no longer than the call, as in one process

    def _handle(self, msg, got):
        req = msg.get("req")
        self.depth += 1
        try:
            if not isinstance(req, dict):
                raise ProtocolError("bad request")
            ng = req.get("ng")
            if type(ng) is int:
                # Run it as deep as one process would: below it, the tests' frames (ng) and the candidate's.
                result = padded(ng - grader_frames(self.files) - 3, lambda: self._op(req, got))
            else:
                result = self._op(req, got)
        except BaseException as e:  # noqa: B036 - the candidate's SystemExit is a result, not our exit
            self.depth -= 1
            if isinstance(e, (ProtocolError, _Poisoned)) and self.poison is None:
                self._poison("%s: %s" % (type(e).__name__, _safe_str(e)))
            elif type(e) is TypeError and _TEST_DATA in _safe_str(e):
                self._poison(_DATA_ERR % clip(_safe_str(e), 200))
            self._send({"rep": {"raise": True}}, [e])
            return
        self.depth -= 1
        self._send({"rep": {"ok": True}}, [result])

    def _op(self, req, got):
        op = req.get("op")
        name = req.get("name")
        if op == "import":
            import importlib

            return importlib.import_module(str(name))
        if op == "status":
            return self._status()
        if op == "unpatch":
            return self._unpatch(name, req.get("attr"))
        if not got:
            raise ProtocolError("no target")
        obj = got[0]
        if op == "getattr":
            return getattr(obj, str(name))
        if op == "setattr":
            setattr(obj, str(name), got[1])
            return None
        if op == "delattr":
            delattr(obj, str(name))
            return None
        if op == "call":
            if len(got) != 3 or type(got[1]) is not tuple or type(got[2]) is not tuple:
                raise ProtocolError("bad call")
            return obj(*got[1], **{str(k): v for k, v in got[2]})
        if op == "dunder":
            if name not in _OPS:
                raise ProtocolError("bad special method")
            return special(obj, name)(*got[1:])
        if op == "patch":
            return self._patch(name, req.get("attr"), obj)
        if op == "copy":
            import copy as _copy

            return _copy.deepcopy(obj) if req.get("deep") else _copy.copy(obj)
        raise ProtocolError("unknown op %r" % clip(op, 40))

    def _status(self):
        """Between tests: nothing changed what the tests can see since the last answer (a thread of the candidate's).
        Links only the candidate reaches may hold changes it made during calls: the tests get those when they get
        the link."""
        if self.out:
            self._poison("the candidate's code wrote output after returning (a thread)")
        for n in list(self.other):
            obj = self.links.get(n)
            if obj is not None and changed(obj, self.snaps[n], self.bases[n]):
                self._poison("the candidate's code changed a value shared with the tests after returning (a thread)")
                break
        return None

    def _patch_target(self, path):
        mod, _, qual = str(path).partition(":")
        if not std_module(mod):
            raise ProtocolError("patch of a non-standard module")
        if mod not in sys.modules:
            __import__(mod)
        t = sys.modules[mod] if not qual else resolve_std(path)
        if t is None:
            raise self._poison("the tests patched %s, which the candidate process doesn't have" % clip(path, 200))
        return t

    def _patch(self, path, attr, value):
        """The tests' mock.patch of a standard-library module or class: the candidate process sees it too."""
        t = self._patch_target(path)
        attr = str(attr)
        old = vars(t).get(attr, _NO)
        setattr(t, attr, value)
        self.patches.append((path, attr, t, old))

    def _unpatch(self, path, attr):
        for i in range(len(self.patches) - 1, -1, -1):
            p, a, t, old = self.patches[i]
            if p == path and a == attr:
                del self.patches[i]
                if old is _NO:
                    delattr(t, a)
                else:
                    setattr(t, a, old)
                return None
        raise ProtocolError("unpatch without a patch")

    def call_back(self, op, vals, **plain):
        """The candidate's code uses a test object: ask the test process (only while the tests wait on a call)."""
        if self.poison is not None:
            raise _Poisoned(self.poison)
        if self.depth <= 0:
            raise self._poison("the candidate's code used a test object outside a call from the tests (a thread)")
        with self.io:
            self._send({"req": dict(plain, op=op, ng=code_frames(self.files))}, vals)
            while True:
                msg, got = self._recv()
                if "rep" in msg:
                    rep = msg["rep"]
                    if not isinstance(rep, dict):
                        raise ProtocolError("bad reply")
                    if "unsendable" in rep:
                        raise self._poison("a test object's answer can't be sent to the candidate: %s" % clip(rep["unsendable"], 300))
                    if rep.get("raise") is True and got and isinstance(got[0], BaseException):
                        raise got[0]
                    if rep.get("ok") is True and len(got) == 1:
                        return got[0]
                    raise ProtocolError("bad reply")
                self._handle(msg, got)


_BY_VALUE = frozenset((tuple, frozenset, bytes, complex, decimal.Decimal, fractions.Fraction, datetime.datetime, datetime.date, datetime.time, datetime.timedelta, datetime.timezone, slice, range))
_OPS = FORWARDABLE | META_FORWARDABLE | frozenset(CMP) | frozenset(ALWAYS) | {"__hash__"}


def _raw_data(v, data):
    """v's own value as its built-in data type, read without its class's overrides."""
    if data is int:
        return int.__int__(v)
    if data is float:
        return float.__float__(v)
    if data is complex:
        return complex(float.__float__(complex.real.__get__(v)), complex.imag.__get__(v))
    if data is str:
        return str.__str__(v)
    if data is bytes:
        return bytes(memoryview(v))
    if data is tuple:
        return tuple(tuple.__iter__(v))
    if data is frozenset:
        return frozenset(frozenset.__iter__(v))
    raise TypeError("not immutable data")
