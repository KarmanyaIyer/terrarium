// Terrarium app shell: starts the Node backend, hands its URL and token to the UI (`backend_info`),
// hides the window on close, and stops the backend cleanly on Quit.

mod backend;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use backend::{Backend, BackendError, BackendInfo, Launch};
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, LogicalPosition, Manager, RunEvent, State, TitleBarStyle, WebviewUrl, WebviewWindowBuilder,
    WindowEvent, Wry,
};

/// Time the backend gets to save VMs and stop oMLX after SIGTERM before its process group is killed.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
const READY_TIMEOUT: Duration = Duration::from_secs(130);

static QUITTING: AtomicBool = AtomicBool::new(false);
static EXIT_OK: AtomicBool = AtomicBool::new(false);

/// Only debug builds know the repo they were built from; release builds carry no build-machine paths.
#[cfg(debug_assertions)]
fn repo_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

#[cfg(not(debug_assertions))]
fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default()
}

#[cfg(not(debug_assertions))]
fn resources(app: &AppHandle) -> PathBuf {
    app.path().resource_dir().unwrap_or_else(|_| exe_dir().join("../Resources"))
}

/// Default data, models and Python locations: the repo's data/, models/ and .venv in debug builds; in the
/// app, ~/Library/Application Support/Terrarium for data and models, and the Python bundled with it.
fn default_paths(app: &AppHandle) -> backend::Paths {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let repo = repo_dir();
        backend::Paths { data: repo.join("data"), models: repo.join("models"), venv: repo.join(".venv") }
    }
    #[cfg(not(debug_assertions))]
    {
        let support = backend::support_dir();
        backend::Paths { data: support.join("data"), models: support.join("models"), venv: resources(app).join("app/python") }
    }
}

#[cfg(debug_assertions)]
fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .and_then(|p| std::env::split_paths(&p).map(|d| d.join(name)).find(|f| f.is_file()))
}

/// Debug builds (`tauri dev`) run the backend from source with the `node` on PATH. Release builds run
/// the bundled Node on the bundled backend (see scripts/package.sh for the layout).
fn launch(app: &AppHandle) -> Launch {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let repo = repo_dir();
        let node = std::env::var_os("TERRARIUM_NODE")
            .map(PathBuf::from)
            .or_else(|| find_in_path("node"))
            .unwrap_or_else(|| PathBuf::from("node"));
        Launch { node, script: repo.join("apps/backend/src/main.ts"), cwd: repo.join("apps/backend") }
    }
    #[cfg(not(debug_assertions))]
    {
        let backend = resources(app).join("app/apps/backend");
        Launch { node: exe_dir().join("node"), script: backend.join("dist/main.js"), cwd: backend }
    }
}

fn start_backend(app: &AppHandle, backend: &Arc<Backend>) {
    if let Ok(url) = std::env::var("TERRARIUM_BACKEND_URL") {
        if !url.is_empty() {
            let token = std::env::var("TERRARIUM_BACKEND_TOKEN").unwrap_or_default();
            eprintln!("terrarium: using external backend {url}");
            backend.attach(url, token);
            return;
        }
    }
    let paths = backend::resolve_paths(default_paths(app));
    let log = (!cfg!(debug_assertions)).then(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join("Library/Logs/Terrarium/backend.log")
    });
    backend.start(&launch(app), &paths, log);
}

fn show_error(app: &AppHandle, err: &BackendError) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!(
            "window.__terrariumBackendError && window.__terrariumBackendError({})",
            serde_json::to_string(err).unwrap_or_default()
        );
        let _ = w.eval(&js);
        let _ = w.show();
    }
}

/// Hide the window right away, give the backend up to STOP_TIMEOUT, then exit.
fn quit(app: &AppHandle) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    for w in app.webview_windows().values() {
        let _ = w.hide();
    }
    let backend = app.state::<Arc<Backend>>().inner().clone();
    let app = app.clone();
    thread::spawn(move || {
        backend.stop(STOP_TIMEOUT);
        EXIT_OK.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
async fn backend_info(backend: State<'_, Arc<Backend>>) -> Result<BackendInfo, String> {
    let b = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || b.wait_ready(READY_TIMEOUT))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn restart_backend(app: AppHandle, backend: State<'_, Arc<Backend>>) -> Result<BackendInfo, String> {
    let b = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        b.stop(STOP_TIMEOUT);
        start_backend(&app, &b);
        b.wait_ready(READY_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    quit(&app);
}

/// The page's undo bridge (App.tsx): false means a text field has focus, so the field's own undo runs.
fn edit_in_page(app: &AppHandle, action: &str) {
    let Some(w) = app.get_webview_window("main") else { return };
    let script = format!("if (!(window.__terrariumEdit && window.__terrariumEdit('{action}'))) document.execCommand('{action}');");
    let _ = w.eval(script);
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    // Custom Quit item: the predefined one terminates the process without giving the backend time.
    let quit_item = MenuItemBuilder::with_id("quit", "Quit Terrarium").accelerator("CmdOrCtrl+Q").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Terrarium")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit_item)
        .build()?;
    // Custom Undo and Redo: the predefined items only reach a focused text field, and the app has its own undo stack.
    let undo_item = MenuItemBuilder::with_id("undo", "Undo").accelerator("CmdOrCtrl+Z").build(app)?;
    let redo_item = MenuItemBuilder::with_id("redo", "Redo").accelerator("CmdOrCtrl+Shift+Z").build(app)?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&undo_item)
        .item(&redo_item)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;
    MenuBuilder::new(app).items(&[&app_menu, &edit, &view, &window]).build()
}

fn main() {
    let app = tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                quit(app);
            }
            if event.id() == "undo" || event.id() == "redo" {
                edit_in_page(app, event.id().as_ref());
            }
        })
        .invoke_handler(tauri::generate_handler![backend_info, restart_backend, quit_app])
        .setup(|app| {
            let handle = app.handle().clone();
            let backend = Backend::new(move |err| show_error(&handle, &err));
            app.manage(backend.clone());

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Terrarium")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1000.0, 640.0)
                .center()
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(LogicalPosition::new(14.0, 13.0))
                .initialization_script(include_str!("shell.js"))
                .on_page_load(|w, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        if let Some(err) = w.state::<Arc<Backend>>().last_error() {
                            show_error(w.app_handle(), &err);
                        }
                    }
                })
                .build()?;

            start_backend(app.handle(), &backend);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Terrarium");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } if !EXIT_OK.load(Ordering::SeqCst) => {
            api.prevent_exit();
            quit(app);
        }
        // Backstop for exits that skip ExitRequested (e.g. a system logout): stop is a no-op if done.
        RunEvent::Exit => app.state::<Arc<Backend>>().stop(STOP_TIMEOUT),
        RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
}
