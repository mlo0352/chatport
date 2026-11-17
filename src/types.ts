export type Provider =
  "codex" | "claude" | "opencode" | "t3" | "chatgpt" | "freebuff";
export type Activity = {
  state:
    "working" | "idle" | "unfinished" | "interrupted" | "failed" | "unknown";
  active: boolean | null;
  detail: string;
  revision: string;
  at?: number;
  snapshot?: boolean;
};
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  available?: boolean;
  recoverable?: boolean;
  missing?: string;
  archivePath?: string;
  bytes?: number;
  ref?: {
    path?: string;
    dataUrl?: string;
    transcript?: string;
    textKey?: string;
    imageIndex?: number;
    offset?: number;
    end?: number;
  };
};
export type Preferences = {
  theme: "system" | "light" | "dark";
  liveUpdates: boolean;
  includeImages: boolean;
};
export type Source = {
  id: string;
  provider: Provider;
  name: string;
  root: string;
  available: boolean;
  imported?: boolean;
  error?: string;
  count: number;
  nativeVersion?: string;
  format?: "native" | "portable";
  nativeRoot?: string;
  archiveNativePath?: string;
  originalSourceId?: string;
  originalRoot?: string;
  imagesIncluded?: boolean;
};
export type Chat = {
  id: string;
  sourceId: string;
  provider: Provider;
  nativeId: string;
  title: string;
  cwd: string;
  resumeCwd?: string;
  folderMapping?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  starred?: boolean;
  imported?: boolean;
  model?: string;
  origin?: string;
  parentId?: string;
  locator: string;
  messageCount?: number;
  resumeProvider?: Provider;
  resumeNativeId?: string;
  activity?: Activity;
};
export type Message = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  at?: number;
  kind?: string;
  attachments?: Attachment[];
};
export type Job = {
  id: string;
  type: "export" | "import" | "restore";
  state: "running" | "completed" | "failed" | "cancelled";
  stage: string;
  progress: number;
  createdAt: string;
  path?: string;
  error?: string;
  result?: any;
};
export type Library = {
  sources: Source[];
  chats: Chat[];
  jobs: Job[];
  scanning: boolean;
  indexing?: boolean;
  scanError?: string;
  machine: string;
  updatedAt?: number;
  dataDir: string;
  preferences?: Preferences;
};
