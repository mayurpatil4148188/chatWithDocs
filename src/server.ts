import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { db } from './db.js';
import { enqueue, claimNextJob, id, now } from './queue.js';
import { processJob } from './ingest.js';
import { answerQuestion } from './llm.js';
import { addMessage, archiveChat, createChat, ensureChat, listChats, renameChat } from './chats.js';

type EvidenceRow = { chunkId: string; pageNo: number; text: string };

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'is', 'this', 'that', 'what', 'which', 'who', 'how', 'are', 'was', 'were', 'for', 'with', 'from', 'into', 'about', 'doc', 'docs', 'document', 'please', 'tell', 'can', 'you']);

function ftsQuery(question: string) {
  const terms = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
  return terms.map((term) => `"${term.replaceAll('"', '')}"`).join(' OR ');
}

function retrieveEvidence(documentId: string, question: string): EvidenceRow[] {
  const query = ftsQuery(question);
  if (query) {
    try {
      const rows = db.prepare(`SELECT c.id chunkId, c.page_no pageNo, c.text FROM document_chunks c
        JOIN document_versions v ON v.id=c.document_version_id AND v.document_id=?
        JOIN document_fts f ON f.chunk_id=c.id
        WHERE length(trim(c.text)) > 20 AND document_fts MATCH ?
        LIMIT 6`).all(documentId, query) as EvidenceRow[];
      if (rows.length) return rows;
    } catch { /* invalid FTS syntax falls through to document overview */ }
  }
  return db.prepare(`SELECT c.id chunkId, c.page_no pageNo, c.text FROM document_chunks c
    JOIN document_versions v ON v.id=c.document_version_id AND v.document_id=?
    WHERE length(trim(c.text)) > 20
    ORDER BY c.page_no, c.ordinal LIMIT 6`).all(documentId) as EvidenceRow[];
}

const port = Number(process.env.PORT ?? 3000);
const uploadDir = process.env.UPLOAD_DIR ?? './data/uploads';
const publicDir = path.resolve('public');
fs.mkdirSync(uploadDir, { recursive: true });

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const body = async (req: http.IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

async function worker() {
  const job = claimNextJob();
  if (job) {
    try { await processJob(job); }
    catch (error) {
      const retryAt = new Date(Date.now() + Math.min(30000, 1000 * 2 ** Number(job.attempts ?? 0))).toISOString();
      db.prepare(`UPDATE processing_jobs SET status='failed', error=?, available_at=?, updated_at=? WHERE id=?`).run(String(error), retryAt, now(), job.id);
      db.prepare(`UPDATE documents SET status='failed' WHERE id=(SELECT document_id FROM document_versions WHERE id=?)`).run(job.document_version_id);
    }
  }
  setTimeout(worker, Number(process.env.QUEUE_POLL_MS ?? 1000));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && ['/', '/app.js', '/styles.css'].includes(url.pathname)) {
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const filePath = path.join(publicDir, filename);
      const contentType = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'content-type': contentType });
      return res.end(fs.readFileSync(filePath));
    }
    if (req.method === 'GET' && url.pathname === '/v1/documents') {
      return send(res, 200, { data: db.prepare('SELECT * FROM documents ORDER BY created_at DESC').all() });
    }
    if (req.method === 'POST' && url.pathname === '/v1/documents') {
      const input = JSON.parse((await body(req)).toString() || '{}');
      if (!input.filename || !input.mimeType || !input.contentBase64) return send(res, 400, { error: 'filename, mimeType, and contentBase64 are required' });
      if (!['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(input.mimeType)) return send(res, 415, { error: 'Only PDF and DOCX are supported' });
      const documentId = id('doc');
      const versionId = id('ver');
      const storagePath = path.join(uploadDir, `${versionId}-${path.basename(input.filename)}`);
      const content = Buffer.from(input.contentBase64, 'base64');
      fs.writeFileSync(storagePath, content, { flag: 'wx' });
      const checksum = crypto.createHash('sha256').update(content).digest('hex');
      db.transaction(() => {
        db.prepare(`INSERT INTO documents(id,title,source_filename,mime_type,status,created_at) VALUES (?,?,?,?,?,?)`).run(documentId, input.filename, input.filename, input.mimeType, 'queued', now());
        db.prepare(`INSERT INTO document_versions(id,document_id,checksum_sha256,storage_path,status,created_at) VALUES (?,?,?,?,?,?)`).run(versionId, documentId, checksum, storagePath, 'queued', now());
      })();
      const jobId = enqueue(versionId);
      return send(res, 202, { documentId, documentVersionId: versionId, jobId, status: 'queued' });
    }
    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const job = db.prepare('SELECT * FROM processing_jobs WHERE id=?').get(jobMatch[1]);
      if (!job) return send(res, 404, { error: 'Job not found' });
      return send(res, 200, { job, steps: db.prepare('SELECT * FROM processing_steps WHERE job_id=? ORDER BY rowid').all(jobMatch[1]) });
    }
    const searchMatch = url.pathname.match(/^\/v1\/documents\/([^/]+)\/search$/);
    if (req.method === 'GET' && searchMatch) {
      const query = url.searchParams.get('q')?.trim();
      if (!query) return send(res, 400, { error: 'q is required' });
      const rows = retrieveEvidence(searchMatch[1], query);
      return send(res, 200, { data: rows });
    }
    const conversationsMatch = url.pathname.match(/^\/v1\/documents\/([^/]+)\/conversations$/);
    if (req.method === 'GET' && conversationsMatch) {
      const document = db.prepare('SELECT id FROM documents WHERE id=?').get(conversationsMatch[1]);
      if (!document) return send(res, 404, { error: 'Document not found' });
      return send(res, 200, { data: listChats(conversationsMatch[1], url.searchParams.get('includeArchived') === 'true') });
    }
    if (req.method === 'POST' && conversationsMatch) {
      const document = db.prepare('SELECT id, status FROM documents WHERE id=?').get(conversationsMatch[1]) as any;
      if (!document) return send(res, 404, { error: 'Document not found' });
      if (document.status !== 'ready') return send(res, 409, { error: 'Document is not ready', status: document.status });
      return send(res, 201, createChat(document.id));
    }
    const conversationMatch = url.pathname.match(/^\/v1\/documents\/([^/]+)\/conversations\/([^/]+)$/);
    if (req.method === 'PATCH' && conversationMatch) {
      const input = JSON.parse((await body(req)).toString() || '{}');
      const chat = db.prepare('SELECT id FROM conversations WHERE id=? AND document_id=?').get(conversationMatch[2], conversationMatch[1]);
      if (!chat) return send(res, 404, { error: 'Chat not found' });
      if (typeof input.archived !== 'boolean') return send(res, 400, { error: 'archived must be boolean' });
      archiveChat(conversationMatch[2], input.archived);
      return send(res, 200, { data: listChats(conversationMatch[1], true).find((item) => item.id === conversationMatch[2]) });
    }
    const chatMatch = url.pathname.match(/^\/v1\/documents\/([^/]+)\/chat$/);
    if (req.method === 'POST' && chatMatch) {
      const input = JSON.parse((await body(req)).toString() || '{}');
      const question = String(input.question ?? '').trim();
      if (!question) return send(res, 400, { error: 'question is required' });
      const document = db.prepare('SELECT id, title, status FROM documents WHERE id=?').get(chatMatch[1]) as any;
      if (!document) return send(res, 404, { error: 'Document not found' });
      if (document.status !== 'ready') return send(res, 409, { error: 'Document is not ready', status: document.status });
      const conversation = ensureChat(document.id, input.conversationId ? String(input.conversationId) : undefined);
      if (conversation.title === 'New chat') renameChat(conversation.id, question.slice(0, 48));
      addMessage(conversation.id, 'user', question);
      const rows = retrieveEvidence(document.id, question);
      if (!rows.length) {
        const text = 'No readable text was extracted from this document, so it cannot be answered yet.';
        addMessage(conversation.id, 'assistant', text);
        return send(res, 200, { conversationId: conversation.id, text, grounding: 'not_found', citations: [], chat: listChats(document.id).find((chat) => chat.id === conversation.id) });
      }
      const citations = rows.map((row, index) => ({ citationId: `cite_${index + 1}`, documentId: document.id, chunkId: row.chunkId, pageStart: row.pageNo, pageEnd: row.pageNo, label: `Page ${row.pageNo}` }));
      const text = await answerQuestion(question, rows);
      addMessage(conversation.id, 'assistant', text, citations);
      return send(res, 200, { conversationId: conversation.id, text, grounding: 'supported', evidence: rows, citations, chat: listChats(document.id).find((chat) => chat.id === conversation.id) });
    }
    const deleteDocumentMatch = url.pathname.match(/^\/v1\/documents\/([^/]+)$/);
    if (req.method === 'DELETE' && deleteDocumentMatch) {
      const document = db.prepare(`SELECT id FROM documents WHERE id=?`).get(deleteDocumentMatch[1]) as { id: string } | undefined;
      if (!document) return send(res, 404, { error: 'Document not found' });
      const files = db.prepare(`SELECT storage_path FROM document_versions WHERE document_id=?`).all(document.id) as Array<{ storage_path: string }>;
      db.transaction(() => {
        db.prepare(`DELETE FROM document_fts WHERE chunk_id IN (SELECT c.id FROM document_chunks c JOIN document_versions v ON v.id=c.document_version_id WHERE v.document_id=?)`).run(document.id);
        db.prepare(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE document_id=?)`).run(document.id);
        db.prepare(`DELETE FROM conversations WHERE document_id=?`).run(document.id);
        db.prepare(`DELETE FROM processing_steps WHERE job_id IN (SELECT id FROM processing_jobs WHERE document_version_id IN (SELECT id FROM document_versions WHERE document_id=?))`).run(document.id);
        db.prepare(`DELETE FROM processing_jobs WHERE document_version_id IN (SELECT id FROM document_versions WHERE document_id=?)`).run(document.id);
        db.prepare(`DELETE FROM document_chunks WHERE document_version_id IN (SELECT id FROM document_versions WHERE document_id=?)`).run(document.id);
        db.prepare(`DELETE FROM document_pages WHERE document_version_id IN (SELECT id FROM document_versions WHERE document_id=?)`).run(document.id);
        db.prepare(`DELETE FROM document_versions WHERE document_id=?`).run(document.id);
        db.prepare(`DELETE FROM documents WHERE id=?`).run(document.id);
      })();
      for (const file of files) { try { fs.rmSync(file.storage_path, { force: true }); } catch { /* best effort cleanup */ } }
      return send(res, 200, { deleted: true, documentId: document.id });
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) { send(res, 500, { error: String(error) }); }
});

server.listen(port, () => console.log(`Chat With Docs API listening on http://localhost:${port}`));
worker();
