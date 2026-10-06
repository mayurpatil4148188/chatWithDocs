import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function syntheticDocx() {
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Chat With Docs integration test document. This fixture contains enough text for retrieval.</w:t></w:r></w:p></w:body></w:document>']
  ].map(([name, content]) => ({ name, data: Buffer.from(content) }));
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const checksum = crc32(file.data);
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(file.data.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    local.push(header, file.data);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(file.data.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);
    offset += header.length + file.data.length;
  }
  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralDirectory, end]);
}

async function waitFor(url: string, predicate: (value: any) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const value = await response.json();
      if (predicate(value)) return value;
    } catch { /* server is still starting or processing */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(child: ChildProcess) {
  if (!child.killed) child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('HTTP smoke test covers upload, processing, search, chat, and deletion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-with-docs-test-'));
  const port = 31_000 + Math.floor(Math.random() * 500);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'start'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_PATH: path.join(root, 'test.sqlite'),
      UPLOAD_DIR: path.join(root, 'uploads'),
      LLM_PROVIDER: 'mock',
      QUEUE_POLL_MS: '1000',
      RATE_LIMIT_MAX_REQUESTS: '1000'
    },
    stdio: 'ignore'
  });

  try {
    await waitFor(`${baseUrl}/health`, (value) => value.ok === true);
    const configResponse = await fetch(`${baseUrl}/v1/config`);
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json() as { provider: string; externalProvider: boolean; privacyMessage: string; LLM_API_KEY?: string };
    assert.equal(config.provider, 'mock');
    assert.equal(config.externalProvider, false);
    assert.match(config.privacyMessage, /not sent to an external/i);
    assert.equal(config.LLM_API_KEY, undefined);

    const malformedJson = await fetch(`${baseUrl}/v1/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json'
    });
    assert.equal(malformedJson.status, 400);

    const mismatchedFile = await fetch(`${baseUrl}/v1/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'fake.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('not a PDF').toString('base64') })
    });
    assert.equal(mismatchedFile.status, 415);

    const content = syntheticDocx();
    const uploadResponse = await fetch(`${baseUrl}/v1/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'integration.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBase64: content.toString('base64') })
    });
    assert.equal(uploadResponse.status, 202);
    const uploaded = await uploadResponse.json() as { documentId: string; jobId: string };

    const job = await waitFor(`${baseUrl}/v1/jobs/${uploaded.jobId}`, (value) => value.job?.status === 'complete' || value.job?.status === 'failed');
    assert.equal(job.job.status, 'complete', job.job.error ?? 'processing job failed without an error');

    const searchResponse = await fetch(`${baseUrl}/v1/documents/${uploaded.documentId}/search?q=integration`);
    assert.equal(searchResponse.status, 200);
    const search = await searchResponse.json() as { data: Array<{ pageNo: number; text: string }> };
    assert.equal(search.data[0]?.pageNo, 1);
    assert.match(search.data[0]?.text ?? '', /integration test/i);

    const chatResponse = await fetch(`${baseUrl}/v1/documents/${uploaded.documentId}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What is in this document?' })
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json() as { grounding: string; citations: unknown[] };
    assert.equal(chat.grounding, 'supported');
    assert.ok(chat.citations.length > 0);

    const deleteResponse = await fetch(`${baseUrl}/v1/documents/${uploaded.documentId}`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 200);

    const failedUploadResponse = await fetch(`${baseUrl}/v1/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'retry.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-invalid-fixture').toString('base64') })
    });
    assert.equal(failedUploadResponse.status, 202);
    const failedUpload = await failedUploadResponse.json() as { documentId: string; jobId: string };
    const failedJob = await waitFor(`${baseUrl}/v1/jobs/${failedUpload.jobId}`, (value) => value.job?.status === 'failed');
    assert.equal(failedJob.job.status, 'failed');
    const retryResponse = await fetch(`${baseUrl}/v1/documents/${failedUpload.documentId}/retry`, { method: 'POST' });
    assert.equal(retryResponse.status, 202);
    const retry = await retryResponse.json() as { status: string; documentId: string };
    assert.equal(retry.status, 'queued');
    assert.equal(retry.documentId, failedUpload.documentId);
    await fetch(`${baseUrl}/v1/documents/${failedUpload.documentId}`, { method: 'DELETE' });
  } finally {
    await stop(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});
