# Linux build framework

Linux paths, XDG data storage, provider discovery, terminal launchers, a read-only flock activity probe, OpenCode/Freebuff status evidence, best-effort X11 window focus through `xdotool`, and Debian/AppImage packaging are implemented. A Linux binary has **not** been built or tested yet. Windows-hosted fixture tests cover portable archives and path translation; they do not certify Linux runtime behavior.

No VMs, WSL distributions, containers, or CI machines are started by these scripts. Run the steps below later, on a Linux computer, at a controlled time. No virtualization is required.

Target baseline: Ubuntu 22.04 or Debian 12, x86_64 or aarch64. Build on the oldest supported distro to avoid a newer glibc dependency. Install Node.js 22.13+ and Rust, then the native Tauri dependencies:

```sh
sudo apt install build-essential pkg-config curl wget file libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
npm ci
npm run check
npm test
npm run dist
```

The native build bundles the current machine's Node executable and activity helper. Do not copy the Windows `chatport-runtime` directory into a Linux package. Output is in `src-tauri/target/release/bundle`. Linux desktop data is `${XDG_DATA_HOME:-$HOME/.local/share}/chatport` (override with `CHATPORT_DATA`). The provider CLIs must be installed separately and signed in on that computer; archives omit credentials. Desktop launchers must have those binaries on PATH. `CHATPORT_TERMINAL=/path/to/terminal` can override terminal detection. Common GNOME, KDE, Debian, Kitty, Alacritty, and WezTerm launchers are supported.

## Moving from Windows

Pair both computers in Nearby, send chats, and accept the incoming offer. USB/network-folder archives use the same validated format. In Sources or Nearby, add a mapping such as `C:\Users\example\Desktop\tools` → `/home/example/code`. The longest matching prefix wins; Linux matches are case sensitive. Each conversation's Edit folder overrides mappings. Copy the actual repositories separately. These overrides apply to the next resume and do not change an already running process or rewrite historical messages.

Portable conversations and images are readable across OSes. Codex native restore rewrites transcript paths into the destination profile, retains conversation IDs and queued history, and never merges over an existing conversation database. Resume support still depends on the destination provider CLI accepting its stored session format. Native Freebuff, Claude, T3, and OpenCode imports are readable, but cross-OS native resume is not currently implemented for those formats.

## Later hardware validation

1. Build/install on a real Linux laptop; check native pickers, dark/system theme, terminal startup and Unicode paths.
2. Transfer synthetic chats in both directions between Windows and Linux; verify image preview, checksums, receiver acceptance, interrupted-transfer retry, and identity retention after restart.
3. Restore a synthetic Codex profile, map the project path, sign in separately, and resume that exact session. Verify flock ownership on that CLI release.
4. Check discovery on the chosen LAN. It uses mDNS UDP 5353; transfers use an app-owned HTTPS TCP port. Network isolation or firewalls may prevent discovery; pairing links allow an explicit IP. ChatPort does not change firewall settings.
5. Test window focus on that desktop. Windows activation is implemented. On Linux, ChatPort uses `xdotool` to find and activate an X11 window owned by the process holding the Codex writer lock; install `xdotool` to use it. Native Wayland does not allow this and is reported as unavailable.

Tauri references: https://v2.tauri.app/start/prerequisites/ and https://v2.tauri.app/distribute/debian/.
