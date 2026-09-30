import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve('.env');

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envPath); } catch { /* missing .env is fine */ }
} else if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
