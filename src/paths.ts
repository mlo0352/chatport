export function displayPath(value: string) {
  if (value.startsWith("\\\\?\\UNC\\")) return "\\\\" + value.slice(8);
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}
export type FolderMapping = { id: string; from: string; to: string };
export function pathKind(value: string): "win32" | "posix" | "relative" {
  const p = displayPath(value);
  return /^[a-z]:[/\\]/i.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
    ? "win32"
    : p.startsWith("/")
      ? "posix"
      : "relative";
}
export function normalizedParts(value: string) {
  const p = displayPath(value),
    kind = pathKind(p);
  return {
    kind,
    parts: p.split(kind === "win32" ? /[/\\]+/ : /\/+/).filter(Boolean),
  };
}
export function relativePortable(root: string, file: string): string | null {
  const a = normalizedParts(root),
    b = normalizedParts(file);
  if (
    a.kind === "relative" ||
    a.kind !== b.kind ||
    b.parts.length < a.parts.length
  )
    return null;
  const fold = (s: string) => (a.kind === "win32" ? s.toLowerCase() : s);
  if (!a.parts.every((p, i) => fold(p) === fold(b.parts[i]))) return null;
  const rest = b.parts.slice(a.parts.length);
  if (rest.some((p) => p === ".." || p === ".")) return null;
  return rest.join("/");
}
export function mappedFolder(value: string, rules: FolderMapping[]) {
  for (const rule of [...rules].sort((a, b) => b.from.length - a.from.length)) {
    const rel = relativePortable(rule.from, value);
    if (rel !== null) {
      const sep = pathKind(rule.to) === "win32" ? "\\" : "/";
      return {
        path: rel
          ? displayPath(rule.to).replace(/[/\\]+$/, "") +
            sep +
            rel.split("/").join(sep)
          : displayPath(rule.to),
        ruleId: rule.id,
      };
    }
  }
  return { path: displayPath(value), ruleId: undefined };
}
export function nativeFolder(value: string, platform: string) {
  return pathKind(value) === (platform === "win32" ? "win32" : "posix");
}
