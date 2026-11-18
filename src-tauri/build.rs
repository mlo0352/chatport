use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

fn collect_files(current: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::metadata(&path)?;
        if metadata.is_dir() {
            collect_files(&path, files)?;
        } else if metadata.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn main() {
    tauri_build::build();

    // Debug builds run from the checked-out runtime folder. Release builds embed it.
    if env::var("PROFILE").as_deref() != Ok("release") {
        return;
    }

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let runtime = manifest.parent().unwrap().join("chatport-runtime");
    println!("cargo:rerun-if-changed={}", runtime.display());
    assert!(
        runtime.is_dir(),
        "chatport-runtime is missing; run `npm run build` before building a release"
    );

    let mut files = Vec::new();
    collect_files(&runtime, &mut files).unwrap();
    files.sort();

    let archive_path = PathBuf::from(env::var("OUT_DIR").unwrap()).join("runtime.zip");
    let mut archive = ZipWriter::new(File::create(&archive_path).unwrap());
    let default_options =
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for path in files {
        let name = path
            .strip_prefix(&runtime)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let options = if name == "node" || name == "chatport-probe" {
            default_options.unix_permissions(0o755)
        } else {
            default_options
        };
        archive.start_file(name, options).unwrap();
        let mut source = File::open(&path).unwrap();
        std::io::copy(&mut source, &mut archive).unwrap();
    }
    archive.finish().unwrap();

    let mut bytes = Vec::new();
    File::open(&archive_path)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }

    println!(
        "cargo:rustc-env=CHATPORT_RUNTIME_ID={}-{:016x}",
        env::var("CARGO_PKG_VERSION").unwrap(),
        hash
    );
}
