#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;
static STARTUP: Mutex<()> = Mutex::new(());
fn data_dir() -> PathBuf {
    std::env::var_os("CHATPORT_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("ChatPort")
            } else if cfg!(target_os = "macos") {
                PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                    .join("Library/Application Support/ChatPort")
            } else {
                std::env::var_os("XDG_DATA_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                            .join(".local/share")
                    })
                    .join("chatport")
            }
        })
}
fn runtime(app: &tauri::AppHandle) -> PathBuf {
    let path = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("chatport-runtime")
    } else {
        app.path().resource_dir().unwrap().join("chatport-runtime")
    };
    #[cfg(windows)]
    if let Some(v) = path.to_str() {
        if let Some(unc) = v.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", unc));
        }
        return PathBuf::from(v.strip_prefix(r"\\?\").unwrap_or(v));
    }
    #[allow(unreachable_code)]
    path
}
fn request(v: &serde_json::Value, body: Option<&str>) -> Result<String, String> {
    let port = v["port"]
        .as_u64()
        .filter(|p| *p > 0 && *p < 65536)
        .ok_or("Invalid service port")?;
    let token = v["token"]
        .as_str()
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("Invalid service credential")?;
    let addr: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_millis(400)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(800)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(800)))
        .map_err(|e| e.to_string())?;
    let req = if let Some(b) = body {
        format!("POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}",b.len())
    } else {
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n")
    };
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| e.to_string())?;
    Ok(response)
}
fn healthy(v: &serde_json::Value) -> bool {
    request(v, None)
        .map(|r| r.contains("200 OK") && r.contains("\"ok\":true"))
        .unwrap_or(false)
}
#[tauri::command]
async fn bootstrap(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move||{
 let _guard=STARTUP.lock().map_err(|e|e.to_string())?;
 let dir=data_dir();fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
 let read=||fs::read_to_string(dir.join("service.json")).ok().and_then(|s|serde_json::from_str::<serde_json::Value>(&s).ok());
 if let Some(v)=read(){if healthy(&v){if v["version"].as_str()==Some(env!("CARGO_PKG_VERSION")){return Ok(v);}return Err("Another ChatPort service version is running. Finish transfers and restart ChatPort.".into());}}
 let root=runtime(&app);let log=fs::OpenOptions::new().create(true).append(true).open(dir.join("service.log")).map_err(|e|e.to_string())?;
 let mut cmd=Command::new(root.join(if cfg!(windows){"node.exe"}else{"node"}));cmd.arg(root.join("service.cjs")).arg("--data").arg(&dir).current_dir(&dir).stdin(Stdio::null()).stdout(log.try_clone().map_err(|e|e.to_string())?).stderr(log);
 #[cfg(windows)] cmd.creation_flags(0x08000000|0x00000200|0x00000008);
 cmd.spawn().map_err(|e|format!("Could not start ChatPort: {e}"))?;
 for _ in 0..100{std::thread::sleep(Duration::from_millis(100));if let Some(v)=read(){if healthy(&v){return Ok(v);}}}
 Err(format!("ChatPort could not start. See {}",dir.join("service.log").display()))
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("This path is no longer available".into());
    }
    let mut c = Command::new(if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    });
    if p.is_file() && cfg!(windows) {
        c.arg(format!("/select,{path}"));
    } else if p.is_file() {
        c.arg(p.parent().ok_or("No parent folder")?);
    } else {
        c.arg(path);
    }
    c.spawn().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    open::that(url).map_err(|e| e.to_string())
}
#[tauri::command]
fn focus_window(handle: u64, pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "user32")]
        extern "system" {
            fn GetWindowThreadProcessId(hwnd: *mut c_void, pid: *mut u32) -> u32;
            fn IsWindowVisible(hwnd: *mut c_void) -> i32;
            fn ShowWindow(hwnd: *mut c_void, command: i32) -> i32;
            fn SetForegroundWindow(hwnd: *mut c_void) -> i32;
            fn GetForegroundWindow() -> *mut c_void;
            fn IsIconic(hwnd: *mut c_void) -> i32;
        }
        unsafe {
            let hwnd = handle as usize as *mut c_void;
            let mut actual = 0;
            GetWindowThreadProcessId(hwnd, &mut actual);
            if actual != pid || IsWindowVisible(hwnd) == 0 {
                return Err("That window is no longer open".into());
            }
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, 9);
            }
            if GetForegroundWindow() != hwnd
                && SetForegroundWindow(hwnd) == 0
                && GetForegroundWindow() != hwnd
            {
                return Err("Windows did not allow this window to come to the foreground".into());
            }
            return Ok(());
        }
    }
    #[cfg(target_os = "linux")]
    {
        let _ = pid;
        let id = handle.to_string();
        let output = Command::new("xdotool")
            .args(["windowactivate", "--sync", id.as_str()])
            .output()
            .map_err(|_| "Install xdotool to activate an X11 window on Linux".to_string())?;
        if !output.status.success() {
            return Err("The Linux desktop did not allow this window to come to the foreground".into());
        }
        return Ok(());
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (handle, pid);
        Err("External window activation is unavailable on this desktop session".into())
    }
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            reveal_path,
            open_url,
            focus_window
        ])
        .run(tauri::generate_context!())
        .expect("ChatPort could not open");
}
