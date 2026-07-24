#!/usr/bin/env node
// =============================================================================
// test-watchdog-heartbeat-contract.js — Contrato del heartbeat del watchdog (#4077).
//
// El heartbeat (.pipeline/logs/watchdog.heartbeat) es la señal que decide si el
// supervisor relanza el watchdog. Este test fija su contrato:
//   - JSON con `ts` ISO8601 parseable + `pid` numérico.
//   - escritura atómica (tmp + Move-Item) => sin `.tmp` huérfanos.
//
// La función `validateHeartbeat` (pura) es la fuente de verdad del contrato y
// se testea siempre. Si hay PowerShell disponible, además se ejecuta el snippet
// real `Write-Heartbeat` de watchdog.ps1 y se valida su salida (skip en CI Linux).
//
// Ejecución: node --test .pipeline/test-watchdog-heartbeat-contract.js
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Valida que un objeto cumpla el contrato del heartbeat. Pura.
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateHeartbeat(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'no-object' };
  if (typeof obj.pid !== 'number' || !Number.isFinite(obj.pid) || obj.pid <= 0) {
    return { ok: false, reason: 'pid-invalido' };
  }
  if (typeof obj.ts !== 'string') return { ok: false, reason: 'ts-no-string' };
  const parsed = Date.parse(obj.ts);
  if (!Number.isFinite(parsed)) return { ok: false, reason: 'ts-no-iso8601' };
  return { ok: true };
}

test('contrato — heartbeat válido pasa', () => {
  const r = validateHeartbeat({ pid: 1234, ts: '2026-06-18T07:16:44.1234567-03:00' });
  assert.strictEqual(r.ok, true);
});

test('contrato — pid no numérico falla', () => {
  assert.strictEqual(validateHeartbeat({ pid: '1234', ts: new Date(0).toISOString() }).ok, false);
  assert.strictEqual(validateHeartbeat({ pid: 0, ts: new Date(0).toISOString() }).ok, false);
  assert.strictEqual(validateHeartbeat({ ts: new Date(0).toISOString() }).ok, false);
});

test('contrato — ts no parseable falla', () => {
  assert.strictEqual(validateHeartbeat({ pid: 1, ts: 'no-fecha' }).ok, false);
  assert.strictEqual(validateHeartbeat({ pid: 1 }).ok, false);
  assert.strictEqual(validateHeartbeat({ pid: 1, ts: 12345 }).ok, false);
});

function powershellBin() {
  for (const bin of ['powershell.exe', 'pwsh']) {
    try {
      execFileSync(bin, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
        stdio: 'ignore',
      });
      return bin;
    } catch (_) {
      /* probar el siguiente */
    }
  }
  return null;
}

test('contrato — Write-Heartbeat real produce JSON válido y atómico (si hay PowerShell)', (t) => {
  const ps = powershellBin();
  if (!ps) {
    t.skip('PowerShell no disponible (probablemente CI Linux)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  try {
    const hb = path.join(dir, 'watchdog.heartbeat').replace(/\\/g, '\\\\');
    // Réplica exacta del Write-Heartbeat de watchdog.ps1.
    const script = [
      `$HeartbeatFile = "${hb}"`,
      '$payload = @{ pid = $PID; ts = (Get-Date).ToString(\'o\') } | ConvertTo-Json -Compress',
      '$tmp = "$HeartbeatFile.tmp"',
      '$payload | Out-File -FilePath $tmp -Encoding utf8 -NoNewline',
      'Move-Item -Path $tmp -Destination $HeartbeatFile -Force',
    ].join('; ');
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });

    const file = path.join(dir, 'watchdog.heartbeat');
    assert.ok(fs.existsSync(file), 'el heartbeat fue escrito');
    assert.ok(!fs.existsSync(file + '.tmp'), 'no quedó .tmp huérfano (escritura atómica)');

    let raw = fs.readFileSync(file, 'utf8');
    // PowerShell utf8 puede prefijar BOM; lo removemos antes de parsear.
    raw = raw.replace(/^﻿/, '');
    const obj = JSON.parse(raw);
    const v = validateHeartbeat(obj);
    assert.strictEqual(v.ok, true, `heartbeat no cumple contrato: ${v.reason} (${raw})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

module.exports = { validateHeartbeat };
