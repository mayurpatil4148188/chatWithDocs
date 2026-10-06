import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function waitForHealth(url: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for test server');
}

test('HTTP upload and request size limits return 413', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-with-docs-upload-limit-'));
  const port = 31_900 + Math.floor(Math.random() * 100);
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
      MAX_UPLOAD_BYTES: '8',
      MAX_REQUEST_BYTES: '4096',
      RATE_LIMIT_MAX_REQUESTS: '100'
    },
    stdio: 'ignore'
  });

  try {
    await waitForHealth(`${baseUrl}/health`);
    const oversizedFile = await fetch(`${baseUrl}/v1/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'large.pdf', mimeType: 'application/pdf', contentBase64: Buffer.alloc(9, 0x41).toString('base64') })
    });
    assert.equal(oversizedFile.status, 413);

    const oversizedRequest = await fetch(`${baseUrl}/v1/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'large-request.pdf', mimeType: 'application/pdf', contentBase64: 'A'.repeat(8_000) })
    });
    assert.equal(oversizedRequest.status, 413);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});
