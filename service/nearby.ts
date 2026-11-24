import { createServer, request as httpsRequest, type Server } from "node:https";
import type { ServerResponse, IncomingMessage as HttpMessage } from "node:http";
import { networkInterfaces, hostname } from "node:os";
import { isIP } from "node:net";
import {
  createSocket,
  type Socket as UdpSocket,
  type RemoteInfo,
} from "node:dgram";
import { execFile } from "node:child_process";
import {
  randomUUID,
  randomBytes,
  X509Certificate,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { existsSync, createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { generate } from "selfsigned";
import { Bonjour, type Browser, type Service } from "bonjour-service";
import { z } from "zod";
import { readJSON, atomicJSON, inside } from "./common";
import { findExecutable } from "./platform";
import { digest } from "./transfer";

export type Device = {
  id: string;
  name: string;
  platform: string;
  host: string;
  port: number;
  fingerprint: string;
  online: boolean;
  trusted: boolean;
  lastSeen: number;
};
type Trusted = Device & { cert: string; token: string };
type Identity = { id: string; name: string; key: string; cert: string };
export type NetworkTransfer = {
  remoteState?: string;
  id: string;
  direction: "outgoing" | "incoming";
  peerId: string;
  peerName: string;
  state:
    | "preparing"
    | "offered"
    | "downloading"
    | "importing"
    | "completed"
    | "declined"
    | "failed";
  chatCount: number;
  bytes: number;
  received: number;
  sha256?: string;
  createdAt: string;
  error?: string;
  includeImages: boolean;
  file?: string;
  ids?: string[];
  result?: unknown;
};
type Hooks = {
  prepare: (
    ids: string[] | undefined,
    destination: string,
    includeImages: boolean,
    progress: (stage: string, value: number) => void,
  ) => Promise<{
    path: string;
    chatCount: number;
    bytes: number;
    sha256: string;
  }>;
  importFile: (
    file: string,
    includeImages: boolean,
    sha: string,
    peer: Device,
  ) => Promise<unknown>;
};
type Options = {
  dataDir: string;
  name?: string;
  bind?: string;
  port?: number;
  discovery?: boolean;
  mdns?: boolean;
  mdnsOptions?: any;
  discoveryPort?: number;
  tailscalePeers?: string[];
  addresses?: string[];
  enabled?: boolean;
  platform?: string;
};
const deviceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(70),
  platform: z.string().max(30),
  port: z.number().int().min(1).max(65535),
  cert: z.string().max(12000),
});
const offerSchema = z.object({
  id: z.string().uuid(),
  chatCount: z.number().int().min(1).max(100000),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  includeImages: z.boolean(),
});
const beaconSchema = z.object({
  app: z.literal("chatport"),
  v: z.literal(1),
  kind: z.enum(["query", "announce"]),
  id: z.string().uuid(),
  name: z.string().min(1).max(70).optional(),
  platform: z.string().max(30).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const DISCOVERY_PORT = 45888;
export const certFingerprint = (cert: string | Buffer) =>
  new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase();
const cleanHost = (value: string) => value.replace(/^::ffff:/, "");
function addresses() {
  return [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((list) =>
        (list || [])
          .filter((v) => !v.internal && v.family === "IPv4")
          .map((v) => v.address),
      ),
    ),
  ];
}
function tailscaleExecutable() {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.ProgramFiles,
          process.env.ProgramW6432,
          process.env["ProgramFiles(x86)"],
          "C:\\Program Files",
        ]
          .filter(Boolean)
          .map((root) => join(String(root), "Tailscale", "tailscale.exe"))
      : process.platform === "darwin"
        ? [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
          ]
        : [
            "/usr/bin/tailscale",
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
          ];
  return findExecutable("tailscale", process.platform, candidates);
}
function tailscaleAddresses(status: any) {
  const peers = status?.Peer;
  if (!peers || typeof peers !== "object") return [];
  const result: string[] = [];
  for (const peer of Object.values(peers) as any[]) {
    if (peer?.Online === false) continue;
    const ip = (Array.isArray(peer?.TailscaleIPs) ? peer.TailscaleIPs : []).find(
      (value: unknown) => typeof value === "string" && isIP(value) === 4,
    );
    if (ip) result.push(ip);
  }
  return [...new Set(result)];
}
function discoveryTarget(value: string, fallback: number) {
  const match = /^([^:]+)(?::(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const host = match[1],
    port = match[2] ? Number(match[2]) : fallback;
  return isIP(host) === 4 && port > 0 && port < 65536
    ? { host, port }
    : undefined;
}
function equalSecret(a: string, b: string) {
  return (
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
async function readBody(req: HttpMessage) {
  let text = "";
  for await (const b of req) {
    text += b;
    if (Buffer.byteLength(text) > 24000)
      throw new Error("Request is too large");
  }
  return text ? JSON.parse(text) : {};
}
export class Nearby {
  private identity!: Identity;
  private trusted = new Map<string, Trusted>();
  private discovered = new Map<string, Device>();
  private records = new Map<string, NetworkTransfer>();
  private server?: Server;
  private bonjour?: Bonjour;
  private browser?: Browser;
  private published?: Service;
  private udp?: UdpSocket;
  private timer?: ReturnType<typeof setInterval>;
  private probing = false;
  private nextUnicast = 0;
  private tailscaleAt = 0;
  private tailscaleCache: string[] = [];
  private invitation?: { token: string; expiresAt: number };
  private enabled = false;
  private port = 0;
  private discoveryError = "";
  private busy = new Set<string>();
  private attempts = new Map<string, { count: number; at: number }>();
  private stopping = false;
  private pinging = false;
  private polling = false;
  private nextPing = 0;
  constructor(
    private options: Options,
    private hooks: Hooks,
  ) {}
  private get root() {
    return join(this.options.dataDir, "nearby");
  }
  private publicDevice(host = "") {
    return {
      id: this.identity.id,
      name: this.identity.name,
      platform: this.options.platform || process.platform,
      host,
      port: this.port,
      fingerprint: certFingerprint(this.identity.cert),
      online: true,
      trusted: true,
      lastSeen: Date.now(),
    };
  }
  private savePeers() {
    atomicJSON(join(this.root, "peers.json"), [...this.trusted.values()]);
  }
  private save() {
    atomicJSON(join(this.root, "transfers.json"), [...this.records.values()]);
  }
  async start() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.identity = readJSON(join(this.root, "identity.json"));
    if (!this.identity) {
      const pair = await generate(
        [{ name: "commonName", value: "chatport.local" }],
        {
          keyType: "ec",
          curve: "P-256",
          algorithm: "sha256",
          notBeforeDate: new Date(Date.now() - 86400000),
          notAfterDate: new Date(Date.now() + 10 * 365 * 86400000),
          extensions: [
            { name: "basicConstraints", cA: true },
            { name: "extKeyUsage", serverAuth: true, clientAuth: true },
            {
              name: "subjectAltName",
              altNames: [{ type: 2, value: "chatport.local" }],
            },
          ],
        },
      );
      this.identity = {
        id: randomUUID(),
        name: this.options.name || hostname(),
        key: pair.private,
        cert: pair.cert,
      };
      atomicJSON(join(this.root, "identity.json"), this.identity);
    }
    for (const p of readJSON(join(this.root, "peers.json")) || [])
      if (p?.id && p.cert && p.token)
        this.trusted.set(p.id, { ...p, online: false });
    for (const r of readJSON(join(this.root, "transfers.json")) || []) {
      if (["preparing", "downloading", "importing"].includes(r.state)) {
        r.state = "failed";
        r.error =
          "ChatPort restarted before this transfer finished. Retry the transfer.";
      }
      this.records.set(r.id, r);
    }
    this.save();
    if (this.options.enabled !== false) await this.setEnabled(true);
    return this;
  }
  async setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    if (!enabled) {
      if (this.busy.size)
        throw new Error(
          "Finish active network transfers before turning off Nearby.",
        );
      await this.stopListening();
      this.enabled = false;
      return;
    }
    const server = createServer(
      {
        key: this.identity.key,
        cert: this.identity.cert,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      },
      (req, res) => void this.handle(req, res),
    );
    await new Promise<void>((resolve, reject) => {
      let retried = false;
      const error = (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && !this.options.port && !retried) {
          retried = true;
          server.listen(0, this.options.bind || "0.0.0.0");
        } else reject(e);
      };
      server.on("error", error);
      server.listen(
        this.options.port ||
          readJSON(join(this.root, "listener.json"))?.port ||
          0,
        this.options.bind || "0.0.0.0",
        () => {
          server.off("error", error);
          resolve();
        },
      );
    });
    this.server = server;
    this.port = (server.address() as any).port;
    atomicJSON(join(this.root, "listener.json"), { port: this.port });
    this.enabled = true;
    this.stopping = false;
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.on("error", (e) => {
      this.discoveryError = e.message;
    });
    if (this.options.discovery !== false) {
      if (this.options.mdns !== false) {
        try {
          this.bonjour = new Bonjour(this.options.mdnsOptions, (err: Error) => {
            this.discoveryFailure(String(err.message || err));
          });
          this.published = this.bonjour.publish({
            name: "ChatPort-" + this.identity.id,
            type: "chatport",
            protocol: "tcp",
            port: this.port,
            disableIPv6: true,
            txt: {
              v: "1",
              id: this.identity.id,
              name: this.identity.name,
              platform: this.options.platform || process.platform,
              fingerprint: certFingerprint(this.identity.cert),
            },
          });
          this.browser = this.bonjour.find({ type: "chatport" }, (s) =>
            this.found(s),
          );
          this.browser.on("down", (s) => {
            const p = this.discovered.get(String(s.txt?.id));
            if (p) p.online = false;
          });
        } catch (e: any) {
          this.discoveryFailure(e.message);
        }
      }
      await this.startUnicast();
    }
    this.timer = setInterval(() => {
      if (Date.now() >= this.nextPing) {
        this.nextPing = Date.now() + 10000;
        void this.ping();
      }
      if (Date.now() >= this.nextUnicast) {
        this.nextUnicast = Date.now() + 5000;
        void this.probe();
      }
      void this.pollTransfers();
    }, 2000);
    this.timer.unref();
    this.nextUnicast = 0;
    void this.ping();
    void this.probe();
  }
  private discoveryFailure(message: string) {
    if (this.discoveryError.includes(message)) return;
    this.discoveryError = [this.discoveryError, message]
      .filter(Boolean)
      .join("; ")
      .slice(0, 500);
  }
  private async startUnicast() {
    const socket = createSocket("udp4");
    try {
      await new Promise<void>((resolve, reject) => {
        const error = (e: Error) => reject(e);
        socket.once("error", error);
        socket.bind(
          this.options.discoveryPort || DISCOVERY_PORT,
          "0.0.0.0",
          () => {
            socket.off("error", error);
            resolve();
          },
        );
      });
    } catch (e: any) {
      try {
        socket.close();
      } catch {}
      this.discoveryFailure(
        "Unicast discovery could not start on UDP port " +
          (this.options.discoveryPort || DISCOVERY_PORT) +
          " (" +
          e.message +
          ")",
      );
      return;
    }
    this.udp = socket;
    socket.on("message", (data, rinfo) => this.udpMessage(data, rinfo));
    socket.on("error", (e) =>
      this.discoveryFailure("Unicast discovery failed (" + e.message + ")"),
    );
    void this.probe();
  }
  private async tailscalePeers() {
    if (this.options.tailscalePeers) return this.options.tailscalePeers;
    if (Date.now() - this.tailscaleAt < 30000) return this.tailscaleCache;
    this.tailscaleAt = Date.now();
    const exe = tailscaleExecutable();
    if (!exe) return (this.tailscaleCache = []);
    const output = await new Promise<string>((resolve) => {
      execFile(
        exe,
        ["status", "--json"],
        { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => resolve(error ? "" : String(stdout)),
      );
    });
    try {
      this.tailscaleCache = tailscaleAddresses(JSON.parse(output));
    } catch {
      this.tailscaleCache = [];
    }
    return this.tailscaleCache;
  }
  private async probe() {
    if (this.stopping || this.probing || !this.udp || !this.enabled) return;
    this.probing = true;
    try {
      const peers = await this.tailscalePeers();
      if (this.stopping || !this.udp || !this.enabled) return;
      const data = Buffer.from(
        JSON.stringify({
          app: "chatport",
          v: 1,
          kind: "query",
          id: this.identity.id,
        }),
      );
      for (const peer of peers) {
        const target = discoveryTarget(
          peer,
          this.options.discoveryPort || DISCOVERY_PORT,
        );
        if (target)
          this.udp.send(data, target.port, target.host, () => {});
      }
    } catch (e: any) {
      this.discoveryFailure("Unicast discovery probe failed (" + e.message + ")");
    } finally {
      this.probing = false;
    }
  }
  private announce(host: string, port: number) {
    if (this.stopping || !this.udp || !this.enabled || !this.identity) return;
    const device = this.publicDevice();
    const data = Buffer.from(
      JSON.stringify({
        app: "chatport",
        v: 1,
        kind: "announce",
        id: device.id,
        name: device.name,
        platform: device.platform,
        port: device.port,
        fingerprint: device.fingerprint,
      }),
    );
    try {
      this.udp.send(data, port, host, () => {});
    } catch {}
  }
  private udpMessage(data: Buffer, rinfo: RemoteInfo) {
    if (data.length > 4096) return;
    let value: z.infer<typeof beaconSchema>;
    try {
      const parsed = beaconSchema.safeParse(JSON.parse(data.toString("utf8")));
      if (!parsed.success) return;
      value = parsed.data;
    } catch {
      return;
    }
    if (value.id === this.identity.id) return;
    const host = cleanHost(rinfo.address);
    if (isIP(host) !== 4) return;
    if (value.kind === "query") {
      this.announce(host, rinfo.port);
      return;
    }
    this.foundDevice({
      id: value.id,
      name: value.name || "ChatPort computer",
      platform: value.platform || "unknown",
      host,
      port: value.port!,
      fingerprint: value.fingerprint!,
    });
  }
  private found(service: any) {
    const txt = service.txt || {},
      id = String(txt.id || ""),
      host = cleanHost(
        service.referer?.address ||
          service.addresses?.find((h: string) => isIP(h) === 4) ||
          "",
      );
    this.foundDevice({
      id,
      name: String(txt.name || service.name).slice(0, 70),
      platform: String(txt.platform || "unknown"),
      host,
      port: service.port,
      fingerprint: String(txt.fingerprint),
    });
  }
  private foundDevice(value: {
    id: string;
    name: string;
    platform: string;
    host: string;
    port: number;
    fingerprint: string;
  }) {
    const { id, name, platform, host, port, fingerprint } = value;
    if (
      id === this.identity.id ||
      !z.string().uuid().safeParse(id).success ||
      !isIP(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^([a-f0-9]{64})$/.test(fingerprint)
    )
      return;
    const p: Device = {
      id,
      name: name.slice(0, 70),
      platform: platform.slice(0, 30),
      host,
      port,
      fingerprint,
      online: true,
      trusted: this.trusted.has(id),
      lastSeen: Date.now(),
    };
    this.discovered.set(id, p);
    const known = this.trusted.get(id);
    if (known && known.fingerprint === p.fingerprint) {
      known.host = p.host;
      known.port = p.port;
    }
  }
  refresh() {
    this.browser?.update();
    this.nextUnicast = 0;
    void this.probe();
    void this.ping();
  }
  status() {
    const peers = new Map<string, Device>();
    for (const p of this.discovered.values()) peers.set(p.id, p);
    for (const p of this.trusted.values())
      peers.set(p.id, { ...p, trusted: true });
    return {
      enabled: this.enabled,
      device: this.identity ? this.publicDevice() : undefined,
      addresses: this.options.addresses || addresses(),
      peers: [...peers.values()].map(
        ({
          id,
          name,
          platform,
          host,
          port,
          fingerprint,
          online,
          trusted,
          lastSeen,
        }) => ({
          id,
          name,
          platform,
          host,
          port,
          fingerprint,
          online,
          trusted,
          lastSeen,
        }),
      ),
      transfers: [...this.records.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(({ file, ids, ...r }) => r),
      discoveryError: this.discoveryError,
    };
  }
  invite() {
    if (!this.enabled) throw new Error("Turn on Nearby first");
    this.invitation = {
      token: randomBytes(32).toString("hex"),
      expiresAt: Date.now() + 120000,
    };
    const data = {
      v: 1,
      ...this.publicDevice(),
      addresses: this.options.addresses || addresses(),
      cert: this.identity.cert,
      token: this.invitation.token,
      expiresAt: this.invitation.expiresAt,
    };
    return {
      link:
        "chatport://pair/" +
        Buffer.from(JSON.stringify(data)).toString("base64url"),
      expiresAt: data.expiresAt,
    };
  }
  async pair(link: string, hostOverride?: string) {
    if (!this.enabled) throw new Error("Turn on Nearby first");
    if (!link.startsWith("chatport://pair/") || link.length > 20000)
      throw new Error("Paste a ChatPort pairing link from the other computer");
    let value: any;
    try {
      value = JSON.parse(
        Buffer.from(
          link.slice("chatport://pair/".length),
          "base64url",
        ).toString(),
      );
    } catch {
      throw new Error("Invalid pairing link");
    }
    const d = deviceSchema.parse(value);
    if (
      value.v !== 1 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.token) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt < Date.now()
    )
      throw new Error(
        "The pairing link expired. Copy a new one from the other computer.",
      );
    if (d.id === this.identity.id)
      throw new Error("This pairing link belongs to this ChatPort instance");
    const pin = certFingerprint(d.cert);
    if (pin !== value.fingerprint)
      throw new Error("Pairing link certificate mismatch");
    const previous = this.trusted.get(d.id);
    if (previous && previous.fingerprint !== pin)
      throw new Error(
        "This computer changed identity. Forget the previous pairing first.",
      );
    const hosts = hostOverride
      ? [hostOverride]
      : [
          this.discovered.get(d.id)?.host,
          ...(value.addresses || []),
          value.host,
        ].filter(Boolean);
    let last: unknown;
    for (const host of [...new Set(hosts)] as string[]) {
      if (!isIP(host)) continue;
      const peer: Trusted = {
        ...this.publicDevice(),
        ...d,
        host,
        fingerprint: pin,
        token: "",
        online: true,
        trusted: true,
        lastSeen: Date.now(),
      };
      try {
        const r = await this.json(peer, "/pair", "POST", {
          token: value.token,
          device: { ...this.publicDevice(), cert: this.identity.cert },
        });
        if (
          typeof r.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(r.token) ||
          r.id !== d.id
        )
          throw new Error("Invalid pairing response");
        peer.token = r.token;
        this.trusted.set(peer.id, peer);
        this.savePeers();
        return this.status();
      } catch (e) {
        last = e;
      }
    }
    throw (
      last ||
      new Error(
        "No reachable address in this pairing link. Enter the other computer’s IP address.",
      )
    );
  }
  forget(id: string) {
    if (
      this.busy.size &&
      [...this.records.values()].some(
        (r) => r.peerId === id && this.busy.has(r.id),
      )
    )
      throw new Error("Finish the transfer before forgetting this computer");
    this.trusted.delete(id);
    this.savePeers();
  }
  rename(name: string) {
    this.identity.name = z.string().trim().min(1).max(70).parse(name);
    atomicJSON(join(this.root, "identity.json"), this.identity);
    this.published?.stop();
    if (this.enabled && this.bonjour)
      this.published = this.bonjour.publish({
        name: "ChatPort-" + this.identity.id,
        type: "chatport",
        port: this.port,
        txt: {
          v: "1",
          id: this.identity.id,
          name: this.identity.name,
          platform: this.options.platform || process.platform,
          fingerprint: certFingerprint(this.identity.cert),
        },
      });
  }
  private connect(
    peer: Trusted,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<import("node:http").IncomingMessage> {
    return new Promise((resolve, reject) => {
      const data =
        body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = httpsRequest(
        {
          host: peer.host,
          port: peer.port,
          path,
          method,
          cert: this.identity.cert,
          key: this.identity.key,
          ca: peer.cert,
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          servername: "chatport.local",
          checkServerIdentity: (_host, cert) =>
            certFingerprint(cert.raw) === peer.fingerprint
              ? undefined
              : new Error(
                  "The remote certificate does not match the paired computer",
                ),
          headers: {
            "X-ChatPort-Device": this.identity.id,
            Authorization: "Bearer " + peer.token,
            ...(data
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": data.length,
                }
              : {}),
          },
        },
        resolve,
      );
      req.on("error", reject);
      req.setTimeout(15000, () =>
        req.destroy(new Error("The other computer did not respond")),
      );
      if (data) req.write(data);
      req.end();
    });
  }
  private async json(
    peer: Trusted,
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    const r = await this.connect(peer, path, method, body);
    let text = "";
    for await (const data of r) {
      text += data;
      if (text.length > 24000) {
        r.destroy();
        throw new Error("Remote response is too large");
      }
    }
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error("Invalid response from the other computer");
    }
    if (r.statusCode !== 200)
      throw new Error(
        result.error || "The other computer rejected this request",
      );
    return result;
  }
  private async ping() {
    if (this.stopping || this.pinging) return;
    this.pinging = true;
    await Promise.all(
      [...this.trusted.values()].map(async (p) => {
        try {
          const value = await this.json(p, "/hello");
          p.online = value.id === p.id;
          p.lastSeen = Date.now();
        } catch {
          p.online = false;
        }
      }),
    );
    this.pinging = false;
  }
  async send(
    peerId: string,
    ids: string[] | undefined,
    includeImages: boolean,
  ) {
    const peer = this.trusted.get(peerId);
    if (!this.enabled || !peer)
      throw new Error("Pair with this computer before sending chats");
    const r: NetworkTransfer = {
      id: randomUUID(),
      peerId,
      direction: "outgoing",
      peerName: peer.name,
      state: "preparing",
      chatCount: ids?.length || 0,
      bytes: 0,
      received: 0,
      createdAt: new Date().toISOString(),
      includeImages,
      ids,
    };
    this.records.set(r.id, r);
    this.save();
    void this.prepare(r, peer);
    return r.id;
  }
  private async prepare(r: NetworkTransfer, peer: Trusted) {
    this.busy.add(r.id);
    try {
      const dest = join(this.root, "outgoing", r.id);
      const result = await this.hooks.prepare(
        r.ids,
        dest,
        r.includeImages,
        () => {},
      );
      if (!inside(join(this.root, "outgoing"), result.path))
        throw new Error("Outgoing archive is outside its transfer folder");
      Object.assign(r, {
        file: result.path,
        bytes: result.bytes,
        chatCount: result.chatCount,
        sha256: result.sha256,
        state: "offered",
      });
      this.save();
      await this.offer(r, peer);
    } catch (e: any) {
      r.state = "failed";
      r.error = e.message;
      this.save();
    } finally {
      this.busy.delete(r.id);
    }
  }
  private async offer(r: NetworkTransfer, p: Trusted) {
    const result = await this.json(p, "/offers", "POST", {
      id: r.id,
      chatCount: r.chatCount,
      bytes: r.bytes,
      sha256: r.sha256,
      includeImages: r.includeImages,
    });
    if (result.state === "completed") {
      r.state = "completed";
      r.received = r.bytes;
    } else if (result.state === "declined") r.state = "declined";
    else r.state = "offered";
    r.error = undefined;
    this.save();
  }
  async accept(id: string, includeImages: boolean) {
    const r = this.records.get(id);
    if (
      !r ||
      r.direction !== "incoming" ||
      !["offered", "failed"].includes(r.state)
    )
      throw new Error("This transfer cannot be accepted");
    const peer = this.trusted.get(r.peerId);
    if (!peer) throw new Error("The sending computer is no longer paired");
    if (this.busy.has(id)) return;
    r.includeImages = includeImages;
    this.busy.add(id);
    r.state = "downloading";
    r.error = undefined;
    this.save();
    void this.receive(r, peer)
      .catch((e) => {
        r.state = "failed";
        r.error = e.message;
        this.save();
      })
      .finally(() => this.busy.delete(id));
  }
  private async receive(r: NetworkTransfer, p: Trusted) {
    const folder = join(this.root, "incoming");
    await mkdir(folder, { recursive: true });
    const file = join(folder, r.id + ".chatport.zip"),
      partial = file + ".partial";
    if (!inside(folder, partial))
      throw new Error("Invalid transfer destination");
    if (
      existsSync(file) &&
      (await stat(file)).size === r.bytes &&
      (await digest(file)) === r.sha256
    ) {
      r.received = r.bytes;
      return this.finishImport(r, p, file);
    }
    if (existsSync(file))
      throw new Error(
        "An existing received archive failed verification. The original is retained for inspection.",
      );
    await rm(partial, { force: true });
    const response = await this.connect(p, "/transfers/" + r.id);
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error("The sender could not provide this archive");
    }
    if (Number(response.headers["content-length"]) !== r.bytes) {
      response.destroy();
      throw new Error("Archive size changed after it was offered");
    }
    r.received = 0;
    let last = 0;
    response.on("data", (chunk) => {
      r.received += chunk.length;
      if (r.received > r.bytes)
        response.destroy(new Error("Archive is larger than its declared size"));
      if (Date.now() - last > 300) {
        last = Date.now();
        this.save();
      }
    });
    try {
      await pipeline(response, createWriteStream(partial, { flags: "wx" }));
      if (r.received !== r.bytes || (await digest(partial)) !== r.sha256)
        throw new Error("The received archive failed its SHA-256 check");
      await rename(partial, file);
      await this.finishImport(r, p, file);
    } catch (e) {
      await rm(partial, { force: true }).catch(() => {});
      throw e;
    }
  }
  private async finishImport(r: NetworkTransfer, p: Trusted, file: string) {
    r.file = file;
    r.state = "importing";
    this.save();
    r.result = await this.hooks.importFile(file, r.includeImages, r.sha256!, p);
    r.state = "completed";
    r.error = undefined;
    this.save();
    await this.json(p, "/receipts", "POST", {
      id: r.id,
      sha256: r.sha256,
    }).catch(() => {});
  }
  decline(id: string) {
    const r = this.records.get(id);
    if (!r || r.direction !== "incoming" || r.state !== "offered")
      throw new Error("This transfer cannot be declined");
    r.state = "declined";
    this.save();
  }
  async retry(id: string) {
    const r = this.records.get(id);
    if (!r || r.state !== "failed")
      throw new Error("This transfer cannot be retried");
    if (r.direction === "incoming") return this.accept(id, r.includeImages);
    const p = this.trusted.get(r.peerId);
    if (!p) throw new Error("Pair with the receiving computer first");
    if (r.file && existsSync(r.file) && (await digest(r.file)) === r.sha256) {
      r.state = "offered";
      await this.offer(r, p);
    } else {
      r.state = "preparing";
      void this.prepare(r, p);
    }
    this.save();
  }
  private authorized(req: HttpMessage) {
    const id = String(req.headers["x-chatport-device"] || ""),
      peer = this.trusted.get(id);
    const cert = (
      req.socket as import("node:tls").TLSSocket
    ).getPeerCertificate();
    if (
      !peer ||
      !cert?.raw ||
      certFingerprint(cert.raw) !== peer.fingerprint ||
      !equalSecret(
        String(req.headers.authorization || ""),
        "Bearer " + peer.token,
      )
    )
      return undefined;
    peer.host = cleanHost(req.socket.remoteAddress || peer.host);
    peer.online = true;
    peer.lastSeen = Date.now();
    return peer;
  }
  private async handle(req: HttpMessage, res: ServerResponse) {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const send = (code: number, value: any) => {
      res.writeHead(code);
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.origin) {
        send(403, {
          error: "Browser access is not supported on the transfer port",
        });
        return;
      }
      if (req.url === "/hello" && req.method === "GET") {
        send(200, { ...this.publicDevice() });
        return;
      }
      if (req.url === "/pair" && req.method === "POST") {
        const ip = cleanHost(req.socket.remoteAddress || ""),
          attempt = this.attempts.get(ip) || { count: 0, at: Date.now() };
        if (Date.now() - attempt.at > 60000) {
          attempt.count = 0;
          attempt.at = Date.now();
        }
        if (++attempt.count > 8) {
          send(429, { error: "Too many pairing attempts. Try again later." });
          return;
        }
        this.attempts.set(ip, attempt);
        const body = await readBody(req),
          d = deviceSchema.parse(body.device),
          actual = (
            req.socket as import("node:tls").TLSSocket
          ).getPeerCertificate();
        if (
          !this.invitation ||
          this.invitation.expiresAt < Date.now() ||
          typeof body.token !== "string" ||
          !equalSecret(body.token, this.invitation.token) ||
          !actual?.raw ||
          certFingerprint(actual.raw) !== certFingerprint(d.cert)
        ) {
          send(403, { error: "Pairing link is invalid or expired" });
          return;
        }
        const existing = this.trusted.get(d.id),
          fingerprint = certFingerprint(d.cert);
        if (existing && existing.fingerprint !== fingerprint)
          throw new Error(
            "Forget the previous pairing before replacing its identity",
          );
        const token = randomBytes(32).toString("hex");
        this.trusted.set(d.id, {
          ...d,
          host: ip,
          fingerprint,
          token,
          online: true,
          trusted: true,
          lastSeen: Date.now(),
        });
        this.invitation = undefined;
        this.savePeers();
        send(200, { id: this.identity.id, token });
        return;
      }
      const peer = this.authorized(req);
      if (!peer) {
        send(401, { error: "Pair with this computer first" });
        return;
      }
      if (req.url === "/offers" && req.method === "POST") {
        const v = offerSchema.parse(await readBody(req)),
          old = this.records.get(v.id);
        if (old) {
          if (old.peerId !== peer.id || old.sha256 !== v.sha256) {
            send(409, { error: "Transfer identity conflict" });
            return;
          }
          send(200, { state: old.state });
          return;
        }
        const count = [...this.records.values()].filter(
          (r) => r.peerId === peer.id && r.state === "offered",
        ).length;
        if (count >= 20) {
          send(429, { error: "Too many pending transfers" });
          return;
        }
        this.records.set(v.id, {
          ...v,
          peerId: peer.id,
          peerName: peer.name,
          state: "offered",
          direction: "incoming",
          received: 0,
          createdAt: new Date().toISOString(),
        });
        this.save();
        send(200, { state: "offered" });
        return;
      }
      if (req.url === "/receipts" && req.method === "POST") {
        const body = await readBody(req),
          r = this.records.get(body.id);
        if (
          !r ||
          r.direction !== "outgoing" ||
          r.peerId !== peer.id ||
          r.sha256 !== body.sha256
        )
          throw new Error("Invalid transfer receipt");
        r.state = "completed";
        r.received = r.bytes;
        this.save();
        send(200, { ok: true });
        return;
      }
      const match = req.url?.match(/^\/transfers\/([a-f0-9-]{36})$/);
      if (match && req.method === "GET") {
        const r = this.records.get(match[1]);
        if (
          !r ||
          r.direction !== "outgoing" ||
          r.peerId !== peer.id ||
          !r.file ||
          !inside(join(this.root, "outgoing"), r.file) ||
          !existsSync(r.file)
        ) {
          send(404, { error: "Archive is not available" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": r.bytes,
        });
        await pipeline(createReadStream(r.file), res);
        return;
      }
      const state = req.url?.match(/^\/offers\/([a-f0-9-]{36})$/);
      if (state && req.method === "GET") {
        const r = this.records.get(state[1]);
        if (!r || r.peerId !== peer.id) {
          send(404, { error: "Transfer is not available" });
          return;
        }
        send(200, { state: r.state, received: r.received });
        return;
      }
      send(404, { error: "Unknown transfer operation" });
    } catch (e: any) {
      if (!res.headersSent) send(400, { error: e.message });
      else res.destroy();
    }
  }
  async pollTransfers() {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      for (const r of this.records.values())
        if (r.direction === "outgoing" && r.state === "offered") {
          const p = this.trusted.get(r.peerId);
          if (!p) continue;
          try {
            const s = await this.json(p, "/offers/" + r.id);
            r.remoteState = s.state;
            if (s.state === "completed" || s.state === "declined") {
              r.state = s.state;
              r.received = s.state === "completed" ? r.bytes : 0;
              this.save();
            } else if (Number.isFinite(s.received)) {
              r.received = Math.max(0, Math.min(r.bytes, s.received));
            }
          } catch {}
        }
    } finally {
      this.polling = false;
    }
  }
  private async stopListening() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    try {
      this.udp?.close();
    } catch {}
    this.udp = undefined;
    this.browser?.stop();
    this.bonjour?.unpublishAll();
    this.bonjour?.destroy();
    this.bonjour = undefined;
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
  }
  async close() {
    await this.stopListening();
    this.enabled = false;
  }
}
