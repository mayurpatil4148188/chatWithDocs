import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateLimiter } from '../src/rate-limit.js';
import { matchesDeclaredFileType } from '../src/file-validation.js';
import { fetchWithTimeout } from '../src/llm.js';
import { answerQuestion } from '../src/llm.js';
import { assertExtractionLimits } from '../src/extraction-limits.js';

test('the repository exposes a credential-free mock-provider configuration', async () => {
  const example = await import('node:fs/promises').then((fs) => fs.readFile('.env.example', 'utf8'));
  assert.match(example, /^LLM_PROVIDER=mock$/m);
  assert.match(example, /^HOST=127\.0\.0\.1$/m);
  assert.match(example, /^MAX_UPLOAD_BYTES=\d+$/m);
});

test('rate limiter blocks requests after the configured window quota', () => {
  const limit = createRateLimiter(1_000, 2);
  assert.equal(limit('local', 0).allowed, true);
  assert.equal(limit('local', 100).allowed, true);
  const blocked = limit('local', 200);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limit('local', 1_001).allowed, true);
});

test('file validation checks declared PDF and DOCX signatures', () => {
  assert.equal(matchesDeclaredFileType(Buffer.from('%PDF-1.7\n'), 'application/pdf'), true);
  assert.equal(matchesDeclaredFileType(Buffer.from('not a PDF'), 'application/pdf'), false);
  assert.equal(matchesDeclaredFileType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
  assert.equal(matchesDeclaredFileType(Buffer.from('not a DOCX'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), false);
});

test('LLM fetch aborts after the configured timeout', async () => {
  await assert.rejects(
    fetchWithTimeout('https://provider.invalid', {}, 5, async (_input, init) => {
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
      return new Response('{}');
    }),
    { message: 'aborted', name: 'AbortError' }
  );
});

test('extraction limits reject excessive pages and text', () => {
  const page = (text: string) => ({ pageNo: 1, text, ocrUsed: false });
  assert.doesNotThrow(() => assertExtractionLimits([page('short')], 1, 100));
  assert.throws(() => assertExtractionLimits([page('a'), page('b')], 1, 100), /maximum page count/);
  assert.throws(() => assertExtractionLimits([page('0123456789')], 10, 5), /maximum extracted text size/);
});

test('LLM provider HTTP failures become actionable errors', async () => {
  const previous = {
    provider: process.env.LLM_PROVIDER,
    key: process.env.LLM_API_KEY,
    baseUrl: process.env.LLM_BASE_URL
  };
  const originalFetch = globalThis.fetch;
  process.env.LLM_PROVIDER = 'openai-compatible';
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_BASE_URL = 'https://provider.invalid/v1';
  globalThis.fetch = async () => new Response('', { status: 503 });
  try {
    await assert.rejects(
      answerQuestion('What is this?', [{ pageNo: 1, text: 'A sufficiently long evidence passage for the provider test.' }]),
      /LLM request failed with 503/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.provider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previous.provider;
    if (previous.key === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = previous.baseUrl;
  }
});

test('LLM provider timeouts become actionable errors', async () => {
  const previous = {
    provider: process.env.LLM_PROVIDER,
    key: process.env.LLM_API_KEY,
    timeout: process.env.LLM_REQUEST_TIMEOUT_MS
  };
  const originalFetch = globalThis.fetch;
  process.env.LLM_PROVIDER = 'openai-compatible';
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_REQUEST_TIMEOUT_MS = '5';
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  try {
    await assert.rejects(
      answerQuestion('What is this?', [{ pageNo: 1, text: 'A sufficiently long evidence passage for the timeout test.' }]),
      /LLM request timed out after 5 ms/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.provider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = previous.provider;
    if (previous.key === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = previous.key;
    if (previous.timeout === undefined) delete process.env.LLM_REQUEST_TIMEOUT_MS; else process.env.LLM_REQUEST_TIMEOUT_MS = previous.timeout;
  }
});
