// Read-only ownership lookup. Restart Manager is only queried; no restart/shutdown API is used.
#[cfg(windows)]
pub fn lookup(path: &str) -> serde_json::Value {
    use std::{
        collections::{HashMap, HashSet},
        ffi::{c_void, OsStr},
        mem::{size_of, zeroed},
        os::windows::ffi::OsStrExt,
    };
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Unique {
        pid: u32,
        start: [u32; 2],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Info {
        process: Unique,
        app: [u16; 256],
        service: [u16; 64],
        kind: u32,
        status: u32,
        session: u32,
        restartable: i32,
    }
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        exe: [u16; 260],
    }
    #[link(name = "Rstrtmgr")]
    extern "system" {
        fn RmStartSession(session: *mut u32, flags: u32, key: *mut u16) -> u32;
        fn RmRegisterResources(
            session: u32,
            count: u32,
            paths: *const *const u16,
            n: u32,
            apps: *const Unique,
            s: u32,
            services: *const *const u16,
        ) -> u32;
        fn RmGetList(
            session: u32,
            needed: *mut u32,
            count: *mut u32,
            info: *mut Info,
            reasons: *mut u32,
        ) -> u32;
        fn RmEndSession(session: u32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Process32FirstW(h: Handle, e: *mut Entry) -> i32;
        fn Process32NextW(h: Handle, e: *mut Entry) -> i32;
        fn CloseHandle(h: Handle) -> i32;
        fn AttachConsole(pid: u32) -> i32;
        fn GetConsoleWindow() -> Handle;
        fn FreeConsole() -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(cb: unsafe extern "system" fn(Handle, isize) -> i32, param: isize) -> i32;
        fn IsWindowVisible(h: Handle) -> i32;
        fn GetWindowThreadProcessId(h: Handle, pid: *mut u32) -> u32;
        fn GetWindowTextW(h: Handle, text: *mut u16, max: i32) -> i32;
        fn GetWindow(h: Handle, command: u32) -> Handle;
    }
    struct Context {
        pids: HashSet<u32>,
        windows: Vec<serde_json::Value>,
    }
    unsafe extern "system" fn callback(h: Handle, param: isize) -> i32 {
        let c = &mut *(param as *mut Context);
        let mut pid = 0;
        GetWindowThreadProcessId(h, &mut pid);
        if c.pids.contains(&pid) && IsWindowVisible(h) != 0 && GetWindow(h, 4).is_null() {
            let mut text = [0u16; 512];
            let n = GetWindowTextW(h, text.as_mut_ptr(), 512);
            if n > 0 {
                c.windows.push(serde_json::json!({"handle":h as usize as u64,"pid":pid,"title":String::from_utf16_lossy(&text[..n as usize])}));
            }
        }
        1
    }
    unsafe {
        let mut session = 0;
        let mut key = [0u16; 33];
        if RmStartSession(&mut session, 0, key.as_mut_ptr()) != 0 {
            return serde_json::json!({"windows":[]});
        }
        let name: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
        let ptr = name.as_ptr();
        let mut pids = HashSet::new();
        if RmRegisterResources(session, 1, &ptr, 0, std::ptr::null(), 0, std::ptr::null()) == 0 {
            let (mut needed, mut count, mut reasons) = (0, 0, 0);
            let result = RmGetList(
                session,
                &mut needed,
                &mut count,
                std::ptr::null_mut(),
                &mut reasons,
            );
            if result == 234 && needed <= 1000 {
                let mut list: Vec<Info> = vec![zeroed(); needed as usize];
                count = needed;
                if RmGetList(
                    session,
                    &mut needed,
                    &mut count,
                    list.as_mut_ptr(),
                    &mut reasons,
                ) == 0
                {
                    for i in list.iter().take(count as usize) {
                        pids.insert(i.process.pid);
                    }
                }
            }
        }
        RmEndSession(session);
        let snapshot = CreateToolhelp32Snapshot(2, 0);
        let mut parents = HashMap::new();
        if snapshot as isize != -1 {
            let mut entry: Entry = zeroed();
            entry.size = size_of::<Entry>() as u32;
            let mut valid = Process32FirstW(snapshot, &mut entry);
            while valid != 0 {
                let len = entry.exe.iter().position(|x| *x == 0).unwrap_or(260);
                parents.insert(
                    entry.pid,
                    (
                        entry.parent,
                        String::from_utf16_lossy(&entry.exe[..len]).to_lowercase(),
                    ),
                );
                valid = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
        }
        let original: Vec<u32> = pids.iter().copied().collect();
        for mut pid in original.iter().copied() {
            for _ in 0..15 {
                let Some((parent, _)) = parents.get(&pid) else {
                    break;
                };
                let Some((_, name)) = parents.get(parent) else {
                    break;
                };
                if *parent == 0
                    || *parent == pid
                    || ["explorer.exe", "services.exe", "svchost.exe", "wininit.exe"]
                        .contains(&name.as_str())
                {
                    break;
                }
                pids.insert(*parent);
                pid = *parent;
            }
        }
        let mut context = Context {
            pids,
            windows: Vec::new(),
        };
        EnumWindows(callback, &mut context as *mut Context as isize);
        if context.windows.is_empty() {
            for pid in original {
                if AttachConsole(pid) != 0 {
                    let h = GetConsoleWindow();
                    if !h.is_null() && IsWindowVisible(h) != 0 {
                        let mut owner = 0;
                        GetWindowThreadProcessId(h, &mut owner);
                        context.windows.push(serde_json::json!({"handle":h as usize as u64,"pid":owner,"title":"Console"}));
                    }
                    FreeConsole();
                }
            }
        }
        context.windows.sort_by_key(|v| v["handle"].as_u64());
        context.windows.dedup_by_key(|v| v["handle"].as_u64());
        serde_json::json!({"windows":context.windows})
    }
}
#[cfg(target_os = "linux")]
pub fn lookup(path: &str) -> serde_json::Value {
    use std::{collections::HashSet, fs, process::Command};
    let target = match fs::canonicalize(path) {
        Ok(value) => value,
        Err(_) => return serde_json::json!({"windows":[]}),
    };
    let mut pids = HashSet::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return serde_json::json!({"windows":[]});
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(fds) = fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            if fs::read_link(fd.path()).is_ok_and(|link| link == target) {
                pids.insert(pid);
                break;
            }
        }
    }
    let mut windows = Vec::new();
    for pid in pids {
        let pid_text = pid.to_string();
        let Ok(found) = Command::new("xdotool")
            .args(["search", "--onlyvisible", "--pid", pid_text.as_str()])
            .output()
        else {
            continue;
        };
        if !found.status.success() {
            continue;
        }
        for id in String::from_utf8_lossy(&found.stdout).lines() {
            let id = id.trim();
            let Ok(handle) = id.parse::<u64>() else {
                continue;
            };
            let title = Command::new("xdotool")
                .args(["getwindowname", id])
                .output()
                .ok()
                .filter(|value| value.status.success())
                .map(|value| {
                    String::from_utf8_lossy(&value.stdout)
                        .trim()
                        .to_string()
                })
                .unwrap_or_default();
            if title.is_empty() {
                continue;
            }
            windows.push(serde_json::json!({"handle": handle, "pid": pid, "title": title}));
        }
    }
    windows.sort_by_key(|value| value["handle"].as_u64());
    windows.dedup_by_key(|value| value["handle"].as_u64());
    serde_json::json!({"windows":windows})
}
#[cfg(not(any(windows, target_os = "linux")))]
pub fn lookup(_path: &str) -> serde_json::Value {
    serde_json::json!({"windows":[]})
}
