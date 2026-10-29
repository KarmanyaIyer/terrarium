"""Terrarium grading RPC (Python 3.9+, standard library only).

Candidate code runs in its own process (uid 1000 in the guest); the hidden tests run in another (uid 1001) and use
the candidate's modules through proxies. The rule: the isolated run may never report a pass that the same tests
would not give the same code in one process. Where it can reproduce Python's semantics it does; where it can't, it
raises GraderError (a BaseException, so assertRaises can't catch it) and the test errors instead of passing.

Values. Immutable plain data (None, bool, int, float, complex, str, bytes, tuple, frozenset, slice, range, Decimal,
Fraction, datetime values with no or a fixed-offset timezone, namedtuples the test made, built-in classes and
functions by name) crosses by value; a tuple or frozenset met twice in one message arrives as one object, and a
by-value object keeps its identity across messages while either side holds it (Encoder). Mutable
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
Candidate functions, generators and modules arrive as real ones standing for the candidate's (_make_forwarder,
_gen_wrap, grade_runner's ProxyModule); the attributes a function's stand-in copies are kept the same both ways.

Process state. Mirrored with every message, where code on either side could see or change it: sys.stdout/stderr/
stdin, print/input, argv, os.environ, the working directory, the umask, the locale, the time zone, logger levels,
the random module's state, the decimal context, the recursion limit, the warnings filters and the settings in
_PROC_MIRROR (both ways); the tests' warnings hooks, sys.path and standard-library attributes (StdWatch). What the
other process can't take the same way ends the run (Client._end, Server._poison). Each process has its own copy of
the workspace: the tests looking at a path the candidate's code changed in its copy, or changing their own, is a
grader error (_FS_CHANGE). Each side runs the other's
requests as deep in its stack as one process would ("ng": the requester's code frames), so recursion runs out at
the same depth.

Wire format: 4-byte big-endian length, then ASCII JSON. Every message is {"req": {...}} or {"rep": {...}}; values go
under "v" (decoded first), then "sync" (new contents of linked containers) is applied. Both sides: "held"/"loose"
(links its code started or stopped holding), "unlink" (links neither side holds). Test side: "st" (process state),
"release" (proxies it dropped, in that order), "weak" (those of them the tests held weak references to). Candidate
side: "out", "stdin", "random", "rlimit", "decimal", "warnings", "cst" (state its code changed), "weakalive" (weakly
held objects released while the candidate still had them: a grader error), "busy" (seconds it spent on sync),
"fatal". "st" and "cst" carry the process state and "fn" (attributes set on functions or generators the other side
has), "proc"/"procdirty" (ProcSettings); "st" also "std" (standard-library attributes) and "unimport", "cst" also
"fs" (workspace paths the candidate's code changed).
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
from operator import attrgetter, is_not

# The grader's own references: what tests or candidate code assign to these modules' attributes (mirrored to the
# other process, or refused) never reaches the grader's protocol or its type checks. `_time` is the module itself
# (time.tzset() changes its attributes).
_time = time


def _frozen(m):
    return types.SimpleNamespace(**vars(m))


time, json, struct, base64, datetime, decimal, fractions, io, weakref, threading, socket, collections, keyword, types = map(_frozen, (time, json, struct, base64, datetime, decimal, fractions, io, weakref, threading, socket, collections, keyword, types))
id = builtins.id  # the tests' side may give candidate objects their candidate id (see Client.install_guards)
_getrefcount = sys.getrefcount
_getframe = sys._getframe
_get_ident = threading.get_ident
_intern = sys.intern
_path_join, _normpath, _isabs = os.path.join, os.path.normpath, os.path.isabs

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


# Grading errors made in this process: how many, and the last one. Code catching one (a bare except) carries on
# where one process wouldn't have raised at all, so a run that made one can't pass (grade_runner, Server._handle).
RAISED = [0, None]


class GraderError(BaseException):
    """A failure of the grading, not an exception from the candidate's code. Not an Exception subclass, so
    a hidden test's assertRaises can't catch it; unittest records it as an error."""

    def __init__(self, *args):
        BaseException.__init__(self, *args)
        RAISED[0] += 1
        RAISED[1] = "%s: %s" % (type(self).__name__, clip(args[0] if args else "", 300))


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
    FLOATS_MAX = 1 << 16

    def __init__(self, sock):
        self.sock = sock
        # The tests' side: the values of the floats received (a float arrives as a new object, one process could have
        # had it), or None once there were too many to keep; the candidate's side keeps none (floats_off).
        self.floats = set()
        self.floats_off = True
        self.decoder = json.JSONDecoder(parse_float=self._float)

    def _float(self, s):
        v = float(s)
        if self.floats is not None:
            if len(self.floats) < self.FLOATS_MAX:
                self.floats.add(v)
            else:
                self.floats = None
        return v

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
            text = self._exact(n, deadline).decode("ascii")
            msg = json.loads(text) if self.floats_off or self.floats is None else self.decoder.decode(text)
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
# Lists up to this long are compared element by element: quicker than the pointer compare's fixed cost (0.4 to 1
# us: three ctypes calls and the audit events they raise).
_SHORT_LIST = 64


def _threaded():
    return threading.active_count() > 1


def shallow(v, base):
    """What changed() compares against: v's own contents read through base (never v's overrides), holding the
    elements so they stay alive. Containers nested in v are links of their own."""
    if base is list:
        items = list(list.__iter__(v))
        return (_READ(v) if _READ is not None and len(items) > _SHORT_LIST and not _threaded() else None, items)
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
    if not keys:
        return base is DefaultDict and _FACTORY.__get__(v) is not fac
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
_GRADER_GLOBALS = globals()


def grader_frames(code):
    """How many frames on this thread's stack run code (module globals ids) of the grader's, the caller's included."""
    n = 0
    f = _getframe(1)
    while f is not None:
        if id(f.f_globals) in code:
            n += 1
        f = f.f_back
    return n


def code_frames(code):
    """How many frames on this thread's stack run code not the grader's (the tests', the candidate's, the library's)."""
    n = 0
    f = _getframe(1)
    while f is not None:
        if id(f.f_globals) not in code:
            n += 1
        f = f.f_back
    return n


# Attribute reads CPython audits ("object.__getattr__") that reach a frame or its code.
_FRAME_READS = frozenset(("tb_frame", "f_code", "gi_frame", "gi_code", "cr_frame", "cr_code", "ag_frame", "ag_code"))
# Modules whose frame reads count as their caller's (unittest's own reporting reads tracebacks through them).
_FRAME_HELPERS = frozenset(("traceback", "linecache"))
# inspect's state checks only compare a generator's or coroutine's frame with None: a stand-in's is None when the
# candidate's is (_gen_mirror).
_STATE_READERS = frozenset(("getgeneratorstate", "getcoroutinestate"))


def guard_frames(readers, foreign, hit, unittest_reads):
    """An audit hook: code reading a frame of the grader's code (foreign: module globals ids) gets hit(why) raised,
    unless the reader is the grader (readers) or, with unittest_reads, unittest's own machinery. Such frames stand
    in for the other process's code, so what a test or candidate reads there (frame names, a traceback through the
    other side, inspect.stack() in a callback) isn't what one process would show it. Can't be removed once added."""
    busy = set()
    ident = threading.get_ident
    getframe = _getframe
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
            if r.f_code.co_name in _STATE_READERS and r.f_globals.get("__name__") == "inspect":
                return
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


# id() on the tests' side of a candidate object: this bit set on its id in the candidate process.
CANDIDATE_ID = 1 << 62


def _guard(mod, name, check):
    """Replace mod.name with a function that calls check(args) first (it raises when the answer can't be this
    process's), then the original."""
    real = getattr(mod, name, None)
    if real is None:
        return

    def guarded(*args, **kwargs):
        check(args)
        return real(*args, **kwargs)

    guarded.__name__ = guarded.__qualname__ = getattr(real, "__name__", name)
    guarded.__doc__ = getattr(real, "__doc__", None)
    setattr(mod, name, guarded)


def _std(name):
    """The real (imported) standard-library module, not the grader's frozen copy; None where it doesn't exist."""
    try:
        __import__(name)
    except ImportError:
        return None
    return sys.modules[name]


def synthetic_traceback(shape):
    """A real traceback object for a test's traceback crossing to the candidate (`__exit__`'s third argument): it is
    one, and not None, as there, with as many entries and each one's tb_lasti and tb_lineno (shape); its frames are
    the grader's, which the frame guard keeps candidate code from reading."""
    f = _getframe()
    tb = None
    for lasti, line in reversed(shape):
        tb = types.TracebackType(tb, f, lasti, line)
    return tb if tb is not None else types.TracebackType(None, f, f.f_lasti, f.f_lineno)


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


def _random_reader(inst, gs):
    """A function reading inst's Mersenne Twister state (index and 624 words) in place, if inst is a plain
    random.Random on CPython and what it reads is what getstate() says; else None."""
    try:
        import ctypes
        import random

        if type(inst) is not random.Random or getattr(gs, "__self__", None) is not inst or getattr(gs, "__func__", None) is not random.Random.getstate:
            return None
        buf = (ctypes.c_char * 2500).from_address(id(inst) + object.__basicsize__)
        words = struct.unpack("=i624I", buf.raw)
        state = gs()[1]
        if words[0] != state[-1] or words[1:] != state[:-1]:
            return None
        return lambda: buf.raw
    except Exception:
        return None


class RandomState:
    """The random module's state, compared with the last one cheaply: getstate() (a 625-tuple) only once the
    generator's raw state or gauss_next changed (_random_reader), or every time where that can't be read."""

    def __init__(self):
        self.key = None  # (the module's generator, its getstate, a reader or None)
        self.tok = None

    def maybe(self, r):
        """r.getstate() unless the state is surely the one this last returned (then None)."""
        gs = getattr(r, "getstate", None)
        if gs is None:
            return None
        inst = getattr(r, "_inst", None)
        k = self.key
        if k is None or k[0] is not inst or k[1] is not gs:
            k = self.key = (inst, gs, _random_reader(inst, gs))
            self.tok = None
        if k[2] is not None:
            tok = (k[2](), inst.gauss_next)
            if tok == self.tok:
                return None
            self.tok = tok
        return gs()


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
    return [_time.tzname[0], _time.tzname[1], _time.timezone, _time.altzone, _time.daylight]


# Loggers as neither process changed them: logging.disable() level, and root's (level, propagate, disabled).
LOG_DEFAULT = [0, {"": [30, True, False]}]


def log_levels():
    """[logging.disable() level, {logger name ("" for root): [level, propagate, disabled]}] for the loggers that differ
    from a new one (root always): how the loggers filter records, which both processes keep alike."""
    lg = sys.modules.get("logging")
    if lg is None:
        return LOG_DEFAULT
    root, mgr, cls = lg.root, lg.Logger.manager, lg.Logger
    out = {"": [root.level, root.propagate, root.disabled]}
    for name, x in list(mgr.loggerDict.items()):
        if isinstance(x, cls):
            st = [x.level, x.propagate, x.disabled]
            if st != [0, True, False]:
                out[name] = st
    return [mgr.disable, out]


def log_apply(st):
    """Loggers as the other process has them (log_levels()); False if they can't be."""
    if not (isinstance(st, list) and len(st) == 2 and type(st[0]) is int and isinstance(st[1], dict)):
        raise ProtocolError("bad logging state")
    lg = _std("logging")
    cur = log_levels()
    if st[0] != cur[0]:
        lg.disable(st[0])
    for name in set(cur[1]).union(st[1]):
        want = st[1].get(name, [0, True, False])
        if not (isinstance(want, list) and len(want) == 3 and type(want[0]) is int and type(want[1]) is bool and type(want[2]) is bool):
            raise ProtocolError("bad logging state")
        if cur[1].get(name) != want:
            x = lg.root if name == "" else lg.getLogger(name)
            x.setLevel(want[0])
            x.propagate, x.disabled = want[1], want[2]
    return log_levels() == st


def log_quiet(quiet):
    """{logger name ("" for root): [kind of each handler]} for the loggers with handlers: 0 a NullHandler, 1 or 2 a
    StreamHandler on quiet[0] or quiet[1] (the process's own stdout or stderr), None anything else."""
    lg = sys.modules.get("logging")
    if lg is None:
        return {}
    out = {}
    for name, x in [("", lg.root)] + list(lg.Logger.manager.loggerDict.items()):
        hs = x.handlers if isinstance(x, lg.Logger) else None
        if isinstance(hs, list) and list.__len__(hs):
            out[name] = [0 if type(h) is lg.NullHandler else None if type(h) is not lg.StreamHandler else 1 if h.stream is quiet[0] else 2 if h.stream is quiet[1] else None for h in list(list.__iter__(hs))]
    return out


class _CandidateHandlers(list):
    """A logger's handler list in the tests' process after the candidate's code added handlers or filters to that
    logger in its own: what using it would answer isn't what one process would (the candidate's are elsewhere)."""

    __slots__ = ()


def _refuse_handlers(name):
    def method(self, *args, **kwargs):
        raise Inexact("logging: the candidate's code added handlers or filters to this logger in its own process, which the tests' process doesn't have")

    method.__name__ = name
    return method


for _n in ("__iter__", "__len__", "__getitem__", "__setitem__", "__delitem__", "__contains__", "__bool__", "__eq__", "__ne__", "__reversed__", "__add__", "__iadd__", "__mul__", "__repr__", "append", "remove", "insert", "extend", "pop", "clear", "copy", "index", "count", "sort", "reverse"):
    setattr(_CandidateHandlers, _n, _refuse_handlers(_n))


# Process-wide settings CPython keeps in C, where no module attribute changes for the watchers to see. Mirrored: a
# call to one of these setters on either side is made again in the other process before that one's code runs.
_PROC_MIRROR = (("gc", ("enable", "disable", "set_threshold", "set_debug")), ("sys", ("setswitchinterval", "set_int_max_str_digits")), ("socket", ("setdefaulttimeout",)), ("threading", ("stack_size",)))
# Not mirrored (handlers and trace functions are code; timers, limits and the priority act on the process that set
# them): once one side's code has called a function of a group that changes it, the other side calling any function
# of that group is a grader error.
_PROC_GROUPS = {
    "signal handlers and timers": (("signal", ("signal", "getsignal", "setitimer", "getitimer", "alarm", "siginterrupt", "pthread_sigmask", "set_wakeup_fd")),),
    "resource limits": (("resource", ("setrlimit", "getrlimit", "prlimit")),),
    "the process priority": (("os", ("nice", "setpriority", "getpriority")),),
    "trace and profile functions": (("sys", ("settrace", "setprofile", "gettrace", "getprofile")), ("threading", ("settrace", "setprofile", "gettrace", "getprofile", "settrace_all_threads", "setprofile_all_threads"))),
    "faulthandler": (("faulthandler", ("enable", "disable", "is_enabled", "register", "unregister", "dump_traceback_later", "cancel_dump_traceback_later")),),
}
_PROC_ARGS = (int, float, bool, type(None))


class ProcSettings:
    """Both sides: the settings above, as this side's code changes them and the other side's code did."""

    def __init__(self, end, error):
        self.end = end  # end(why): this process can't take the other's change; the run ends
        self.error = error  # error(why): the exception to raise
        self.calls = []  # mirrored setter calls this side's code made, not sent yet: [module, name, args, kwargs]
        self.mine = set()  # groups this side's code changed
        self.sent = set()
        self.theirs = set()  # groups the other side's code changed
        self.real = {}
        for mod_name, names in _PROC_MIRROR:
            mod = _std(mod_name)
            for name in names:
                f = getattr(mod, name, None) if mod is not None else None
                if f is not None:
                    self.real[(mod_name, name)] = f
                    setattr(mod, name, self._mirrored(mod_name, name, f))
        for group, funcs in _PROC_GROUPS.items():
            for mod_name, names in funcs:
                mod = _std(mod_name)
                for name in names:
                    f = getattr(mod, name, None) if mod is not None else None
                    if f is not None:
                        setattr(mod, name, self._grouped(group, mod_name, name, f))

    def _mirrored(self, mod_name, name, real):
        def guarded(*args, **kwargs):
            r = real(*args, **kwargs)
            if args or kwargs or name != "stack_size":
                if not all(type(a) in _PROC_ARGS for a in args) or not all(type(v) in _PROC_ARGS for v in kwargs.values()):
                    self.end("%s.%s() was called with values the other process can't be given" % (mod_name, name))
                self.calls.append([mod_name, name, list(args), kwargs])
            return r

        guarded.__name__ = guarded.__qualname__ = real.__name__
        guarded.__doc__ = real.__doc__
        return guarded

    def _grouped(self, group, mod_name, name, real):
        reads = name.startswith("get") or name == "is_enabled"

        def guarded(*args, **kwargs):
            if group in self.theirs:
                raise self.error("%s.%s(): the other process's code changed %s, which this process doesn't share" % (mod_name, name, group))
            r = real(*args, **kwargs)
            if not reads and not (name == "nice" and args == (0,)):
                self.mine.add(group)
            return r

        guarded.__name__ = guarded.__qualname__ = real.__name__
        guarded.__doc__ = real.__doc__
        return guarded

    def out(self, st):
        """Put this side's changes since it last sent them into st."""
        if self.calls:
            st["proc"], self.calls = self.calls, []
        new = self.mine - self.sent
        if new:
            st["procdirty"] = sorted(new)
            self.sent |= new

    def apply(self, st):
        """The other side's changes: its mirrored calls made here, in order."""
        for e in st.get("proc") or ():
            if not (isinstance(e, list) and len(e) == 4 and isinstance(e[2], list) and isinstance(e[3], dict) and all(type(a) in _PROC_ARGS for a in e[2]) and all(type(k) is str and type(v) in _PROC_ARGS for k, v in e[3].items())):
                raise ProtocolError("bad process setting")
            f = self.real.get((e[0], e[1])) if type(e[0]) is str and type(e[1]) is str else None
            if f is None:
                raise ProtocolError("bad process setting")
            try:
                f(*e[2], **e[3])
            except Exception as x:
                self.end("%s.%s() as the other process's code called it fails here (%s)" % (e[0], e[1], clip(_safe_str(x), 200)))
        for g in st.get("procdirty") or ():
            if g not in _PROC_GROUPS:
                raise ProtocolError("bad process setting")
            self.theirs.add(g)


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
    return _normpath(_path_join(root, v[1])) if v[0] == "rel" else v[1]


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
    return root if v[1] == "." else _path_join(root, v[1])


def path_compose(own, base, entries, j, e):
    """The candidate's sys.path for the tests' one: entries (mapped) with the candidate's own entries (own, its
    interpreter's path, base, in it) around the interpreter's entries the tests' path has at [j, e): what one process
    started as `python3 -m unittest` in the workspace has. None if own doesn't hold base."""
    n = len(base)
    for k in range(len(own) - n + 1):
        if own[k : k + n] == base:
            return entries[:j] + own[:k] + entries[j:e] + own[k + n :] + entries[e:]
    return None


# The workspace's files: each process has its own copy (the candidate's, and the tests' sealed one), so what the
# candidate's code changes in its copy the tests' copy doesn't have. The candidate's side reports the paths its code
# changed (audit events; "*" once another process or native code could have changed any) and the tests' side raises
# Inexact when the tests look at one of them, or change their own copy.
# Audit event -> ((path argument, its dir_fd argument or None), ...): changes ("open" only with a write flag), looks.
_FS_CHANGE = {
    "open": ((0, None),),
    "os.remove": ((0, 1),),
    "os.rmdir": ((0, 1),),
    "os.mkdir": ((0, 2),),
    "os.mkfifo": ((0, 2),),
    "os.mknod": ((0, 3),),
    "os.rename": ((0, 2), (1, 3)),
    "os.link": ((0, 2), (1, 3)),
    "os.symlink": ((1, 2),),
    "os.chmod": ((0, 2),),
    "os.chown": ((0, 3),),
    "os.utime": ((0, 3),),
    "os.truncate": ((0, None),),
    "os.chflags": ((0, None),),
    "os.setxattr": ((0, None),),
    "os.removexattr": ((0, None),),
    "shutil.rmtree": ((0, 1),),
    "sqlite3.connect": ((0, None),),
}
_FS_LOOK = {"open": ((0, None),), "os.listdir": ((0, None),), "os.scandir": ((0, None),), "os.chdir": ((0, None),), "os.listxattr": ((0, None),), "os.getxattr": ((0, None),), "sqlite3.connect": ((0, None),)}
_FS_EVENTS = frozenset(_FS_CHANGE) | frozenset(_FS_LOOK)
# After these anything in the workspace may have changed: another process, or native code.
_FS_ANY = frozenset(("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "ctypes.dlopen", "ctypes.dlsym", "ctypes.call_function"))
_O_WRITE = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
# What getcwd() returns changes only after these (or _FS_ANY), so it isn't asked every message.
_CWD_EVENTS = frozenset(("os.chdir", "os.rename", "os.rmdir", "shutil.rmtree"))
# Calls on the tests' side that look at files without an audit event (os.path's checks and pathlib go through them).
_FS_CALLS = ("stat", "lstat", "access", "readlink")
_FS_SQLITE = ("-journal", "-wal", "-shm")
_FS_MEMORY = (":memory:", "", b":memory:", b"")  # sqlite3 databases that aren't files
# Where a file operation from these (or the grader) isn't the code under test's: see fs_owner().
_FS_OWNERS = frozenset(("unittest", "importlib", "_frozen_importlib", "_frozen_importlib_external", "zipimport"))
# Types whose sys.getsizeof() follows from the value alone, so a copy that crossed reports the original's.
_SIZED = frozenset((tuple, int, bool, float, complex, bytes, type(None)))


def fd_path(fd):
    """The path an open file descriptor names, or None."""
    try:
        if sys.platform == "darwin":
            import fcntl

            return os.fsdecode(fcntl.fcntl(fd, 50, bytes(1024)).split(b"\0", 1)[0]) or None  # F_GETPATH
        return os.readlink("/proc/self/fd/%d" % fd)
    except Exception:
        return None


def fs_where(p, dir_fd):
    """The absolute, normalized path an audit event's (or os call's) path argument names, relative to dir_fd where
    that's set (>= 0); None where it can't be told, False for a descriptor that isn't a file or directory (a pipe,
    a socket)."""
    if p is None:
        p = "."
    elif type(p) is int:
        try:
            if os.fstat(p).st_mode & 0o170000 not in (0o100000, 0o040000):
                return False
        except (OSError, ValueError, OverflowError):
            return False
        p = fd_path(p)
        if p is None or not _isabs(p):
            return None
    elif type(p) is not str:
        try:
            p = os.fsdecode(os.fspath(p))
        except Exception:
            return None
    if not _isabs(p):
        if type(dir_fd) is int and dir_fd >= 0:
            base = fd_path(dir_fd)
        else:
            try:
                base = _getcwd()
            except OSError:
                base = None
        if base is None:
            return None
        p = _path_join(base, p)
    return _normpath(p)


def fs_rel(path, roots):
    """path ("/"-separated, "." for the root) relative to the first of roots (normalized) that holds it, else None."""
    for r in roots:
        if path == r:
            return "."
        if path.startswith(r) and path[len(r) : len(r) + 1] == os.sep:
            return path[len(r) + 1 :].replace(os.sep, "/")
    return None


def fs_hit(rel, changed, inside=True):
    """Whether looking at rel can see a change at one of the changed paths: the same path, one holding it, or (with
    inside: a directory's listing or times) one inside it."""
    for c in changed:
        if c == rel or c == "." or rel.startswith(c + "/") or (inside and (rel == "." or c.startswith(rel + "/"))):
            return True
    return False


def fs_roots(root):
    """A workspace copy's root as file operations may name it: as given and with symlinks resolved."""
    return tuple(dict.fromkeys((_normpath(root), _normpath(os.path.realpath(root)))))


def fs_owner(f, own):
    """Whether the file operation frame f made is the code under test's: past standard-library frames, the first
    frame isn't the grader's (own: its module globals; or __main__), unittest's or the import system's."""
    while f is not None:
        g = f.f_globals
        if g is own:
            return False
        name = g.get("__name__")
        if type(name) is str:
            if name == "__main__" or name.partition(".")[0] in _FS_OWNERS:
                return False
            if not std_module(name):
                return True
        f = f.f_back
    return False


_INF = float("inf")
_NINF = float("-inf")
_FLOATS = ("nan", "inf", "-inf")
_BIG = 1 << BIG_INT_BITS
# Value keys: sweep every key once the table has grown to this, then at twice what survives.
VALUE_SWEEP = 4096


def _interned_check():
    """Whether a str is interned (a string another process interns arrives interned, so `x is "lit"` answers as in
    one process): sys._is_interned (3.13+), else the CPython 3.12 object header read through ctypes, checked here
    first; else every string counts as not interned."""
    f = getattr(sys, "_is_interned", None)
    if f is not None:
        return f
    try:
        import ctypes

        off = 4 * ctypes.sizeof(ctypes.c_ssize_t)  # ob_refcnt, ob_type, length, hash; then the state bits
        state = ctypes.c_uint32.from_address

        def check(s):
            return state(id(s) + off).value & 3 != 0

        if check(sys.intern("terrarium_interned_probe")) and not check("".join(["terrarium", "_not_interned"])):
            return check
    except Exception:
        pass
    return lambda s: False


_interned = _interned_check()


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


class Args(tuple):
    """A call's arguments (or keyword items): crosses as a plain tuple, without a key (no code sees this tuple)."""

    __slots__ = ()


class Encoder:
    """Encodes the values of one message. side._special(enc, v, depth, key) sees every non-scalar first and may
    return its own tag (links, references); plain data goes by value; built-ins by name; anything else through
    side._objref(enc, v, depth, key). key: v is (part of) a dict key or set element.

    A by-value object keeps its identity across messages: the first time it crosses it gets a key (a JSON list
    [key, value] for a str, int or float, a "k" field on a tag), after that it crosses as [key], and the other side
    answers with its own copy. Each side keeps its keyed objects while its code or the other side's may still hold
    them (Side._vsweep). Objects every process shares need none (small ints, '' and one-character latin-1 strings,
    ()); nor do numbers in a container's contents (bulk), which would cost a key each for large lists. A tuple,
    frozenset or namedtuple holding anything but plain data gets none either: keeping it would keep the objects in it
    alive after the tests (or candidate) let go of them."""

    def __init__(self, side, names):
        self.side = side
        self.names = names
        self.memo = {}  # id -> alias number (exceptions)
        self.busy = set()  # ids being encoded: a tuple inside itself (through a list) can't cross
        self.keep = []  # holds everything in memo, so ids stay theirs for the whole message
        self.nans = {}  # id -> number: one NaN object met twice arrives as one object
        self.bulk = False  # encoding a container's contents
        self.vmade = []  # value keys this message made (forgotten if it isn't sent)
        self.refs = 0  # references (not plain data) encoded so far

    def enc(self, v, depth=0, key=False):
        t = type(v)
        if v is None or t is bool:
            return v
        if t is str:
            if len(v) < 2 and v < "Ā":
                return v
            k = self.side.vkey.get(id(v))
            if k is not None:
                return [k]
            k = self.new_key(v)
            return [k, v, 1] if _interned(v) else [k, v]
        if t is int:
            if -6 < v < 257 or (self.bulk and -_BIG < v < _BIG):
                return v
            if self.bulk:
                return {"t": "int", "v": format(v, "x")}
            k = self.side.vkey.get(id(v))
            if k is not None:
                return [k]
            return [self.new_key(v), v] if -_BIG < v < _BIG else {"t": "int", "v": format(v, "x"), "k": self.new_key(v)}
        if t is float:
            if not self.bulk:
                k = self.side.vkey.get(id(v))
                if k is not None:
                    return [k]
            if v != v:
                self.keep.append(v)
                tag = {"t": "float", "v": "nan", "n": self.nans.setdefault(id(v), len(self.nans))}
            elif v in (_INF, _NINF):
                tag = {"t": "float", "v": repr(v)}
            else:
                return v if self.bulk else [self.new_key(v), v]
            if not self.bulk:
                tag["k"] = self.new_key(v)
            return tag
        if depth > MAX_DEPTH:
            raise Unsendable("value nested too deeply")
        d = depth + 1
        if t is Args:
            return {"t": "tuple", "v": [self.enc(x, d) for x in tuple.__iter__(v)]}
        r = self.side._special(self, v, depth, key)
        if r is not None:
            if type(r) is dict and r["t"] not in _VALUE_TAGS:
                self.refs += 1
            return r
        if t is tuple or t is frozenset:
            if t is tuple and not v:
                return {"t": "tuple", "v": []}
            return self.keyed(v, lambda: {"t": "tuple" if t is tuple else "frozenset", "v": [self.enc(x, d, key or t is frozenset) for x in v]})
        if t is bytes:
            return self.keyed(v, lambda: {"t": "bytes", "v": base64.b64encode(v).decode("ascii")})
        if t is complex:
            return self.keyed(v, lambda: {"t": "complex", "v": [self.enc(v.real, d), self.enc(v.imag, d)]})
        if t is decimal.Decimal:
            return self.keyed(v, lambda: {"t": "decimal", "v": str(v)})
        if t is fractions.Fraction:
            return self.keyed(v, lambda: {"t": "fraction", "v": [self.enc(v.numerator, d), self.enc(v.denominator, d)]})
        if t is datetime.datetime or t is datetime.time:
            tz = v.tzinfo
            spec = None if tz is None else _tz(tz)
            if tz is None or spec is not None:
                tag = {"t": t.__name__, "v": v.replace(tzinfo=None).isoformat(), "fold": v.fold}
                if spec is not None:
                    tag["tz"] = spec
                return self.keyed(v, lambda: tag)
        if t is datetime.date:
            return self.keyed(v, lambda: {"t": "date", "v": v.isoformat()})
        if t is datetime.timedelta:
            return self.keyed(v, lambda: {"t": "timedelta", "v": [v.days, v.seconds, v.microseconds]})
        if t is datetime.timezone:
            return self.keyed(v, lambda: {"t": "timezone", "v": _tz(v)})
        if t is slice:
            return self.keyed(v, lambda: {"t": "slice", "v": [self.enc(x, d) for x in (v.start, v.stop, v.step)]})
        if t is range:
            return self.keyed(v, lambda: {"t": "range", "v": [self.enc(x, d) for x in (v.start, v.stop, v.step)]})
        n = self.names.get(id(v))
        if n is not None:
            return {"t": "builtin", "v": n}
        self.refs += 1
        return self.side._objref(self, v, depth, key)

    def new_key(self, v):
        side = self.side
        k = side.next_v
        side.next_v += side.sign
        side.vkey[id(v)] = k
        side.vobj[k] = v
        side.vnew.append(k)
        self.vmade.append(k)
        return k

    def keyed(self, v, build):
        """build()'s tag for by-value object v with its new key (if it holds only plain data), or [key] if v crossed
        before. One without a key met again in this message is an alias to it (it arrives as one object)."""
        k = self.side.vkey.get(id(v))
        if k is not None:
            return [k]
        a = self.memo.get(id(v))
        if a is not None:
            return {"t": "alias", "id": a}
        if id(v) in self.busy:
            raise Unsendable("a %s that contains itself can't be sent" % type(v).__name__)
        self.busy.add(id(v))
        refs = self.refs
        try:
            tag = build()
        finally:
            self.busy.discard(id(v))
        if self.refs == refs:
            tag["k"] = self.new_key(v)
        else:
            a = len(self.keep)
            self.keep.append(v)
            self.memo[id(v)] = a
            tag["a"] = a
        return tag

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


# Tags _special() gives for plain data (no reference to an object a side must keep alive).
_VALUE_TAGS = frozenset(("ntuple", "senum"))


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
        side.decoded += 1
        self.serial = side.decoded  # this message's number among the ones this side read

    def dec(self, x, depth=0):
        if x is None or isinstance(x, (bool, int, float, str)):
            return x
        if type(x) is list:
            return self.side._vin(x)
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
                return self.register(x, base64.b64decode(v, validate=True))
            if t == "int":
                if not isinstance(v, str) or len(v) > MAX_MSG:
                    raise ProtocolError("bad int")
                return self.register(x, int(v, 16))
            if t == "float":
                if v not in _FLOATS:
                    raise ProtocolError("bad float")
                n = x.get("n")
                if v != "nan" or type(n) is not int:
                    return self.register(x, float(v))
                # Separately computed NaNs are separate objects; one sent twice in a message stays one.
                if n not in self.nans:
                    self.nans[n] = float(v)
                return self.register(x, self.nans[n])
            if t == "complex":
                return self.register(x, complex(self.number(v[0], d), self.number(v[1], d)))
            if t == "decimal":
                return self.register(x, decimal.Decimal(str(v)))
            if t == "fraction":
                return self.register(x, fractions.Fraction(self.number(v[0], d), self.number(v[1], d)))
            if t in ("datetime", "time"):
                out = getattr(datetime, t).fromisoformat(str(v))
                if "tz" in x:
                    out = out.replace(tzinfo=_untz(x["tz"]))
                return self.register(x, out.replace(fold=1) if x.get("fold") == 1 else out)
            if t == "date":
                return self.register(x, datetime.date.fromisoformat(str(v)))
            if t == "timedelta":
                return self.register(x, datetime.timedelta(days=int(v[0]), seconds=int(v[1]), microseconds=int(v[2])))
            if t == "timezone":
                return self.register(x, _untz(v))
            if t == "slice":
                return self.register(x, slice(self.dec(v[0], d), self.dec(v[1], d), self.dec(v[2], d)))
            if t == "range":
                return self.register(x, range(self.number(v[0], d), self.number(v[1], d), self.number(v[2], d)))
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
        k = x.get("k")
        if k is not None:
            self.side._vput(k, obj)
        elif self.side.unkeyed is not None:
            # NaNs keep their identity within a message (one object sent twice arrives as one).
            self.side.unkeyed[id(obj)] = self.serial if type(obj) is float and obj != obj else 0
        return obj




# ---------- links (both sides) ----------

_INTS = frozenset((int,))
_STRS = frozenset((str,))
_RAW = frozenset((int, str, float, bool, type(None)))
_FUNCTION, _GENERATOR = types.FunctionType, types.GeneratorType


def _raw_items(items):
    """items as plain JSON values when that is exact and cheap to tell (all ints in JSON's range, or all strings every
    process shares: '' and one latin-1 character), else None."""
    ts = set(map(type, items))
    if ts <= _STRS:
        return list(items) if not items or (max(map(len, items)) < 2 and max(items) < "\u0100") else None
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
        # By-value objects that crossed (Encoder): key -> object, id -> key. Keys are numbered like links.
        self.vobj = {}
        self.vkey = {}
        self.next_v = sign
        self.vnew = []  # keys made or received since this side last sent
        self.vlast = []  # keys made or received before that: measured at this send
        self.vdrops = []  # keys this side forgot, for the other side to forget too
        self.vsweep_at = VALUE_SWEEP
        self.unkeyed = None  # the tests' side: id -> message number (NaNs; else 0) of by-value objects without a key
        self.decoded = 0
        # The candidate's side: functions and generators in links' snapshots (Server._fn_cold), by id.
        self.fn_track = False
        self.fn_in = {}  # n -> ids of the functions and generators its snapshot holds
        self.fn_where = {}  # id -> {n: how many times link n's snapshot holds it}
        self.vobj[0] = float("nan")
        self.vfree = self._vrefs(0)
        del self.vobj[0]

    def _refs(self, n):
        obj = self.links[n]
        return _getrefcount(obj)

    def _vrefs(self, k):
        obj = self.vobj.get(k)
        return 0 if obj is None else _getrefcount(obj)

    def _vin(self, x):
        """A keyed value from the other side: [key] (one that crossed before) or [key, value] / [key, str, 1]
        (interned) for a str, int or float crossing the first time."""
        n = len(x)
        k = x[0] if n else None
        if type(k) is not int:
            raise ProtocolError("bad value key")
        if n == 1:
            obj = self.vobj.get(k)
            if obj is None:
                raise ProtocolError("unknown value key")
            return obj
        obj = x[1] if n in (2, 3) else None
        t = type(obj)
        if t is not str and t is not int and t is not float:
            raise ProtocolError("bad keyed value")
        if n == 3:
            if x[2] != 1 or t is not str:
                raise ProtocolError("bad keyed value")
            obj = _intern(obj)
        self._vput(k, obj)
        return obj

    def _vput(self, k, obj):
        """Register the other side's key k for obj, this side's copy of its object."""
        if type(k) is not int or k * self.sign >= 0 or k in self.vobj:
            raise ProtocolError("bad value key")
        self.vobj[k] = obj
        self.vkey.setdefault(id(obj), k)
        self.vnew.append(k)

    def _vforget(self, k):
        obj = self.vobj.pop(k, None)
        if obj is not None and self.vkey.get(id(obj)) == k:
            del self.vkey[id(obj)]

    def _vsweep(self):
        """Forget keyed objects this side's code no longer holds (the table's is the only reference): this side can't
        compare them with anything again, so the other side may forget its copy's key too, whoever holds that. Keys
        are measured one send after they appear (most are a call's arguments or result, gone by then); all of them
        once the table doubles."""
        full = len(self.vobj) >= self.vsweep_at
        todo = list(self.vobj) if full else self.vlast
        self.vlast, self.vnew = [] if full else self.vnew, []
        free, refs, drops = self.vfree, self._vrefs, self.vdrops
        for k in todo:
            if refs(k) == free:
                self._vforget(k)
                drops.append(k)
        if full:
            self.vsweep_at = max(VALUE_SWEEP, 2 * len(self.vobj))

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
            if n in self.fn_in:
                self._fn_reached(n)

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
        if n in self.fn_in:
            self._fn_unsnap(n)
        items = elements(snap, base)
        if items and not _RAW.issuperset(set(map(type, items))):
            get, links = self.link_of.get, self.links
            kids = []
            fns = [] if self.fn_track else None
            for x in items:
                t = type(x)
                if t not in _RAW:
                    if fns is not None and (t is _FUNCTION or t is _GENERATOR):
                        fns.append(id(x))
                        continue
                    k = get(id(x))
                    if k is not None and links.get(k) is x:
                        kids.append(k)
            if kids:
                self.kids[n] = kids
                for k in kids:
                    self._parent(k, n, 1)
            if fns:
                self.fn_in[n] = fns
                where = self.fn_where
                for i in fns:
                    w = where.get(i)
                    if w is None:
                        where[i] = {n: 1}
                    else:
                        w[n] = w.get(n, 0) + 1

    def _fn_unsnap(self, n):
        for i in self.fn_in.pop(n):
            w = self.fn_where.get(i)
            if w is not None:
                c = w.get(n, 0) - 1
                if c > 0:
                    w[n] = c
                else:
                    w.pop(n, None)
                    if not w:
                        del self.fn_where[i]

    def _fn_reached(self, n):
        """This side's code can reach link n again (Server: its functions may change)."""

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
        if n in self.fn_in:
            self._fn_unsnap(n)
        for s in (self.held, self.touched, self.other, self.reported, self.to_report):
            s.discard(n)
        if obj is not None and self.link_of.get(id(obj)) == n:
            del self.link_of[id(obj)]
        return obj

    def _contents(self, enc, obj, base, depth):
        """The tag carrying container obj's own contents, read through base (numbers in it unkeyed: Encoder)."""
        bulk, enc.bulk = enc.bulk, True
        try:
            return self._contents_bulk(enc, obj, base, depth)
        finally:
            enc.bulk = bulk

    def _contents_bulk(self, enc, obj, base, depth):
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
        self._vsweep()
        if self.vdrops:
            msg["vdrop"], self.vdrops = self.vdrops, []
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
        for key in ("held", "loose", "unlink", "vdrop"):
            v = msg.get(key)
            if v is not None and not (isinstance(v, list) and all(type(n) is int for n in v)):
                raise ProtocolError("bad %s list" % key)
        for k in msg.get("vdrop") or ():
            self._vforget(k)
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


def std_module_name(v):
    """The name of a standard-library module object as sys.modules has it (sent by name: each process's own), else None."""
    if type(v) is not types.ModuleType:
        return None
    name = vars(v).get("__name__")
    if isinstance(name, str) and std_module(name) and sys.modules.get(name) is v:
        return name
    return None


def import_std(name):
    """A standard-library module by name, imported if need be; None if it isn't one or can't be imported here."""
    m = sys.modules.get(name)
    if m is None and std_module(name) and name.partition(".")[0] not in _NO_IMPORT:
        try:
            __import__(name)
        except Exception:
            return None
        m = sys.modules.get(name)
    return m if isinstance(m, types.ModuleType) else None


# Standard-library attributes that aren't raw assignments for StdWatch: process state mirrored on its own
# (Client._state, Server._cst) or the interpreter's.
_STD_OWN = {
    "sys": frozenset(("stdout", "stderr", "stdin", "argv", "path", "last_type", "last_value", "last_traceback", "last_exc", "ps1", "ps2")),
    "builtins": frozenset(("print", "input", "_")),
    "time": frozenset(("tzname", "timezone", "altzone", "daylight")),
    "warnings": frozenset(("filters", "showwarning", "_showwarnmsg_impl", "_filters_version")),
}
# ... and those the other process can't be given (its import system's own).
_STD_UNSHARED = {"sys": frozenset(("modules", "meta_path", "path_hooks", "path_importer_cache"))}
# The import system: its binding of modules and their names isn't a change anyone made.
_IMPORTING = frozenset(("importlib", "importlib._bootstrap", "importlib._bootstrap_external", "_frozen_importlib", "_frozen_importlib_external", "importlib.util"))
# A class's own caches (abc's).
_CLASS_CACHES = frozenset(("__abstractmethods__", "_abc_impl", "_abc_registry", "_abc_cache", "_abc_negative_cache", "_abc_negative_cache_version"))
_IMMUTABLE_TYPE = 1 << 8
_LAZY_IMPORT = getattr(types, "LazyImportType", _NO)


class _Quiet:
    """The grader's own changes to the standard library, not reported by watch (a StdWatch or None)."""

    def __init__(self, watch):
        self.watch = watch

    def __enter__(self):
        if self.watch is not None:
            self.watch.flush()
            self.watch.quiet += 1

    def __exit__(self, *exc):
        if self.watch is not None:
            self.watch.flush()
            self.watch.quiet -= 1


def std_watch_available():
    return sys.version_info >= (3, 12) and sys.implementation.name == "cpython"


class StdWatch:
    """Raw changes to standard-library module and class attributes (`time.sleep = fake`, a mock.patch of one), seen
    through CPython's dict and type watchers (3.12+; elsewhere `ok` stays False and nothing is seen). Not reported:
    a module's own code changing its globals or its classes (its caches, and its setters), the import system's
    bindings, submodules, dunder names of modules, abc's caches, and _STD_OWN; nor anything while `quiet`.

    changed(where, path, name, old) is called for each change: where is the module's dict or the class, path
    "module:" or the class's type_path, old the value before the change (_NO: none). A standard-library module
    replaced or removed in sys.modules outside the import system calls changed(None, name, None, old). A class's
    changes are found by comparing its namespace with a copy: at its watcher's event where that comes after the
    change (3.12), else at the next event or flush(). If a watcher callback fails, `broken` is set: what the
    tests and the candidate see may differ from then on. other(name, deleted), if given, is called for any other
    module removed (or replaced) in sys.modules outside the import system."""

    def __init__(self, changed, other=None):
        self.changed = changed
        self.other = other
        self.quiet = 0
        self.ok = False
        self.broken = None
        self.mods = {}  # id(module dict) -> (dict, module name)
        self.types = {}  # id(class) -> [class, path, module dict, copy of its namespace]
        self.pending = {}  # id(class) -> counted, for watchers called before the change
        self._probe = None
        if not std_watch_available():
            return
        try:
            import ctypes

            api = ctypes.pythonapi
            dict_cb = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
            type_cb = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)
            api.PyDict_AddWatcher.argtypes, api.PyDict_AddWatcher.restype = [dict_cb], ctypes.c_int
            api.PyType_AddWatcher.argtypes, api.PyType_AddWatcher.restype = [type_cb], ctypes.c_int
            for f in (api.PyDict_Watch, api.PyType_Watch):
                f.argtypes, f.restype = [ctypes.c_int, ctypes.py_object], ctypes.c_int
            for f in (api.PyDict_ClearWatcher, api.PyType_ClearWatcher):
                f.argtypes, f.restype = [ctypes.c_int], ctypes.c_int
        except (ImportError, AttributeError):
            return
        cast, obj = ctypes.cast, ctypes.py_object
        self._obj = lambda p: cast(p, obj).value

        def on_dict(ev, d, k, v):
            if ev <= 2 and self.broken is None:
                try:
                    self._dict_event(ev, d, k, v, _getframe(1))
                except BaseException as e:  # noqa: B036 - nothing may be raised into the interpreter here
                    self.broken = "%s: %s" % (type(e).__name__, clip(_safe_str(e), 200))
            return 0

        def on_type(t):
            if self.broken is None:
                try:
                    self._type_event(t, _getframe(1))
                except BaseException as e:  # noqa: B036
                    self.broken = "%s: %s" % (type(e).__name__, clip(_safe_str(e), 200))
            return 0

        self._cbs = (dict_cb(on_dict), type_cb(on_type))  # kept alive as long as the watchers
        self._dw = api.PyDict_AddWatcher(self._cbs[0])
        self._tw = api.PyType_AddWatcher(self._cbs[1])
        self._watch_dict = lambda d: api.PyDict_Watch(self._dw, d)
        self._watch_type = lambda t: api.PyType_Watch(self._tw, t)

        def clear():
            # Before the interpreter tears down: a watcher called during teardown would crash it.
            api.PyDict_ClearWatcher(self._dw)
            api.PyType_ClearWatcher(self._tw)

        _std("atexit").register(clear)
        # Where the type watcher runs relative to the change (after it on 3.12).
        probe = type("probe", (), {})
        seen = []
        self._probe = lambda t: seen.append("x" in _DICT(probe))
        self._watch_type(probe)
        probe.x = 1
        self._probe = None
        self.after = seen == [True]
        self.sysmods = id(sys.modules)
        self._watch_dict(sys.modules)
        for name, m in list(sys.modules.items()):
            if std_module(name) and isinstance(m, types.ModuleType):
                self._watch_module(name, m)
        self.ok = True

    def _watch_module(self, name, m):
        d = vars(m)
        if id(d) in self.mods:
            return
        self.mods[id(d)] = (d, name)
        self._watch_dict(d)
        for key, v in list(d.items()):
            if issubclass(type(v), type):
                self._watch_class(name, d, key, v)

    def _watch_class(self, name, d, key, cls):
        """A class defined at the top of a standard-library module, as it's bound there (its path resolves to it)."""
        if id(cls) in self.types or type.__dict__["__flags__"].__get__(cls) & _IMMUTABLE_TYPE:
            return
        get = type.__dict__
        if get["__module__"].__get__(cls) != name or get["__qualname__"].__get__(cls) != key:
            return
        self.types[id(cls)] = [cls, "%s:%s" % (name, key), d, dict(_DICT(cls))]
        self._watch_type(cls)

    def _counted(self, f, own):
        """Whether code in frame f changing something of module dict own is someone else's: not the module's own
        code, the import system's, or a standard-library module's setting itself up (enum's _convert_ adds signal's
        names); the first frame out of the standard library decides."""
        if self.quiet or f is None or f.f_globals is own:
            return False
        while f is not None:
            g = f.f_globals
            name = g.get("__name__")
            if name in _IMPORTING:
                return False
            if not std_module(name):
                return True
            if getattr(g.get("__spec__"), "_initializing", False) is True:
                return False
            f = f.f_back
        return True

    def _dict_event(self, ev, dp, kp, vp, f):
        key = self._obj(kp)
        new = self._obj(vp) if vp else _NO
        if dp == self.sysmods:
            if not isinstance(key, str):
                return
            if not std_module(key):
                if ev != 0 and self.other is not None and new is not sys.modules.get(key, _NO) and self._counted(f, None):
                    self.other(key, ev == 2)
                return
            if issubclass(type(new), types.ModuleType):
                self._watch_module(key, new)
            old = sys.modules.get(key, _NO)
            if ev != 0 and new is not old and self._counted(f, None):
                self.changed(None, key, None, old)
            return
        hit = self.mods.get(dp)
        if hit is None or not isinstance(key, str):
            return
        d, name = hit
        # By their types alone: an isinstance() check would read a test object's __class__.
        if ev != 2 and issubclass(type(new), type):
            self._watch_class(name, d, key, new)
        if key[:2] == "__" == key[-2:] or key in _STD_OWN.get(name, ()):
            return
        old = d.get(key, _NO)
        if issubclass(type(new), types.ModuleType) or issubclass(type(old), types.ModuleType) or new is old or type(old) is _LAZY_IMPORT:
            return  # a submodule, or a lazy import (3.15) taking its value
        if self._counted(f, d):
            self.changed(d, name + ":", key, old)

    def _type_event(self, tp, f):
        if self._probe is not None:
            return self._probe(tp)
        rec = self.types.get(tp)
        if rec is None:
            return
        counted = self._counted(f, rec[2])
        if self.after:
            self._diff(rec, counted)
        else:
            self.flush()
            self.pending[tp] = counted or self.pending.get(tp, False)

    def _diff(self, rec, counted):
        cls, path, own, snap = rec
        cur = _DICT(cls)
        for key in set(snap).union(cur):
            old, new = snap.get(key, _NO), cur.get(key, _NO)
            if old is new or key in _CLASS_CACHES:
                continue
            if new is _NO:
                del snap[key]
            else:
                snap[key] = new
            if counted:
                self.changed(cls, path, key, old)

    def flush(self):
        """Report the class changes still waiting on their watcher's next event."""
        while self.pending:
            tp, counted = self.pending.popitem()
            rec = self.types.get(tp)
            if rec is not None:
                self._diff(rec, counted)



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
            return c.call("call", [self, Args(args), Args(map(Args, kwargs.items()))])

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

    f = _getframe(1)
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
    return info[0].call("call", [cls, Args(args), Args(map(Args, kwargs.items()))])


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


_CO_VARARGS, _CO_VARKEYWORDS, _CO_GENERATOR, _CO_COROUTINE, _CO_ASYNC_GENERATOR = 0x04, 0x08, 0x20, 0x80, 0x200
# Readers of a stand-in function's or generator's code object that see only what is the candidate's in it (the
# signature, flags, file and first line): inspect's signature, source and kind checks.
_CODE_READERS = frozenset(("_signature_from_function", "_has_code_flag", "getfile", "findsource", "_signature_is_functionlike", "getgeneratorstate"))
_CODE_ATTRS = frozenset(("__code__", "gi_code", "gi_frame"))
# A candidate function's attributes its stand-in copies, kept the same both ways (fn_changes): what either side's code
# sets on its function reaches the other's before that runs. On 3.14+ __annotate__ (reading __annotations__ there would
# evaluate them; setting __annotations__ sets __annotate__ to None). The tests can't set a stand-in's __defaults__,
# __kwdefaults__ or __code__ (code_guard); the candidate's side watches its function's __code__ too.
_FN_ANN = ("__annotate__",) if sys.version_info >= (3, 14) else ()
_FN_TP = ("__type_params__",) if sys.version_info >= (3, 12) else ()
_FN_TESTS = ("__name__", "__qualname__", "__module__", "__doc__") + _FN_ANN + _FN_TP
# Its own dicts (its attributes; before 3.14 its annotations) aren't links, which both sides would compare every message
# for every function the tests hold: their contents are compared with its other attributes (fn_dict_changes).
_FN_DICTS = ("__dict__",) if sys.version_info >= (3, 14) else ("__dict__", "__annotations__")
_FN_CAND = _FN_TESTS + ("__defaults__", "__kwdefaults__", "__code__")
_GEN_SYNC = ("__name__", "__qualname__")
_FN_DESC_KEY = {"__name__": "name", "__qualname__": "qual", "__module__": "mod", "__doc__": "doc", "__defaults__": "defaults", "__kwdefaults__": "kwdefaults", "__annotations__": "ann", "__type_params__": "tp"}
_FN_GET = {names: attrgetter(*names) for names in (_FN_TESTS, _FN_CAND, _GEN_SYNC)}


def fn_changes(who, obj, names, snap):
    """[(name, value)] for each attribute of obj (a function or generator: a stand-in, or the candidate's own) in
    names that is no longer the one in snap, and their values now; a change the other side can't take is Inexact."""
    cur = _FN_GET[names](obj)
    if not any(map(is_not, cur, snap)):
        return None, snap
    out = []
    for name, a, b in zip(names, cur, snap):
        if a is b:
            continue
        if name == "__annotate__":
            if a is not None:
                raise Inexact("%s replaced __annotate__ of a function the other process has a copy of" % who)
            out.append(("__annotations__", obj.__annotations__))
        elif name == "__code__":
            raise Inexact("%s replaced __code__ of a function the other process has a copy of" % who)
        else:
            out.append((name, a))
    return out, cur


def fn_dicts(f):
    """Function f's own dicts (_FN_DICTS) as they are now: (the dict, its keys, its values) each."""
    return tuple((d, list(dict.__iter__(d)), list(dict.values(d))) for d in [getattr(f, name) for name in _FN_DICTS])


def fn_dicts_same(dicts, snap):
    """Whether dicts (a function's own, in _FN_DICTS order) are the ones in snap, holding the same items."""
    for d, (d0, keys, vals) in zip(dicts, snap):
        if d is not d0 or dict.__len__(d) != len(keys) or keys and (any(map(is_not, dict.__iter__(d), keys)) or any(map(is_not, dict.values(d), vals))):
            return False
    return True


def fn_dict_changes(who, enc, dicts, snap):
    """[name, [replaced, items]] (encoded) for each of a function's own dicts that is another dict, or holds other items,
    than in snap; and the snapshot now (snap if none)."""
    if fn_dicts_same(dicts, snap):
        return None, snap
    out = []
    for name, d, (d0, keys, vals) in zip(_FN_DICTS, dicts, snap):
        if type(d) is not dict:
            raise Inexact("%s set %s of a function the other process has a copy of to a %s" % (who, name, type(d).__name__))
        out.append([name, [int(d is not d0), [[enc.enc(k, 1, True), enc.enc(x, 1)] for k, x in list(dict.items(d))]]])
    return out, tuple((d, list(dict.__iter__(d)), list(dict.values(d))) for d in dicts)


def fn_dict_in(f, name, value):
    """The other side's change to f's own dict (fn_dict_changes): a new dict, or new contents in the same one."""
    if value[0]:
        setattr(f, name, dict(value[1]))
    else:
        d = getattr(f, name)
        dict.clear(d)
        dict.update(d, value[1])


def _dict_items_in(dec, raw):
    if not (isinstance(raw, list) and all(isinstance(e, list) and len(e) == 2 for e in raw)):
        raise ProtocolError("bad function attributes")
    return [(dec.dec(k, 1), dec.dec(x, 1)) for k, x in raw]


def fn_change_in(dec, raw):
    """Decoded (rid, name, value) changes to functions or generators (fn_changes), in the order they were encoded."""
    if not isinstance(raw, list):
        raise ProtocolError("bad function attributes")
    out = []
    for e in raw:
        if not (isinstance(e, list) and len(e) == 3 and type(e[0]) is int and (e[1] in _FN_DESC_KEY or e[1] in _FN_DICTS or e[1] in ("close", "start"))):
            raise ProtocolError("bad function attributes")
        if e[1] in _FN_DICTS:
            v = e[2]
            if not (isinstance(v, list) and len(v) == 2 and v[0] in (0, 1)):
                raise ProtocolError("bad function attributes")
            out.append((e[0], e[1], (v[0], _dict_items_in(dec, v[1]))))
        else:
            out.append((e[0], e[1], None if e[1] in ("close", "start") else dec.dec(e[2])))
    return out


_FWD_MAKERS = {}  # source -> its compiled maker: one compile per signature shape


def _make_forwarder(p, desc):
    """A real function standing for candidate function p (its proxy): its signature, names, defaults, attributes
    and kind (generator, coroutine) are the candidate function's; calling it calls that one. Its globals are this
    module's, so its frames are the grader's (the frame guard keeps them from the tests)."""
    names, argc, posonly, kwonly, flags = desc["vars"], desc["argc"], desc["posonly"], desc["kwonly"], desc["flags"]
    defaults, kwdefaults = desc["defaults"], desc["kwdefaults"]
    if any(not n.isidentifier() or keyword.iskeyword(n) or n.startswith("_terrarium") for n in names):
        raise Inexact("the candidate function %s has a parameter the grader can't reproduce" % clip(desc["qual"], 100))
    nd = len(defaults or ())
    pos, kw, rest = names[:argc], names[argc : argc + kwonly], names[argc + kwonly :]
    params, call = [], []
    for j, n in enumerate(pos):
        params.append(n + ("=None" if j >= argc - nd else ""))
        call.append(n)
        if j == posonly - 1:
            params.append("/")
    k = 0
    if flags & _CO_VARARGS:
        params.append("*" + rest[k])
        call.append("*" + rest[k])
        k += 1
    elif kw:
        params.append("*")
    for n in kw:
        params.append(n + ("=None" if kwdefaults is not None and n in kwdefaults else ""))
        call.append("%s=%s" % (n, n))
    if flags & _CO_VARKEYWORDS:
        params.append("**" + rest[k])
        call.append("**" + rest[k])
    args = ", ".join(call)
    if flags & _CO_ASYNC_GENERATOR:
        # Its asend()/athrow() can't be passed on through a stand-in: using one is a grader error.
        head, body = "async def", "raise Inexact('the candidate\\'s async generators can\\'t be used from the tests\\' process')\n  yield"
    elif flags & _CO_COROUTINE:
        # The candidate's coroutine is made at the first step (one process makes it at the call, running none of its
        # code) and run by the candidate's process one step at a time for the tests' event loop.
        head, body = "async def", "return await _await_candidate(_terrarium_p(%s))" % args
    elif flags & _CO_GENERATOR:
        # Calling it returns the stand-in for the candidate's generator at once (one process creates the generator at
        # the call, running none of its code); its code is flagged a generator's for inspect, as the candidate's is.
        head, body = "def", "return _terrarium_p(%s)" % args
    else:
        head, body = "def", "return _terrarium_p(%s)" % args
    src = "def _terrarium_make(_terrarium_p):\n %s _terrarium_f(%s):\n  %s\n return _terrarium_f\n" % (head, ", ".join(params), body)
    make = _FWD_MAKERS.get(src)
    if make is None:
        ns = {}
        exec(compile(src, "<terrarium>", "exec"), globals(), ns)
        make = _FWD_MAKERS[src] = ns["_terrarium_make"]
    f = make(p)
    co = f.__code__
    kw = {"co_name": desc["co"], "co_filename": desc["file"], "co_firstlineno": desc["line"]}
    if hasattr(co, "co_qualname"):
        kw["co_qualname"] = desc["coq"]
    if flags & _CO_GENERATOR:
        # A new function rather than __code__ assignment, which 3.15 warns about when the kind differs.
        kw["co_flags"] = co.co_flags | _CO_GENERATOR
        f = types.FunctionType(co.replace(**kw), f.__globals__, f.__name__, None, f.__closure__)
    else:
        f.__code__ = co.replace(**kw)
    f.__name__, f.__qualname__, f.__module__, f.__doc__ = desc["name"], desc["qual"], desc["mod"], desc["doc"]
    f.__defaults__, f.__kwdefaults__ = defaults, kwdefaults
    return f


def _fwd_fill(f, p, desc):
    """Stand-in f's own dicts and type parameters (decoded after f exists: its dict may hold f)."""
    f.__dict__ = desc["dict"]
    if "ann" in desc:
        f.__annotations__ = desc["ann"]
    else:
        f.__annotate__ = _fwd_annotate(p)
    if desc.get("tp"):
        f.__type_params__ = desc["tp"]


def _fwd_annotate(p):
    def __annotate__(format):
        if format != 1:
            raise NotImplementedError
        # The candidate's own dict (linked): changes either side makes to it reach the other.
        return getattr(p, "__annotations__")

    return __annotate__


@types.coroutine
def _await_candidate(c):
    """Await candidate coroutine c (its proxy) in the tests' event loop: the candidate's process runs it one step at
    a time (Server._step). Where it yields to the loop (asyncio.sleep(0)) this yields too, so the loop's other tasks
    run in between as in one process; what is thrown in (a task's cancellation) goes on to it. Closed or finalized
    here, the candidate's coroutine is left alone: it is closed when the candidate lets go of it."""
    p = proxy_rid(c)
    if p is None:
        raise Inexact("a candidate coroutine function returned something other than a candidate coroutine")
    how, v = "send", None
    while True:
        r = p[0].call("step", [c, v], how=how)
        if type(r) is not tuple or len(r) != 2 or r[0] not in (0, 1, 2):
            raise p[0]._fail("candidate broke the grading protocol (bad coroutine step)")
        if r[0] == 0:
            return r[1]
        if r[0] == 2:
            raise Inexact("the candidate's coroutine waited on something other than the event loop's next turn: the tests' event loop is in their process")
        try:
            v, how = (yield), "send"
        except GeneratorExit:
            return None
        except BaseException as e:  # noqa: B036 - thrown in: passed on
            v, how = e, "throw"


class _NoLoop:
    """The running event loop a candidate coroutine sees while the tests' loop runs it (Server._step): that loop is
    in the tests' process, so using it (a future, a task, a timer, current_task()) is a grader error."""

    def __getattribute__(self, name):
        raise Inexact("the candidate's coroutine used the running event loop (%s), which is in the tests' process" % clip(name, 60))

    def __hash__(self):
        raise Inexact("the candidate's coroutine used the running event loop, which is in the tests' process")


def _gen_wrap(p, me):
    """A real generator standing for candidate generator p (its proxy): next, send, throw and close are p's. me: [a
    weak reference to this generator, started, primed, closed there]. Primed (the candidate's generator had started
    when this was made, or started there since: _gen_mirror), its first yield is where the candidate's is and every
    send or throw goes on to it. When it is being finalized (its weak references are cleared first) p is left
    alone: the candidate's generator is closed when the candidate lets go of it too, as in one process."""
    me[1] = True
    if me[2]:
        y = None
    else:
        try:
            y = p.__next__()
        except StopIteration as e:
            return e.value
    while True:
        try:
            sent = yield y
        except BaseException as e:  # noqa: B036 - thrown in (close() throws GeneratorExit): passed on
            if isinstance(e, GeneratorExit) and (me[3] or me[0]() is None):
                return
            try:
                y = p.throw(e)
            except StopIteration as e2:
                return e2.value
        else:
            try:
                y = p.__next__() if sent is None else p.send(sent)
            except StopIteration as e:
                return e.value


def _gen_mirror(g, me, how):
    """The candidate's generator started ("start") or finished ("close") in its process: stand-in g does too, without
    running the candidate's (_gen_wrap). A running one is left to finish its step."""
    if g.gi_running:
        return
    if how == "start":
        if not me[1] and g.gi_frame is not None:
            me[2] = True
            next(g)
    else:
        me[1] = me[3] = True
        g.close()


def _gen_state(g):
    """0: not started, 1: started (suspended or running), 2: finished or closed (inspect.getgeneratorstate)."""
    if g.gi_running or getattr(g, "gi_suspended", False):
        return 1
    f = g.gi_frame
    if f is None:
        return 2
    return 0 if hasattr(g, "gi_suspended") or f.f_lasti == -1 else 1


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
        self.weak_err = None  # a weak reference that died before one process's would have (or a stale stand-in: fnheat), raised at the next reply
        self.ntuples = {}
        self.thrown = {}
        self.candidate_secs = 0.0
        left = None if deadline is None else deadline - time.monotonic()
        self.sync_limit = SYNC_LIMIT if left is None else max(SYNC_MIN, SYNC_SHARE * left)
        self.state = {}  # process state as both sides last had it
        self.ended = None  # process state the candidate changed that this process can't take: every later call fails
        self.ran = False  # candidate code has run (a call was made)
        self.unkeyed = {}
        self.chan.floats_off = False
        self.loaded = set()  # candidate modules the tests imported
        self.unloaded = set()  # those the tests removed from sys.modules since the last message
        self.unimported = set()  # those removed in the candidate's sys.modules too
        self.fs_changed = set()  # paths in the workspace the candidate's code changed in its copy ("/"-separated)
        self.fs_any = False  # ... or anything in it (another process, native code)
        self.fs_busy = set()
        self.cwd_maybe = True  # getcwd() may have changed since last asked (_CWD_EVENTS)
        self.cwd_any = False  # ... after any change (_FS_ANY)
        self.rstate = RandomState()
        self.proc = None  # ProcSettings (install_guards)
        self.orig = {"stdout": sys.stdout, "stderr": sys.stderr, "stdin": sys.stdin, "print": builtins.print, "input": builtins.input}
        self.stdin_obj = None  # the tests' io.StringIO stdin the candidate last got the text of
        self.env0 = dict(os.environ)
        self.cwd0 = _getcwd()
        self.fs_roots = fs_roots(self.cwd0)
        self.path_obj, self.path0 = sys.path, list(sys.path)
        self.path_base = tuple(sys.path)  # the interpreter's own entries (the runner adds none)
        self.path_lists = {id(sys.path): (sys.path, 0)}  # the tests' sys.path lists: (list, number the candidate knows it by)
        self.umask0 = umask_now(0o022)
        self.locale0 = locale_now()
        self.tz0 = tz_now()
        self.watch = None  # the tests' raw changes to standard-library modules and classes (install_guards)
        self.state["loglevels"] = LOG_DEFAULT
        self.logquiet = False  # the tests added or removed a logger's handler since the last message
        self.fwd = weakref.WeakValueDictionary()  # rid -> the real function standing for candidate function rid
        self.fwd_rids = weakref.WeakKeyDictionary()  # that function -> rid
        self.fwd_desc = {}  # rid -> its decoded description, while its proxy lives
        self.fwd_snap = {}  # rid -> its stand-in's _FN_TESTS (generators: _GEN_SYNC) as the candidate's last had them
        self.fwd_dsnap = {}  # rid -> its stand-in's own dicts as the candidate's last had them (fn_dicts)
        self.meths = {}  # rid -> [weak reference to the bound method standing for candidate bound method rid, its proxy]
        self.meth_ids = {}  # id of such a bound method -> rid
        self.gens = weakref.WeakValueDictionary()  # rid -> the real generator standing for candidate generator rid
        self.gen_rids = weakref.WeakKeyDictionary()  # that generator -> its proxy (kept as long as it)
        # Stand-ins whose attributes are compared before each message: the ones whose candidate function or generator
        # the candidate's code may reach (it reports which: Server._fn_sweep), and the ones a message hands over.
        self.fn_hot = set()
        self.fn_out = []
        self.fn_dying = []  # (rid, own dicts, their snapshot) of stand-ins that died: what the tests put in them is sent
        self.fn_inexact = None  # why the tests' process can't have stand-in functions (their closures, globals)
        self.gen_inexact = None  # ... or stand-in generators (gi_yieldfrom)
        self.module_inexact = None  # why it can't have stand-in modules (type() checks)
        self.std_orig = {}  # (path, name) -> (module dict or class, value before the tests' first change)
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
            n = _getrefcount(p)
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
            desc = self.fwd_desc.pop(rid, None)
            dsnap = self.fwd_dsnap.pop(rid, None)
            if desc is not None and dsnap is not None:
                # A stand-in's own dicts outlive it (its description holds them): what the tests put in them reaches
                # the candidate's function with the next message, before its release.
                self.fn_dying.append((rid, [desc["dict"]] + ([desc["ann"]] if "ann" in desc else []), dsnap))
            self.fwd_snap.pop(rid, None)
            self.fn_hot.discard(rid)
            self.release[rid] = None
        finally:
            self.lock.release()

    @staticmethod
    def _ref_users(ref):
        return _getrefcount(ref)

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
        if d.get("noweak") is True and not is_meta and layout.__weakrefoffset__ == 0 and layout.__dictoffset__ == 0 and layout.__itemsize__ == 0:
            # As the candidate's class: no weak references (a __dict__ slot, which 3.12 manages as an unslotted
            # class's dict, and no __weakref__).
            ns["__slots__"] = ("__dict__",)
        for tail, inexact in tails:
            # No other __slots__: CPython 3.12 gives a slotted class whose MRO holds real Python classes their dict
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
            # A real traceback there (`__exit__`'s third argument) of the same shape, the test's own one when it comes
            # back.
            shape, tb = [], v
            while tb is not None:
                line = tb.tb_lineno
                shape.append([tb.tb_lasti, line if type(line) is int else -1])
                tb = tb.tb_next
            return {"t": "ttb", "id": self._callback_id(v), "n": shape}
        if t is types.ModuleType:
            name = std_module_name(v)
            if name is not None:
                return {"t": "smod", "n": name}
        if t is types.FunctionType or t is types.GeneratorType:
            rid = self._standin_rid(v)
            if rid is not None:
                self.fn_out.append(rid)
                return {"t": "obj", "id": rid}
        if t is types.MethodType:
            rid = self.meth_ids.get(id(v))
            if rid is not None and self._meth_known(rid) is v:
                return {"t": "obj", "id": rid}
            if self._standin_rid(v.__func__) is not None or proxy_rid(v.__func__) is not None:
                return {"t": "meth", "f": enc.enc(v.__func__, depth + 1), "s": enc.enc(v.__self__, depth + 1)}
        fields = ntuple_fields(t)
        if fields is not None and t is not tuple and _plain_ntuple(t):
            self.ntuples[(t.__name__, fields)] = t
            return enc.keyed(v, lambda: {"t": "ntuple", "n": t.__name__, "f": list(fields), "v": [enc.enc(x, depth + 1, key) for x in tuple.__iter__(v)]})
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
            elif "c" not in x:
                raise ProtocolError("unknown object %d" % rid)
            else:
                obj = dec.register(x, self._instance(rid, x, dec, d))
            if "fn" in x:
                return self._forwarder(rid, obj, x["fn"], dec, d)
            if "gen" in x:
                return self._gen_standin(rid, obj, x["gen"])
            if "meth" in x:
                return self._meth(rid, obj, x["meth"], dec, d)
            return obj
        if t == "meth":
            f, s = dec.dec(x.get("f"), d), dec.dec(x.get("s"), d)
            if not callable(f):
                raise ProtocolError("bad method")
            return types.MethodType(f, s)
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
        if t == "smod":
            m = import_std(x.get("n"))
            if m is None:
                raise Inexact("the candidate's code handed over the standard-library module %s, which the tests' process can't import" % clip(x.get("n"), 100))
            return m
        raise ProtocolError("unknown tag %r" % clip(t, 40))

    def _meth_known(self, rid):
        e = self.meths.get(rid)
        return None if e is None else e[0]()

    def _meth(self, rid, p, raw, dec, d):
        """The bound method standing for candidate bound method rid (p its proxy, kept while it lives), the same one
        while it lives: one the candidate's code hands over twice is one object here too."""
        m = self._meth_known(rid)
        if raw == 1 and type(raw) is int:
            if m is None:
                raise ProtocolError("unknown method %d" % rid)
            return m
        if m is not None or not isinstance(raw, list) or len(raw) != 2:
            raise ProtocolError("bad method")
        f, s = dec.dec(raw[0], d), dec.dec(raw[1], d)
        if not callable(f):
            raise ProtocolError("bad method")
        m = types.MethodType(f, s)
        mid = id(m)

        def gone(_, rid=rid, mid=mid):
            # Its proxy goes too: the candidate's bound method is released.
            if self.meth_ids.get(mid) == rid:
                del self.meth_ids[mid]
            self.meths.pop(rid, None)

        self.meths[rid] = [weakref.ref(m, gone), p]
        self.meth_ids[mid] = rid
        return m

    def _forwarder(self, rid, p, raw, dec, d):
        """The real function standing for candidate function rid (p its proxy), the same one while it lives."""
        f = self.fwd.get(rid)
        if isinstance(raw, dict):
            if f is not None:
                raise ProtocolError("function %d described twice" % rid)
            desc = self._fn_desc(raw, dec, d)
        else:
            desc = self.fwd_desc.get(rid)
            if f is not None:
                return f
            if desc is None:
                raise ProtocolError("function %d without a description" % rid)
        if self.fn_inexact is not None:
            raise Inexact(self.fn_inexact)
        f = _make_forwarder(p, desc)
        self.fwd[rid] = f
        self.fwd_rids[f] = rid
        if isinstance(raw, dict):
            # In the order they were encoded, after f exists (its own dict may hold it).
            desc["dict"] = dict(_dict_items_in(dec, raw.get("dict")))
            if "ann" in raw:
                desc["ann"] = dict(_dict_items_in(dec, raw["ann"]))
            if "tp" in raw:
                desc["tp"] = dec.dec(raw["tp"], d)
                if type(desc["tp"]) is not tuple:
                    raise ProtocolError("bad function description")
            self.fwd_desc[rid] = desc
        _fwd_fill(f, p, desc)
        self.fwd_snap[rid] = _FN_GET[_FN_TESTS](f)
        self.fwd_dsnap[rid] = fn_dicts(f)
        self.fn_hot.add(rid)
        return f

    def _fn_desc(self, raw, dec, d):
        """A candidate function's description, its values decoded (in the order they were encoded)."""
        out = {}
        for key, kind in (("name", str), ("qual", str), ("co", str), ("coq", str), ("argc", int), ("posonly", int), ("kwonly", int), ("flags", int), ("line", int)):
            v = raw.get(key)
            if type(v) is not kind:
                raise ProtocolError("bad function description")
            out[key] = v
        names = raw.get("vars")
        if not (isinstance(names, list) and all(type(n) is str for n in names)):
            raise ProtocolError("bad function description")
        out["vars"] = names
        out["file"] = path_entry_in(raw.get("file"), self.cwd0)
        for key in ("mod", "doc", "defaults", "kwdefaults"):
            out[key] = dec.dec(raw.get(key), d)
        if not (out["defaults"] is None or type(out["defaults"]) is tuple) or not (out["kwdefaults"] is None or type(out["kwdefaults"]) is dict):
            raise ProtocolError("bad function description")
        if out["line"] < 1 or out["argc"] < out["posonly"] or len(names) != out["argc"] + out["kwonly"] + bool(out["flags"] & _CO_VARARGS) + bool(out["flags"] & _CO_VARKEYWORDS):
            raise ProtocolError("bad function description")
        return out

    def _gen_standin(self, rid, p, names):
        """The real generator standing for candidate generator rid (p its proxy), the same one while it lives."""
        g = self.gens.get(rid)
        if g is None:
            if not (isinstance(names, list) and len(names) == 3 and type(names[0]) is str and type(names[1]) is str and names[2] in (0, 1, 2)):
                raise ProtocolError("bad generator")
            if self.gen_inexact is not None:
                raise Inexact(self.gen_inexact)
            me = [None, False, False, False]
            g = _gen_wrap(p, me)
            me[0] = weakref.ref(g)
            g.__name__, g.__qualname__ = names[:2]
            if names[2]:
                _gen_mirror(g, me, "start" if names[2] == 1 else "close")
            self.gens[rid] = g
            self.gen_rids[g] = (rid, p, me)
            self.fwd_snap[rid] = _FN_GET[_GEN_SYNC](g)
            self.fn_hot.add(rid)
        return g

    def _standin_rid(self, v):
        """The candidate rid a stand-in function or generator of this side's stands for, else None."""
        t = type(v)
        if t is types.FunctionType:
            return self.fwd_rids.get(v)
        if t is types.GeneratorType:
            hit = self.gen_rids.get(v)
            return None if hit is None else hit[0]
        return None

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
        if self.cwd_maybe or self.cwd_any:
            self.cwd_maybe = False
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
        ll = log_levels()
        if ll != s["loglevels"]:
            if any(type(v[0]) is not int or type(v[1]) is not bool or type(v[2]) is not bool for v in ll[1].values()) or type(ll[0]) is not int:
                raise Inexact("logging: the tests set a logger's level, propagate or disabled to something other than an int or bool")
            s["loglevels"] = st["loglevels"] = ll
        if self.logquiet:
            self.logquiet = False
            lq = log_quiet((self.orig["stdout"], self.orig["stderr"]))
            if lq != s.get("logquiet", {}):
                s["logquiet"] = st["logquiet"] = lq
        r = sys.modules.get("random")
        if r is not None:
            rs = self.rstate.maybe(r)
            if rs is not None and rs != s.get("random"):
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
        w = self.watch
        if w is not None:
            if w.broken is not None:
                raise Inexact("watching the tests' changes to the standard library failed (%s)" % w.broken)
            w.flush()
            if self.std_orig:
                self._std_state(enc, st, s)
        if self.fwd_snap or self.fn_dying:
            fn = self._fn_state(enc)
            if fn:
                st["fn"] = fn
        if self.proc is not None:
            self.proc.out(st)
        if self.unloaded:
            st["unimport"] = sorted(self.unloaded)
            self.unimported |= self.unloaded
            self.unloaded = set()
        return st

    def _fn_state(self, enc):
        """What the tests set on stand-in functions and generators since the candidate's own last had it: the ones
        its code may reach (fn_hot) and the ones this message hands over."""
        out, new = [], []
        dying, self.fn_dying = self.fn_dying, []
        for rid, dicts, snap in dying:
            dch = fn_dict_changes("the tests", enc, dicts, snap)[0]
            if dch:
                out.extend([rid] + e for e in dch)
        todo, self.fn_out = self.fn_out, []
        todo = list(self.fn_hot) + [rid for rid in todo if rid not in self.fn_hot]
        for rid in todo:
            snap = self.fwd_snap.get(rid)
            if snap is None:
                continue
            f, names = self.fwd.get(rid), _FN_TESTS
            if f is None:
                f, names = self.gens.get(rid), _GEN_SYNC
                if f is None:
                    continue
                me = self.gen_rids[f][2]
                if not me[1] and f.gi_frame is None:
                    # Closed (or thrown into) before it started: none of its code ran, and the candidate's one is
                    # closed the same way.
                    me[1] = True
                    out.append([rid, "close", None])
            ch, cur = fn_changes("the tests", f, names, snap)
            if ch:
                out.extend([rid, name, enc.enc(v)] for name, v in ch)
                new.append((rid, ch, cur))
            if names is _FN_TESTS:
                dch, self.fwd_dsnap[rid] = fn_dict_changes("the tests", enc, [getattr(f, name) for name in _FN_DICTS], self.fwd_dsnap[rid])
                if dch:
                    out.extend([rid] + e for e in dch)
                    desc = self.fwd_desc.get(rid)
                    if desc is not None:
                        desc["dict"] = f.__dict__
                        if "ann" in desc:
                            desc["ann"] = f.__annotations__
        for rid, ch, cur in new:
            self.fwd_snap[rid] = cur
            desc = self.fwd_desc.get(rid)
            if desc is not None:
                for name, v in ch:
                    desc[_FN_DESC_KEY[name]] = v
        return out

    def _module_removed(self, name, deleted):
        """StdWatch: the tests removed (or replaced) a module in sys.modules: a candidate one leaves the candidate's
        sys.modules too, with the next message (its code importing it again runs it again, as in one process)."""
        if name in self.loaded:
            if deleted:
                self.unloaded.add(name)
            else:
                self._end("the tests replaced candidate module %s in sys.modules, which the candidate's process can't share" % name)

    def _std_changed(self, where, path, name, old):
        """StdWatch: the tests changed a standard-library module's or class's attribute (sent with the next call)."""
        if where is None:
            self._end("the tests replaced or removed the standard-library module %s in sys.modules, which the candidate's process can't share" % path)
        elif name in _STD_UNSHARED.get(path[:-1], ()):
            self._end("the tests set %s%s, which the candidate's process can't share" % (path[:-1] + ".", name))
        else:
            self.std_orig.setdefault((path, name), (where, old))

    def _std_state(self, enc, st, s):
        """The standard-library attributes the tests changed since the candidate last had them: [path, name, "orig"]
        (back to the candidate's own), [path, name, "del"] or [path, name, "set", value]."""
        last = s.get("std") or {}
        new, out = None, []
        for key, (where, orig) in self.std_orig.items():
            cur = (where if type(where) is dict else _DICT(where)).get(key[1], _NO)
            if cur is last.get(key, orig):
                continue
            if new is None:
                new = dict(last)
            new[key] = cur
            if cur is orig:
                out.append([key[0], key[1], "orig"])
            elif cur is _NO:
                out.append([key[0], key[1], "del"])
            else:
                if type(where) is not dict and proxy_rid(cur) is None and type(cur) is not types.FunctionType and owner(type(cur), "__get__") is not None:
                    # A descriptor on a class (other than a function, whose stand-in binds as one) acts there; a test
                    # object standing for it wouldn't.
                    raise Inexact("the tests set %s.%s to %s, which the candidate's process would have to bind as one process does" % (key[0], key[1], clip(type(cur).__name__, 100)))
                out.append([key[0], key[1], "set", enc.enc(cur)])
        if new is not None:
            s["std"] = new
            st["std"] = out

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
        return [hit[1], [cwd_out(p, self.cwd0) if _isabs(p) else ["abs", p] for p in cur], first, last + 1, [["abs", p] for p in base]]

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
        if "fn" in cst:
            out["fn"] = fn_change_in(dec, cst["fn"])
        for key in ("fncool", "fnheat"):
            v = cst.get(key)
            if v is not None and not (isinstance(v, list) and all(type(n) is int for n in v)):
                raise ProtocolError("bad %s list" % key)
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
        fs = cst.get("fs")
        if fs is not None:
            if not (isinstance(fs, list) and all(type(p) is str for p in fs)):
                raise ProtocolError("bad workspace changes")
            for p in fs:
                if p == "*":
                    self.fs_any = True
                else:
                    self.fs_changed.add(p)
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
        if "loglevels" in cst:
            if not log_apply(cst["loglevels"]):
                self._end("logging: the candidate's code set a logger's level in a way the tests' process can't")
            s["loglevels"] = log_levels()
        for name in cst.get("loghandlers") or ():
            if not isinstance(name, str):
                raise ProtocolError("bad logging state")
            lg = _std("logging")
            x = lg.root if name == "" else lg.getLogger(name)
            if type(x.handlers) is not _CandidateHandlers:
                x.handlers = _CandidateHandlers(list.copy(x.handlers))
        if self.proc is not None:
            self.proc.apply(cst)
        elif cst.get("proc") or cst.get("procdirty"):
            self._end("the candidate's code changed process settings this process isn't set up to take")
        for rid in cst.get("fncool") or ():
            self.fn_hot.discard(rid)
        for rid in cst.get("fnheat") or ():
            # The candidate's code got a function (or generator) again that it couldn't reach before: what the tests
            # set on its stand-in meanwhile hasn't reached it.
            self.fn_hot.add(rid)
            f, names = self.fwd.get(rid), _FN_TESTS
            if f is None:
                f, names = self.gens.get(rid), _GEN_SYNC
            snap = self.fwd_snap.get(rid)
            if f is not None and snap is not None and (any(map(is_not, _FN_GET[names](f), snap)) or (not fn_dicts_same([getattr(f, name) for name in _FN_DICTS], self.fwd_dsnap[rid]) if names is _FN_TESTS else not self.gen_rids[f][2][1] and f.gi_frame is None)):
                self.weak_err = "the tests changed a candidate function's (or generator's) stand-in while only the grader held the candidate's own, and candidate code got it back (in a container) before the change reached it"
        for rid, name, value in cst.get("fn") or ():
            # The candidate's code set an attribute of a function or generator the tests have a stand-in for, or
            # started or finished a generator.
            if name == "start" or name == "close":
                g = self.gens.get(rid)
                if g is not None:
                    _gen_mirror(g, self.gen_rids[g][2], name)
                continue
            if name in _FN_DICTS:
                f, desc = self.fwd.get(rid), self.fwd_desc.get(rid)
                key = "dict" if name == "__dict__" else "ann"
                if f is not None:
                    fn_dict_in(f, name, value)
                    self.fwd_dsnap[rid] = fn_dicts(f)
                    if desc is not None:
                        desc[key] = getattr(f, name)
                elif desc is not None:
                    if value[0]:
                        desc[key] = dict(value[1])
                    else:
                        dict.clear(desc[key])
                        dict.update(desc[key], value[1])
                continue
            if name not in _FN_DESC_KEY:
                raise ProtocolError("bad function attribute")
            desc = self.fwd_desc.get(rid)
            if desc is not None:
                desc[_FN_DESC_KEY[name]] = value
            f, names = self.fwd.get(rid), _FN_TESTS
            if f is None:
                f, names = self.gens.get(rid), _GEN_SYNC
                if f is None or name not in _GEN_SYNC:
                    continue
            try:
                setattr(f, name, value)
            except Exception as e:
                self._end("the candidate's code set %s of a function to a value its stand-in here can't take (%s)" % (name, clip(_safe_str(e), 200)))
                continue
            self.fwd_snap[rid] = _FN_GET[names](f)
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
            for k in enc.vmade:
                self._vforget(k)
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
            self.ran = True
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
        """The candidate's module name. Loaded again (the tests deleted it from sys.modules): the candidate's process
        runs it again too, into a new module, as one process's import would."""
        fresh = name in self.loaded and name not in self.unimported and name not in self.unloaded
        self.loaded.add(name)
        self.unimported.discard(name)
        return self.call("import", name=name, fresh=fresh)

    def _crossed(self, x):
        """Whether x is, or stands for, an object the candidate's process has too (a candidate object, a linked
        container, a by-value object that crossed, a test object the candidate holds): one process would count the
        candidate's references to it, and its referrers and weak references there."""
        if proxy_rid(x) is not None or self._standin_rid(x) is not None:
            return True
        i = id(x)
        n = self.link_of.get(i)
        if n is not None and self.links.get(n) is x:
            return True
        k = self.vkey.get(i)
        if k is not None and self.vobj.get(k) is x:
            return True
        k = self.callback_ids.get(i)
        return k is not None and self.callbacks.get(k) is x

    def install_guards(self):
        """Process introspection that can't see the candidate's half is a grader error rather than this process's
        answer: refcounts, referrers, weak references and sizes of shared objects; once candidate code has run, the
        process's objects, memory, CPU time and threads. gc.collect() collects in both processes (candidate objects
        the tests let go of in a cycle die as in one process) and counts both. id() of a candidate object (or a value
        it sent) is its id there with CANDIDATE_ID set: the same while the object lives, as in one process."""
        gc, wr, tm = _std("gc"), _std("weakref"), _std("time")

        def shared(what):
            def check(args):
                if any(map(self._crossed, args)) or any(map(self._identity_unsure, args)):
                    raise Inexact("%s of an object the candidate's process shares: one process would count what the candidate's code holds too" % what)

            return check

        def ran(what):
            def check(args):
                if self.ran:
                    raise Inexact("%s: candidate code ran in another process, which this one doesn't count" % what)

            return check

        def proxied(what, standins=False):
            def check(args):
                if any(proxy_rid(x) is not None or self._linked(x) or standins and self._standin_rid(x) is not None for x in args):
                    raise Inexact("%s of a candidate object or a container shared with the candidate's process: its stand-in here isn't the object" % what)

            return check

        _guard(sys, "getrefcount", shared("sys.getrefcount"))
        _guard(gc, "get_referrers", shared("gc.get_referrers"))
        _guard(wr, "getweakrefcount", shared("weakref.getweakrefcount"))
        _guard(wr, "getweakrefs", shared("weakref.getweakrefs"))
        _guard(gc, "get_referents", proxied("gc.get_referents", True))
        _guard(sys, "getsizeof", proxied("sys.getsizeof"))
        for mod, names in ((gc, ("get_objects", "get_stats", "get_count", "freeze", "get_freeze_count")), (sys, ("getallocatedblocks",)), (tm, ("process_time", "process_time_ns", "thread_time", "thread_time_ns")), (os, ("times",)), (_std("resource"), ("getrusage",)), (_std("tracemalloc"), ("get_traced_memory", "take_snapshot", "get_tracemalloc_memory", "reset_peak")), (_std("threading"), ("active_count", "enumerate"))):
            for name in names:
                if mod is not None:
                    _guard(mod, name, ran("%s.%s()" % (mod.__name__, name)))
        collect = gc.collect

        def both(*args, **kwargs):
            n = collect(*args, **kwargs)
            if self.ran and not self.gone and not self.ended:
                gen = args[0] if args else kwargs.get("generation", 2)
                got = self.call("gc", [gen if type(gen) is int else 2])
                n += got if type(got) is int else 0
            return n

        both.__name__ = both.__qualname__ = "collect"
        both.__doc__ = collect.__doc__
        gc.collect = both
        builtins.id = self.candidate_id
        # logging: the candidate's records stay in its process, so a handler or filter the tests add wouldn't see
        # them (one writing to the process's own stdout or stderr shows nothing the tests can read), and its loggers
        # wouldn't use the tests' logger class or record factory.
        lg = _std("logging")
        quiet = (self.orig["stdout"], self.orig["stderr"])

        def adds(args):
            h = args[1] if len(args) > 1 else None
            if type(h) is lg.NullHandler or (type(h) is lg.StreamHandler and h.stream in quiet and not h.filters):
                # One that shows the tests nothing; the candidate's logger of that name gets a like one (log_quiet),
                # so logging's last-resort handler stays out of it there too.
                self.logquiet = True
                return
            self._end("logging: the tests added a handler or filter, which the candidate's records (logged in its own process) wouldn't reach")

        def removes(args):
            self.logquiet = True

        def setter(what):
            def check(args):
                self._end("logging: the tests called %s, which the candidate's loggers (in its own process) wouldn't use" % what)

            return check

        _guard(lg.Logger, "addHandler", adds)
        _guard(lg.Logger, "removeHandler", removes)
        _guard(lg.Logger, "addFilter", lambda args: adds(()))
        for name in ("setLoggerClass", "setLogRecordFactory"):
            _guard(lg, name, setter("logging." + name))
        # A stand-in function's (or generator's) code object and frames are the grader's: only inspect's signature,
        # source and kind checks read it for what is the candidate's in it (CPython audits these reads and writes).
        own = id(globals())

        def code_guard(ev, args):
            if ev == "object.__getattr__":
                if args[1] in _CODE_ATTRS and self._standin_rid(args[0]) is not None:
                    f = _getframe(1)
                    g = f.f_globals
                    if id(g) == own or (g.get("__name__") == "inspect" and f.f_code.co_name in _CODE_READERS):
                        return
                    raise Inexact("code read %s of a candidate function or generator, whose stand-in in the tests' process has the grader's code" % args[1])
            elif ev == "object.__setattr__":
                if args[1] in ("__code__", "__defaults__", "__kwdefaults__") and self._standin_rid(args[0]) is not None and id(_getframe(1).f_globals) != own:
                    raise Inexact("the tests set %s of a candidate function's stand-in, which the candidate's own function wouldn't get" % args[1])
            elif ev in _FS_ANY:
                if ev[0] != "c" or fs_owner(_getframe(1), _GRADER_GLOBALS):  # not the grader's own ctypes calls
                    self.cwd_any = True
                    if self.fs_changed:
                        # (Not after the candidate's own process start, fs_any: a version check there is common.)
                        raise Inexact("the tests ran another process or native code (%s) after the candidate's code changed its copy of the workspace (it would see the tests' copy, without the change)" % ev)
            elif ev in _FS_EVENTS:
                if ev in _CWD_EVENTS:
                    self.cwd_maybe = True
                if ev == "sqlite3.connect" and type(args[0]) in (str, bytes) and args[0] in _FS_MEMORY:
                    return
                write = ev in _FS_CHANGE and ev != "sqlite3.connect" and (ev != "open" or (type(args[2]) is int and args[2] & _O_WRITE and type(args[0]) is not int))
                if write or self.fs_changed or self.fs_any:
                    for i, j in _FS_CHANGE[ev] if write else _FS_LOOK.get(ev, ()):
                        self._fs_check(args[i] if i < len(args) else None, args[j] if j is not None and j < len(args) else None, write, _getframe(1), ev != "os.chdir")

        sys.addaudithook(code_guard)

        def fs_call(real):
            def guarded(*args, **kwargs):
                if self.fs_changed or self.fs_any:
                    self._fs_check(args[0] if args else kwargs.get("path"), kwargs.get("dir_fd"), False, _getframe(1))
                return real(*args, **kwargs)

            guarded.__name__ = guarded.__qualname__ = real.__name__
            guarded.__doc__ = real.__doc__
            return guarded

        for name in _FS_CALLS:
            if getattr(os, name, None) is not None:
                setattr(os, name, fs_call(getattr(os, name)))
        # Identity: a by-value object that crossed without a key (a tuple or frozenset holding more than plain data, a
        # number in a container's contents) arrives as a new object each time, where one process could have one.
        ut = _std("unittest")

        def same(args):
            if len(args) < 3:
                return
            a, b = args[1], args[2]
            t = type(a)
            if t is not type(b) or not (self._identity_unsure(a) or self._identity_unsure(b)):
                return
            if t is int or t is float or t is complex:
                if a != a and b != b:
                    n = self.unkeyed.get(id(a), 0)
                    if n and n == self.unkeyed.get(id(b)):
                        return  # two NaNs from one message: as separate or as one as they were there
                elif a != b:
                    return  # different numbers are different objects in any process
            raise Inexact("assertIs/assertIsNot of a %s that may have crossed from the candidate's process without its identity (one process could have the same object)" % t.__name__)

        def keywords(real):
            # expr1=/expr2= given by keyword are checked too.
            def guarded(self_, expr1, expr2, msg=None):
                same((self_, expr1, expr2))
                return real(self_, expr1, expr2, msg)

            guarded.__name__ = guarded.__qualname__ = real.__name__
            guarded.__doc__ = real.__doc__
            return guarded

        ut.TestCase.assertIs = keywords(ut.TestCase.assertIs)
        ut.TestCase.assertIsNot = keywords(ut.TestCase.assertIsNot)
        self.proc = ProcSettings(self._end, Inexact)
        # String annotations (`from __future__ import annotations`) evaluate in the function's globals: a stand-in's
        # are this module's, not the candidate module's.
        for mod, name, evals in ((_std("typing"), "get_type_hints", lambda a, k: (a[0] if a else k.get("globalns")) is None), (_std("inspect"), "get_annotations", lambda a, k: k.get("eval_str") and k.get("globals") is None), (_std("annotationlib"), "get_annotations", lambda a, k: k.get("eval_str") and k.get("globals") is None)):
            if mod is not None and getattr(mod, name, None) is not None:
                setattr(mod, name, self._hints_guard(getattr(mod, name), evals))
        # Last: the guards above aren't the tests' changes.
        w = StdWatch(self._std_changed, self._module_removed)
        self.watch = w if w.ok else None

    def _linked(self, x):
        n = self.link_of.get(id(x))
        return n is not None and self.links.get(n) is x

    def _fs_check(self, p, dir_fd, write, f, inside=True):
        """A file operation by the tests (frame f) on path p, in their copy of the workspace: Inexact where one
        process would see the candidate's changes there, inside it unless only its existence counts (inside=False:
        chdir), or the tests' change would reach the candidate's code."""
        tid = _get_ident()
        if tid in self.fs_busy:
            return
        self.fs_busy.add(tid)
        try:
            if not fs_owner(f, _GRADER_GLOBALS):
                return
            where = fs_where(p, dir_fd)
            if where is False:
                return
            rel = None
            if where is not None:
                rel = fs_rel(where, self.fs_roots)
                if rel is None:
                    rel = fs_rel(os.path.realpath(where), self.fs_roots)
                if rel is None:
                    return
        finally:
            self.fs_busy.discard(tid)
        what = clip(repr(p), 200) if rel is None else ("its top directory" if rel == "." else rel)
        if write:
            raise Inexact("the tests changed %s in their copy of the workspace, which the candidate's process doesn't share (one process would see the change)" % what)
        if rel is None:
            raise Inexact("the tests looked at %s, a path the grader can't place, after the candidate's code changed its copy of the workspace (each process has its own; one process would see the change)" % what)
        if self.fs_any:
            raise Inexact("the tests looked at %s after the candidate's code started a process or called native code, which could have changed its copy of the workspace (each process has its own; one process would see the change)" % what)
        if fs_hit(rel, self.fs_changed, inside):
            raise Inexact("the tests looked at %s in their copy of the workspace, where the candidate's code changed %s in its own (each process has its own; one process would see the change)" % (what, ", ".join(sorted(c for c in self.fs_changed if fs_hit(rel, (c,), inside)))[:200]))

    def _hints_guard(self, real, evals):
        def guarded(obj, *args, **kwargs):
            if self._standin_rid(obj) is not None and evals(args, kwargs) and any(type(v) is str for v in dict(obj.__annotations__).values()):
                raise Inexact("%s evaluates the string annotations of a candidate function in its globals, which in this process are the grader's" % real.__name__)
            return real(obj, *args, **kwargs)

        guarded.__name__ = guarded.__qualname__ = real.__name__
        guarded.__doc__ = real.__doc__
        guarded.__wrapped__ = real
        return guarded

    def _identity_unsure(self, x):
        """Whether x is an immutable value whose identity the candidate's process may have had and this one lost."""
        t = type(x)
        if t is not int and t is not float and t is not complex and not isinstance(x, (tuple, frozenset)):
            return False
        k = self.vkey.get(id(x))
        if k is not None and self.vobj.get(k) is x:
            return False
        if id(x) in self.unkeyed:
            return True
        if t is float:
            # Floats in a message are recorded by value (Channel.floats): a float of a value never received is the tests'.
            return self.chan.floats is None or x in self.chan.floats
        # A number in a container's contents crosses without a key: once candidate code has run, any could have.
        return t is not tuple and t is not frozenset and not isinstance(x, tuple) and self.ran and not (t is int and -5 <= x <= 256)

    def candidate_id(self, obj):
        """id() for the tests: a candidate object's (or a value it sent) is its id in the candidate process."""
        p = proxy_rid(obj)
        if p is None or p[0] is not self:
            k = self.vkey.get(id(obj))
            if k is None or k * self.sign > 0 or self.vobj.get(k) is not obj:
                return id(obj)
        cid = self.call("id", [obj])
        if type(cid) is not int or cid < 0:
            raise self._fail("candidate broke the grading protocol (bad id)")
        return CANDIDATE_ID | cid


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
        return self._srv.call_back("call", [self, Args(args), Args(map(Args, kwargs.items()))])

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
        self.std_saved = {}  # (path, name) -> this process's own value of a standard-library attribute the tests changed
        self.watch = None
        self.loglevels = LOG_DEFAULT  # loggers as last exchanged
        self.loghandlers = set()  # loggers the candidate's code added handlers or filters to ("" for root)
        self.loghandlers_sent = set()
        self.logquiet = {}  # logger name -> the handlers standing here for the tests' quiet ones on it (log_quiet)
        self.fn_sent = {}  # rid -> [function or generator the tests have a stand-in for, the names kept, their values, generator state]
        # Of those, the ones this side's code may reach (compared each message), and how that changed since last told.
        self.fn_track = True
        self.fn_hot = set()
        self.fn_heated = set()
        self.fn_cooled = set()
        self.fn_young = []  # rids handed to or by this side's code since the last message
        self.fn_young_prev = []  # ... before that: measured at the end of this message
        self.fn_far_in = 0
        self.fn_sent[0] = [lambda: None]
        self.objs[0] = self.fn_sent[0][0]
        self.fn_free = self._fn_refs(0)  # references the bookkeeping alone holds (objs, fn_sent)
        del self.fn_sent[0], self.objs[0]
        self.fs_new = []  # workspace paths the candidate's code changed, not yet reported (see _FS_CHANGE)
        self.fs_seen = set()
        self.cwd_maybe = True  # getcwd() may have changed since last asked (_CWD_EVENTS)
        self.cwd_any = False  # ... after any change (_FS_ANY)
        self.rstate = RandomState()
        self.proc = None  # ProcSettings (_install_guards)
        self.rlimit = sys.getrecursionlimit()  # recursion limit last exchanged
        import warnings

        self.warn_orig = (warnings.showwarning, warnings._showwarnmsg_impl)
        self.warn = None  # warnings state last exchanged
        self.dec = None  # decimal context last exchanged
        # The grader's code: this module's, and the worker script's below it (by module globals).
        f, files = _getframe(), set(GRADER_CODE)
        while f is not None:
            files.add(id(f.f_globals))
            f = f.f_back
        self.files = frozenset(files)
        guard_frames(self.files, self.files, self._poison, False)
        self.raises = _watch_raises(self)
        self._install_guards()
        w = StdWatch(self._std_changed)
        self.watch = w if w.ok else None

    def _crossed(self, x):
        """Whether x is shared with the tests' process: an object they hold, a linked container, a by-value object
        that crossed, or a test object."""
        t = type(x)
        if t is TestObject or t is TestData:
            return True
        i = id(x)
        rid = self.ids.get(i)
        if rid is not None and self.objs.get(rid) is x:
            return True
        n = self.link_of.get(i)
        if n is not None and self.links.get(n) is x:
            return True
        k = self.vkey.get(i)
        if k is not None and self.vobj.get(k) is x:
            return True
        k = self.tobj_ids.get(i)
        return k is not None and self.tobjs.get(k) is x

    def _install_guards(self):
        """The candidate's code asking about references or sizes of an object the tests' process shares, or listing
        every object, gets an answer one process wouldn't give (the grader's tables hold them; the tests' half is
        elsewhere): the run ends with a grader error."""
        gc, wr = _std("gc"), _std("weakref")

        def shared(what):
            def check(args):
                if any(map(self._crossed, args)):
                    raise self._poison("the candidate's code called %s on an object the tests' process shares (one process would count the tests' references too)" % what)

            return check

        def never(what):
            def check(args):
                raise self._poison("the candidate's code called %s, which would list the grader's objects and not the tests'" % what)

            return check

        def sized(args):
            # A copy of a tuple (a plain namedtuple), number, bytes or ASCII string has the original's size; a list, dict or set's
            # depends on how it grew, another string's on whether its UTF-8 form was cached.
            if args and self._crossed(args[0]) and not (type(args[0]) in _SIZED or type(args[0]) is str and args[0].isascii() or isinstance(args[0], tuple) and ntuple_fields(type(args[0])) is not None and _plain_ntuple(type(args[0]))):
                raise self._poison("the candidate's code called sys.getsizeof() on an object the tests' process shares (its copy here may not be the size of theirs)")

        for mod, name in ((sys, "getrefcount"), (gc, "get_referrers"), (gc, "get_referents"), (wr, "getweakrefcount"), (wr, "getweakrefs")):
            _guard(mod, name, shared("%s.%s()" % (mod.__name__, name)))
        _guard(sys, "getsizeof", sized)
        _guard(gc, "get_objects", never("gc.get_objects()"))
        # logging: the tests' process can't have the candidate's handlers and filters (the logger's list there ends
        # the run when used), nor its logger class or record factory.
        lg = _std("logging")

        def adds(args):
            if args and isinstance(args[0], lg.Logger):
                self.loghandlers.add("" if args[0] is lg.root else args[0].name)

        def setter(what):
            def check(args):
                raise self._poison("the candidate's code called %s, which would change logging in the tests' process too" % what)

            return check

        def removes(args):
            if len(args) > 1 and any(args[1] is h for hs in self.logquiet.values() for h in hs):
                adds(args)

        _guard(lg.Logger, "addHandler", adds)
        _guard(lg.Logger, "removeHandler", removes)
        _guard(lg.Logger, "addFilter", adds)
        for name in ("setLoggerClass", "setLogRecordFactory"):
            _guard(lg, name, setter("logging." + name))
        self.proc = ProcSettings(self._poison, self._poison)
        # Files the candidate's code changes in its copy of the workspace, for the tests' side (see _FS_CHANGE).
        self.fs_roots = fs_roots(self.cwd0)

        def fs_guard(ev, args):
            if ev in _FS_ANY:
                if ev[0] != "c" or fs_owner(_getframe(1), _GRADER_GLOBALS):  # not the grader's own ctypes calls
                    self._fs_note("*")
                    self.cwd_any = True
                return
            if ev in _CWD_EVENTS:
                self.cwd_maybe = True
            spec = _FS_CHANGE.get(ev)
            if spec is None or (ev == "open" and not (type(args[2]) is int and args[2] & _O_WRITE and type(args[0]) is not int)):
                return
            for i, j in spec:
                p = args[i] if i < len(args) else None
                if ev == "sqlite3.connect" and type(p) in (str, bytes) and p in _FS_MEMORY:
                    continue
                where = fs_where(p, args[j] if j is not None and j < len(args) else None)
                if where is False:
                    continue
                if where is None:
                    self._fs_note("*")
                    continue
                for w in (where, os.path.realpath(where)):
                    rel = fs_rel(w, self.fs_roots)
                    if rel is not None:
                        self._fs_note(rel)
                        if ev == "sqlite3.connect":
                            for suffix in _FS_SQLITE:
                                self._fs_note(rel + suffix)

        sys.addaudithook(fs_guard)

    def _fn_refs(self, rid):
        return _getrefcount(self.fn_sent[rid][0])

    def _fn_heat(self, rid):
        """The candidate's code has function (or generator) rid: compare it before each message."""
        if rid not in self.fn_hot:
            self.fn_hot.add(rid)
            if rid in self.fn_cooled:
                self.fn_cooled.discard(rid)  # the tests' side was never told
            else:
                self.fn_heated.add(rid)
        self.fn_young.append(rid)

    def _fn_reached(self, n):
        ids = self.ids
        for i in self.fn_in[n]:
            rid = ids.get(i)
            if rid in self.fn_sent and rid not in self.fn_hot:
                self._fn_heat(rid)

    def _fn_cold(self, rid):
        """Whether only the bookkeeping refers to function rid: its rid, fn_sent, and the storage and snapshots of
        links this side's code doesn't hold (unchanged since the snapshot)."""
        n = self._fn_refs(rid) - self.fn_free
        if n:
            where = self.fn_where.get(id(self.fn_sent[rid][0]))
            for k, c in (where or {}).items():
                if k in self.held or k not in self.links or changed(self.links[k], self.snaps[k], self.bases[k]):
                    return False
                n -= 2 * c
        return n == 0

    def _fn_sweep(self):
        """After a message: re-measure which functions and generators the tests have the candidate's code may still
        reach: the ones handed to or by it before the last message (most were a call's target, arguments or result),
        and in amortized sweeps all of them (about 8 per message). One only the bookkeeping holds stays as it is until
        the candidate's code gets it again (in a message, or a link that holds it)."""
        todo, self.fn_young_prev, self.fn_young = self.fn_young_prev, self.fn_young, []
        self.fn_far_in -= 1
        if self.fn_far_in <= 0:
            todo = list(self.fn_hot)
            self.fn_far_in = max(1, len(todo) // 8)
        young = set(self.fn_young_prev)
        for rid in todo:
            if rid in self.fn_hot and rid not in young and rid not in self.fn_heated and self._fn_cold(rid):
                self.fn_hot.discard(rid)
                self.fn_cooled.add(rid)

    def _fs_note(self, rel):
        if rel not in self.fs_seen:
            self.fs_seen.add(rel)
            self.fs_new.append(rel)

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
            return enc.keyed(v, lambda: {"t": "ntuple", "n": key_[0], "f": list(key_[1]), "v": [enc.enc(x, depth + 1, key) for x in tuple.__iter__(v)]})
        if isinstance(v, type):
            return self._class_tag(enc, v, depth)
        if isinstance(v, BaseException):
            return enc.aliased(v, lambda: self._object(enc, v, depth))
        if t is types.ModuleType:
            name = std_module_name(v)
            if name is not None:
                return {"t": "smod", "n": name}
        if t is types.MethodType:
            # By reference (the tests' side keeps one bound method for it while it lives), described the first time.
            tag = self._object(enc, v, depth)
            tag["meth"] = [enc.enc(v.__func__, depth + 1), enc.enc(v.__self__, depth + 1)] if "c" in tag else 1
            return tag
        tag = self._object(enc, v, depth)
        if t is types.FunctionType:
            if "c" in tag:
                tag["fn"] = self._fn_desc(enc, v, depth + 1)
                self.fn_sent[tag["id"]] = [v, _FN_CAND, _FN_GET[_FN_CAND](v), None, fn_dicts(v)]
            else:
                tag["fn"] = 1
        elif t is types.GeneratorType:
            tag["gen"] = [str(v.__name__), str(v.__qualname__), _gen_state(v)]
            if "c" in tag:
                self.fn_sent[tag["id"]] = [v, _GEN_SYNC, _FN_GET[_GEN_SYNC](v), tag["gen"][2], None]
        if t is types.FunctionType or t is types.GeneratorType:
            self._fn_heat(tag["id"])
        return tag

    def _fn_desc(self, enc, f, d):
        """What the tests' side needs for a real function standing for f (_make_forwarder)."""
        co = f.__code__
        n = co.co_argcount + co.co_kwonlyargcount + bool(co.co_flags & _CO_VARARGS) + bool(co.co_flags & _CO_VARKEYWORDS)
        name = co.co_filename
        out = {
            "name": str(f.__name__),
            "qual": str(f.__qualname__),
            "co": co.co_name,
            "coq": getattr(co, "co_qualname", str(f.__qualname__)),
            "argc": co.co_argcount,
            "posonly": co.co_posonlyargcount,
            "kwonly": co.co_kwonlyargcount,
            "flags": co.co_flags & (_CO_VARARGS | _CO_VARKEYWORDS | _CO_GENERATOR | _CO_COROUTINE | _CO_ASYNC_GENERATOR),
            "vars": list(co.co_varnames[:n]),
            "file": cwd_out(name, self.cwd0) if _isabs(name) else ["abs", name],
            "line": max(co.co_firstlineno, 1),
            "mod": enc.enc(f.__module__, d),
            "doc": enc.enc(f.__doc__, d),
            "defaults": enc.enc(f.__defaults__, d),
            "kwdefaults": enc.enc(f.__kwdefaults__, d),
            "dict": [[enc.enc(k, d, True), enc.enc(x, d)] for k, x in list(dict.items(f.__dict__))],
        }
        if sys.version_info < (3, 14):
            out["ann"] = [[enc.enc(k, d, True), enc.enc(x, d)] for k, x in list(dict.items(f.__annotations__))]
        tp = getattr(f, "__type_params__", ())
        if tp:
            out["tp"] = enc.enc(tp, d)
        return out

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
            if get["__weakrefoffset__"].__get__(cls) == 0:
                out["noweak"] = True  # __slots__ without __weakref__: weakref.ref() of one is a TypeError
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
            elif rid in self.fn_sent:
                self._fn_heat(rid)
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
                shape = x.get("n")
                if type(k) is not int or not isinstance(shape, list) or not all(isinstance(e, list) and len(e) == 2 and type(e[0]) is int and type(e[1]) is int for e in shape):
                    raise ProtocolError("bad test traceback")
                obj = self.tobjs[k] = synthetic_traceback(shape)
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
        if t == "meth":
            f, s = dec.dec(x.get("f"), d), dec.dec(x.get("s"), d)
            if not callable(f):
                raise ProtocolError("bad method")
            return types.MethodType(f, s)
        if t == "smod":
            m = import_std(x.get("n"))
            if m is None:
                raise self._poison("the tests handed over the standard-library module %s, which the candidate's process can't import" % clip(x.get("n"), 100))
            return m
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
        if "loglevels" in st:
            with _Quiet(self.watch):
                if not log_apply(st["loglevels"]):
                    self._poison("logging: the tests set a logger's level in a way the candidate's process can't")
            self.loglevels = log_levels()
        if "logquiet" in st:
            with _Quiet(self.watch):
                self._log_quiet(st["logquiet"])
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
        for path, name, how, value in st.get("std") or ():
            self._std_apply(path, name, how, value)
        if self.proc is not None:
            self.proc.apply(st)
        for name in st.get("unimport") or ():
            if not isinstance(name, str) or std_module(name):
                raise ProtocolError("bad module")
            sys.modules.pop(name, None)

    def _log_quiet(self, want):
        """The tests' loggers' quiet handlers (log_quiet()) as like ones on the same loggers here, added and removed
        without the candidate's own handlers or the guards seeing (a kind log_quiet() didn't know is left out)."""
        if not isinstance(want, dict):
            raise ProtocolError("bad logging handlers")
        lg = _std("logging")
        streams = (None, self.orig["stdout"], self.orig["stderr"])
        with lg._lock:
            for name in set(self.logquiet).union(want):
                kinds = want.get(name, [])
                if not isinstance(name, str) or not isinstance(kinds, list) or any(k not in (0, 1, 2, None) or type(k) is bool for k in kinds):
                    raise ProtocolError("bad logging handlers")
                x = lg.root if name == "" else lg.getLogger(name)
                old = set(map(id, self.logquiet.pop(name, ())))
                hs = [lg.NullHandler() if k == 0 else lg.StreamHandler(streams[k]) for k in kinds if k is not None]
                if (old or hs) and isinstance(x.handlers, list):
                    list.__setitem__(x.handlers, slice(None), [h for h in list.__iter__(x.handlers) if id(h) not in old] + hs)
                    if hs:
                        self.logquiet[name] = hs

    def _apply_fn(self, changes):
        for rid, name, value in changes:
            # The tests set an attribute of their stand-in for this function (or generator): the candidate's own gets it.
            if name == "close":
                g = self.objs.get(rid)
                if type(g) is types.GeneratorType:
                    try:
                        g.close()
                    except Exception as e:
                        self._poison("closing a candidate generator the tests closed failed (%s)" % clip(_safe_str(e), 200))
                continue
            hit = self.fn_sent.get(rid)
            if hit is None:
                if rid in self.objs:
                    self._poison("the tests set %s of a candidate function the grader didn't send them" % name)
                continue
            if name in _FN_DICTS:
                if hit[4] is None:
                    raise ProtocolError("bad function attribute")
                fn_dict_in(hit[0], name, value)
                hit[4] = fn_dicts(hit[0])
                continue
            if name not in hit[1] and not (name == "__annotations__" and "__annotate__" in hit[1]):
                raise ProtocolError("bad function attribute")
            try:
                setattr(hit[0], name, value)
            except Exception as e:
                self._poison("the tests set %s of a candidate function to a value it can't take here (%s)" % (name, clip(_safe_str(e), 200)))
                continue
            hit[2] = _FN_GET[hit[1]](hit[0])

    def _std_apply(self, path, name, how, value):
        """A standard-library module's or class's attribute as the tests changed it."""
        mod, _, qual = path.partition(":")
        t = import_std(mod)
        if t is not None and qual:
            t = resolve_std(path)
        if t is None:
            self._poison("the tests changed %s.%s, which the candidate's process doesn't have" % (clip(path, 200), clip(name, 100)))
            return
        key = (path, name)
        try:
            with _Quiet(self.watch):
                if key not in self.std_saved:
                    self.std_saved[key] = vars(t).get(name, _NO)
                if how == "orig":
                    value = self.std_saved[key]
                if how == "del" or value is _NO:
                    if name in vars(t):
                        delattr(t, name)
                else:
                    setattr(t, name, value)
        except Exception as e:
            self._poison("the tests changed %s.%s, which the candidate's process can't change the same way (%s)" % (clip(path, 200), clip(name, 100), clip(_safe_str(e), 200)))

    def _std_changed(self, where, path, name, old):
        """StdWatch: the candidate's code changed the standard library, which the tests' process can't see."""
        if where is None:
            self._poison("the candidate's code replaced or removed the standard-library module %s in sys.modules, which the tests' process can't share" % path)
        else:
            self._poison("the candidate's code set %s%s, a standard-library attribute the tests' process can't share" % (path[:-1] + "." if path.endswith(":") else path + ".", name))

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
        w = self.watch
        if w is not None:
            if w.broken is not None:
                self._poison("watching the candidate's changes to the standard library failed (%s)" % w.broken)
            w.flush()
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
        if self.cwd_maybe or self.cwd_any:
            self.cwd_maybe = False
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
        ll = log_levels()
        if ll != self.loglevels:
            if type(ll[0]) is not int or any(type(v[0]) is not int or type(v[1]) is not bool or type(v[2]) is not bool for v in ll[1].values()):
                self._poison("logging: the candidate's code set a logger's level, propagate or disabled to something other than an int or bool")
            else:
                self.loglevels = cst["loglevels"] = ll
        if self.loghandlers != self.loghandlers_sent:
            cst["loghandlers"] = sorted(self.loghandlers - self.loghandlers_sent)
            self.loghandlers_sent = set(self.loghandlers)
        if path_changed(self.path_obj, self.path0):
            self._poison("the candidate's code changed sys.path, which the tests' process can't share (its imports would differ)")
        if self.fs_new:
            cst["fs"], self.fs_new = self.fs_new, []
        if self.proc is not None:
            self.proc.out(cst)
        fn = []
        for n in self.touched:
            self._hold(n)  # as _outgoing does: functions in those links are the candidate code's again (_fn_reached)
        for rid in list(self.fn_hot):
            hit = self.fn_sent[rid]
            try:
                ch, hit[2] = fn_changes("the candidate's code", hit[0], hit[1], hit[2])
            except Inexact as e:
                self._poison(str(e))
                break
            if ch:
                fn.extend([rid, name, enc.enc(v)] for name, v in ch)
            if hit[4] is not None:
                try:
                    dch, hit[4] = fn_dict_changes("the candidate's code", enc, [getattr(hit[0], name) for name in _FN_DICTS], hit[4])
                except Inexact as e:
                    self._poison(str(e))
                    break
                if dch:
                    fn.extend([rid] + e for e in dch)
            if hit[3] is not None:
                st = _gen_state(hit[0])
                if st != hit[3]:
                    hit[3] = st
                    fn.append([rid, "start" if st == 1 else "close", None])
        if fn:
            cst["fn"] = fn
        if self.fn_heated:
            cst["fnheat"] = sorted(self.fn_heated)
            self.fn_heated = set()
        if self.fn_cooled:
            cst["fncool"] = sorted(self.fn_cooled)
            self.fn_cooled = set()
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
            rs = self.rstate.maybe(r) if r is not None else None
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
                for k in enc.vmade:
                    self._vforget(k)
                self.refd = set()
                if "rep" not in msg:
                    raise
                why = clip(_safe_str(e) or type(e).__name__, 300)
                msg = {"rep": {"unsendable": why if isinstance(e, (GraderError, RecursionError)) else "%s while sending the result: %s" % (type(e).__name__, why)}, "v": []}
                enc = Encoder(self, CANDIDATE_NAMES_OUT)
            self._report(msg, enc)
            self._outgoing(enc, msg)
            if self.fn_hot:
                self._fn_sweep()
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
                # In the order the tests' side encoded them (a value's key comes before references to it).
                for name in ("stdout", "stderr", "stdin"):
                    v = st.get(name)
                    if isinstance(v, list) and len(v) >= 2:
                        st[name] = v[:-1] + [dec.dec(v[-1])]
                for name in ("print", "input", "argv"):
                    if st.get(name) is not None:
                        st[name] = dec.dec(st[name])
                ws = st.get("warnings")
                if ws is not None:
                    if not (isinstance(ws, list) and len(ws) == 3):
                        raise ProtocolError("bad warnings state")
                    st["warnings"] = (warnings_in(dec, ws[0]), None if ws[1] is None else dec.dec(ws[1]), None if ws[2] is None else dec.dec(ws[2]))
                sv = st.get("std")
                if sv is not None:
                    if not isinstance(sv, list):
                        raise ProtocolError("bad standard-library state")
                    out = []
                    for e in sv:
                        if not (isinstance(e, list) and len(e) in (3, 4) and isinstance(e[0], str) and isinstance(e[1], str) and e[2] in ("orig", "del", "set") and (len(e) == 4) == (e[2] == "set")):
                            raise ProtocolError("bad standard-library state")
                        out.append((e[0], e[1], e[2], dec.dec(e[3]) if len(e) == 4 else None))
                    st["std"] = out
                if "fn" in st:
                    st["fn"] = fn_change_in(dec, st["fn"])
            self._incoming(dec, msg)
            if isinstance(st, dict) and "fn" in st:
                # Before the releases: what the tests set on a stand-in that died since reaches the candidate's own.
                self._apply_fn(st.pop("fn"))
            weak = msg.get("weak") or ()
            # In the order the tests dropped them: an object the tests held weakly must die as its proxy did.
            for rid in msg.get("release") or ():
                self.fn_sent.pop(rid, None)
                self.fn_hot.discard(rid)
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
        n = RAISED[0]
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
            elif RAISED[0] != n and not isinstance(e, GraderError):
                self._poison("the candidate's code caught a grading error (%s)" % RAISED[1])
            self._send({"rep": {"raise": True}}, [e])
            return
        self.depth -= 1
        if RAISED[0] != n:
            self._poison("the candidate's code caught a grading error (%s)" % RAISED[1])
        self._send({"rep": {"ok": True}}, [result])

    def _op(self, req, got):
        op = req.get("op")
        name = req.get("name")
        if op == "import":
            import importlib

            if req.get("reload") is True:
                return importlib.reload(sys.modules[str(name)])
            if req.get("fresh") is True:
                sys.modules.pop(str(name), None)
            return importlib.import_module(str(name))
        if op == "gc":
            gen = got[0] if got else 2
            return _std("gc").collect(gen if type(gen) is int and 0 <= gen <= 2 else 2)
        if op == "status":
            return self._status()
        if op == "unpatch":
            return self._unpatch(name, req.get("attr"))
        if not got:
            raise ProtocolError("no target")
        obj = got[0]
        if op == "id":
            return id(obj)
        if op == "names":
            if type(obj) is not types.ModuleType:
                raise ProtocolError("names of a non-module")
            return list(vars(obj))
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
        if op == "step":
            return self._step(obj, req.get("how"), got[1] if len(got) == 2 else None)
        if op == "copy":
            import copy as _copy

            return _copy.deepcopy(obj) if req.get("deep") else _copy.copy(obj)
        raise ProtocolError("unknown op %r" % clip(op, 40))

    def _step(self, c, how, v):
        """One step of candidate coroutine c for the tests' event loop (_await_candidate): (0, its result) once it
        returns, (1, None) where it yielded to the loop, (2, None) where it yielded anything else. Its asyncio sees
        a running loop that is a grader error to use (_NoLoop)."""
        if type(c) is not types.CoroutineType or how not in ("send", "throw"):
            raise ProtocolError("bad coroutine step")
        aio = _std("_asyncio") or _std("asyncio.events")
        prev = aio._get_running_loop()
        aio._set_running_loop(_NoLoop())
        try:
            y = c.send(v) if how == "send" else c.throw(v)
        except StopIteration as e:
            return (0, e.value)
        finally:
            aio._set_running_loop(prev)
        return (1, None) if y is None else (2, None)

    def _status(self):
        """Between tests: nothing changed what the tests can see since the last answer (a thread of the candidate's).
        Links only the candidate reaches may hold changes it made during calls: the tests get those when they get
        the link."""
        if self.out:
            self._poison("the candidate's code wrote output after returning (a thread)")
        for rid in self.fn_hot:
            hit = self.fn_sent[rid]
            if any(map(is_not, _FN_GET[hit[1]](hit[0]), hit[2])) or hit[3] is not None and _gen_state(hit[0]) != hit[3] or hit[4] is not None and not fn_dicts_same([getattr(hit[0], name) for name in _FN_DICTS], hit[4]):
                self._poison("the candidate's code changed a function or generator the tests have after returning (a thread)")
                break
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
        with _Quiet(self.watch):
            setattr(t, attr, value)
        self.patches.append((path, attr, t, old))

    def _unpatch(self, path, attr):
        for i in range(len(self.patches) - 1, -1, -1):
            p, a, t, old = self.patches[i]
            if p == path and a == attr:
                del self.patches[i]
                with _Quiet(self.watch):
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
