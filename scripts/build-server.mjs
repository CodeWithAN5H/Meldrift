#!/usr/bin/env node
/**
 * Builds the signaling server as a standalone Windows executable for Tauri's
 * externalBin sidecar. The target triple suffix is required by Tauri; the
 * installer renames it next to Meldrift.exe.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const triple =
  process.env.MELDRIFT_TARGET_TRIPLE ??
  (process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc');
const outDir = join(root, 'src-tauri', 'binaries');
const outfile = join(outDir, `meldrift-server-${triple}.exe`);

mkdirSync(outDir, { recursive: true });

console.log(`[server] compiling ${outfile}`);
execFileSync(
  process.platform === 'win32' ? 'bun.exe' : 'bun',
  [
    'build',
    '--compile',
    '--minify',
    '--target=bun-windows-x64',
    'server/src/index.ts',
    '--outfile',
    outfile,
  ],
  { cwd: root, stdio: 'inherit' },
);

const size = statSync(outfile).size;
if (size < 10 * 1024 * 1024) {
  throw new Error(`[server] sidecar looks too small (${size} bytes)`);
}
console.log(`[server] sidecar ready (${(size / 1024 / 1024).toFixed(1)} MiB)`);
