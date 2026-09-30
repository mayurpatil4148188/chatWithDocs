import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const databasePath = process.env.DATABASE_PATH ?? './data/chat-with-docs.sqlite';
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  checksum_sha256 TEXT NOT NULL UNIQUE,
  storage_path TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  parser TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_pages (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  page_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  ocr_used INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(document_version_id, page_no)
);
CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  page_id TEXT NOT NULL REFERENCES document_pages(id),
  page_no INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(document_version_id, page_no, ordinal)
);
CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(chunk_id UNINDEXED, text);
CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  status TEXT NOT NULL,
  current_step TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  available_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_steps (
  job_id TEXT NOT NULL REFERENCES processing_jobs(id),
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(job_id, step)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT '',
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
`);

const conversationColumns = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
if (!conversationColumns.some((column) => column.name === 'updated_at')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
}
if (!conversationColumns.some((column) => column.name === 'archived_at')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN archived_at TEXT`);
}
