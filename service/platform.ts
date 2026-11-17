import { homedir } from "node:os";
import { join, win32, posix } from "node:path";
import { existsSync, statSync } from "node:fs";
export function appDataPath(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  const join = platform === "win32" ? win32.join : posix.join;
  return platform === "win32"
    ? join(env.LOCALAPPDATA || home, "ChatPort")
    : platform === "darwin"
      ? join(home, "Library", "Application Support", "ChatPort")
      : join(env.XDG_DATA_HOME || join(home, ".local", "share"), "chatport");
}
export function executableName(name: string, platform = process.platform) {
  return name + (platform === "win32" ? ".exe" : "");
}
export function pathEntries(
  platform = process.platform,
  path = process.env.PATH || "",
) {
  return path.split(platform === "win32" ? ";" : ":").filter(Boolean);
}
export function findExecutable(
  name: string,
  platform = process.platform,
  extra: string[] = [],
) {
  return [
    ...pathEntries(platform).map((p) =>
      join(p, executableName(name, platform)),
    ),
    ...extra,
  ].find((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}
export function terminalPlan(
  executable: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  platform = process.platform,
) {
  if (platform === "win32") {
    const q = (s: string) => "'" + s.replaceAll("'", "''") + "'";
    const script =
      Object.entries(env)
        .map(([k, v]) => `$env:${k}=${q(v)};`)
        .join("") +
      `Set-Location -LiteralPath ${q(cwd)}; & ${q(executable)} @(${args.map(q).join(",")})`;
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoExit",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      display: script,
    };
  }
  const q = (s: string) => "'" + s.replaceAll("'", `'"'"'`) + "'";
  const invocation =
    Object.entries(env)
      .map(([k, v]) => `${k}=${q(v)}`)
      .join(" ") + ` ${q(executable)} ${args.map(q).join(" ")}`;
  const script = `cd -- ${q(cwd)} && ${invocation}; printf '\\nPress Enter to close this terminal.'; read answer`;
  const choices: [string, string[]][] = [
    ["x-terminal-emulator", ["-e"]],
    ["gnome-terminal", ["--"]],
    ["konsole", ["-e"]],
    ["kitty", ["--directory", cwd]],
    ["alacritty", ["--working-directory", cwd, "-e"]],
    ["wezterm", ["start", "--cwd", cwd, "--"]],
  ];
  if (process.env.CHATPORT_TERMINAL)
    choices.unshift([process.env.CHATPORT_TERMINAL, ["-e"]]);
  for (const [candidate, prefix] of choices) {
    const bin = candidate.includes("/")
      ? existsSync(candidate)
        ? candidate
        : undefined
      : findExecutable(candidate, platform);
    if (bin)
      return {
        command: bin,
        args: [...prefix, "/bin/sh", "-lc", script],
        display: `cd -- ${q(cwd)}; ${invocation}`,
      };
  }
  throw new Error(
    "No desktop terminal was found. Install a terminal or set CHATPORT_TERMINAL to its executable path.",
  );
}
