import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  HardDrive,
  Library as LibraryIcon,
  LoaderCircle,
  Minus,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Star,
  Terminal,
  Trash2,
  X,
  Link2,
  CheckCircle2,
  AlertCircle,
  MessageSquare,
  FileArchive,
  PanelLeftClose,
  PanelLeftOpen,
  SlidersHorizontal,
  Wifi,
} from "lucide-react";
import type { Chat, Job, Library, Message, Provider, Source } from "./types";
import {
  desktop,
  external,
  pickArchive,
  pickFolder,
  reveal,
  rpc,
  focusChat,
  openInTermSanity,
} from "./api";
import appIcon from "../app-icon.svg";
import ProviderLogo from "./ProviderLogo";
import ActivityBadge from "./ActivityBadge";
import Attachments from "./Attachments";
import { displayPath } from "./paths";
import { version } from "../package.json";
import Nearby, { FolderMappings } from "./Nearby";
const providerNames: Record<Provider, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  t3: "T3 Code",
  chatgpt: "ChatGPT",
  freebuff: "Freebuff",
};
const empty: Library = {
  chats: [],
  sources: [],
  jobs: [],
  scanning: true,
  machine: "",
  dataDir: "",
};
type View =
  "all" | "starred" | "archived" | "imported" | "transfers" | "nearby";
type Modal = "export" | "import" | "sources" | "folder" | "restore" | null;
const date = (value: number) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year:
          new Date(value).getFullYear() !== new Date().getFullYear()
            ? "numeric"
            : undefined,
      })
    : "—";
const folderName = (value: string) =>
  value.split(/[/\\]/).filter(Boolean).at(-1) || value;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
function Mark() {
  return <img className="app-mark" src={appIcon} alt="" />;
}
function ProviderDot({ provider }: { provider: Provider }) {
  return <ProviderLogo provider={provider} />;
}
function IconButton({
  title,
  children,
  onClick,
  disabled = false,
}: {
  title: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export default function App() {
  const [library, setLibrary] = useState(empty),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [view, setView] = useState<View>("all"),
    [provider, setProvider] = useState("all"),
    [query, setQuery] = useState(""),
    [matches, setMatches] = useState<{ id: string; excerpt: string }[]>([]),
    [selected, setSelected] = useState(""),
    [checked, setChecked] = useState<Set<string>>(new Set()),
    [modal, setModal] = useState<Modal>(null),
    [path, setPath] = useState(""),
    [sourceProvider, setSourceProvider] = useState<Provider>("codex"),
    [restoreSource, setRestoreSource] = useState<Source>(),
    [busy, setBusy] = useState(false),
    [collapsed, setCollapsed] = useState(false),
    [sort, setSort] = useState("newest");
  const [statusFilter, setStatusFilter] = useState("all"),
    [newMessages, setNewMessages] = useState(false);
  const lastRevision = useRef("");
  const prefs = library.preferences || {
    theme: "system" as const,
    liveUpdates: true,
    includeImages: true,
  };
  const [messages, setMessages] = useState<Message[]>([]),
    [cursor, setCursor] = useState<number>(),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false),
    [tools, setTools] = useState(false),
    [readerError, setReaderError] = useState("");
  const search = useRef<HTMLInputElement>(null),
    reader = useRef<HTMLDivElement>(null),
    readerGeneration = useRef(0);
  const chat = library.chats.find((c) => c.id === selected),
    source = library.sources.find((s) => s.id === chat?.sourceId);
  const refresh = async () => {
    try {
      setLibrary(await rpc<Library>("library"));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  async function settings(patch: Partial<typeof prefs>) {
    setLibrary((l) => ({ ...l, preferences: { ...prefs, ...patch } }));
    try {
      const p = await rpc("settings.update", patch);
      setLibrary((l) => ({ ...l, preferences: p }));
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        prefs.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : prefs.theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [prefs.theme]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        search.current?.focus();
      }
      if (e.key === "Escape") setModal(null);
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      if (!query.trim()) {
        setMatches([]);
        return;
      }
      rpc<{ id: string; excerpt: string }[]>("search", { q: query })
        .then((r) => live && setMatches(r))
        .catch(() => live && setMatches([]));
    }, 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, library.indexing]);
  const rows = useMemo(() => {
    const q = query.toLowerCase().trim(),
      ids = new Set(matches.map((m) => m.id));
    return library.chats
      .filter(
        (c) =>
          (view !== "starred" || c.starred) &&
          (view !== "archived" || c.archived) &&
          (view !== "imported" || c.imported) &&
          (provider === "all" || c.provider === provider) &&
          (statusFilter === "all" ||
            (statusFilter === "active"
              ? c.activity?.active === true
              : statusFilter === "unfinished"
                ? c.activity?.state === "unfinished"
                : c.activity?.state === statusFilter)) &&
          (!q ||
            [c.title, c.cwd, c.resumeCwd, c.nativeId, c.model].some((s) =>
              s?.toLowerCase().includes(q),
            ) ||
            ids.has(c.id)),
      )
      .sort((a, b) =>
        sort === "oldest"
          ? a.updatedAt - b.updatedAt
          : sort === "title"
            ? a.title.localeCompare(b.title)
            : b.updatedAt - a.updatedAt,
      );
  }, [library.chats, view, provider, query, matches, sort, statusFilter]);
  useEffect(() => {
    if (!selected && rows.length) setSelected(rows[0].id);
  }, [rows, selected]);
  useEffect(() => {
    const generation = ++readerGeneration.current;
    lastRevision.current = "";
    setNewMessages(false);
    setMessages([]);
    setReaderError("");
    setMore(false);
    setCursor(undefined);
    if (!selected) return;
    setLoading(true);
    rpc<{ messages: Message[]; before: number; hasMore: boolean }>("messages", {
      id: selected,
      tools,
    })
      .then((r) => {
        if (generation !== readerGeneration.current) return;
        setMessages(r.messages);
        lastRevision.current =
          chat?.activity?.revision || String(chat?.updatedAt || "");
        setCursor(r.before);
        setMore(r.hasMore);
        requestAnimationFrame(() => {
          if (reader.current)
            reader.current.scrollTop = reader.current.scrollHeight;
        });
      })
      .catch(
        (e) =>
          generation === readerGeneration.current &&
          setReaderError(errorText(e)),
      )
      .finally(
        () => generation === readerGeneration.current && setLoading(false),
      );
  }, [selected, tools]);
  const revision = chat?.activity?.revision || String(chat?.updatedAt || "");
  useEffect(() => {
    if (
      !selected ||
      !prefs.liveUpdates ||
      !messages.length ||
      lastRevision.current === revision
    )
      return;
    let current = true;
    const generation = readerGeneration.current;
    const el = reader.current;
    const following =
      !el || el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    rpc<{ messages: Message[]; before: number; hasMore: boolean }>("messages", {
      id: selected,
      tools,
    })
      .then((r) => {
        if (!current || generation !== readerGeneration.current) return;
        lastRevision.current = revision;
        setMessages((old) => {
          const byId = new Map(old.map((m) => [m.id, m]));
          for (const m of r.messages) byId.set(m.id, m);
          return [...byId.values()];
        });
        setReaderError("");
        if (following)
          requestAnimationFrame(() => {
            if (reader.current)
              reader.current.scrollTop = reader.current.scrollHeight;
          });
        else setNewMessages(true);
      })
      .catch((e) => current && setReaderError(errorText(e)));
    return () => {
      current = false;
    };
  }, [selected, tools, revision, prefs.liveUpdates, messages.length]);
  async function action(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await fn();
      if (success) setNotice(success);
      await refresh();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  function show(m: Modal, initial = "") {
    setPath(initial);
    setModal(m);
  }
  async function browseFile() {
    try {
      const file = await pickArchive();
      if (file) setPath(file);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function browseFolder() {
    try {
      const dir = await pickFolder(path || undefined);
      if (dir) setPath(dir);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function submit() {
    let ok = false;
    if (modal === "export")
      ok = await action(
        () =>
          rpc("export", {
            destination: path,
            includeImages: prefs.includeImages,
            ...(checked.size ? { ids: [...checked] } : {}),
          }),
        "Export started. You can keep browsing.",
      );
    if (modal === "import")
      ok = await action(
        () => rpc("import", { file: path, includeImages: prefs.includeImages }),
        "Import started. Integrity checks run before chats enter your library.",
      );
    if (modal === "sources")
      ok = await action(
        () => rpc("source.add", { provider: sourceProvider, root: path }),
        "Source added. Scanning for conversations.",
      );
    if (modal === "folder" && chat)
      ok = await action(
        () => rpc("preference", { id: chat.id, cwd: path }),
        "Resume folder saved.",
      );
    if (modal === "restore" && restoreSource)
      ok = await action(
        () => rpc("restore", { sourceId: restoreSource.id, target: path }),
        "Native profile restore started.",
      );
    if (ok) setModal(null);
  }
  async function older() {
    if (!chat || loading) return;
    const generation = readerGeneration.current;
    setLoading(true);
    const height = reader.current?.scrollHeight || 0;
    try {
      const r = await rpc("messages", { id: chat.id, before: cursor, tools });
      if (generation !== readerGeneration.current) return;
      setMessages((m) => [...r.messages, ...m]);
      setCursor(r.before);
      setMore(r.hasMore);
      requestAnimationFrame(() => {
        if (reader.current)
          reader.current.scrollTop = reader.current.scrollHeight - height;
      });
    } catch (e) {
      setReaderError(errorText(e));
    } finally {
      if (generation === readerGeneration.current) setLoading(false);
    }
  }
  function toggle(id: string) {
    setChecked((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  const running = library.jobs.filter((j) => j.state === "running").length;
  return (
    <div className={"app " + (collapsed ? "nav-collapsed" : "")}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <Mark />
          <strong data-tauri-drag-region>ChatPort</strong>
          <span className="brand-subtitle" data-tauri-drag-region></span>
        </div>
        <div className="window-buttons">
          {desktop && (
            <>
              <button
                aria-label="Minimize"
                onClick={() => getCurrentWindow().minimize()}
              >
                <Minus size={15} />
              </button>
              <button
                aria-label="Maximize"
                onClick={() => getCurrentWindow().toggleMaximize()}
              >
                <Square size={12} />
              </button>
              <button
                className="close-window"
                aria-label="Close"
                onClick={() => getCurrentWindow().close()}
              >
                <X size={17} />
              </button>
            </>
          )}
        </div>
      </header>
      <aside className="sidebar">
        <div className="sidebar-top">
          <span className="eyebrow">LIBRARY</span>
          <IconButton
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </IconButton>
        </div>
        <nav>
          {(
            [
              ["all", "All conversations", LibraryIcon, library.chats.length],
              ["nearby", "Nearby", Wifi, ""],
              [
                "starred",
                "Starred",
                Star,
                library.chats.filter((c) => c.starred).length,
              ],
              [
                "archived",
                "Archived",
                Archive,
                library.chats.filter((c) => c.archived).length,
              ],
              [
                "imported",
                "Imported",
                ArrowDownToLine,
                library.chats.filter((c) => c.imported).length,
              ],
              [
                "transfers",
                "Transfers",
                FileArchive,
                running || library.jobs.length,
              ],
            ] as const
          ).map(([id, label, Icon, count]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              title={label}
              onClick={() => setView(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              <b>{count}</b>
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          <div className="section-label">
            <span>SOURCES</span>
            <IconButton title="Manage sources" onClick={() => show("sources")}>
              <Plus />
            </IconButton>
          </div>
          <button
            className={"source-item " + (provider === "all" ? "chosen" : "")}
            onClick={() => {
              setProvider("all");
              if (view === "transfers") setView("all");
            }}
          >
            <HardDrive size={17} />
            <span>All sources</span>
          </button>
          {(
            [
              "codex",
              "claude",
              "opencode",
              "t3",
              "chatgpt",
              "freebuff",
            ] as Provider[]
          ).map((p) => {
            const n = library.chats.filter((c) => c.provider === p).length;
            return (
              <button
                key={p}
                title={providerNames[p]}
                className={"source-item " + (provider === p ? "chosen" : "")}
                onClick={() => {
                  setProvider(p);
                  if (view === "transfers") setView("all");
                }}
              >
                <ProviderDot provider={p} />
                <span>{providerNames[p]}</span>
                <b>{n}</b>
              </button>
            );
          })}
        </div>
        <div className="sidebar-bottom">
          <button className="transfer-card" onClick={() => show("export")}>
            <ArrowUpRight size={20} />
            <strong>Export conversations</strong>
          </button>
          <div className="machine" title={library.dataDir}>
            <Monitor size={16} />
            <span>{library.machine || "Connecting…"}</span>
            <IconButton
              title="Sources and integration details"
              onClick={() => show("sources")}
            >
              <Settings2 />
            </IconButton>
          </div>
        </div>
      </aside>
      <main className="main">
        <div className="toolbar">
          <div className="search">
            <Search size={18} />
            <input
              ref={search}
              placeholder="Search conversations, folders, and messages…"
              aria-label="Search conversations"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query ? (
              <IconButton title="Clear search" onClick={() => setQuery("")}>
                <X />
              </IconButton>
            ) : (
              <kbd>Ctrl K</kbd>
            )}
          </div>
          <IconButton
            title="Scan for chats"
            onClick={() => action(() => rpc("scan"))}
          >
            <RefreshCw className={library.scanning ? "spin" : ""} />
          </IconButton>
          <button className="button" onClick={() => show("import")}>
            <ArrowDownToLine size={16} />
            Import
          </button>
          <button className="button primary" onClick={() => show("export")}>
            <ArrowUpFromLine size={16} />
            {checked.size ? `Export ${checked.size}` : "Export all"}
          </button>
        </div>
        {error && (
          <div className="banner error" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
            <IconButton title="Dismiss error" onClick={() => setError("")}>
              <X />
            </IconButton>
          </div>
        )}
        {library.scanError && (
          <div className="banner error">{library.scanError}</div>
        )}
        {view === "nearby" ? (
          <Nearby
            ids={[...checked]}
            total={library.chats.length}
            includeImages={prefs.includeImages}
            onImported={() => void refresh()}
          />
        ) : view === "transfers" ? (
          <section className="transfer-page">
            <div className="page-heading">
              <div>
                <h1>Transfers</h1>
                <p>Export and import history.</p>
              </div>
              <button className="button primary" onClick={() => show("export")}>
                <Plus size={16} />
                New export
              </button>
            </div>
            {!library.jobs.length ? (
              <div className="empty-state">
                <FileArchive size={34} />
                <h2>No transfers yet</h2>
                <p>
                  Export to a USB drive, mapped drive, or network folder.
                  <br />
                  Import the same archive on your other machine.
                </p>
                <button className="button" onClick={() => show("import")}>
                  Import an archive
                </button>
              </div>
            ) : (
              <div className="job-list">
                {library.jobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    cancel={() =>
                      action(() => rpc("job.cancel", { id: job.id }))
                    }
                    reveal={() => action(() => reveal(job.path!))}
                  />
                ))}
              </div>
            )}
            <div className="transfer-note">
              <CheckCircle2 size={18} />
              <p>
                Imports are checked against SHA-256 file hashes. Provider
                sign-in files, API keys, and application configuration are
                excluded from ChatPort exports. Conversation text can contain
                secrets you put in it.
              </p>
            </div>
          </section>
        ) : (
          <div className="library-layout">
            <section className="conversation-list">
              <div className="list-heading">
                <div>
                  <h1>
                    {view === "starred"
                      ? "Starred"
                      : view === "archived"
                        ? "Archived"
                        : view === "imported"
                          ? "Imported"
                          : "Conversations"}
                  </h1>
                  <span>
                    {rows.length}{" "}
                    {rows.length === 1 ? "conversation" : "conversations"}
                    {library.scanning
                      ? " · scanning…"
                      : library.indexing
                        ? " · indexing messages…"
                        : ""}
                  </span>
                </div>
                <select
                  aria-label="Sort conversations"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="title">A–Z</option>
                </select>
              </div>
              <div className="selection-bar">
                <select
                  className="status-filter"
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  <option value="active">Active</option>
                  <option value="unfinished">Unfinished</option>
                  <option value="interrupted">Interrupted</option>
                  <option value="failed">Failed</option>
                </select>
                <label>
                  <input
                    type="checkbox"
                    aria-label="Select all visible conversations"
                    checked={
                      !!rows.length && rows.every((c) => checked.has(c.id))
                    }
                    onChange={(e) =>
                      setChecked(
                        e.target.checked
                          ? new Set([...checked, ...rows.map((c) => c.id)])
                          : new Set(
                              [...checked].filter(
                                (id) => !rows.some((c) => c.id === id),
                              ),
                            ),
                      )
                    }
                  />
                  <span>
                    {checked.size
                      ? `${checked.size} selected`
                      : "Select for export"}
                  </span>
                </label>
                {!!checked.size && (
                  <button
                    className="text-button"
                    onClick={() => setChecked(new Set())}
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="chat-rows" role="list">
                {rows.map((c) => (
                  <div
                    key={c.id}
                    data-chat-id={c.id}
                    className={
                      "chat-row " + (selected === c.id ? "selected" : "")
                    }
                    role="listitem"
                  >
                    <input
                      type="checkbox"
                      aria-label={"Select " + c.title}
                      checked={checked.has(c.id)}
                      onChange={() => toggle(c.id)}
                    />
                    <button
                      className="chat-main"
                      onClick={() => setSelected(c.id)}
                    >
                      <div className="chat-title">
                        <strong>{c.title}</strong>
                        {c.starred && <Star size={12} fill="currentColor" />}
                      </div>
                      <div className="chat-meta">
                        <ProviderDot provider={c.provider} />
                        <ActivityBadge activity={c.activity} compact />
                        <span>
                          {folderName(c.resumeCwd || c.cwd) ||
                            providerNames[c.provider]}
                        </span>
                        {c.imported && <ArrowDownToLine size={12} />}
                        <time>{date(c.updatedAt)}</time>
                      </div>
                      {query && matches.find((m) => m.id === c.id) && (
                        <p className="excerpt">
                          {matches.find((m) => m.id === c.id)?.excerpt}
                        </p>
                      )}
                    </button>
                  </div>
                ))}
                {!rows.length && (
                  <div className="empty-state small">
                    <MessageSquare size={28} />
                    <h2>
                      {query
                        ? "No conversations found"
                        : library.scanning
                          ? "Looking for conversations…"
                          : "No conversations here yet"}
                    </h2>
                    <p>
                      {query
                        ? "Try a title, working folder, or phrase from a message."
                        : "Add a provider folder or import a conversation archive."}
                    </p>
                    {!query && (
                      <button
                        className="button"
                        onClick={() => show("sources")}
                      >
                        Add a source
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>
            <section className="reader">
              {chat ? (
                <>
                  <div className="reader-heading">
                    <div className="reader-kicker">
                      <ProviderDot provider={chat.provider} />
                      <ActivityBadge activity={chat.activity} />
                      <span>{providerNames[chat.provider]}</span>
                      {chat.imported && <span className="pill">Imported</span>}
                      {chat.archived && <span className="pill">Archived</span>}
                      <span className="reader-actions">
                        <IconButton
                          title={
                            chat.starred
                              ? "Unstar conversation"
                              : "Star conversation"
                          }
                          onClick={() =>
                            action(() =>
                              rpc("preference", {
                                id: chat.id,
                                starred: !chat.starred,
                              }),
                            )
                          }
                        >
                          <Star fill={chat.starred ? "currentColor" : "none"} />
                        </IconButton>
                        <IconButton
                          title="Copy conversation ID"
                          onClick={() =>
                            action(
                              () =>
                                navigator.clipboard.writeText(chat.nativeId),
                              "Conversation ID copied.",
                            )
                          }
                        >
                          <Copy />
                        </IconButton>
                      </span>
                    </div>
                    <h2 title={chat.title}>{chat.title}</h2>
                    <div className="reader-details">
                      <span>{new Date(chat.updatedAt).toLocaleString()}</span>
                      {chat.model && <span>{chat.model}</span>}
                    </div>
                    <div className="working-folder">
                      <FolderOpen size={16} />
                      <div>
                        <span>Resume folder</span>
                        <button
                          title={
                            chat.resumeCwd ||
                            chat.cwd ||
                            "Choose a working folder"
                          }
                          onClick={() =>
                            show("folder", chat.resumeCwd || chat.cwd)
                          }
                        >
                          {chat.resumeCwd ||
                            chat.cwd ||
                            "Choose a working folder"}
                        </button>
                      </div>
                      <button
                        className="text-button"
                        onClick={() =>
                          show("folder", chat.resumeCwd || chat.cwd)
                        }
                      >
                        Edit
                      </button>
                    </div>
                    {chat.resumeCwd && chat.resumeCwd !== chat.cwd && (
                      <div className="original-folder" title={chat.cwd}>
                        Original: {chat.cwd || "none recorded"}
                      </div>
                    )}
                    <div className="reader-controls">
                      {chat.activity?.active === true && (
                        <button
                          className="button compact"
                          disabled={busy}
                          title="Focus the open chat; TermSanity selects its exact pane and tab"
                          onClick={() => action(() => focusChat(chat.id))}
                        >
                          <Monitor size={15} />
                          Focus open chat
                        </button>
                      )}
                      <button
                        className="button primary compact"
                        disabled={
                          busy ||
                          !["codex", "claude", "opencode"].includes(
                            chat.provider,
                          ) ||
                          (chat.imported &&
                            !(chat.provider === "codex" && source?.nativeRoot))
                        }
                        onClick={() =>
                          action(
                            () => rpc("resume", { id: chat.id }),
                            "Conversation opened in a terminal.",
                          )
                        }
                      >
                        <Terminal size={15} />
                        Resume in terminal
                        <ArrowUpRight size={13} />
                      </button>
                      <IconButton
                        title="Copy resume command"
                        onClick={() =>
                          action(async () => {
                            const cmd = await rpc<string>("resume.plan", {
                              id: chat.id,
                            });
                            await navigator.clipboard.writeText(cmd);
                          }, "Resume command copied.")
                        }
                      >
                        <Copy />
                      </IconButton>
                      {["codex", "claude"].includes(chat.provider) &&
                        !chat.imported && (
                          <button
                            className="text-button termsanity"
                            title="Open this conversation in TermSanity"
                            onClick={() =>
                              action(
                                () => openInTermSanity(chat.id),
                                "Opened as an agent tab in TermSanity.",
                              )
                            }
                          >
                            <Link2 size={14} />
                            TermSanity
                          </button>
                        )}
                      <label className="tools-toggle">
                        <input
                          type="checkbox"
                          aria-label="Live updates"
                          checked={prefs.liveUpdates}
                          onChange={(e) =>
                            settings({ liveUpdates: e.target.checked })
                          }
                        />
                        Live
                      </label>
                      <label className="tools-toggle">
                        <input
                          type="checkbox"
                          checked={tools}
                          onChange={(e) => setTools(e.target.checked)}
                        />
                        Tools
                      </label>
                    </div>
                    {chat.imported &&
                      chat.provider === "codex" &&
                      !source?.nativeRoot && (
                        <div className="import-hint">
                          <span>
                            Reading from an archive. Restore a native profile to
                            resume.
                          </span>
                          <button
                            className="text-button"
                            onClick={() => {
                              setRestoreSource(source);
                              show("restore");
                            }}
                          >
                            Restore profile
                            <ChevronRight size={13} />
                          </button>
                        </div>
                      )}
                    {["t3", "chatgpt", "freebuff"].includes(chat.provider) && (
                      <p className="read-only-note">
                        Read and transfer here. Continue this chat in{" "}
                        {providerNames[chat.provider]}.
                      </p>
                    )}
                  </div>
                  <div className="message-scroll" ref={reader}>
                    {newMessages && (
                      <button
                        className="load-older jump-latest"
                        onClick={() => {
                          if (reader.current)
                            reader.current.scrollTop =
                              reader.current.scrollHeight;
                          setNewMessages(false);
                        }}
                      >
                        Jump to latest messages
                      </button>
                    )}
                    {more && (
                      <button
                        className="load-older"
                        disabled={loading}
                        onClick={older}
                      >
                        {loading ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <ArrowUpFromLine size={14} />
                        )}
                        Load earlier messages
                      </button>
                    )}
                    {loading && !messages.length && (
                      <div className="loading">
                        <LoaderCircle className="spin" />
                        Loading conversation…
                      </div>
                    )}
                    {readerError && (
                      <div className="banner error">{readerError}</div>
                    )}
                    {messages.map((m, i) => (
                      <article
                        key={m.id + "-" + i}
                        className={"message " + m.role}
                      >
                        <div className="message-label">
                          <span>
                            {m.role === "user"
                              ? "You"
                              : m.role === "assistant"
                                ? providerNames[chat.provider]
                                : m.role === "tool"
                                  ? "Tool output"
                                  : "System"}
                          </span>
                          {m.at ? (
                            <time>
                              {new Date(m.at).toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </time>
                          ) : null}
                          <IconButton
                            title="Copy message"
                            onClick={() =>
                              action(
                                () => navigator.clipboard.writeText(m.text),
                                "Message copied.",
                              )
                            }
                          >
                            <Copy />
                          </IconButton>
                        </div>
                        <div className="message-text">{m.text}</div>
                        {!!m.attachments?.length && (
                          <Attachments chatId={chat.id} items={m.attachments} />
                        )}
                      </article>
                    ))}
                    {!loading && !messages.length && !readerError && (
                      <div className="empty-state small">
                        <MessageSquare size={28} />
                        <h2>No readable messages</h2>
                        <p>
                          This session may contain only tool events, or its
                          transcript is no longer available.
                        </p>
                      </div>
                    )}
                  </div>
                  <footer className="reader-footer">
                    <span className="dot" />
                    Saved conversation · {chat.nativeId}
                    <button
                      className="text-button"
                      onClick={() => {
                        setChecked(new Set([chat.id]));
                        show("export");
                      }}
                    >
                      Export this chat
                      <ArrowUpRight size={12} />
                    </button>
                  </footer>
                </>
              ) : (
                <div className="empty-state welcome">
                  <Mark />
                  <span className="eyebrow"></span>
                  <h1>Select a conversation</h1>
                  <p>
                    Browse the chats on this machine, choose a new working
                    folder,
                    <br />
                    or export it to another drive.
                  </p>
                  <button className="button" onClick={() => show("import")}>
                    <ArrowDownToLine size={16} />
                    Import conversations
                  </button>
                </div>
              )}
            </section>
          </div>
        )}
        <footer className="statusbar">
          <span>
            <span className={"dot " + (error ? "offline" : "")} />
            {library.scanning
              ? "Scanning sources"
              : library.indexing
                ? "Indexing message search"
                : `${library.chats.length} conversations across ${library.sources.filter((s) => s.count > 0).length} sources`}
          </span>
          {running ? (
            <button onClick={() => setView("transfers")}>
              <LoaderCircle className="spin" size={12} />
              {running} transfer{running === 1 ? "" : "s"} in progress
            </button>
          ) : (
            <span>ChatPort {version}</span>
          )}
        </footer>
      </main>
      {notice && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {notice}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className={"modal " + (modal === "sources" ? "wide" : "")}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <header>
              <div>
                <span className="eyebrow"></span>
                <h2 id="modal-title">
                  {modal === "export"
                    ? `Export ${checked.size || library.chats.length} conversations`
                    : modal === "import"
                      ? "Import conversations"
                      : modal === "folder"
                        ? "Change resume folder"
                        : modal === "restore"
                          ? "Restore a Codex profile"
                          : "Sources & integrations"}
                </h2>
              </div>
              <IconButton title="Close dialog" onClick={() => setModal(null)}>
                <X />
              </IconButton>
            </header>
            <div className="modal-body">
              {(modal === "export" || modal === "import") && (
                <label className="image-option">
                  <input
                    type="checkbox"
                    checked={prefs.includeImages}
                    onChange={(e) =>
                      settings({ includeImages: e.target.checked })
                    }
                  />
                  <span>
                    <strong>Include image files</strong>
                    <small>
                      Copies available screenshots and attachments. Native
                      history may already contain embedded images.
                    </small>
                  </span>
                </label>
              )}
              {modal === "export" && (
                <>
                  <div className="feature-strip">
                    <FileArchive />
                    <div>
                      <strong>Archive contents</strong>
                      <p>
                        Includes conversation text, original IDs, and supported
                        native session data. Copy it to a USB drive or a network
                        folder, then import it on the next machine.
                      </p>
                    </div>
                  </div>
                  <label className="field-label">Destination folder</label>
                  <PathField
                    value={path}
                    set={setPath}
                    browse={browseFolder}
                    placeholder="E:\Chats or \\server\share\Chats"
                  />
                  <p className="field-help">
                    The destination can be removable storage, a mapped drive, or
                    a UNC network path. No credentials or provider config files
                    are added.
                  </p>
                  {!!checked.size && (
                    <button
                      className="text-button"
                      onClick={() => setChecked(new Set())}
                    >
                      Export all {library.chats.length} conversations instead
                    </button>
                  )}
                </>
              )}
              {modal === "import" && (
                <>
                  <p className="dialog-description">
                    Open a ChatPort archive from another machine, or a ChatGPT{" "}
                    <code>conversations.json</code> / data export ZIP. Imported
                    chats stay separate from your live provider profiles.
                  </p>
                  <label className="field-label">Archive file</label>
                  <PathField
                    value={path}
                    set={setPath}
                    browse={browseFile}
                    placeholder="Choose a .chatport.zip, .zip, or .json file"
                  />
                  <div className="info-box">
                    <CheckCircle2 size={18} />
                    <p>
                      ChatPort archives are verified before being added.
                      Existing chats are kept. Cloud-only ChatGPT chats require
                      a data export from ChatGPT.
                    </p>
                  </div>
                </>
              )}
              {modal === "folder" && (
                <>
                  <p className="dialog-description">
                    Choose where this conversation should resume. ChatPort saves
                    the choice and starts the same session in that folder.
                    Project files stay in their current locations.
                  </p>
                  <label className="field-label">Working directory</label>
                  <PathField
                    value={path}
                    set={setPath}
                    browse={browseFolder}
                    placeholder="Choose an existing project folder"
                  />
                  <p className="field-help">
                    Original recorded folder: <code>{chat?.cwd || "none"}</code>
                  </p>
                  <div className="info-box">
                    <Terminal size={18} />
                    <p>
                      Codex supports a folder override on resume. Claude Code
                      and OpenCode start from the selected folder. This applies
                      to the next resumed process; it does not change a running
                      agent.
                    </p>
                  </div>
                  {chat?.resumeCwd && (
                    <button
                      className="text-button"
                      onClick={async () => {
                        if (
                          await action(
                            () => rpc("preference", { id: chat.id, cwd: "" }),
                            "Original folder restored.",
                          )
                        )
                          setModal(null);
                      }}
                    >
                      Reset to original folder
                    </button>
                  )}
                </>
              )}
              {modal === "restore" && (
                <>
                  <p className="dialog-description">
                    Restore the native Codex data from this imported archive
                    into a separate profile. Original conversation IDs and
                    queued native data are retained.
                  </p>
                  <label className="field-label">
                    Empty Codex profile folder
                  </label>
                  <PathField
                    value={path}
                    set={setPath}
                    browse={browseFolder}
                    placeholder="e.g. D:\Codex-profile"
                  />
                  <div className="info-box">
                    <HardDrive size={18} />
                    <p>
                      Choose an empty folder. Existing <code>auth.json</code>{" "}
                      and <code>config.toml</code> may remain; other files stop
                      the restore. Resume uses this folder as{" "}
                      <code>CODEX_HOME</code>. Sign in on the destination
                      machine if needed.
                    </p>
                  </div>
                </>
              )}
              {modal === "sources" && (
                <>
                  <FolderMappings />
                  <div className="app-settings">
                    <label>
                      Appearance
                      <select
                        aria-label="Appearance"
                        value={prefs.theme}
                        onChange={(e) =>
                          settings({
                            theme: e.target.value as
                              "system" | "light" | "dark",
                          })
                        }
                      >
                        <option value="system">System</option>
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                      </select>
                    </label>
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={prefs.liveUpdates}
                        onChange={(e) =>
                          settings({ liveUpdates: e.target.checked })
                        }
                      />
                      Live conversation updates
                    </label>
                  </div>
                  <p className="dialog-description">
                    ChatPort discovers supported local stores. Add a folder for
                    another profile, drive, or custom installation.
                  </p>
                  <div className="source-list">
                    {library.sources.map((s) => (
                      <div key={s.id}>
                        <ProviderDot provider={s.provider} />
                        <div>
                          <strong>
                            {s.name}
                            {s.imported ? " · archive" : ""}
                          </strong>
                          <span title={s.root}>{s.root}</span>
                          {s.error && (
                            <small className="source-error">{s.error}</small>
                          )}
                        </div>
                        <span className="source-count">
                          {s.error
                            ? "Check source"
                            : s.available
                              ? `${s.count} chats`
                              : "Not found"}
                        </span>
                        {s.provider === "codex" && s.imported && (
                          <button
                            className="text-button"
                            onClick={() => {
                              setRestoreSource(s);
                              show("restore");
                            }}
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="add-source">
                    <label className="field-label">Add a provider folder</label>
                    <div className="source-fields">
                      <select
                        aria-label="Source provider"
                        value={sourceProvider}
                        onChange={(e) =>
                          setSourceProvider(e.target.value as Provider)
                        }
                      >
                        {(
                          [
                            "codex",
                            "claude",
                            "opencode",
                            "t3",
                            "freebuff",
                          ] as Provider[]
                        ).map((p) => (
                          <option key={p} value={p}>
                            {providerNames[p]}
                          </option>
                        ))}
                      </select>
                      <PathField
                        value={path}
                        set={setPath}
                        browse={browseFolder}
                        placeholder={
                          sourceProvider === "t3"
                            ? "T3 userdata folder containing statev2.sqlite"
                            : "Provider data folder"
                        }
                      />
                    </div>
                  </div>
                  <div className="integration-card">
                    <div>
                      <ProviderLogo provider="t3" />
                      <strong>T3 Code</strong>
                      <span className="pill">MIT · open source</span>
                    </div>
                    <p>
                      Read and transfer T3 conversations alongside native CLI
                      chats. T3 also offers native-session import and remote
                      access. The adapter supports V1 and V2 database layouts;
                      T3 is not installed on this machine for live integration
                      testing.
                    </p>
                    <button
                      className="text-button"
                      onClick={() =>
                        external("https://github.com/pingdotgg/t3code")
                      }
                    >
                      Explore T3 Code
                      <ArrowUpRight size={13} />
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        external(
                          "https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-migration.md",
                        )
                      }
                    >
                      Session migration docs
                      <ArrowUpRight size={13} />
                    </button>
                  </div>
                </>
              )}
            </div>
            <footer>
              <button className="button" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy || !path.trim()}
                onClick={submit}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : modal === "export" ? (
                  <ArrowUpFromLine size={16} />
                ) : modal === "sources" ? (
                  <Plus size={16} />
                ) : (
                  <Check size={16} />
                )}{" "}
                {modal === "export"
                  ? "Create archive"
                  : modal === "import"
                    ? "Import conversations"
                    : modal === "folder"
                      ? "Save folder"
                      : modal === "restore"
                        ? "Restore profile"
                        : "Add source"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
function PathField({
  value,
  set,
  browse,
  placeholder,
}: {
  value: string;
  set: (v: string) => void;
  browse: () => void;
  placeholder: string;
}) {
  return (
    <div className="path-field">
      <input
        autoFocus
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      <button className="button" title="Browse" onClick={browse}>
        <FolderOpen size={17} />
        Browse
      </button>
    </div>
  );
}
function JobCard({
  job,
  cancel,
  reveal,
}: {
  job: Job;
  cancel: () => void;
  reveal: () => void;
}) {
  return (
    <article className={"job-card " + job.state}>
      <div className="job-icon">
        {job.state === "running" ? (
          <LoaderCircle className="spin" />
        ) : job.state === "completed" ? (
          <CheckCircle2 />
        ) : job.state === "failed" ? (
          <AlertCircle />
        ) : (
          <X />
        )}
      </div>
      <div className="job-info">
        <strong>
          {job.type === "export"
            ? "Conversation export"
            : job.type === "import"
              ? "Conversation import"
              : "Native Codex restore"}{" "}
          <span className="pill">{job.state}</span>
        </strong>
        <p>
          {job.error || job.stage}
          {job.result?.chatCount
            ? ` · ${job.result.chatCount} conversations`
            : ""}
        </p>
        {job.state === "running" && <progress max={1} value={job.progress} />}
        <span className="job-path" title={job.path}>
          {job.path || new Date(job.createdAt).toLocaleString()}
        </span>
        {job.result?.sha256 && (
          <span className="checksum" title={job.result.sha256}>
            SHA-256 · {job.result.sha256.slice(0, 24)}…
          </span>
        )}
      </div>
      {job.state === "running" && job.type !== "restore" ? (
        <button className="button" onClick={cancel}>
          Cancel
        </button>
      ) : job.path ? (
        <button className="button" onClick={reveal}>
          <FolderOpen size={16} />
          Show files
        </button>
      ) : null}
    </article>
  );
}
