"""Start oMLX 0.7.2 with only the routes Terrarium uses.

Terrarium is the only client (loopback + random API key). This launcher also removes every route that
could fetch from the web, run MCP tools, execute model-written code (accuracy benchmarks), download or
upload models, or serve the admin web UI. Arguments are passed through to `omlx serve`.
"""

import os
import re
import sys

os.environ["OMLX_HEADLESS"] = "1"  # read by omlx.server at import time

import omlx.server as server  # noqa: E402
from omlx.cli import main  # noqa: E402

ALLOWED = [
    ("GET", r"/health"),
    ("GET", r"/api/status"),
    ("GET", r"/v1/models"),
    ("GET", r"/v1/models/status"),
    ("POST", r"/v1/models/[^/]+/load"),
    ("POST", r"/v1/models/[^/]+/unload"),
    ("POST", r"/v1/chat/completions"),
    ("POST", r"/v1/tokenize"),
    ("GET", r"/admin/api/models"),
    ("PUT", r"/admin/api/models/[^/]+/settings"),
    ("POST", r"/admin/api/reload"),  # re-scan the model dir after Terrarium adds or removes a model
    ("GET", r"/admin/api/models/[^/]+/generation_config"),
    ("GET", r"/admin/api/device-info"),
    ("GET", r"/admin/api/stats"),
]


_COMPILED = [(m, re.compile("^" + p + "$")) for m, p in ALLOWED]


def _request_allowed(method: str, path: str) -> bool:
    return any(m == method and rx.match(path) for m, rx in _COMPILED)


class AllowlistMiddleware:
    """Outermost app middleware: rejects every request outside ALLOWED, whichever router serves it."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        if scope["type"] != "http" or not _request_allowed(scope.get("method", ""), scope.get("path", "")):
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
                return
            await send({"type": "http.response.start", "status": 404, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": b'{"detail":"not available in Terrarium"}'})
            return
        return await self.app(scope, receive, send)


server.app.add_middleware(AllowlistMiddleware)
print(f"terrarium: oMLX allowlist active ({len(ALLOWED)} routes)", flush=True)


def _exit_with_parent() -> None:
    """The backend holds our stdin open and never writes to it. EOF, or being reparented, means it died without
    stopping us: shut down (SIGTERM, then a hard exit) rather than keep a model loaded with nobody to stop it."""
    import select
    import signal
    import threading
    import time

    parent = os.getppid()

    def watch() -> None:
        fd = sys.stdin.fileno()
        while True:
            ready, _, _ = select.select([fd], [], [], 2.0)
            if ready and not os.read(fd, 4096):
                break
            if os.getppid() != parent:
                break
        try:
            print("terrarium: backend is gone; stopping oMLX", flush=True)
        except OSError:
            pass  # stdout is a pipe to the backend too: usually broken by now
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(10)
        os._exit(1)

    threading.Thread(target=watch, name="terrarium-parent-watch", daemon=True).start()


if os.environ.get("TERRARIUM_PARENT_STDIN") == "1":
    _exit_with_parent()

if __name__ == "__main__":
    sys.argv = ["omlx", "serve", *sys.argv[1:]]
    main()
