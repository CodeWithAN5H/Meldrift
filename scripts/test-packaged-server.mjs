#!/usr/bin/env node
/**
 * Exercises the packaged signaling sidecar the way the desktop shell does:
 * health readiness, account + room persistence across a restart, a port
 * conflict, and a clean shutdown. Requires `bun run server:build` first.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const triple =
  process.env.MELDRIFT_TARGET_TRIPLE ??
  (process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc');
const binary = join(root, 'src-tauri', 'binaries', `meldrift-server-${triple}.exe`);
if (!existsSync(binary)) {
  console.error(`Missing ${binary}. Run: bun run server:build`);
  process.exit(1);
}

const port = 19000 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), 'meldrift-sidecar-'));
const database = join(dir, 'server', 'meldrift.db');
let child = null;
let passed = 0;

function check(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`ok ${passed} - ${message}`);
}

function startServer() {
  return spawn(binary, [], {
    env: {
      ...process.env,
      MELDRIFT_HOST: '127.0.0.1',
      MELDRIFT_PORT: String(port),
      MELDRIFT_DATA: database,
      MELDRIFT_VERSION: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function stop(proc, timeoutMs = 5000) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill();
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Health endpoint never became ready');
}

async function api(path, init = {}, token) {
  const headers = { ...(init.body ? { 'content-type': 'application/json' } : {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

try {
  child = startServer();
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  const health = await waitForHealth();
  check(health.name === 'meldrift-signaling', 'health identifies the Meldrift server');
  check(health.version === 'test', 'health reports the sidecar version');

  const username = `p0${Date.now().toString(36).slice(-6)}`;
  const register = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'correct-horse-1', displayName: 'Player One' }),
  });
  check(register.status === 201, 'account creation works');
  const token = register.data.token;

  const room = await api(
    '/api/rooms',
    { method: 'POST', body: JSON.stringify({ name: 'P0 Local', kind: 'voice' }) },
    token,
  );
  check(room.status === 201, 'room creation works');

  await stop(child);
  child = null;
  check(true, 'server stops');

  child = startServer();
  await waitForHealth();
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'correct-horse-1' }),
  });
  check(login.status === 200, 'account survives a restart (same database)');

  const bootstrap = await api('/api/bootstrap', {}, login.data.token);
  check(
    bootstrap.status === 200 && bootstrap.data.rooms.some((item) => item.id === room.data.id),
    'room survives a restart',
  );

  const duplicate = spawn(binary, [], {
    env: {
      ...process.env,
      MELDRIFT_HOST: '127.0.0.1',
      MELDRIFT_PORT: String(port),
      MELDRIFT_DATA: join(dir, 'duplicate.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const duplicateExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still-running'), 6000);
    duplicate.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (duplicateExit === 'still-running') duplicate.kill();
  check(duplicateExit !== 0, 'a second instance on the same port is rejected');

  const broken = spawn(binary, [], {
    env: {
      ...process.env,
      MELDRIFT_HOST: '127.0.0.1',
      MELDRIFT_PORT: String(port + 1),
      // A directory cannot be opened as a SQLite database.
      MELDRIFT_DATA: dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const brokenExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still-running'), 6000);
    broken.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (brokenExit === 'still-running') broken.kill();
  check(brokenExit !== 0, 'an unusable database path fails start-up');

  await stop(child);
  child = null;
  let reachable = true;
  try {
    await fetch(`${base}/api/health`);
  } catch {
    reachable = false;
  }
  check(!reachable, 'shutdown releases the port');

  console.log(`\n${passed} checks passed. Database: ${database}`);
} catch (error) {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await stop(child);
  rmSync(dir, { recursive: true, force: true });
}
