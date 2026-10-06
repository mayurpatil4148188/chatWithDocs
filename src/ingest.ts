import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import { db } from './db.js';
import { now } from './queue.js';
import { assertExtractionLimits } from './extraction-limits.js';

type Page = { pageNo: number; text: string; ocrUsed: boolean };

const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');

async function extract(filePath: string, mimeType: string): Promise<Page[]> {
  const buffer = fs.readFileSync(filePath);
  if (mimeType === 'application/pdf') {
    const result = await pdf(buffer, { pagerender: async (pageData: any) => {
      const content = await pageData.getTextContent();
      return content.items.map((item: any) => item.str).join(' ');
    }});
    const pages = result.text.split(/\f|\n\s*\n(?=\S)/).map((text: string, index: number) => ({ pageNo: index + 1, text: text.trim(), ocrUsed: false }));
    return pages.length ? pages : [{ pageNo: 1, text: result.text.trim(), ocrUsed: false }];
  }
  const result = await mammoth.extractRawText({ path: filePath });
  return [{ pageNo: 1, text: result.value.trim(), ocrUsed: false }];
}

export async function processJob(job: any) {
  const version = db.prepare(`SELECT v.*, d.id document_id, d.mime_type, d.status document_status
    FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE v.id=?`).get(job.document_version_id) as any;
  if (!version) throw new Error('Document version not found');
  const setStep = db.prepare(`UPDATE processing_steps SET status=?, progress=?, error=?, updated_at=? WHERE job_id=? AND step=?`);
  const setCurrent = db.prepare(`UPDATE processing_jobs SET current_step=?, updated_at=? WHERE id=?`);
  const pages = await extract(version.storage_path, version.mime_type);
  assertExtractionLimits(
    pages,
    Number(process.env.MAX_DOCUMENT_PAGES ?? 100),
    Number(process.env.MAX_EXTRACTED_TEXT_BYTES ?? 10 * 1024 * 1024)
  );
  setCurrent.run('extract', now(), job.id);
  setStep.run('complete', 1, null, now(), job.id, 'extract');

  const insertPage = db.prepare(`INSERT OR REPLACE INTO document_pages
    (id, document_version_id, page_no, text, text_sha256, ocr_used, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertChunk = db.prepare(`INSERT OR REPLACE INTO document_chunks
    (id, document_version_id, page_id, page_no, ordinal, text, text_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    db.prepare(`DELETE FROM document_fts WHERE chunk_id IN (SELECT id FROM document_chunks WHERE document_version_id=?)`).run(version.id);
    db.prepare(`DELETE FROM document_chunks WHERE document_version_id=?`).run(version.id);
    db.prepare(`DELETE FROM document_pages WHERE document_version_id=?`).run(version.id);
    for (const page of pages) {
      const pageId = `${version.id}_page_${page.pageNo}`;
      insertPage.run(pageId, version.id, page.pageNo, page.text, sha(page.text), page.ocrUsed ? 1 : 0, JSON.stringify({ ocrRequired: page.text.length < 20 }));
      const chunks = page.text.match(/.{1,1200}(?:\s|$)/g) ?? [''];
      chunks.forEach((text, ordinal) => {
        const clean = text.trim();
        if (clean.length < 20) return;
        const chunkId = `${pageId}_chunk_${ordinal}`;
        insertChunk.run(chunkId, version.id, pageId, page.pageNo, ordinal, clean, sha(clean));
        db.prepare(`INSERT INTO document_fts(chunk_id, text) VALUES (?, ?)`).run(chunkId, clean);
      });
    }
    db.prepare(`UPDATE document_versions SET page_count=?, parser=?, status='ready' WHERE id=?`).run(pages.length, version.mime_type, version.id);
    db.prepare(`UPDATE documents SET status='ready' WHERE id=?`).run(version.document_id);
  })();
  for (const step of ['chunk', 'index', 'ready']) setStep.run('complete', 1, null, now(), job.id, step);
  db.prepare(`UPDATE processing_jobs SET status='complete', current_step='ready', updated_at=? WHERE id=?`).run(now(), job.id);
}
