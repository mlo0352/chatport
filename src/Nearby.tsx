import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Copy,
  FolderOpen,
  LoaderCircle,
  Monitor,
  RefreshCw,
  Trash2,
  Wifi,
} from "lucide-react";
import { rpc, pickFolder } from "./api";
import type { FolderMapping } from "./paths";
type Peer = {
  id: string;
  name: string;
  platform: string;
  host: string;
  online: boolean;
  trusted: boolean;
};
type Transfer = {
  remoteState?: string;
  id: string;
  direction: "incoming" | "outgoing";
  peerName: string;
  state: string;
  chatCount: number;
  bytes: number;
  received: number;
  includeImages: boolean;
  error?: string;
};
type Status = {
  enabled: boolean;
  device: { name: string };
  addresses: string[];
  peers: Peer[];
  transfers: Transfer[];
  discoveryError?: string;
};
const platform = (s: string) =>
  ({ win32: "Windows", linux: "Linux", darwin: "macOS" })[s] || s;
const bytes = (n: number) =>
  n < 1048576
    ? `${(n / 1024).toFixed(0)} KB`
    : `${(n / 1048576).toFixed(1)} MB`;
export function FolderMappings() {
  const [mappings, setMappings] = useState<FolderMapping[]>([]),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    const reload = () =>
      rpc("folders.list")
        .then((r) => setMappings(r.mappings))
        .catch((e) => setError(String(e.message || e)));
    void reload();
    window.addEventListener("chatport-folders-changed", reload);
    return () => window.removeEventListener("chatport-folders-changed", reload);
  }, []);
  async function save(next: FolderMapping[]) {
    setSaving(true);
    try {
      await rpc("folders.save", { mappings: next });
      setMappings(next);
      window.dispatchEvent(new Event("chatport-folders-changed"));
      setFrom("");
      setTo("");
      setError("");
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="folder-mappings">
      <h3>Folder mappings</h3>
      <p>
        Translate project folders from another computer. Individual chat folder
        edits take priority. Project files must be copied separately.
      </p>
      {mappings.map((m) => (
        <div className="mapping-row" key={m.id}>
          <code>{m.from}</code>
          <span>→</span>
          <code>{m.to}</code>
          <button
            className="icon-button"
            title="Remove folder mapping"
            disabled={saving}
            onClick={() => save(mappings.filter((v) => v.id !== m.id))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <div className="mapping-inputs">
        <input
          aria-label="Original folder prefix"
          placeholder="Original folder, e.g. C:\Users\example\Desktop\tools"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <span>→</span>
        <input
          aria-label="Local folder prefix"
          placeholder="Existing folder on this computer"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <button
          className="icon-button"
          title="Choose mapping destination"
          onClick={async () => {
            const p = await pickFolder();
            if (p) setTo(p);
          }}
        >
          <FolderOpen size={17} />
        </button>
      </div>
      <button
        className="button compact"
        disabled={!from || !to || saving}
        onClick={() =>
          save([
            ...mappings,
            { id: crypto.randomUUID(), from: from.trim(), to: to.trim() },
          ])
        }
      >
        Add mapping
      </button>
      {error && (
        <p role="alert" className="network-error">
          {error}
        </p>
      )}
    </section>
  );
}
export default function Nearby({
  ids,
  total,
  includeImages,
  onImported,
}: {
  ids: string[];
  total: number;
  includeImages: boolean;
  onImported: () => void;
}) {
  const [status, setStatus] = useState<Status>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [link, setLink] = useState(""),
    [host, setHost] = useState(""),
    [pairOpen, setPairOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [images, setImages] = useState(includeImages);
  async function refresh() {
    try {
      setStatus(await rpc("nearby.status"));
    } catch (e: any) {
      setError(e.message || String(e));
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (
      status?.transfers.some(
        (t) => t.state === "completed" && t.direction === "incoming",
      )
    )
      onImported();
  }, [status?.transfers.filter((t) => t.state === "completed").length]);
  async function run(fn: () => Promise<unknown>, message = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(message);
      await refresh();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="transfer-page nearby-page">
      <div className="page-heading">
        <div>
          <h1>Nearby</h1>
          <p>Send chats between computers on the same network.</p>
        </div>
        <label className="settings-check">
          <input
            type="checkbox"
            aria-label="Nearby enabled"
            checked={status?.enabled ?? true}
            disabled={busy || !status}
            onChange={(e) =>
              run(() => rpc("nearby.enabled", { enabled: e.target.checked }))
            }
          />
          Discoverable
        </label>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="banner">{notice}</div>}
      <div className="nearby-self">
        <Monitor size={20} />
        <div>
          <strong>{status?.device.name || "This computer"}</strong>
          <p>
            {status?.enabled
              ? status.addresses.join(" · ") || "No network address detected"
              : "Nearby is off"}
          </p>
        </div>
        <button
          className="button compact"
          disabled={busy || !status?.enabled}
          onClick={() =>
            run(async () => {
              const r = await rpc("nearby.invite");
              await navigator.clipboard.writeText(r.link);
            }, "Pairing link copied. Paste it into ChatPort on the other computer within two minutes.")
          }
        >
          <Copy size={15} />
          Copy pairing link
        </button>
        <button
          className="button compact"
          disabled={!status?.enabled}
          onClick={() => setPairOpen(!pairOpen)}
        >
          Pair computer
        </button>
        <button
          className="icon-button"
          title="Refresh nearby computers"
          disabled={!status?.enabled}
          onClick={() => run(() => rpc("nearby.refresh"))}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {pairOpen && (
        <div className="pair-form">
          <label>
            Paste the pairing link copied from the other computer
            <input
              aria-label="Pairing link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="chatport://pair/…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            IP address override <span className="muted">(optional)</span>
            <input
              aria-label="Peer IP address"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="Use when automatic discovery is unavailable"
            />
          </label>
          <button
            className="button primary compact"
            disabled={busy || !link.trim()}
            onClick={() =>
              run(async () => {
                await rpc("nearby.pair", {
                  link: link.trim(),
                  host: host.trim() || undefined,
                });
                setLink("");
                setHost("");
                setPairOpen(false);
              }, "Computers paired. You can send in either direction.")
            }
          >
            Pair
          </button>
          <p>
            Pair once. Each incoming transfer still waits for acceptance.
            Connections are encrypted and pinned to the paired computers.
          </p>
        </div>
      )}
      <div className="nearby-selection">
        <span>
          {ids.length
            ? `${ids.length} selected conversation${ids.length === 1 ? "" : "s"}`
            : `All ${total} conversations`}
        </span>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={images}
            onChange={(e) => setImages(e.target.checked)}
          />
          Include images
        </label>
        <small>Sending keeps the originals.</small>
      </div>
      <div className="peer-grid">
        {status?.peers.map((p) => (
          <article className="peer-card" key={p.id}>
            <div className="peer-title">
              <Monitor size={22} />
              <div>
                <h3>{p.name}</h3>
                <p>
                  {platform(p.platform)} · {p.host}
                </p>
              </div>
              <span className={"peer-status " + (p.online ? "online" : "")}>
                {p.online ? "Online" : "Offline"}
              </span>
            </div>
            <div className="peer-actions">
              {p.trusted ? (
                <>
                  <button
                    className="button primary compact"
                    disabled={
                      busy ||
                      !status.enabled ||
                      !p.online ||
                      (!total && !ids.length)
                    }
                    onClick={() =>
                      run(
                        () =>
                          rpc("nearby.send", {
                            peerId: p.id,
                            ids: ids.length ? ids : undefined,
                            includeImages: images,
                          }),
                        "Transfer offered. Accept it on the other computer.",
                      )
                    }
                  >
                    <ArrowUpFromLine size={15} />
                    {ids.length ? "Send selected" : "Send all chats"}
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      run(() => rpc("nearby.forget", { id: p.id }))
                    }
                  >
                    Forget
                  </button>
                </>
              ) : (
                <button
                  className="button compact"
                  onClick={() => setPairOpen(true)}
                >
                  Pair to send
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {status?.enabled && !status.peers.length && (
        <div className="nearby-empty">
          <Wifi size={26} />
          <h3>Looking for ChatPort computers</h3>
          <p>
            Open ChatPort on your other computer. If the network blocks
            discovery, use a pairing link and its IP address.
          </p>
        </div>
      )}
      {status?.discoveryError && (
        <p className="network-error">
          Discovery: {status.discoveryError}. Pairing by IP is still available.
        </p>
      )}
      {!!status?.transfers.length && (
        <div className="network-history">
          <h3>Network transfers</h3>
          {status.transfers.map((t) => (
            <article className="network-transfer" key={t.id}>
              <div className="network-transfer-icon">
                {t.state === "completed" ? (
                  <CheckCircle2 size={21} />
                ) : t.direction === "incoming" ? (
                  <ArrowDownToLine size={21} />
                ) : (
                  <ArrowUpFromLine size={21} />
                )}
              </div>
              <div className="network-transfer-detail">
                <strong>
                  {t.chatCount || "Preparing"} chat
                  {t.chatCount === 1 ? "" : "s"}{" "}
                  {t.direction === "incoming" ? "from" : "to"} {t.peerName}
                </strong>
                <p>
                  {t.state === "offered"
                    ? t.direction === "incoming"
                      ? "Waiting for your acceptance"
                      : t.remoteState === "downloading"
                        ? "Sending archive"
                        : t.remoteState === "importing"
                          ? "Receiver is checking and importing"
                          : t.remoteState === "failed"
                            ? "Receiver needs to retry"
                            : "Waiting for acceptance"
                    : t.state === "preparing"
                      ? "Preparing archive"
                      : t.state === "importing"
                        ? "Checking and importing"
                        : t.state[0].toUpperCase() + t.state.slice(1)}
                  {t.bytes > 0 && ` · ${bytes(t.bytes)}`}
                  {t.includeImages ? " · with images" : ""}
                </p>
                {["preparing", "downloading", "importing"].includes(
                  t.state,
                ) && (
                  <progress
                    max={Math.max(1, t.bytes)}
                    value={t.state === "downloading" ? t.received : undefined}
                  />
                )}{" "}
                {t.error && <p className="network-error">{t.error}</p>}
              </div>
              <div className="peer-actions">
                {t.direction === "incoming" && t.state === "offered" && (
                  <>
                    <button
                      className="button primary compact"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          rpc("nearby.accept", {
                            id: t.id,
                            includeImages: images && t.includeImages,
                          }),
                        )
                      }
                    >
                      Accept{images && t.includeImages ? " with images" : ""}
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        run(() => rpc("nearby.decline", { id: t.id }))
                      }
                    >
                      Decline
                    </button>
                  </>
                )}
                {t.state === "failed" && (
                  <button
                    className="button compact"
                    disabled={busy}
                    onClick={() => run(() => rpc("nearby.retry", { id: t.id }))}
                  >
                    Retry
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <FolderMappings />
    </section>
  );
}
