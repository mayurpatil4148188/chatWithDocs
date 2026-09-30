import { db } from './db.js';
import { id, now } from './queue.js';

export type SavedMessage = { id: string; role: string; text: string; citations: unknown[]; createdAt: string };
export type SavedChat = { id: string; documentId: string; title: string; createdAt: string; updatedAt: string; archivedAt: string | null; messages: SavedMessage[] };

const toMessage = (row: any): SavedMessage => ({
  id: row.id,
  role: row.role,
  text: row.text,
  citations: JSON.parse(row.citations_json || '[]'),
  createdAt: row.created_at
});

const toChat = (row: any, messages: SavedMessage[] = []): SavedChat => ({
  id: row.id,
  documentId: row.document_id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at ?? null,
  messages
});

export function listChats(documentId: string, includeArchived = false): SavedChat[] {
  const rows = db.prepare(`SELECT * FROM conversations WHERE document_id=? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC, created_at DESC`).all(documentId) as any[];
  const messagesFor = db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at`);
  return rows.map((row) => toChat(row, messagesFor.all(row.id).map(toMessage)));
}

export function getChat(conversationId: string, documentId?: string): SavedChat | undefined {
  const row = documentId
    ? db.prepare(`SELECT * FROM conversations WHERE id=? AND document_id=?`).get(conversationId, documentId)
    : db.prepare(`SELECT * FROM conversations WHERE id=?`).get(conversationId);
  if (!row) return undefined;
  const messages = db.prepare(`SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at`).all(conversationId).map(toMessage);
  return toChat(row, messages);
}

export function createChat(documentId: string, title = 'New chat'): SavedChat {
  const chatId = id('chat');
  const timestamp = now();
  db.prepare(`INSERT INTO conversations(id, document_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(chatId, documentId, title, timestamp, timestamp);
  return getChat(chatId, documentId)!;
}

export function ensureChat(documentId: string, conversationId?: string): SavedChat {
  if (conversationId) {
    const existing = getChat(conversationId, documentId);
    if (existing) return existing;
  }
  const chats = listChats(documentId);
  return chats[0] ?? createChat(documentId);
}

export function addMessage(conversationId: string, role: string, text: string, citations: unknown[] = []): SavedMessage {
  const messageId = id('msg');
  const timestamp = now();
  db.prepare(`INSERT INTO messages(id, conversation_id, role, text, citations_json, created_at) VALUES (?,?,?,?,?,?)`)
    .run(messageId, conversationId, role, text, JSON.stringify(citations), timestamp);
  db.prepare(`UPDATE conversations SET updated_at=? WHERE id=?`).run(timestamp, conversationId);
  return { id: messageId, role, text, citations, createdAt: timestamp };
}

export function renameChat(conversationId: string, title: string) {
  db.prepare(`UPDATE conversations SET title=?, updated_at=? WHERE id=?`).run(title, now(), conversationId);
}

export function archiveChat(conversationId: string, archived: boolean) {
  db.prepare(`UPDATE conversations SET archived_at=?, updated_at=? WHERE id=?`).run(archived ? now() : null, now(), conversationId);
}
