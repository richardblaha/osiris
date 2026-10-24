//! Osiris for the desktop: the PWA in a window of its own. The app's page only chooses where to connect; a project
//! folder gets its local agent (`osiris <folder>`, started here unless one runs), whose own address then serves the PWA
//! in this window, and a server is opened at its URL (the PWA signs in there as on the web).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Manager, State, Url};

/// What a running agent writes to `.osiris/private/agent.json`.
#[derive(Deserialize)]
struct AgentInfo {
    pid: u32,
    url: String,
}

#[derive(Serialize)]
struct Opened {
    url: String,
}

/// The agents this app started, stopped when it quits (one it found running stays).
#[derive(Default)]
struct Agents(Mutex<Vec<Child>>);

fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(windows)]
    {
        Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

fn running_agent(folder: &Path) -> Option<AgentInfo> {
    let text = std::fs::read_to_string(folder.join(".osiris/private/agent.json")).ok()?;
    let info: AgentInfo = serde_json::from_str(&text).ok()?;
    // The process must live and its port answer (a reused process id is someone else).
    let answers = Url::parse(&info.url)
        .ok()
        .and_then(|u| u.socket_addrs(|| None).ok())
        .and_then(|addrs| addrs.into_iter().next())
        .map(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok())
        .unwrap_or(false);
    (alive(info.pid) && answers).then_some(info)
}

/// The `osiris` command: `OSIRIS_AGENT` (a path), else the one on PATH.
fn agent_command() -> Command {
    match std::env::var("OSIRIS_AGENT") {
        Ok(path) if path.ends_with(".mjs") => {
            let mut c = Command::new("node");
            c.arg(path);
            c
        }
        Ok(path) => Command::new(path),
        Err(_) => Command::new("osiris"),
    }
}

/// The agent over `folder` (found or started), as the address that opens its PWA signed in.
#[tauri::command]
fn open_folder(folder: String, agents: State<'_, Agents>) -> Result<Opened, String> {
    agent_url(PathBuf::from(folder), &agents).map(|url| Opened { url })
}

fn agent_url(folder: PathBuf, agents: &Agents) -> Result<String, String> {
    if !folder.is_dir() {
        return Err(format!("{} isn't a folder", folder.display()));
    }
    let info = match running_agent(&folder) {
        Some(info) => info,
        None => {
            let error_file = folder.join(".osiris/private/agent-error");
            let _ = std::fs::remove_file(&error_file);
            let child = agent_command()
                .arg(&folder)
                // Any free port: several folders can be open at once.
                .args(["--port", "0"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("Osiris (the agent) didn't start: {e}. Install it (npm i -g @osiris/agent) or set OSIRIS_AGENT."))?;
            agents.0.lock().unwrap().push(child);
            let started = Instant::now();
            loop {
                if let Some(info) = running_agent(&folder) {
                    break info;
                }
                // The agent says why it couldn't start (a missing model key, …).
                if let Ok(why) = std::fs::read_to_string(&error_file) {
                    return Err(format!("Osiris didn't start: {}", why.trim()));
                }
                if started.elapsed() > Duration::from_secs(60) {
                    return Err(format!("Osiris didn't start over {} (run `osiris {}` to see why).", folder.display(), folder.display()));
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    };
    let token = std::fs::read_to_string(folder.join(".osiris/private/local-token")).map_err(|e| e.to_string())?;
    Ok(format!("{}/#token={}", info.url, token.trim()))
}

/// Opens an address in the main window: an agent's or a server's PWA.
#[tauri::command]
fn navigate(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only http(s) addresses".into());
    }
    app.get_webview_window("main").ok_or("No window")?.navigate(url).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Agents::default())
        .invoke_handler(tauri::generate_handler![open_folder, navigate])
        // `osiris-desktop <folder>` (or "Open with Osiris"): straight to that project, past the connection page.
        .setup(|app| {
            if let Some(folder) = std::env::args().nth(1).map(PathBuf::from).filter(|f| f.is_dir()) {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let result = agent_url(folder, &handle.state::<Agents>()).and_then(|url| navigate(url, handle.clone()));
                    if let (Err(err), Some(window)) = (result, handle.get_webview_window("main")) {
                        let _ = window.eval(&format!("document.getElementById('status').textContent = {}", serde_json::to_string(&err).unwrap_or_default()));
                    }
                });
            }
            Ok(())
        })
        .menu(|app| {
            let switch = MenuItem::with_id(app, "switch", "Switch project…", true, Some("CmdOrCtrl+Shift+O"))?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
            Menu::with_items(app, &[&Submenu::with_items(app, "Osiris", true, &[&switch, &reload, &quit])?])
        })
        .on_menu_event(|app, event| {
            let Some(window) = app.get_webview_window("main") else { return };
            match event.id().as_ref() {
                // Back to the app's own page, where a folder or a server is chosen.
                "switch" => {
                    let home = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
                    let _ = window.navigate(Url::parse(home).unwrap());
                }
                "reload" => {
                    let _ = window.eval("location.reload()");
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("Osiris didn't start")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                for mut child in app.state::<Agents>().0.lock().unwrap().drain(..) {
                    let _ = child.kill();
                }
            }
        });
}
