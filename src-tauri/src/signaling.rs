use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/* --------------------------------------------------------------------------
   Local signaling server lifecycle.

   Meldrift ships the Bun signaling service as a Tauri sidecar. This module owns
   that process: it picks a loopback port, starts the sidecar, waits for a real
   /api/health response, restarts it after a crash, and kills it when the app
   exits. Nothing is bound to a public interface and nothing is left behind.
   -------------------------------------------------------------------------- */

const LOCAL_HOST: &str = "127.0.0.1";
const FIRST_PORT: u16 = 8787;
const LAST_PORT: u16 = 8796;
const READY_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_RESTARTS: u32 = 3;
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const HEALTH_MARKER: &str = "meldrift-signaling";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalingStatus {
    pub mode: String,
    pub state: String,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub managed: bool,
    pub reused: bool,
    pub error: Option<String>,
    pub log_path: String,
    pub restarts: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalingDiagnostics {
    pub log_path: String,
    pub log_tail: String,
}

pub struct SignalingState {
    inner: Mutex<Inner>,
}

struct Inner {
    child: Option<CommandChild>,
    status: SignalingStatus,
    stopping: bool,
    data_dir: PathBuf,
    log_path: PathBuf,
}

impl SignalingState {
    pub fn new(data_dir: PathBuf) -> Self {
        let log_path = data_dir.join("logs").join("signaling.log");
        if let Some(parent) = log_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(meta) = fs::metadata(&log_path) {
            if meta.len() > MAX_LOG_BYTES {
                let _ = fs::remove_file(&log_path);
            }
        }
        Self {
            inner: Mutex::new(Inner {
                child: None,
                stopping: false,
                data_dir,
                log_path: log_path.clone(),
                status: SignalingStatus {
                    mode: "local".into(),
                    state: "stopped".into(),
                    url: None,
                    port: None,
                    managed: false,
                    reused: false,
                    error: None,
                    log_path: log_path.display().to_string(),
                    restarts: 0,
                },
            }),
        }
    }
}

pub fn autostart(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(error) = start_local(&app) {
            update(&app, |status| {
                status.state = "failed".into();
                status.error = Some(error);
            });
        }
    });
}

#[tauri::command]
pub fn signaling_status(state: State<'_, SignalingState>) -> SignalingStatus {
    state
        .inner
        .lock()
        .map(|inner| inner.status.clone())
        .unwrap_or_else(|_| failed_status("Signaling state is unavailable"))
}

#[tauri::command]
pub fn signaling_start(app: AppHandle) -> Result<SignalingStatus, String> {
    start_local(&app)?;
    Ok(signaling_status(app.state::<SignalingState>()))
}

#[tauri::command]
pub fn signaling_stop(app: AppHandle) -> SignalingStatus {
    stop_local(&app)
}

#[tauri::command]
pub fn signaling_set_mode(app: AppHandle, mode: String) -> Result<SignalingStatus, String> {
    match mode.as_str() {
        "local" => start_local(&app),
        "remote" => {
            stop_local(&app);
            Ok(update(&app, |status| {
                status.mode = "remote".into();
                status.error = None;
            }))
        }
        _ => Err("Unknown server mode".into()),
    }
}

#[tauri::command]
pub fn signaling_diagnostics(state: State<'_, SignalingState>) -> SignalingDiagnostics {
    let (path, tail) = match state.inner.lock() {
        Ok(inner) => {
            let tail = fs::read_to_string(&inner.log_path)
                .map(|text| {
                    let lines: Vec<&str> = text.lines().collect();
                    lines[lines.len().saturating_sub(40)..].join("\n")
                })
                .unwrap_or_default();
            (inner.log_path.display().to_string(), tail)
        }
        Err(_) => (String::new(), String::new()),
    };
    SignalingDiagnostics {
        log_path: path,
        log_tail: tail,
    }
}

/* ---- lifecycle --------------------------------------------------------- */

fn start_local(app: &AppHandle) -> Result<SignalingStatus, String> {
    {
        let state = app.state::<SignalingState>();
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Signaling state is unavailable".to_string())?;
        if inner.child.is_some() || matches!(inner.status.state.as_str(), "ready" | "starting") {
            return Ok(inner.status.clone());
        }
    }

    let (port, reused) = choose_endpoint()?;
    let url = local_url(port);

    if reused {
        return Ok(update(app, |status| {
            status.mode = "local".into();
            status.state = "ready".into();
            status.url = Some(url);
            status.port = Some(port);
            status.managed = false;
            status.reused = true;
            status.error = None;
            status.restarts = 0;
        }));
    }

    update(app, |status| {
        status.mode = "local".into();
        status.state = "starting".into();
        status.url = Some(url);
        status.port = Some(port);
        status.managed = true;
        status.reused = false;
        status.error = None;
        status.restarts = 0;
    });

    if let Err(error) = spawn_sidecar(app, port, 0) {
        update(app, |status| {
            status.state = "failed".into();
            status.managed = false;
            status.error = Some(error.clone());
        });
        return Err(error);
    }

    Ok(signaling_status(app.state::<SignalingState>()))
}

fn spawn_sidecar(app: &AppHandle, port: u16, restarts: u32) -> Result<(), String> {
    let (data_dir, log_path) = {
        let state = app.state::<SignalingState>();
        let inner = state
            .inner
            .lock()
            .map_err(|_| "Signaling state is unavailable".to_string())?;
        (inner.data_dir.clone(), inner.log_path.clone())
    };
    let server_dir = data_dir.join("server");
    fs::create_dir_all(&server_dir)
        .map_err(|error| format!("Could not create the server data folder: {error}"))?;
    let database = server_dir.join("meldrift.db");

    append_log(
        &log_path,
        &format!(
            "--- starting sidecar on {LOCAL_HOST}:{port} (restart {restarts}) ---"
        ),
    );

    let command = app
        .shell()
        .sidecar("meldrift-server")
        .map_err(|error| format!("The bundled signaling server is missing: {error}"))?
        .env("MELDRIFT_HOST", LOCAL_HOST)
        .env("MELDRIFT_PORT", port.to_string())
        .env("MELDRIFT_DATA", database.display().to_string())
        .env("MELDRIFT_VERSION", env!("CARGO_PKG_VERSION"))
        .env("MELDRIFT_PARENT_WATCH", "1")
        .set_process_group(true);

    let (receiver, child) = command
        .spawn()
        .map_err(|error| format!("The signaling server could not start: {error}"))?;

    {
        let state = app.state::<SignalingState>();
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "Signaling state is unavailable".to_string())?;
        inner.child = Some(child);
        inner.stopping = false;
        inner.status.restarts = restarts;
    }
    update(app, |status| {
        status.state = "starting".into();
        status.error = None;
    });

    let monitor_app = app.clone();
    std::thread::spawn(move || monitor(monitor_app, receiver, port, restarts));
    Ok(())
}

fn monitor(app: AppHandle, mut receiver: Receiver<CommandEvent>, port: u16, restarts: u32) {
    let started = Instant::now();
    let mut ready = false;

    loop {
        match receiver.try_recv() {
            Ok(CommandEvent::Stdout(line)) => log_line(&app, &line),
            Ok(CommandEvent::Stderr(line)) => log_line(&app, &line),
            Ok(CommandEvent::Terminated(payload)) => {
                let stopping = {
                    let state = app.state::<SignalingState>();
                    let stopped = match state.inner.lock() {
                        Ok(mut inner) => {
                            inner.child = None;
                            inner.stopping
                        }
                        Err(_) => true,
                    };
                    stopped
                };
                if stopping {
                    update(&app, |status| {
                        status.state = "stopped".into();
                        status.url = None;
                        status.managed = false;
                        status.reused = false;
                    });
                    return;
                }

                append_log(
                    &log_path(&app),
                    &format!("--- sidecar terminated unexpectedly: {payload:?} ---"),
                );
                update(&app, |status| {
                    status.state = "crashed".into();
                    status.error = Some(format!(
                        "The local signaling server stopped unexpectedly ({}). See the server log.",
                        payload.code.map_or_else(|| "no exit code".into(), |code| format!("exit {code}"))
                    ));
                });

                if restarts < MAX_RESTARTS {
                    std::thread::sleep(Duration::from_millis(750 * u64::from(restarts + 1)));
                    let stopping = app
                        .state::<SignalingState>()
                        .inner
                        .lock()
                        .map(|inner| inner.stopping)
                        .unwrap_or(true);
                    if stopping {
                        return;
                    }
                    if let Err(error) = spawn_sidecar(&app, port, restarts + 1) {
                        update(&app, |status| {
                            status.state = "failed".into();
                            status.error = Some(error);
                        });
                    }
                }
                return;
            }
            Ok(CommandEvent::Error(error)) => {
                append_log(&log_path(&app), &format!("sidecar error: {error}"));
            }
            Ok(_) => {}
            Err(_) => {
                if receiver.is_closed() {
                    // The process is gone; the Terminated event normally
                    // arrives first. Treat a lost channel as a failure, not a hang.
                    let stopping = app
                        .state::<SignalingState>()
                        .inner
                        .lock()
                        .map(|inner| inner.stopping)
                        .unwrap_or(true);
                    if !stopping {
                        update(&app, |status| {
                            status.state = "failed".into();
                            status.error =
                                Some("Lost contact with the local signaling server.".into());
                        });
                    }
                    return;
                }

                if !ready && health_ok(port) {
                    ready = true;
                    update(&app, |status| {
                        status.state = "ready".into();
                        status.url = Some(local_url(port));
                        status.port = Some(port);
                        status.managed = true;
                        status.error = None;
                    });
                }
                if !ready && started.elapsed() >= READY_TIMEOUT {
                    let child = {
                        let state = app.state::<SignalingState>();
                        let taken = match state.inner.lock() {
                            Ok(mut inner) => {
                                inner.stopping = true;
                                inner.child.take()
                            }
                            Err(_) => None,
                        };
                        taken
                    };
                    if let Some(child) = child {
                        let _ = child.kill();
                    }
                    update(&app, |status| {
                        status.state = "failed".into();
                        status.managed = false;
                        status.error = Some(format!(
                            "The local signaling server did not answer its health check within {}s. See {}.",
                            READY_TIMEOUT.as_secs(),
                            status.log_path
                        ));
                    });
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
}

pub fn stop_local(app: &AppHandle) -> SignalingStatus {
    let child = {
        let state = app.state::<SignalingState>();
        let taken = match state.inner.lock() {
            Ok(mut inner) => {
                inner.stopping = true;
                inner.child.take()
            }
            Err(_) => None,
        };
        taken
    };
    if let Some(child) = child {
        let _ = child.kill();
    }
    update(app, |status| {
        status.state = "stopped".into();
        status.url = None;
        status.port = None;
        status.managed = false;
        status.reused = false;
    })
}

pub fn shutdown(app: &AppHandle) {
    let _ = stop_local(app);
}

/* ---- helpers ----------------------------------------------------------- */

fn choose_endpoint() -> Result<(u16, bool), String> {
    for port in FIRST_PORT..=LAST_PORT {
        if health_ok(port) {
            // An existing Meldrift server (for example from a second app
            // instance) is reused instead of starting a duplicate.
            return Ok((port, true));
        }
        if TcpListener::bind((LOCAL_HOST, port)).is_ok() {
            return Ok((port, false));
        }
    }
    Err(format!(
        "No free loopback port between {FIRST_PORT} and {LAST_PORT}. Close the process using it and retry."
    ))
}

fn local_url(port: u16) -> String {
    format!("http://{LOCAL_HOST}:{port}")
}

fn health_ok(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    if stream
        .write_all(
            b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        )
        .is_err()
    {
        return false;
    }
    let mut raw = String::new();
    if stream.read_to_string(&mut raw).is_err() {
        return false;
    }
    is_meldrift_health(&raw)
}

fn is_meldrift_health(raw: &str) -> bool {
    let status_ok = raw.starts_with("HTTP/1.1 200") || raw.starts_with("HTTP/1.0 200");
    status_ok && raw.contains(HEALTH_MARKER)
}

fn log_path(app: &AppHandle) -> PathBuf {
    app.state::<SignalingState>()
        .inner
        .lock()
        .map(|inner| inner.log_path.clone())
        .unwrap_or_default()
}

fn log_line(app: &AppHandle, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    append_log(&log_path(app), line.trim_end());
}

fn append_log(path: &Path, line: &str) {
    if path.as_os_str().is_empty() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn update<F: FnOnce(&mut SignalingStatus)>(app: &AppHandle, change: F) -> SignalingStatus {
    let state = app.state::<SignalingState>();
    let status = match state.inner.lock() {
        Ok(mut inner) => {
            change(&mut inner.status);
            inner.status.clone()
        }
        Err(_) => failed_status("Signaling state is unavailable"),
    };
    let _ = app.emit("signaling-status", status.clone());
    status
}

fn failed_status(message: &str) -> SignalingStatus {
    SignalingStatus {
        mode: "local".into(),
        state: "failed".into(),
        url: None,
        port: None,
        managed: false,
        reused: false,
        error: Some(message.into()),
        log_path: String::new(),
        restarts: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_health_endpoint_counts() {
        assert!(is_meldrift_health(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true,\"name\":\"meldrift-signaling\"}"
        ));
        assert!(!is_meldrift_health(
            "HTTP/1.1 200 OK\r\n\r\n{\"name\":\"some-other-server\"}"
        ));
        assert!(!is_meldrift_health("HTTP/1.1 404 Not Found\r\n\r\n"));
        assert!(!is_meldrift_health(""));
    }

    #[test]
    fn local_urls_never_leave_loopback() {
        assert_eq!(local_url(8787), "http://127.0.0.1:8787");
        assert!(!local_url(8787).contains("0.0.0.0"));
    }

    #[test]
    fn status_serializes_to_the_ui_contract() {
        let status = SignalingStatus {
            mode: "local".into(),
            state: "ready".into(),
            url: Some(local_url(8787)),
            port: Some(8787),
            managed: true,
            reused: false,
            error: None,
            log_path: "log".into(),
            restarts: 0,
        };
        let json = serde_json::to_value(&status).expect("json");
        assert_eq!(json["logPath"], "log");
        assert_eq!(json["state"], "ready");
        assert!(json.get("log_path").is_none());
    }
}
