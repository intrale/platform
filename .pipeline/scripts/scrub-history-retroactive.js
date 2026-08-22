#!/usr/bin/env node
// =============================================================================
// scrub-history-retroactive.js — Issue #3317
//
// Script one-off para sanear retroactivamente `.pipeline/commander-history.jsonl`.
// Cierra el flanco que quedó tras el incidente Groq del 2026-05-17, donde
// quedaron API keys de proveedores en el historial visible del dashboard.
//
// El issue #3310 implementó scrubbing write-time para mensajes nuevos. Este
// script cierra la ventana retroactiva: pasa el archivo histórico por el mismo
// `sanitize()` y reescribe atómicamente, sin pisar appends concurrentes del
// commander vivo.
//
// Estrategia: snapshot-by-offset.
//   1. Captura `offset = fs.statSync(history).size` al arrancar.
//   2. Sanea los bytes [0, offset) (histórico que necesita cierre retroactivo).
//   3. Deja intactos los bytes [offset, EOF) (appends post-arranque, YA
//      scrubbeados write-time por #3310). Se concatenan al final del archivo.
//   4. Resultado: zero-downtime, sin tocar pulpo.js, sin perder appends.
//
// Uso:
//   node .pipeline/scripts/scrub-history-retroactive.js               # apply
//   node .pipeline/scripts/scrub-history-retroactive.js --dry-run     # solo reporta
//   node .pipeline/scripts/scrub-history-retroactive.js --json        # output JSON
//   node .pipeline/scripts/scrub-history-retroactive.js --no-telegram # sin alerta
//
// CAs cubiertos:
//   CA-1..CA-15 (PO), SEC-1..SEC-8 (security), CAT-1..CAT-5 (guru), UX-1..UX-6.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { sanitize } = require('../sanitizer');

// -----------------------------------------------------------------------------
// Constantes y defaults
// -----------------------------------------------------------------------------

const PIPELINE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_HISTORY_FILE = process.env.SCRUB_HISTORY_FILE
    || path.join(PIPELINE_ROOT, 'commander-history.jsonl');
const DEFAULT_BACKUP_DIR = process.env.SCRUB_HISTORY_BACKUP_DIR
    || path.join(os.homedir(), '.claude', 'secrets', 'backups');
const DEFAULT_LOG_DIR = process.env.SCRUB_HISTORY_LOG_DIR
    || path.join(PIPELINE_ROOT, 'logs');

// CA-7 / SEC-6: residual patterns que NO deben aparecer en el output saneado.
// Si alguno matchea post-scrub → aborto + restore desde .bak + alerta.
// Mantener alineado con los patrones core de sanitizer.js (defense-in-depth,
// no se importan los patrones para evitar acoplamiento + falsos negativos si
// el sanitizer queda compilado con flags distintos).
const RESIDUAL_PATTERNS = [
    { name: 'GROQ_API_KEY', re: /gsk_[A-Za-z0-9]{40,}/ },
    { name: 'ANTHROPIC_KEY', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
    { name: 'OPENAI_PROJECT_KEY', re: /sk-proj-[A-Za-z0-9_-]{40,}/ },
    { name: 'OPENAI_KEY', re: /(?<![A-Za-z0-9_-])sk-(?!ant-|proj-)[A-Za-z0-9]{48,}/ },
    { name: 'CEREBRAS_API_KEY', re: /(?<![A-Za-z0-9_-])csk-[A-Za-z0-9]{40,}/ },
    { name: 'NVIDIA_NIM_API_KEY', re: /nvapi-[A-Za-z0-9_-]{40,}/ },
    { name: 'AWS_ACCESS_KEY', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
    { name: 'GITHUB_TOKEN', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{80,})\b/ },
    { name: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { name: 'GOOGLE_OAUTH_TOKEN', re: /ya29\.[A-Za-z0-9_-]{20,}/ },
    { name: 'SLACK_WEBHOOK', re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\// },
    { name: 'PRIVATE_KEY', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |)PRIVATE KEY-----/ },
];

// CA-9: retry/backoff para `fs.renameSync` en Windows (EBUSY si el dashboard
// tiene un handle abierto sobre el archivo).
const RENAME_RETRY_DELAYS_MS = [100, 500, 2000];

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function isoTs() {
    return new Date().toISOString().replace(/:/g, '').replace(/\..+/, '').replace('T', '-');
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function md5(buf) {
    return crypto.createHash('md5').update(buf).digest('hex');
}

// -----------------------------------------------------------------------------
// CA-2 / G-T1: parseo JSON-aware con fallback raw para líneas inválidas.
// -----------------------------------------------------------------------------

function sanitizeJsonValue(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return sanitize(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(sanitizeJsonValue);
    if (typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) {
            out[k] = sanitizeJsonValue(value[k]);
        }
        return out;
    }
    return value;
}

// Cuenta de placeholders [REDACTED:TYPE] en un texto. Usado para detectar
// qué patrones aplicaron en cada línea (SEC-4: solo nombre + cantidad,
// nunca el valor literal scrubbed).
function countPlaceholders(text) {
    const counts = {};
    const re = /\[REDACTED:([A-Z_]+)\]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        counts[m[1]] = (counts[m[1]] || 0) + 1;
    }
    return counts;
}

function diffPlaceholders(before, after) {
    const b = countPlaceholders(before);
    const a = countPlaceholders(after);
    const out = {};
    for (const k of Object.keys(a)) {
        const delta = (a[k] || 0) - (b[k] || 0);
        if (delta > 0) out[k] = delta;
    }
    return out;
}

/**
 * Procesa una línea cruda (sin newline) y devuelve {sanitizedLine, modified, patterns, fallback}.
 *
 *  - Si la línea parsea como JSON: recursivamente sanea cada string field y
 *    re-serializa con JSON.stringify (mantiene archivo como JSONL válido).
 *  - Si NO parsea: aplica sanitize() raw sobre la línea (CAT-5 fallback).
 *    Se loggea para el conteo de "Líneas inválidas".
 */
function processLine(rawLine) {
    if (rawLine === '') {
        return { sanitizedLine: '', modified: false, patterns: {}, kind: 'empty' };
    }

    let parsed;
    try {
        parsed = JSON.parse(rawLine);
    } catch (_e) {
        // CA-2 / CAT-5: línea no-JSON → fallback raw.
        const sanitizedRaw = sanitize(rawLine);
        return {
            sanitizedLine: sanitizedRaw,
            modified: sanitizedRaw !== rawLine,
            patterns: diffPlaceholders(rawLine, sanitizedRaw),
            kind: 'invalid_json',
        };
    }

    const sanitizedObj = sanitizeJsonValue(parsed);
    const before = JSON.stringify(parsed);
    const after = JSON.stringify(sanitizedObj);
    return {
        sanitizedLine: after,
        modified: before !== after,
        patterns: diffPlaceholders(before, after),
        kind: 'json',
    };
}

/**
 * Procesa el head buffer (texto histórico) línea por línea y devuelve el
 * resultado saneado + estadísticas agregadas.
 *
 * @param {string} headText - contenido como string UTF-8.
 * @returns {{ output: string, stats: object, lineDetails: Array }}
 */
function sanitizeJsonlBuffer(headText) {
    // Separamos por `\n` preservando si la última línea no termina en newline.
    const endsWithNewline = headText.endsWith('\n');
    const lines = headText.split('\n');
    // Si termina en `\n`, el último elemento de split es '' (vacío) — lo dejamos
    // para reconstruir el trailing newline al final.
    const trailing = endsWithNewline ? lines.pop() : '';

    const stats = {
        totalLines: lines.length,
        modifiedLines: 0,
        invalidJsonLines: 0,
        emptyLines: 0,
        patternsTotal: {}, // { GROQ_API_KEY: 4, JWT: 2, ... }
        patternsLineCount: {}, // cantidad de líneas distintas donde aparece cada patrón
    };
    const lineDetails = [];

    const outLines = lines.map((raw, idx) => {
        const result = processLine(raw);

        if (result.kind === 'empty') {
            stats.emptyLines++;
        }
        if (result.kind === 'invalid_json' && raw !== '') {
            stats.invalidJsonLines++;
        }
        if (result.modified) {
            stats.modifiedLines++;
            // SEC-4 / CA-6: detalle SIN literales, solo nombre + count.
            const detail = {
                line: idx + 1,
                kind: result.kind,
                patterns: Object.keys(result.patterns),
                counts: result.patterns,
            };
            lineDetails.push(detail);
            for (const [name, count] of Object.entries(result.patterns)) {
                stats.patternsTotal[name] = (stats.patternsTotal[name] || 0) + count;
                stats.patternsLineCount[name] = (stats.patternsLineCount[name] || 0) + 1;
            }
        }

        return result.sanitizedLine;
    });

    let output = outLines.join('\n');
    if (endsWithNewline) output += '\n' + trailing;

    return { output, stats, lineDetails };
}

// -----------------------------------------------------------------------------
// CA-5 / SEC-3: backup seguro fuera de .pipeline/, perms 0600.
// -----------------------------------------------------------------------------

function ensureBackupDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    try {
        fs.chmodSync(dir, 0o700);
    } catch (_e) {
        // Cross-platform: chmod puede ser no-op en Windows. No abortamos por
        // el directorio (verificamos perms del archivo .bak individual).
    }
}

function createBackup(historyPath, backupDir) {
    ensureBackupDir(backupDir);
    const backupName = `scrub-history-${isoTs()}.bak`;
    const backupPath = path.join(backupDir, backupName);
    fs.copyFileSync(historyPath, backupPath);
    fs.chmodSync(backupPath, 0o600);

    const mode = fs.statSync(backupPath).mode & 0o777;
    const isWindows = os.platform() === 'win32';
    if (mode !== 0o600) {
        if (isWindows) {
            // CA-5 + UX-3: Windows nativo no soporta POSIX perms vía chmod.
            // El directorio ~/.claude/secrets/backups/ ya es restricted-user.
            // Continuamos con WARN visible (el operador queda enterado).
            return {
                backupPath,
                mode,
                permsEnforced: false,
                warning: `chmod 0600 no efectivo en Windows (mode=0o${mode.toString(8)}). `
                    + `Backup queda en ${path.dirname(backupPath)} (dir restringido por ACL).`,
            };
        }
        throw new Error(
            `No pude setear permisos 0600 al backup (mode=0o${mode.toString(8)}). `
            + `Abortando antes de tocar el original. Workaround: validar ACL manualmente o correr en WSL.`
        );
    }
    return { backupPath, mode, permsEnforced: true, warning: null };
}

// -----------------------------------------------------------------------------
// CA-3 / SEC-1 / CA-9 / G-T5: escritura atómica con retry/backoff en Windows.
// -----------------------------------------------------------------------------

async function atomicWrite(targetPath, content, opts = {}) {
    const tmpPath = `${targetPath}.tmp`;
    const sleepFn = opts.sleepFn || sleep;
    const delays = opts.retryDelays || RENAME_RETRY_DELAYS_MS;

    // 1) Escribir a tmp + fsync.
    const fd = fs.openSync(tmpPath, 'w');
    try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }

    // 2) Rename atómico con retry.
    let lastErr = null;
    for (let attempt = 0; attempt < delays.length; attempt++) {
        try {
            fs.renameSync(tmpPath, targetPath);
            return { ok: true, attempts: attempt + 1, retried: attempt > 0 };
        } catch (e) {
            lastErr = e;
            const retryable = ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
            if (!retryable || attempt === delays.length - 1) break;
            await sleepFn(delays[attempt]);
        }
    }

    // 3) Si todos los reintentos fallan, limpiar tmp y propagar.
    try { fs.unlinkSync(tmpPath); } catch (_e) {}
    return { ok: false, attempts: delays.length, error: lastErr };
}

// -----------------------------------------------------------------------------
// CA-7 / SEC-6 / G-T4: verificación post-scrub.
// -----------------------------------------------------------------------------

function verifyPostScrub(text) {
    // (1) Re-grep contra patrones core sobre el texto crudo. Si algún match
    // queda → fallar (alguna key se escapó al sanitizer).
    const residualHits = [];
    for (const { name, re } of RESIDUAL_PATTERNS) {
        if (re.test(text)) {
            residualHits.push(name);
        }
    }

    // (2) Idempotencia (G-T6 / SEC-5): re-procesar el output con el mismo
    // path JSON-aware (sanitizeJsonlBuffer) y comparar md5. NO podemos usar
    // `sanitize(text)` raw porque algunos patrones del sanitizer (ej.
    // HEADER_AUTHORIZATION) son greedy hasta newline y corromperían el JSON
    // si se aplican sobre texto JSONL como string plano. La aplicación
    // correcta es campo-por-campo, que es justo lo que hace el primer pass;
    // re-aplicar ese mismo procesamiento debe ser no-op (output === input).
    const reProcessed = sanitizeJsonlBuffer(text);
    const md5Pre = md5(Buffer.from(text, 'utf8'));
    const md5Post = md5(Buffer.from(reProcessed.output, 'utf8'));
    const idempotent = md5Pre === md5Post;

    return {
        ok: residualHits.length === 0 && idempotent,
        residualHits,
        idempotent,
        md5Pre,
        md5Post,
    };
}

// -----------------------------------------------------------------------------
// CA-11 / UX-1 / UX-6: formato de output operativo.
// -----------------------------------------------------------------------------

function formatHumanReport(report) {
    const L = [];
    const tag = (s) => `[scrub-history] ${s}`;
    L.push(tag(`Inicio  ${report.startedAt}`));
    L.push(tag(`Archivo ${report.historyPath} (${report.totalLines} líneas, ${report.kb} KB)`));
    if (report.backupPath) {
        const permsNote = report.permsEnforced ? '0600' : 'best-effort';
        L.push(tag(`Backup  ${report.backupPathRedacted} (${permsNote})`));
    } else if (report.dryRun) {
        L.push(tag(`Backup  (dry-run: no se creó)`));
    }
    L.push(tag(`Estrategia snapshot-by-offset (offset=${report.snapshotOffset}B, tail intacto=${report.tailBytes}B)`));
    L.push('');
    L.push(tag(`Resultado:`));
    L.push(`  Líneas procesadas:        ${report.totalLines}`);
    L.push(`  Líneas modificadas:       ${report.modifiedLines}`);
    L.push(`  Líneas intactas:          ${report.intactLines}`);
    L.push(`  Líneas inválidas (skip):  ${report.invalidJsonLines}`);
    if (report.modifiedLines > 0) {
        L.push('');
        L.push('  Patrones detectados:');
        for (const [name, count] of Object.entries(report.patternsTotal).sort()) {
            const lines = report.patternsLineCount[name] || 0;
            L.push(`    ${name.padEnd(20)} ${String(count).padStart(3)} matches en ${lines} líneas`);
        }
        L.push('    (sin literales — solo conteo, ver SEC-4)');
    }
    L.push('');
    if (report.verification) {
        const v = report.verification;
        if (v.ok) {
            L.push(tag(`Verificación post-scrub: 0 hits residuales en re-grep`));
            L.push(tag(`md5 idempotencia: idéntico`));
        } else {
            L.push(tag(`[ABORT] Verificación post-scrub falló.`));
            if (v.residualHits.length > 0) {
                L.push(tag(`         Hits residuales: ${v.residualHits.join(', ')}`));
            }
            if (!v.idempotent) {
                L.push(tag(`         Idempotencia rota (md5 pre=${v.md5Pre}, post=${v.md5Post})`));
            }
        }
    }
    L.push('');
    if (report.outcome === 'ok_noop') {
        L.push(tag(`[OK]  Idempotencia confirmada. No-op (${report.modifiedLines} líneas modificadas).`));
    } else if (report.outcome === 'ok_modified') {
        L.push(tag(`[OK]  Cierre del flanco confirmado. Backup borrado.`));
    } else if (report.outcome === 'dry_run') {
        L.push(tag(`[OK]  Dry-run completo. ${report.modifiedLines} líneas hubieran sido modificadas. Sin cambios al archivo.`));
    } else if (report.outcome === 'no_file') {
        L.push(tag(`[OK]  ${report.historyPath} no existe. Nada que sanear. Salgo limpio.`));
    } else if (report.outcome === 'abort_verify') {
        L.push(tag(`[ABORT] Restauré desde backup. Revisá ${report.logPathRedacted} para detalle.`));
    } else if (report.outcome === 'abort_rename') {
        L.push(tag(`[ERROR] Rename atómico falló tras ${RENAME_RETRY_DELAYS_MS.length} reintentos (EBUSY). `
            + `Backup preservado para rollback manual. Reintentar tras restart-services.`));
    } else if (report.outcome === 'abort_perms') {
        L.push(tag(`[ERROR] ${report.errorMessage || 'No pude setear permisos 0600 al backup.'}`));
    }
    if (report.warnings && report.warnings.length > 0) {
        for (const w of report.warnings) L.push(tag(`[WARN] ${w}`));
    }
    return L.join('\n');
}

// -----------------------------------------------------------------------------
// CA-12 / UX-2: mensaje Telegram natural.
// -----------------------------------------------------------------------------

function buildTelegramMessage(report) {
    if (report.outcome === 'no_file') {
        return 'Corrí scrub retroactivo sobre commander-history.jsonl pero el archivo no existe. Nada que sanear, salgo limpio.';
    }
    if (report.outcome === 'ok_noop') {
        return `Nada que sanear, commander-history.jsonl ya está limpio (${report.totalLines} líneas, 0 cambios). Idempotente.`;
    }
    if (report.outcome === 'dry_run') {
        const patrones = Object.keys(report.patternsTotal).join(', ') || 'ninguno';
        return `Dry-run del scrub retroactivo: ${report.modifiedLines} de ${report.totalLines} líneas hubieran cambiado. Patrones que se redactarían: ${patrones}. Archivo intacto.`;
    }
    if (report.outcome === 'ok_modified') {
        const partes = Object.entries(report.patternsTotal)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([n, c]) => `${n.replace(/_/g, ' ').toLowerCase()} (${c})`);
        const lista = partes.length > 0 ? partes.join(', ') : 'patrones varios';
        return `Listo, sanee commander-history.jsonl. Toqué ${report.modifiedLines} de las ${report.totalLines} líneas históricas — había restos de ${lista}. El backup quedó borrado tras confirmar zero hits residuales. Cierra el flanco del incidente del 17/5.`;
    }
    if (report.outcome === 'abort_verify') {
        const hits = (report.verification && report.verification.residualHits) || [];
        const hitsTxt = hits.length > 0 ? hits.join(', ') : 'patrón no identificado';
        return `Aborté el scrub retroactivo: el re-grep post-sanitización encontró hits residuales (${hitsTxt}). Restauré desde backup. Revisá ~/.claude/secrets/backups/ y .pipeline/logs/scrub-history-*.log para detalle y avisame.`;
    }
    if (report.outcome === 'abort_rename') {
        return `Aborté el scrub retroactivo: el rename atómico falló tras 3 reintentos (EBUSY, probablemente el dashboard tiene un handle abierto). Backup preservado para rollback manual en ~/.claude/secrets/backups/. Reintentar tras restart-services.`;
    }
    if (report.outcome === 'abort_perms') {
        return `Aborté el scrub retroactivo antes de tocar el archivo original: no pude setear permisos 0600 al backup. ${report.errorMessage || ''} Detalle en .pipeline/logs/scrub-history-*.log.`;
    }
    return `Scrub retroactivo terminó en estado inesperado: ${report.outcome}.`;
}

async function maybeSendTelegram(message, opts) {
    if (opts && opts.skipTelegram) return { sent: false, reason: 'skipped_by_flag' };
    if (process.env.SCRUB_HISTORY_NO_TELEGRAM === '1') {
        return { sent: false, reason: 'skipped_by_env' };
    }
    try {
        // Lazy require: evita romper el script si no hay credenciales y
        // estamos en --dry-run o testing.
        const { loadTelegramSecrets } = require(path.join(PIPELINE_ROOT, 'lib', 'telegram-secrets'));
        const sec = loadTelegramSecrets({});
        const https = require('https');
        await new Promise((resolve, reject) => {
            const data = JSON.stringify({ chat_id: sec.chat_id, text: message });
            const req = https.request({
                hostname: 'api.telegram.org',
                path: `/bot${sec.bot_token}/sendMessage`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
            }, (res) => {
                res.on('data', () => {});
                res.on('end', resolve);
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
            req.write(data);
            req.end();
        });
        return { sent: true };
    } catch (e) {
        return { sent: false, reason: `error:${(e && e.message) || 'unknown'}` };
    }
}

// -----------------------------------------------------------------------------
// CA-6 / SEC-4: audit log archivable, SIN literales.
// -----------------------------------------------------------------------------

function writeAuditLog(logDir, lineDetails, report, humanReport) {
    try {
        fs.mkdirSync(logDir, { recursive: true });
    } catch (_e) {}
    const logName = `scrub-history-${isoTs()}.log`;
    const logPath = path.join(logDir, logName);
    const head = humanReport + '\n\n--- per-line detail (no literals) ---\n';
    const detailLines = lineDetails.map((d) => JSON.stringify(d)).join('\n');
    fs.writeFileSync(logPath, head + detailLines + '\n');
    return logPath;
}

// -----------------------------------------------------------------------------
// CA-1: argparse + main()
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const args = argv.slice(2);
    return {
        json: args.includes('--json'),
        dryRun: args.includes('--dry-run'),
        skipTelegram: args.includes('--no-telegram'),
        help: args.includes('--help') || args.includes('-h'),
    };
}

function printHelp() {
    console.log(`
scrub-history-retroactive.js — Sanea retroactivamente commander-history.jsonl (#3317).

Uso:
  node .pipeline/scripts/scrub-history-retroactive.js [opciones]

Opciones:
  --dry-run        Reporta qué se redactaría sin tocar el archivo.
  --json           Emite un único objeto JSON con el resultado (machine-readable).
  --no-telegram    No envía mensaje a Telegram (útil en test/local).
  --help, -h       Esta ayuda.

Variables de entorno:
  SCRUB_HISTORY_FILE         Path al archivo a sanear (default: .pipeline/commander-history.jsonl).
  SCRUB_HISTORY_BACKUP_DIR   Dir de backups (default: ~/.claude/secrets/backups/).
  SCRUB_HISTORY_LOG_DIR      Dir de logs (default: .pipeline/logs/).
  SCRUB_HISTORY_NO_TELEGRAM  Si "1", saltea envío Telegram.
`);
}

/**
 * Orchestrator principal. Exportado para tests (que setean env vars para
 * apuntar a archivos temporales).
 *
 * @param {object} [opts]
 * @param {string} [opts.historyPath]
 * @param {string} [opts.backupDir]
 * @param {string} [opts.logDir]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.skipTelegram]
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn] - para test de retry/backoff.
 * @param {number[]} [opts.retryDelays] - delays acotados en tests.
 * @returns {Promise<object>} report estructurado.
 */
async function runScrub(opts = {}) {
    const historyPath = opts.historyPath || DEFAULT_HISTORY_FILE;
    const backupDir = opts.backupDir || DEFAULT_BACKUP_DIR;
    const logDir = opts.logDir || DEFAULT_LOG_DIR;
    const dryRun = !!opts.dryRun;
    const skipTelegram = !!opts.skipTelegram;

    const startedAt = new Date().toISOString();
    const report = {
        issue: 3317,
        startedAt,
        historyPath,
        backupPath: null,
        backupPathRedacted: null,
        logPath: null,
        logPathRedacted: null,
        snapshotOffset: 0,
        tailBytes: 0,
        totalLines: 0,
        modifiedLines: 0,
        intactLines: 0,
        invalidJsonLines: 0,
        patternsTotal: {},
        patternsLineCount: {},
        kb: 0,
        dryRun,
        outcome: null,
        verification: null,
        permsEnforced: null,
        warnings: [],
        errorMessage: null,
    };

    // (1) Archivo no existe → no-op idempotente.
    if (!fs.existsSync(historyPath)) {
        report.outcome = 'no_file';
        return report;
    }

    // (2) CA-4: snapshot-by-offset al arrancar.
    const stat = fs.statSync(historyPath);
    const originalMode = stat.mode & 0o777;
    report.snapshotOffset = stat.size;
    report.kb = Math.round((stat.size / 1024) * 10) / 10;

    const allBytes = fs.readFileSync(historyPath);
    const headBytes = allBytes.subarray(0, report.snapshotOffset);
    const tailBytes = allBytes.subarray(report.snapshotOffset);
    report.tailBytes = tailBytes.length;

    // (3) CA-2: parsear cada línea como JSON y sanear recursivamente; fallback raw.
    const headText = headBytes.toString('utf8');
    const { output: sanitizedHead, stats, lineDetails } = sanitizeJsonlBuffer(headText);
    report.totalLines = stats.totalLines;
    report.modifiedLines = stats.modifiedLines;
    report.invalidJsonLines = stats.invalidJsonLines;
    report.intactLines = stats.totalLines - stats.modifiedLines - stats.emptyLines;
    if (report.intactLines < 0) report.intactLines = 0;
    report.patternsTotal = stats.patternsTotal;
    report.patternsLineCount = stats.patternsLineCount;

    // Tail: ya sanitizado por write-time (#3310). Lo concatenamos intacto.
    const finalBuffer = Buffer.concat([Buffer.from(sanitizedHead, 'utf8'), tailBytes]);

    // (4) Dry-run: no escribir.
    if (dryRun) {
        report.outcome = 'dry_run';
        const human = formatHumanReport(report);
        report.logPath = writeAuditLog(logDir, lineDetails, report, human);
        report.logPathRedacted = path.basename(report.logPath);
        const msg = buildTelegramMessage(report);
        const tg = await maybeSendTelegram(msg, { skipTelegram });
        report.telegram = tg;
        return report;
    }

    // (5) No-op si nada cambió: no creamos backup, salimos limpio. La presencia
    // de líneas inválidas (no-JSON) NO requiere rewrite porque ya pasaron por
    // sanitize() raw sin modificación visible — el archivo en disco es
    // idéntico byte-a-byte al pre-scrub.
    if (report.modifiedLines === 0) {
        report.outcome = 'ok_noop';
        const human = formatHumanReport(report);
        report.logPath = writeAuditLog(logDir, lineDetails, report, human);
        report.logPathRedacted = path.basename(report.logPath);
        const msg = buildTelegramMessage(report);
        const tg = await maybeSendTelegram(msg, { skipTelegram });
        report.telegram = tg;
        return report;
    }

    // (6) CA-5: crear backup ANTES de cualquier escritura.
    let backupInfo;
    try {
        backupInfo = createBackup(historyPath, backupDir);
    } catch (e) {
        report.outcome = 'abort_perms';
        report.errorMessage = e.message;
        const human = formatHumanReport(report);
        report.logPath = writeAuditLog(logDir, lineDetails, report, human);
        report.logPathRedacted = path.basename(report.logPath);
        const msg = buildTelegramMessage(report);
        const tg = await maybeSendTelegram(msg, { skipTelegram });
        report.telegram = tg;
        return report;
    }
    report.backupPath = backupInfo.backupPath;
    // SEC-7: el path del .bak NO va por stdout/Telegram en texto plano.
    // Lo dejamos en report.backupPath para uso interno (restore en case de abort),
    // y mostramos solo el nombre del archivo (sin el dir completo) en human-readable.
    report.backupPathRedacted = `~/.claude/secrets/backups/${path.basename(backupInfo.backupPath)}`;
    report.permsEnforced = backupInfo.permsEnforced;
    if (backupInfo.warning) report.warnings.push(backupInfo.warning);

    // (7) CA-3 + CA-9: escritura atómica + rename con retry/backoff.
    const writeResult = await atomicWrite(historyPath, finalBuffer, {
        sleepFn: opts.sleepFn,
        retryDelays: opts.retryDelays,
    });
    if (!writeResult.ok) {
        // CA-9: NO borrar backup (queda como rollback).
        report.outcome = 'abort_rename';
        report.errorMessage = `rename ${writeResult.error && writeResult.error.code}`;
        const human = formatHumanReport(report);
        report.logPath = writeAuditLog(logDir, lineDetails, report, human);
        report.logPathRedacted = path.basename(report.logPath);
        const msg = buildTelegramMessage(report);
        const tg = await maybeSendTelegram(msg, { skipTelegram });
        report.telegram = tg;
        return report;
    }
    if (writeResult.retried) {
        report.warnings.push(`rename atómico requirió ${writeResult.attempts} intentos (EBUSY)`);
    }

    // (8) CA-10 / SEC-8: preservar permisos del original.
    try {
        const newMode = fs.statSync(historyPath).mode & 0o777;
        if (newMode !== originalMode) {
            fs.chmodSync(historyPath, originalMode);
        }
    } catch (_e) {
        // Best-effort: en Windows puede fallar; loggeamos warning.
        report.warnings.push('No pude restaurar permisos POSIX del archivo (probable Windows).');
    }

    // (9) CA-7 / SEC-6: verificación post-scrub sobre el archivo recién escrito.
    const written = fs.readFileSync(historyPath, 'utf8');
    const verification = verifyPostScrub(written);
    report.verification = verification;

    if (!verification.ok) {
        // SEC-6: abortar + restaurar desde backup + alerta.
        try {
            fs.copyFileSync(report.backupPath, historyPath);
            fs.chmodSync(historyPath, originalMode);
        } catch (e) {
            report.warnings.push(`Restore desde backup falló: ${e.message}`);
        }
        report.outcome = 'abort_verify';
        const human = formatHumanReport(report);
        report.logPath = writeAuditLog(logDir, lineDetails, report, human);
        report.logPathRedacted = path.basename(report.logPath);
        const msg = buildTelegramMessage(report);
        const tg = await maybeSendTelegram(msg, { skipTelegram });
        report.telegram = tg;
        return report;
    }

    // (10) Éxito: borrar backup (SEC-3 paranoid cleanup).
    try {
        fs.unlinkSync(report.backupPath);
    } catch (e) {
        report.warnings.push(`No pude borrar backup post-éxito: ${e.message}`);
    }

    report.outcome = 'ok_modified';
    const human = formatHumanReport(report);
    report.logPath = writeAuditLog(logDir, lineDetails, report, human);
    report.logPathRedacted = path.basename(report.logPath);
    const msg = buildTelegramMessage(report);
    const tg = await maybeSendTelegram(msg, { skipTelegram });
    report.telegram = tg;
    return report;
}

// -----------------------------------------------------------------------------
// CLI entrypoint
// -----------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    const report = await runScrub({
        dryRun: args.dryRun,
        skipTelegram: args.skipTelegram,
    });

    if (args.json) {
        // Sanear el path del backup para no exponerlo en el JSON output.
        const safeReport = { ...report };
        if (safeReport.backupPath) {
            safeReport.backupPath = '<redacted: see backupPathRedacted>';
        }
        console.log(JSON.stringify(safeReport));
    } else {
        console.log(formatHumanReport(report));
    }

    // Exit codes:
    //   0 → OK (incluye no_file, ok_noop, ok_modified, dry_run).
    //   2 → abort por verificación post-scrub.
    //   3 → abort por rename atómico.
    //   4 → abort por permisos backup.
    const exitMap = {
        ok_modified: 0, ok_noop: 0, dry_run: 0, no_file: 0,
        abort_verify: 2, abort_rename: 3, abort_perms: 4,
    };
    process.exit(exitMap[report.outcome] != null ? exitMap[report.outcome] : 1);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`[scrub-history] [ERROR] uncaught: ${e && e.message}`);
        process.exit(10);
    });
}

module.exports = {
    runScrub,
    sanitizeJsonlBuffer,
    processLine,
    sanitizeJsonValue,
    diffPlaceholders,
    verifyPostScrub,
    atomicWrite,
    createBackup,
    buildTelegramMessage,
    formatHumanReport,
    RESIDUAL_PATTERNS,
    RENAME_RETRY_DELAYS_MS,
    parseArgs,
};
