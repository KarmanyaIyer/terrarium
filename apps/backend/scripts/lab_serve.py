"""Neuron Lab sidecar: one model in models/, with hooks on every MLP neuron, served to the Terrarium backend.

Started by the backend (apps/backend/src/lab/sidecar.ts) with the repo .venv's python -I. Listens on 127.0.0.1 on a
port it picks, prints {"port": N} as its first stdout line, and answers only requests with the per-launch key from
TERRARIUM_LAB_KEY. The model loads in the background; GET /health reports progress. One model per process: the
backend stops the process to unload.

Routes: GET /health; POST /probe /find /neuron /generate /sweep /attribute /examples /explore (lab_core.Lab, one at a
time); POST /tokens and /cancel (no wait: tokenizing a field, stopping the op that runs); PUT and DELETE /strains/<id>
(the mix a strain model id stands for); POST /v1/chat/completions and /v1/tokenize for sessions and evals that use a
strain. Chat requests go through oMLX's own message preparation, chat template call, thinking split
and tool-call parsers (imported from the omlx package in the same .venv), so a strain's tool calls parse exactly as
the base model's do in oMLX.
"""

import argparse
import hmac
import json
import os
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script dir off sys.path

import mlx.core as mx  # noqa: E402

from lab_core import Lab, LabError  # noqa: E402

MAX_BODY = 32 * 1024 * 1024
STRAIN_PREFIX = "strain:"


class State:
    def __init__(self):
        self.lab: Lab | None = None
        self.status = "loading"
        self.stage = "starting"
        self.progress = 0.0
        self.detail: str | None = None
        self.busy: str | None = None
        self.lock = threading.Lock()  # one model op at a time: MLX generation isn't re-entrant
        self.key = os.environ.get("TERRARIUM_LAB_KEY", "")
        self.port = 0


S = State()


def log(msg: str) -> None:
    try:
        print(f"lab: {msg}", file=sys.stderr, flush=True)
    except OSError:
        pass


def load_in_background(model_dir: str, cache_dir: str | None) -> None:
    def progress(stage: str, frac: float) -> None:
        S.stage, S.progress = stage, round(frac, 3)

    def run():
        try:
            S.lab = Lab(model_dir, cache_dir=cache_dir, log=log, progress=progress)
            S.status = "ready"
            log(f"ready: {S.lab.model_id} in {S.lab.load_ms} ms, {mx.get_active_memory() / 1e9:.2f} GB active")
        except LabError as err:
            S.status, S.detail = "error", str(err)
        except Exception as err:  # noqa: BLE001: reported to the backend
            S.status, S.detail = "error", f"{type(err).__name__}: {err}"
            traceback.print_exc()

    threading.Thread(target=run, name="lab-load", daemon=True).start()


# ---------- chat (OpenAI-compatible, for strains in sessions and evals) ----------


def _omlx():
    from omlx.api import openai_models, thinking, tool_calling, utils

    return openai_models, thinking, tool_calling, utils


def prepare_chat(body: dict):
    """oMLX's preparation for a chat request: (request, template messages, tools for the template, prompt text, ids)."""
    openai_models, thinking, tool_calling, utils = _omlx()
    lab = S.lab
    req = openai_models.ChatCompletionRequest.model_validate(body)
    native = utils.uses_native_reasoning_content(lab.model_id, config_model_type=lab.config.get("model_type"), engine_model_type=lab.arch)
    messages = utils.extract_text_content(req.messages, None, lab.tok, native_reasoning_content=native, consolidate_system_messages=True)
    tools = None
    if req.tools and req.tool_choice != "none":
        tools = tool_calling.convert_tools_for_template([t.model_dump() for t in req.tools])
        if tools and "gemma" in lab.model_id.lower():
            tools = tool_calling.enrich_tool_params_for_gemma4(tools)
    kwargs = dict(req.chat_template_kwargs or {})
    if req.enable_thinking is not None and "enable_thinking" not in kwargs:
        kwargs["enable_thinking"] = req.enable_thinking
    prompt = lab.render_chat(messages, tools=tools, **kwargs)
    ids = lab.tok.encode(prompt, add_special_tokens=False)
    return req, messages, tools, prompt, ids


def strain_pushes(model: str) -> list:
    if not model.startswith(STRAIN_PREFIX):
        raise LabError(f"model {model!r} is not a strain served by the Lab")
    sid = model[len(STRAIN_PREFIX) :]
    if sid not in S.lab.strains:
        raise LabError(f"strain {sid} is not registered with the Lab")
    return S.lab.strains[sid]


def chat_completion(body: dict, emit) -> dict | None:
    """Generates with the strain's mix. emit(event_json_or_None) streams SSE when the request asks for it; returns the
    response object otherwise."""
    openai_models, thinking, tool_calling, utils = _omlx()
    lab = S.lab
    req, messages, tools, prompt, ids = prepare_chat(body)
    pushes = strain_pushes(req.model)
    max_tokens = req.max_tokens or 4096
    temp = 0.7 if req.temperature is None else req.temperature
    # the repeat penalty only, as the Lab tested the recipe: a presence penalty in the request (older clients) is ignored
    sampler, procs = lab.sampler_for(temp, top_p=req.top_p, top_k=req.top_k, repeat=lab.STRAIN_REPEAT)
    opens, _ = thinking.prompt_opens_thinking(lab.tok, prompt, prompt_token_ids=ids)
    stream = bool(req.stream)
    rid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    created = int(time.time())

    def chunk(delta: dict | None = None, finish=None, usage=None) -> dict:
        out = {"id": rid, "object": "chat.completion.chunk", "created": created, "model": req.model, "choices": [] if usage else [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}
        if usage:
            out["usage"] = usage
        return out

    parser = thinking.ThinkingParser(start_in_thinking=opens)
    content_filter = tool_calling.ToolCallStreamFilter(lab.tok, tools=tools) if tools else None
    thinking_filter = tool_calling.ToolCallStreamFilter(lab.tok, tools=tools, consume_dsml_separator=False) if tools else None
    stream_content = content_filter is None or content_filter.active
    if stream:
        emit(chunk({"role": "assistant"}))
    t0 = time.perf_counter()
    first_at = None
    text = ""
    n_out = 0
    finish = "length"
    last = None
    lab.apply_mix(pushes)
    try:
        for r in lab.stream(ids, max_tokens, sampler, procs, seed=req.seed):
            last = r
            if first_at is None:
                first_at = time.perf_counter()
            if r.finish_reason is None or r.finish_reason == "length":
                n_out += 1
            if r.finish_reason:
                finish = r.finish_reason
            seg = r.text
            if not seg:
                continue
            text += seg
            if req.stop and any(s and s in text for s in req.stop):
                cut = min(text.index(s) for s in req.stop if s and s in text)
                text, finish = text[:cut], "stop"
                break
            if stream and stream_content:
                th, co = parser.feed(seg)
                if th and thinking_filter:
                    th = thinking_filter.feed(th)
                if co and content_filter:
                    co = content_filter.feed(co)
                if th:
                    emit(chunk({"reasoning_content": th}))
                if co:
                    emit(chunk({"content": co}))
    finally:
        lab.clear()
    elapsed = time.perf_counter() - t0
    raw = utils.clean_special_tokens(text) if text else ""
    th_all, regular = thinking.extract_thinking(raw, truncated=finish == "length", start_in_thinking=opens and finish == "length")
    tool_calls = None
    failure = None
    cleaned_text, cleaned_thinking = regular, utils.clean_special_tokens(th_all) if th_all else th_all
    if tools and raw:
        ex = tool_calling.extract_tool_calls_with_thinking(th_all, regular, lab.tok, tools, finish_reason=finish)
        tool_calls, cleaned_text, cleaned_thinking = ex.tool_calls, ex.cleaned_text, ex.cleaned_thinking
        if ex.parse_errors:
            failure = "incomplete_tool_call" if "incomplete" in ex.parse_errors else "invalid_tool_call"
    calls = []
    for tc in tool_calls or []:
        args = tc.function.arguments
        if "gemma" in lab.model_id.lower() and args:
            try:
                args = json.dumps(tool_calling.restore_gemma4_param_names(json.loads(args)), ensure_ascii=False)
            except (json.JSONDecodeError, AttributeError):
                pass
        calls.append({"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": args}})
    ttft = (first_at - t0) if first_at else None
    gen_s = elapsed - (ttft or 0)
    usage = {
        "prompt_tokens": len(ids),
        "completion_tokens": n_out,
        "total_tokens": len(ids) + n_out,
        **({"time_to_first_token": round(ttft, 4)} if ttft else {}),
        **({"prompt_tokens_per_second": round(last.prompt_tps, 2)} if last else {}),
        **({"generation_tokens_per_second": round(n_out / gen_s, 2)} if gen_s > 0 else {}),
    }
    if failure:
        message = "Model output contains an unrecoverable tool call. Previously delivered tool calls must not be executed again on retry."
        err = {"error": {"message": message, "type": "server_error", "code": failure}}
        if stream:
            emit(err)
            return None
        raise ChatError(500, err)
    finish_reason = "tool_calls" if calls else finish
    if stream:
        if not stream_content:
            if cleaned_thinking:
                emit(chunk({"reasoning_content": cleaned_thinking}))
            if cleaned_text:
                emit(chunk({"content": cleaned_text}))
        else:
            th_rest, co_rest = parser.finish(truncated=finish == "length", has_tool_calls=bool(calls))
            if th_rest and thinking_filter:
                th_rest = thinking_filter.feed(th_rest) + thinking_filter.finish()
            if content_filter:
                co_rest = content_filter.feed(co_rest) + content_filter.finish() if co_rest else content_filter.finish()
            if th_rest:
                emit(chunk({"reasoning_content": th_rest}))
            if co_rest and not calls:
                emit(chunk({"content": co_rest}))
        for i, c in enumerate(calls):
            emit(chunk({"tool_calls": [{"index": i, **c}]}))
        emit(chunk({}, finish_reason))
        emit(chunk(usage=usage))
        return None
    message = {"role": "assistant", "content": cleaned_text.strip() if cleaned_text else None}
    if cleaned_thinking:
        message["reasoning_content"] = cleaned_thinking
    if calls:
        message["tool_calls"] = calls
    return {"id": rid, "object": "chat.completion", "created": created, "model": req.model, "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}], "usage": usage}


class ChatError(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(json.dumps(body))
        self.status, self.body = status, body


def tokenize(body: dict) -> dict:
    lab = S.lab
    if "messages" in body:
        body = {**body, "messages": body["messages"]}
        _, _, _, _, ids = prepare_chat({"model": body.get("model", ""), "messages": body["messages"], **({"tools": body["tools"]} if body.get("tools") else {}), **({"chat_template_kwargs": body["chat_template_kwargs"]} if body.get("chat_template_kwargs") else {})})
    else:
        ids = lab.tok.encode(str(body.get("prompt", "")), add_special_tokens=bool(body.get("add_special_tokens", False)))
    tc = lab.config.get("text_config", lab.config)
    return {"count": len(ids), "tokens": ids, "max_model_len": tc.get("max_position_embeddings")}


# ---------- HTTP ----------

LAB_ROUTES = {"/probe": "probe", "/find": "find", "/neuron": "neuron", "/generate": "generate", "/sweep": "sweep", "/attribute": "attribute", "/examples": "write_examples", "/explore": "explore"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "terrarium-lab"

    def log_message(self, fmt, *args):  # quiet: the backend logs requests
        pass

    def _send(self, status: int, obj) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"error": message})

    def _gate(self) -> bool:
        host = self.headers.get("host", "")
        if host not in (f"127.0.0.1:{S.port}", f"localhost:{S.port}"):
            self._error(403, "host not allowed")
            return False
        got = self.headers.get("authorization", "")
        if not S.key or not hmac.compare_digest(got.encode(), f"Bearer {S.key}".encode()):
            self._error(401, "missing or invalid key")
            return False
        return True

    def _body(self) -> dict | None:
        n = int(self.headers.get("content-length") or 0)
        if n > MAX_BODY:
            self._error(413, "request body too large")
            return None
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._error(400, "invalid JSON body")
            return None
        if not isinstance(body, dict):
            self._error(400, "body must be a JSON object")
            return None
        return body

    def do_GET(self):
        if not self._gate():
            return
        if self.path == "/health":
            out = {"status": S.status, "stage": S.stage, "progress": S.progress, "busy": S.busy, "activeBytes": int(mx.get_active_memory()), "peakBytes": int(mx.get_peak_memory())}
            if S.detail:
                out["detail"] = S.detail
            if S.lab and S.status == "ready":
                out["facts"] = S.lab.facts()
                out["strains"] = sorted(S.lab.strains)
            return self._send(200, out)
        self._error(404, "not found")

    def do_PUT(self):
        if not self._gate():
            return
        body = self._body()
        if body is None:
            return
        if self.path.startswith("/strains/") and S.lab:
            pushes = body.get("pushes")
            if not isinstance(pushes, list):
                return self._error(400, "pushes must be a list")
            try:
                S.lab.check_mix(pushes)  # no lock: a strain registers while another one generates
            except LabError as err:
                return self._error(400, str(err))
            S.lab.strains[self.path[len("/strains/") :]] = pushes
            return self._send(200, {"ok": True})
        self._error(404 if S.lab else 409, "not found" if S.lab else "model not loaded")

    def do_DELETE(self):
        if not self._gate():
            return
        if self.path.startswith("/strains/") and S.lab:
            S.lab.strains.pop(self.path[len("/strains/") :], None)
            return self._send(200, {"ok": True})
        self._error(404, "not found")

    def do_POST(self):
        if not self._gate():
            return
        body = self._body()
        if body is None:
            return
        op = LAB_ROUTES.get(self.path)
        if op is None and self.path not in ("/v1/chat/completions", "/v1/tokenize", "/tokens", "/cancel"):
            return self._error(404, "not found")
        if S.status != "ready" or S.lab is None:
            return self._error(409, S.detail or f"model is {S.status} ({S.stage})")
        if self.path == "/v1/tokenize":
            try:
                return self._send(200, tokenize(body))
            except Exception as err:  # noqa: BLE001
                return self._error(400, f"{type(err).__name__}: {err}")
        if self.path == "/tokens":
            try:
                return self._send(200, S.lab.tokens(body))
            except LabError as err:
                return self._error(400, str(err))
        if self.path == "/cancel":
            S.lab.cancelled = True
            return self._send(200, {"ok": True, "busy": S.busy})
        if self.path == "/v1/chat/completions":
            return self._chat(body)
        with S.lock:
            S.busy = op
            S.lab.cancelled = False
            try:
                out = getattr(S.lab, op)(body)
            except LabError as err:
                return self._error(400, str(err))
            except Exception as err:  # noqa: BLE001
                traceback.print_exc()
                return self._error(500, f"{type(err).__name__}: {err}")
            finally:
                S.lab.clear()
                S.busy = None
        self._send(200, out)

    def _chat(self, body: dict) -> None:
        streamed = bool(body.get("stream"))
        started = False

        def start():
            nonlocal started
            if not started:
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("connection", "close")
                self.end_headers()
                started = True

        def emit(obj):
            start()
            self.wfile.write(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()

        if streamed:
            # Queued behind another generation: answer now and send SSE comments while waiting, so the client's
            # header and idle timeouts (5 min in Node's fetch) don't cut the request off.
            try:
                strain_pushes(str(body.get("model", "")))
            except LabError as err:
                return self._send(400, {"error": {"message": str(err), "type": "invalid_request_error"}})
            while not S.lock.acquire(timeout=10):
                try:
                    start()
                    self.wfile.write(b": queued behind another request\n\n")
                    self.wfile.flush()
                except OSError:
                    self.close_connection = True
                    return
        else:
            S.lock.acquire()
        S.busy = "session"
        try:
            out = chat_completion(body, emit if streamed else (lambda _o: None))
        except (BrokenPipeError, ConnectionResetError):
            log("client closed the connection; generation stopped")
            self.close_connection = True
            return
        except ChatError as err:
            return self._send(err.status, err.body) if not started else None
        except LabError as err:
            if started:
                emit({"error": {"message": str(err), "type": "invalid_request_error"}})
                self.wfile.write(b"data: [DONE]\n\n")
                self.close_connection = True
                return
            return self._send(400, {"error": {"message": str(err), "type": "invalid_request_error"}})
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            if started:
                try:
                    emit({"error": {"message": f"{type(err).__name__}: {err}", "type": "server_error"}})
                    self.wfile.write(b"data: [DONE]\n\n")
                except OSError:
                    pass
                self.close_connection = True
                return
            return self._send(500, {"error": {"message": f"{type(err).__name__}: {err}", "type": "server_error"}})
        finally:
            S.busy = None
            S.lock.release()
        if streamed:
            try:
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except OSError:
                pass
            self.close_connection = True
        else:
            self._send(200, out)


def exit_with_parent() -> None:
    """The backend holds our stdin open and never writes to it. EOF, or being reparented, means it died without
    stopping us: exit rather than keep a model loaded with nobody to stop it (same as omlx_serve.py)."""
    import select

    parent = os.getppid()

    def watch() -> None:
        fd = sys.stdin.fileno()
        while True:
            ready, _, _ = select.select([fd], [], [], 2.0)
            if ready and not os.read(fd, 4096):
                break
            if os.getppid() != parent:
                break
        log("backend is gone; exiting")
        os._exit(0)

    threading.Thread(target=watch, name="lab-parent-watch", daemon=True).start()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--cache-limit-bytes", type=int, default=512 * 1024 * 1024)
    args = ap.parse_args()
    if not S.key:
        print("lab: TERRARIUM_LAB_KEY is not set", file=sys.stderr)
        sys.exit(2)
    mx.set_cache_limit(args.cache_limit_bytes)
    if os.environ.get("TERRARIUM_PARENT_STDIN") == "1":
        exit_with_parent()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    S.port = httpd.server_address[1]
    print(json.dumps({"port": S.port}), flush=True)
    load_in_background(args.model_dir, args.cache_dir)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
