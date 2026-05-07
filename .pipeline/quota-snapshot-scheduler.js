#!/usr/bin/env node
// =============================================================================
// quota-snapshot-scheduler.js — Loop que orquesta capture + parse + persist.
// Issue #3012 (split de #3008, hija 1).
//
// CICLO (cada `QUOTA_SNAPSHOT_INTERVAL_MIN` minutos, default 60)
//   1. Si `QUOTA_SNAPSHOT_ENABLED=false` → skip silencioso (CA-18, kill switch).
//   2. Spawn de `.pipeline/scripts/capture-quota-snapshot.ps1`.
//   3. Si capture exit code != 0 → categorizar y registrar fallo en alerter.
//   4. Si OK, parsear el PNG via `lib/quota-snapshot-parser`.
//   5. Si parse OK, validar account_handle y appendear al JSONL via
//      `lib/quota-snapshot-persist`.
//   6. Rotación + retención si corresponde.
//
// EJECUCIÓN
//   - Como servicio Node persistente: `node .pipeline/quota-snapshot-scheduler.js`.
//   - Como tick único (CI / scheduled task): `--once`.
//
// ENV VARS
//   QUOTA_SNAPSHOT_ENABLED         "true"|"false" (default true)
//   QUOTA_SNAPSHOT_INTERVAL_MIN    int minutos (default 60, min 5, max 1440)
//   QUOTA_SNAPSHOT_PS1_PATH        path al .ps1 (default
//                                   .pipeline/scripts/capture-quota-snapshot.ps1)
//   CLAUDE_DESKTOP_PATH            consumido por el .ps1
//   EXPECTED_CLAUDE_ACCOUNT        consumido por el parser (CA-6)
//   QUOTA_PARSE_FAIL_ALERT_THRESHOLD  default 3
//   QUOTA_PNG_RETENTION_DAYS       default 30
//   QUOTA_JSONL_ROTATE_MB          default 5
//
// CA-15 (coexistencia): este scheduler NO toca quota-exhausted.js ni
// weekly-quota.js. Sólo escribe a JSONL. La integración con detector/banner
// queda en #3013.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const parser = require('./lib/quota-snapshot-parser');
const persist = require('./lib/quota-snapshot-persist');
const alerterMod = require('./lib/quota-snapshot-alerter');

const PIPELINE_DIR = __dirname;
const DEFAULT_PS1_PATH = path.join(PIPELINE_DIR, 'scripts', 'capture-quota-snapshot.ps1');
const DEFAULT_PNG_DIR = path.join(PIPELINE_DIR, 'quota-snapshots');
const TG_OUTBOX_DIR = path.join(PIPELINE_DIR, 'servicios', 'telegram', 'pendiente');
const LOG_FILE = path.join(PIPELINE_DIR, 'logs', 'quota-snapshot.log');

const MIN_INTERVAL_MIN = 5;
const MAX_INTERVAL_MIN = 1440;
const DEFAULT_INTERVAL_MIN = 60;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {}
  // Sin console.log para no contaminar stdout (puede haber wrappers).
}

function isEnabled() {
  const raw = String(process.env.QUOTA_SNAPSHOT_ENABLED || '').toLowerCase();
  // Default: habilitado salvo que esté explícitamente "false" (CA-18).
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

function getIntervalMs() {
  const raw = parseInt(process.env.QUOTA_SNAPSHOT_INTERVAL_MIN, 10);
  let n = Number.isFinite(raw) ? raw : DEFAULT_INTERVAL_MIN;
  if (n < MIN_INTERVAL_MIN) n = MIN_INTERVAL_MIN;
  if (n > MAX_INTERVAL_MIN) n = MAX_INTERVAL_MIN;
  return n * 60 * 1000;
}

function enqueueTelegram(text) {
  // Drop al outbox de servicio-telegram. Mismo patrón que rollback.js / restart.js.
  try {
    if (!fs.existsSync(TG_OUTBOX_DIR)) fs.mkdirSync(TG_OUTBOX_DIR, { recursive: true });
    const filename = `${Date.now()}-quota-snapshot.json`;
    fs.writeFileSync(
      path.join(TG_OUTBOX_DIR, filename),
      JSON.stringify({ text, parse_mode: 'Markdown' })
    );
  } catch (e) {
    log(`enqueueTelegram error: ${e && e.message}`);
  }
}

function categorizeCaptureExit(code) {
  // Mapeo del exit code del .ps1 a la whitelist del parser.
  switch (Number(code)) {
    case 2: return null;                    // operador enfocado, skip silencioso
    case 3: return null;                    // lock activo de otro capturador, skip
    case 4: return 'unknown';               // CLAUDE_DESKTOP_PATH inválido
    case 5: return 'session_disconnected';  // timeout esperando UI
    case 6: return 'unknown';               // error de sistema
    default:
      return Number(code) === 0 ? null : 'unknown';
  }
}

/**
 * Spawnea el .ps1 y devuelve `{ exitCode, stdout, stderr }`. Stdout contiene
 * el path absoluto del PNG cuando exit == 0.
 */
function runCaptureScript(ps1Path) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1Path];
    let stdout = '';
    let stderr = '';
    let killed = false;
    let proc;
    try {
      proc = spawn('powershell.exe', args, { windowsHide: true });
    } catch (e) {
      resolve({ exitCode: 6, stdout: '', stderr: `spawn_failed: ${e && e.message}` });
      return;
    }
    proc.stdout.on('data', (d) => { stdout += String(d); });
    proc.stderr.on('data', (d) => { stderr += String(d); });
    const timeout = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, 90 * 1000); // hard cap 90s
    proc.on('exit', (code) => {
      clearTimeout(timeout);
      const exitCode = killed ? 6 : (Number.isFinite(code) ? code : 6);
      resolve({ exitCode, stdout: stdout.trim(), stderr });
    });
    proc.on('error', () => {
      clearTimeout(timeout);
      resolve({ exitCode: 6, stdout: '', stderr });
    });
  });
}

/**
 * Tick: captura + parse + persist. Devuelve `{ ok, snapshot? | category }`.
 * Inyectable: `opts.runCapture`, `opts.parseSnapshot`, `opts.appendSnapshot`,
 * `opts.alerter`, `opts.now`.
 */
async function runOnce(opts = {}) {
  if (!isEnabled()) {
    log('runOnce: kill switch ON (QUOTA_SNAPSHOT_ENABLED=false), skip');
    return { ok: false, category: null, reason: 'killswitch' };
  }

  const ps1Path = opts.ps1Path || process.env.QUOTA_SNAPSHOT_PS1_PATH || DEFAULT_PS1_PATH;
  const allowedRoot = opts.allowedRoot || DEFAULT_PNG_DIR;
  const expectedAccount = opts.expectedAccount || process.env.EXPECTED_CLAUDE_ACCOUNT || '';

  const runCapture = typeof opts.runCapture === 'function'
    ? opts.runCapture
    : () => runCaptureScript(ps1Path);

  const parseSnapshot = typeof opts.parseSnapshot === 'function'
    ? opts.parseSnapshot
    : parser.parseSnapshot;

  const appendSnapshot = typeof opts.appendSnapshot === 'function'
    ? opts.appendSnapshot
    : persist.appendSnapshot;

  const rotateIfNeeded = typeof opts.rotateIfNeeded === 'function'
    ? opts.rotateIfNeeded
    : persist.rotateIfNeeded;

  const cleanupOldPngs = typeof opts.cleanupOldPngs === 'function'
    ? opts.cleanupOldPngs
    : persist.cleanupOldPngs;

  const alerter = opts.alerter || alerterMod.createAlerter({
    sendMessage: enqueueTelegram,
    log: log,
  });

  // 1) Capture.
  const cap = await runCapture();
  if (cap.exitCode !== 0) {
    const category = categorizeCaptureExit(cap.exitCode);
    if (category === null) {
      log(`runOnce: capture skipped (exitCode=${cap.exitCode})`);
      return { ok: false, category: null, reason: 'capture_skipped' };
    }
    log(`runOnce: capture failed (exitCode=${cap.exitCode}, category=${category})`);
    alerter.recordFailure(category);
    return { ok: false, category, reason: 'capture_failed' };
  }

  const pngPath = String(cap.stdout || '').split(/\r?\n/).filter(Boolean).pop();
  if (!pngPath) {
    log('runOnce: capture exit 0 sin path en stdout');
    alerter.recordFailure('unknown');
    return { ok: false, category: 'unknown', reason: 'no_png_path' };
  }

  // 2) Parse.
  let result;
  try {
    result = await parseSnapshot(pngPath, {
      expectedAccount,
      allowedRoot,
    });
  } catch (e) {
    log(`runOnce: parseSnapshot threw: ${e && e.message}`);
    alerter.recordFailure('unknown');
    return { ok: false, category: 'unknown', reason: 'parser_threw' };
  }

  if (!result || !result.ok) {
    const category = (result && result.category) || 'unknown';
    log(`runOnce: parse failed (category=${category}, reason=${result && result.reason})`);
    if (category === 'account_mismatch') {
      alerter.recordAccountMismatch();
    } else {
      alerter.recordFailure(category);
    }
    return { ok: false, category, reason: result && result.reason };
  }

  // 3) Persist.
  try {
    appendSnapshot(result.snapshot);
  } catch (e) {
    log(`runOnce: appendSnapshot error: ${e && e.message}`);
    alerter.recordFailure('unknown');
    return { ok: false, category: 'unknown', reason: 'persist_failed' };
  }

  alerter.recordSuccess();
  alerter.recordAccountOk();

  // 4) Rotación + retención.
  try {
    rotateIfNeeded();
  } catch (e) {
    log(`runOnce: rotateIfNeeded error: ${e && e.message}`);
  }
  try {
    cleanupOldPngs();
  } catch (e) {
    log(`runOnce: cleanupOldPngs error: ${e && e.message}`);
  }

  log(`runOnce: ok (confidence=${result.snapshot.parse_confidence})`);
  return { ok: true, snapshot: result.snapshot };
}

async function mainLoop() {
  const intervalMs = getIntervalMs();
  log(`scheduler: arrancando con interval=${intervalMs / 60000} min`);

  let stop = false;
  process.on('SIGINT', () => { log('scheduler: SIGINT'); stop = true; });
  process.on('SIGTERM', () => { log('scheduler: SIGTERM'); stop = true; });

  // Primer tick inmediato; los siguientes con delay.
  while (!stop) {
    try { await runOnce(); }
    catch (e) { log(`scheduler tick error: ${e && e.message}`); }
    if (stop) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  log('scheduler: salida limpia');
}

if (require.main === module) {
  const once = process.argv.includes('--once');
  if (once) {
    runOnce().then((r) => {
      log(`--once result: ${JSON.stringify({ ok: r.ok, category: r.category || null })}`);
      process.exit(r.ok ? 0 : 1);
    }).catch((e) => {
      log(`--once error: ${e && e.message}`);
      process.exit(2);
    });
  } else {
    mainLoop().catch((e) => {
      log(`mainLoop error: ${e && e.message}`);
      process.exit(2);
    });
  }
}

module.exports = {
  runOnce,
  isEnabled,
  getIntervalMs,
  categorizeCaptureExit,
  enqueueTelegram,
  // Constantes para tests.
  DEFAULT_INTERVAL_MIN,
  MIN_INTERVAL_MIN,
  MAX_INTERVAL_MIN,
};
