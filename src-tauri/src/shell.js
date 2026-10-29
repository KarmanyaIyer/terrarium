// Injected into the main window before the UI loads.
// - Insets the UI's top bar for the overlay title bar's traffic lights (the bar is already a drag region).
// - window.__terrariumBackendError(err): full-window error view with the backend's stderr tail.
(function () {
  if (window.__terrariumShell) return;
  window.__terrariumShell = true;

  var CSS =
    ".topbar{padding-left:80px!important}" +
    "#terrarium-error{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;gap:12px;" +
    "padding:52px 24px 24px;background:#16181c;color:#e6e8eb;font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif}" +
    "#terrarium-error h1{margin:0;font-size:15px;font-weight:650}" +
    "#terrarium-error p{margin:0;color:#aab0b8}" +
    "#terrarium-error pre{flex:1;min-height:0;overflow:auto;margin:0;padding:10px 12px;border-radius:6px;" +
    "background:#0d0e10;border:0.5px solid #2c3036;color:#d0d4d9;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}" +
    "#terrarium-error .row{display:flex;gap:8px}" +
    "#terrarium-error button{height:26px;padding:0 12px;border-radius:5px;border:0.5px solid #3a3f46;background:#23262b;color:#e6e8eb;font:inherit}" +
    "#terrarium-error button:hover{background:#2c3036}" +
    "#terrarium-error .drag{position:absolute;top:0;left:0;right:0;height:40px}";

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
  });

  function invoke(cmd) {
    return window.__TAURI_INTERNALS__.invoke(cmd);
  }

  window.__terrariumBackendError = function (err) {
    ready(function () {
      var old = document.getElementById("terrarium-error");
      if (old) old.remove();
      var root = document.createElement("div");
      root.id = "terrarium-error";
      var drag = document.createElement("div");
      drag.className = "drag";
      drag.setAttribute("data-tauri-drag-region", "");
      var h = document.createElement("h1");
      h.textContent = "Terrarium backend failed";
      var p = document.createElement("p");
      p.textContent = err.message;
      var pre = document.createElement("pre");
      pre.textContent = err.stderr || "(no stderr output)";
      var row = document.createElement("div");
      row.className = "row";
      var retry = document.createElement("button");
      retry.textContent = "Restart backend";
      retry.onclick = function () {
        retry.disabled = true;
        retry.textContent = "Starting...";
        invoke("restart_backend").then(
          function () { location.reload(); },
          function () { retry.disabled = false; retry.textContent = "Restart backend"; }
        );
      };
      var quit = document.createElement("button");
      quit.textContent = "Quit";
      quit.onclick = function () { invoke("quit_app"); };
      row.append(retry, quit);
      root.append(drag, h, p, pre, row);
      document.body.appendChild(root);
      pre.scrollTop = pre.scrollHeight;
    });
  };
})();
