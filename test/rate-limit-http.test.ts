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

test('HTTP rate limiter returns 429 for repeated API requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-with-docs-rate-limit-'));
  const port = 31_500 + Math.floor(Math.random() * 400);
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
      RATE_LIMIT_MAX_REQUESTS: '1',
      RATE_LIMIT_WINDOW_MS: '60000'
    },
    stdio: 'ignore'
  });

  try {
    await waitForHealth(`${baseUrl}/health`);
    const first = await fetch(`${baseUrl}/v1/documents`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-ratelimit-remaining'), '0');

    const second = await fetch(`${baseUrl}/v1/documents`);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '60');

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});
