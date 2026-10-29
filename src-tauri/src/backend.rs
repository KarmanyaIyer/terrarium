// Backend child process: spawn, handshake, stderr tail, graceful stop.
//
// The backend prints exactly one stdout line, {"port":N}, once it listens on 127.0.0.1. It exits on
// SIGTERM and on stdin EOF (TERRARIUM_PARENT_STDIN=1), so we keep its stdin open for its whole life.
// It runs in its own process group with oMLX and the VM runners; whenever it exits, that group is killed,
// so a crashed backend never leaves oMLX holding a model in memory.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const STDERR_TAIL_LINES: usize = 200;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);
/** After an unexpected backend exit, its children get this long after SIGTERM before SIGKILL. */
const ORPHAN_GRACE: Duration = Duration::from_secs(3);

#[derive(Clone, Serialize)]
pub struct BackendInfo {
    pub url: String,
    pub token: String,
}

#[derive(Clone, Serialize)]
pub struct BackendError {
    pub message: String,
    pub stderr: String,
}

#[derive(Clone)]
enum Status {
    Starting,
    Ready(BackendInfo),
    Failed(BackendError),
}

/// How to start the backend: a Node binary plus an entry script.
pub struct Launch {
    pub node: PathBuf,
    pub script: PathBuf,
    pub cwd: PathBuf,
}

/// Data, models and oMLX venv locations, passed as TERRARIUM_DATA / _MODELS / _VENV.
pub struct Paths {
    pub data: PathBuf,
    pub models: PathBuf,
    pub venv: PathBuf,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ConfigFile {
    data_dir: Option<String>,
    models_dir: Option<String>,
    venv_dir: Option<String>,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| "/".into()))
}

fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(p),
    }
}

pub fn config_path() -> PathBuf {
    home().join("Library/Application Support/Terrarium/config.json")
}

/// Env vars win, then ~/Library/Application Support/Terrarium/config.json, then the repo this app was
/// built from (personal app: the existing data/, models/ and .venv keep working without copying).
pub fn resolve_paths(repo: &Path) -> Paths {
    let file: ConfigFile = fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).map_err(|e| eprintln!("terrarium: bad config.json: {e}")).ok())
        .unwrap_or_default();
    let pick = |env: &str, cfg: Option<String>, default: PathBuf| -> PathBuf {
        std::env::var(env)
            .ok()
            .filter(|v| !v.is_empty())
            .map(|v| expand(&v))
            .or_else(|| cfg.map(|v| expand(&v)))
            .unwrap_or(default)
    };
    Paths {
        data: pick("TERRARIUM_DATA", file.data_dir, repo.join("data")),
        models: pick("TERRARIUM_MODELS", file.models_dir, repo.join("models")),
        venv: pick("TERRARIUM_VENV", file.venv_dir, repo.join(".venv")),
    }
}

fn random_token() -> std::io::Result<String> {
    let mut buf = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

struct Inner {
    status: Status,
    /// The backend process, while it runs.
    pid: Option<i32>,
    /// Its process group (oMLX, VM runners), until we have seen it empty. Outlives `pid`.
    pgid: Option<i32>,
    stdin: Option<ChildStdin>,
    stopping: bool,
    generation: u64,
    stderr_tail: VecDeque<String>,
}

pub struct Backend {
    inner: Mutex<Inner>,
    cv: Condvar,
    on_fail: Box<dyn Fn(BackendError) + Send + Sync>,
}

impl Backend {
    pub fn new(on_fail: impl Fn(BackendError) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                status: Status::Starting,
                pid: None,
                pgid: None,
                stdin: None,
                stopping: false,
                generation: 0,
                stderr_tail: VecDeque::new(),
            }),
            cv: Condvar::new(),
            on_fail: Box::new(on_fail),
        })
    }

    /// Dev mode: a backend started elsewhere (TERRARIUM_BACKEND_URL / TERRARIUM_BACKEND_TOKEN).
    pub fn attach(&self, url: String, token: String) {
        let mut g = self.inner.lock().unwrap();
        g.status = Status::Ready(BackendInfo { url, token });
        self.cv.notify_all();
    }

    pub fn last_error(&self) -> Option<BackendError> {
        match &self.inner.lock().unwrap().status {
            Status::Failed(e) => Some(e.clone()),
            _ => None,
        }
    }

    /// Blocks until the handshake arrives, the start fails, or `timeout` passes.
    pub fn wait_ready(&self, timeout: Duration) -> Result<BackendInfo, String> {
        let g = self.inner.lock().unwrap();
        let (g, _) = self
            .cv
            .wait_timeout_while(g, timeout, |g| matches!(g.status, Status::Starting))
            .unwrap();
        match &g.status {
            Status::Ready(info) => Ok(info.clone()),
            Status::Failed(e) => Err(e.message.clone()),
            Status::Starting => Err("backend is still starting".into()),
        }
    }

    fn fail(self: &Arc<Self>, generation: u64, message: String) {
        let err = {
            let mut g = self.inner.lock().unwrap();
            if g.generation != generation || g.stopping || matches!(g.status, Status::Failed(_)) {
                return;
            }
            let stderr = g.stderr_tail.iter().cloned().collect::<Vec<_>>().join("\n");
            let err = BackendError { message, stderr };
            g.status = Status::Failed(err.clone());
            self.cv.notify_all();
            err
        };
        eprintln!("terrarium: backend failed: {}", err.message);
        (self.on_fail)(err);
    }

    pub fn start(self: &Arc<Self>, launch: &Launch, paths: &Paths, log_path: Option<PathBuf>) {
        let generation = {
            let mut g = self.inner.lock().unwrap();
            g.generation += 1;
            g.status = Status::Starting;
            g.stopping = false;
            g.stderr_tail.clear();
            g.generation
        };
        if !launch.node.exists() || !launch.script.exists() {
            let missing = if launch.node.exists() { &launch.script } else { &launch.node };
            self.fail(
                generation,
                format!("Missing {}. Build the app with scripts/package.sh.", missing.display()),
            );
            return;
        }
        let token = match random_token() {
            Ok(t) => t,
            Err(e) => return self.fail(generation, format!("Could not generate a token: {e}")),
        };
        let path = format!(
            "/opt/homebrew/bin:/usr/local/bin:{}",
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into())
        );
        let mut cmd = Command::new(&launch.node);
        cmd.arg(&launch.script)
            .current_dir(&launch.cwd)
            .env("TERRARIUM_TOKEN", &token)
            .env("TERRARIUM_PARENT_STDIN", "1")
            .env("TERRARIUM_DATA", &paths.data)
            .env("TERRARIUM_MODELS", &paths.models)
            .env("TERRARIUM_VENV", &paths.venv)
            .env("PATH", path)
            .env_remove("TERRARIUM_PORT")
            .env_remove("TERRARIUM_DEV")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Own process group, so a stuck backend can be killed along with oMLX and VM runners.
            .process_group(0);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return self.fail(generation, format!("Could not start {}: {e}", launch.node.display())),
        };
        let pid = child.id() as i32;
        {
            let mut g = self.inner.lock().unwrap();
            g.pid = Some(pid);
            g.pgid = Some(pid);
            g.stdin = child.stdin.take();
        }

        let mut log = log_path.and_then(|p| {
            if let Some(dir) = p.parent() {
                let _ = fs::create_dir_all(dir);
            }
            let _ = fs::rename(&p, p.with_extension("prev.log"));
            File::create(&p).ok()
        });

        let stderr = child.stderr.take().unwrap();
        let me = self.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if cfg!(debug_assertions) {
                    eprintln!("{line}");
                }
                if let Some(f) = log.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
                let mut g = me.inner.lock().unwrap();
                if g.generation == generation {
                    if g.stderr_tail.len() == STDERR_TAIL_LINES {
                        g.stderr_tail.pop_front();
                    }
                    g.stderr_tail.push_back(line);
                }
            }
        });

        let stdout = child.stdout.take().unwrap();
        let me = self.clone();
        let tok = token.clone();
        thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            // EOF before the handshake: the exit watcher reports it with the stderr tail.
            if let Some(Ok(line)) = lines.next() {
                let port = serde_json::from_str::<serde_json::Value>(&line)
                    .ok()
                    .and_then(|v| v.get("port").and_then(|p| p.as_u64()));
                match port {
                    Some(port) => {
                        let mut g = me.inner.lock().unwrap();
                        if g.generation == generation && matches!(g.status, Status::Starting) {
                            g.status = Status::Ready(BackendInfo { url: format!("http://127.0.0.1:{port}"), token: tok });
                            me.cv.notify_all();
                        }
                    }
                    None => me.fail(generation, format!("Unexpected handshake line: {line}")),
                }
            }
            for _ in lines {} // keep draining so the backend never blocks on a full pipe
        });

        let me = self.clone();
        thread::spawn(move || {
            let status = child.wait();
            // Let the stderr reader catch the last lines before we build the tail.
            thread::sleep(Duration::from_millis(150));
            let stopping = {
                let mut g = me.inner.lock().unwrap();
                if g.generation == generation {
                    g.pid = None;
                    g.stdin = None;
                }
                me.cv.notify_all();
                g.stopping
            };
            let why = match status {
                Ok(s) => format!("Backend exited ({s})"),
                Err(e) => format!("Backend wait failed: {e}"),
            };
            me.fail(generation, why);
            // A crash (not our stop) leaves oMLX and VM runners behind: ask them to exit, then kill what remains.
            // stop() reaps the group itself.
            if !stopping {
                me.reap_group(pid, ORPHAN_GRACE);
            }
        });

        let me = self.clone();
        thread::spawn(move || {
            thread::sleep(HANDSHAKE_TIMEOUT);
            let starting = {
                let g = me.inner.lock().unwrap();
                g.generation == generation && matches!(g.status, Status::Starting)
            };
            if starting {
                me.fail(generation, format!("No handshake after {} s", HANDSHAKE_TIMEOUT.as_secs()));
                me.stop(Duration::from_secs(5));
            }
        });
    }

    /// SIGTERM plus stdin EOF, wait up to `timeout` for a clean exit (VMs save, oMLX stops), then SIGKILL
    /// the whole process group, also when the backend already exited on its own. Safe to call more than once.
    pub fn stop(&self, timeout: Duration) {
        let mut g = self.inner.lock().unwrap();
        g.stopping = true;
        g.stdin = None;
        let pgid = g.pgid;
        if let Some(pid) = g.pid {
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let deadline = Instant::now() + timeout;
            while g.pid == Some(pid) {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                g = self.cv.wait_timeout(g, deadline - now).unwrap().0;
            }
            if g.pid == Some(pid) {
                eprintln!("terrarium: backend did not exit within {} s; killing its process group", timeout.as_secs());
            }
        }
        drop(g);
        // Anything left in the group (stuck backend, or children it failed to stop) gets SIGKILL.
        if let Some(pgid) = pgid {
            self.reap_group(pgid, Duration::ZERO);
        }
        let g = self.inner.lock().unwrap();
        let _ = self.cv.wait_timeout_while(g, Duration::from_secs(2), |g| g.pid.is_some() && g.pid == pgid);
    }

    /// Kill process group `pgid`: SIGTERM and up to `grace` to exit (skipped when zero), then SIGKILL, then wait
    /// for it to be gone. Once it is, forget it, so a later stop can't signal a group that reused the id.
    fn reap_group(&self, pgid: i32, grace: Duration) {
        let alive = || unsafe { libc::kill(-pgid, 0) == 0 };
        let wait_gone = |limit: Duration| {
            let deadline = Instant::now() + limit;
            while alive() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
            }
        };
        if alive() && !grace.is_zero() {
            eprintln!("terrarium: backend exited; stopping what it left running (process group {pgid})");
            unsafe { libc::kill(-pgid, libc::SIGTERM) };
            wait_gone(grace);
        }
        if alive() {
            unsafe { libc::kill(-pgid, libc::SIGKILL) };
            wait_gone(Duration::from_secs(2));
        }
        if !alive() {
            let mut g = self.inner.lock().unwrap();
            if g.pgid == Some(pgid) {
                g.pgid = None;
            }
        }
    }
}
