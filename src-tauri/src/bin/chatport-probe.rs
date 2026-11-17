#![cfg_attr(windows, windows_subsystem = "windows")]
use std::io::{self, Read};
#[path = "../window_lookup.rs"]
mod window_lookup;
#[cfg(windows)]
fn held(path: &str) -> Option<bool> {
    use std::{ffi::c_void, ffi::OsStr, os::windows::ffi::OsStrExt};
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: *mut c_void,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut c_void,
            disposition: u32,
            flags: u32,
            template: *mut c_void,
        ) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn LockFileEx(
            handle: *mut c_void,
            flags: u32,
            reserved: u32,
            low: u32,
            high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn UnlockFileEx(
            handle: *mut c_void,
            reserved: u32,
            low: u32,
            high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn GetLastError() -> u32;
    }
    let name: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    unsafe {
        let handle = CreateFileW(
            name.as_ptr(),
            0x80000000,
            7,
            std::ptr::null_mut(),
            3,
            0x80,
            std::ptr::null_mut(),
        );
        if handle as isize == -1 {
            return if GetLastError() == 32 {
                Some(true)
            } else {
                None
            };
        }
        let mut o = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: std::ptr::null_mut(),
        };
        let locked = LockFileEx(handle, 3, 0, u32::MAX, u32::MAX, &mut o);
        let error = GetLastError();
        let result = if locked != 0 {
            UnlockFileEx(handle, 0, u32::MAX, u32::MAX, &mut o);
            Some(false)
        } else if error == 33 || error == 32 {
            Some(true)
        } else {
            None
        };
        CloseHandle(handle);
        result
    }
}
#[cfg(unix)]
fn held(path: &str) -> Option<bool> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
    let file = std::fs::File::open(path).ok()?;
    unsafe {
        if flock(file.as_raw_fd(), 2 | 4) == 0 {
            flock(file.as_raw_fd(), 8);
            Some(false)
        } else {
            let error = std::io::Error::last_os_error().raw_os_error();
            if error == Some(11) || error == Some(35) {
                Some(true)
            } else {
                None
            }
        }
    }
}
#[cfg(not(any(windows, unix)))]
fn held(_path: &str) -> Option<bool> {
    None
}
fn main() {
    let mut input = String::new();
    if io::stdin()
        .take(1024 * 1024)
        .read_to_string(&mut input)
        .is_err()
    {
        return;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&input) {
        if v["op"] == "windows" {
            if let Some(path) = v["path"].as_str() {
                println!("{}", window_lookup::lookup(path));
            }
            return;
        }
    }
    let Ok(paths) = serde_json::from_str::<Vec<String>>(&input) else {
        return;
    };
    let result: serde_json::Map<String, serde_json::Value> = paths
        .into_iter()
        .take(5000)
        .map(|p| {
            let value = serde_json::to_value(held(&p)).unwrap();
            (p, value)
        })
        .collect();
    println!("{}", serde_json::Value::Object(result));
}
