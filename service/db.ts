import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
export function openLibrary(root: string) {
  const db = new DatabaseSync(join(root, "library.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,title TEXT NOT NULL,cwd TEXT NOT NULL,updated_at INTEGER NOT NULL,json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at DESC);
CREATE TABLE IF NOT EXISTS preferences(id TEXT PRIMARY KEY,cwd TEXT,starred INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS chat_search USING fts5(chat_id UNINDEXED,text, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS search_versions(chat_id TEXT PRIMARY KEY,version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attachment_refs(chat_id TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(chat_id,id));
`);
  return db;
}
export function setting(
  db: DatabaseSync,
  key: string,
  fallback: any = undefined,
) {
  const r = db.prepare("SELECT json FROM settings WHERE key=?").get(key);
  return r ? JSON.parse(String(r.json)) : fallback;
}
export function putSetting(db: DatabaseSync, key: string, value: any) {
  db.prepare(
    "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json",
  ).run(key, JSON.stringify(value));
}
