import crypto from 'node:crypto';
import { db } from './db.js';

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export function enqueue(documentVersionId: string) {
  const jobId = id('job');
  const timestamp = now();
  const insertJob = db.prepare(`INSERT INTO processing_jobs
    (id, document_version_id, status, current_step, available_at, updated_at)
    VALUES (?, ?, 'queued', 'extract', ?, ?)`);
  const insertStep = db.prepare(`INSERT INTO processing_steps
    (job_id, step, status, updated_at) VALUES (?, ?, 'queued', ?)`);
  db.transaction(() => {
    insertJob.run(jobId, documentVersionId, timestamp, timestamp);
    for (const step of ['upload', 'extract', 'chunk', 'index', 'ready']) insertStep.run(jobId, step, timestamp);
    db.prepare(`UPDATE processing_steps SET status='complete', progress=1, updated_at=? WHERE job_id=? AND step='upload'`).run(timestamp, jobId);
  })();
  return jobId;
}

export function claimNextJob() {
  const job = db.prepare(`SELECT * FROM processing_jobs WHERE status IN ('queued','failed')
    AND attempts < 3 AND available_at <= ? ORDER BY updated_at LIMIT 1`).get(now()) as { id: string } | undefined;
  if (!job) return undefined;
  db.prepare(`UPDATE processing_jobs SET status='running', attempts=attempts+1, updated_at=? WHERE id=?`).run(now(), job.id);
  return db.prepare(`SELECT * FROM processing_jobs WHERE id=?`).get(job.id) as any;
}
