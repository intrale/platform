'use strict';

// #6564 CA-3 — Evidencia de recepción REAL en Telegram de la alerta
// `plan_tier_unknown` (canal *Multi-Provider Health*).
//
// Decisión del operador (17/9, opción A): la prueba de recepción es la
// confirmación de entrega de la API de Telegram (`ok:true` + `message_id`),
// el mismo bus de recibos (#4082) con el que se reconcilian los salientes del
// Commander. No hace falta cliente Telegram autenticado ni captura del celular.
//
// Qué hace:
//   1. Reproduce el disparo del 2.º tick consecutivo de `plan_tier_unknown`
//      con `emitAlerts()` real (1.º tick → 0 envíos, 2.º tick → 1 envío) usando
//      un dedup temporal para no tocar el estado de producción.
//   2. Encola la alerta por el canal REAL (`servicios/telegram/pendiente/` del
//      pipeline de producción) con `defaultTelegramSender` y un `_correlationId`
//      conocido. `svc-telegram` la entrega y escribe el recibo `enviado` con
//      el `message_id` en `servicios/telegram/recibos/<cid>.json`; el Commander
//      lo reconcilia y lo archiva en `recibos/archivado/`.
//   3. Espera el recibo (en `recibos/` o en `recibos/archivado/`), valida que
//      sea `enviado` con `messageIds` numéricos y persiste la evidencia en
//      `.pipeline/evidence/6564/telegram-entrega.json`.
//
// Uso:
//   node .pipeline/tools/evidence-telegram-6564.js             # dry-run (cola temporal, sin envío)
//   node .pipeline/tools/evidence-telegram-6564.js --real      # envío real + espera del recibo
//     [--pipeline-dir <dir .pipeline de producción>] [--timeout-s 240]
//
// Sin `--real` NUNCA escribe en la cola de producción.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const cron = require('../lib/multi-provider/health-cron');
const telegramReceipt = require('../lib/telegram-receipt');

const OUT_DIR = path.resolve(__dirname, '../evidence/6564');
const EVIDENCE_FILE = path.join(OUT_DIR, 'telegram-entrega.json');

function parseArgs(argv) {
    const args = { real: false, timeoutS: 240, pipelineDir: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--real') args.real = true;
        else if (a === '--timeout-s') args.timeoutS = Number(argv[++i]);
        else if (a === '--pipeline-dir') args.pipelineDir = argv[++i];
    }
    if (!Number.isFinite(args.timeoutS) || args.timeoutS <= 0) args.timeoutS = 240;
    return args;
}

function defaultProductionPipelineDir() {
    const root = process.env.PIPELINE_REPO_ROOT || process.env.PIPELINE_ROOT;
    if (root) return path.join(root, '.pipeline');
    return 'C:/Workspaces/Intrale/platform/.pipeline';
}

function findReceipt(pipelineDir, cid) {
    const name = `${cid}.json`;
    const candidates = [
        path.join(telegramReceipt.receiptsDir(pipelineDir), name),
        path.join(telegramReceipt.archivedReceiptsDir(pipelineDir), name),
    ];
    for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        const receipt = telegramReceipt.parseReceipt(fs.readFileSync(file, 'utf8'));
        if (receipt) return { receipt, file };
    }
    return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const args = parseArgs(process.argv.slice(2));
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-telegram-6564-'));
    const pipelineDir = args.real ? (args.pipelineDir || defaultProductionPipelineDir()) : tmp;
    const queueDir = path.join(pipelineDir, 'servicios', 'telegram', 'pendiente');
    if (args.real && !fs.existsSync(queueDir)) {
        throw new Error(`cola real inexistente: ${queueDir} (revisar PIPELINE_REPO_ROOT)`);
    }

    const cid = telegramReceipt.generateCorrelationId('ev6564');
    const now = Date.now();
    const dedupFile = path.join(tmp, 'dedup.json');
    const row = {
        provider: 'antigravity', state: 'green', reason_code: 'cli_catalog_ok',
        last_checked_at: new Date(now).toISOString(), auth_mode: 'oauth', cli_probe: { model_count: 14 },
        plan_check: { reason_code: 'plan_tier_unknown', checked_at: new Date(now).toISOString(), consecutive_count: 1 },
    };
    const sent = [];
    const telegramSender = payload => {
        const ok = cron.defaultTelegramSender(payload, { pipelineDir, correlationId: cid });
        sent.push({ ok, text: cron.formatAlertText(payload) });
        return ok;
    };
    // Tick 1: sólo dashboard. Tick 2: alerta real.
    cron.emitAlerts({ snapshot: { providers: [row] }, dedupFile, now, telegramSender });
    assert.equal(sent.length, 0, 'el 1.º tick no debe alertar');
    row.plan_check.consecutive_count = 2;
    cron.emitAlerts({ snapshot: { providers: [row] }, dedupFile, now: now + 300000, telegramSender });
    assert.equal(sent.length, 1, 'el 2.º tick debe alertar exactamente una vez');
    assert.equal(sent[0].ok, true, 'el sender debe encolar');
    const enqueuedAt = new Date().toISOString();
    const dropfiles = fs.readdirSync(queueDir).filter(f => {
        if (!f.endsWith('mp-health.json')) return false;
        try { return JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8'))._correlationId === cid; }
        catch { return false; }
    });
    console.log(`[6564] alerta encolada cid=${cid} dropfile=${dropfiles[0] || '(ya drenado)'} modo=${args.real ? 'REAL' : 'dry-run'}`);

    const evidence = {
        issue: 6564, criterio: 'CA-3', modo: args.real ? 'real' : 'dry-run',
        canal: 'servicios/telegram/pendiente -> svc-telegram -> API sendMessage -> servicios/telegram/recibos',
        correlationId: cid, dropfile: dropfiles[0] || null, enqueued_at: enqueuedAt,
        ticks: { tick1_envios: 0, tick2_envios: 1 },
        texto_alerta: sent[0].text,
        recibo: null,
    };
    if (!args.real) {
        console.log('[6564] dry-run: no se esperó recibo ni se tocó la cola real');
        console.log(JSON.stringify(evidence, null, 2));
        fs.rmSync(tmp, { recursive: true, force: true });
        return;
    }

    const deadline = Date.now() + args.timeoutS * 1000;
    let found = null;
    while (Date.now() < deadline) {
        found = findReceipt(pipelineDir, cid);
        if (found) break;
        await sleep(2000);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!found) {
        evidence.recibo = { status: 'sin_recibo', esperado_s: args.timeoutS };
        fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n');
        throw new Error(`sin recibo para ${cid} tras ${args.timeoutS}s (svc-telegram caído o cola detenida)`);
    }
    const { receipt, file } = found;
    evidence.recibo = {
        status: receipt.status, messageIds: receipt.messageIds, at: receipt.at,
        archivo: path.relative(pipelineDir, file).replace(/\\/g, '/'),
    };
    fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n');
    if (receipt.status !== telegramReceipt.STATUS_ENVIADO) {
        throw new Error(`recibo ${receipt.status} para ${cid}: la API no confirmó la entrega`);
    }
    console.log(`[6564] entrega confirmada: message_id=${receipt.messageIds.join(',')} at=${receipt.at}`);
    console.log(`[6564] evidencia: ${EVIDENCE_FILE}`);
}

main().catch(err => { console.error(`[6564] ${err.message}`); process.exitCode = 1; });
