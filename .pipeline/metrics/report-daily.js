#!/usr/bin/env node
// V3 Metrics Daily Report — genera PDF con top consumos del día y lo envía por Telegram.
// Contrato definido en issue #2477.
//
// Uso:
//   node .pipeline/metrics/report-daily.js                 → ventana 24h, envía a Telegram
//   node .pipeline/metrics/report-daily.js --dry           → genera HTML+PDF sin enviar
//   node .pipeline/metrics/report-daily.js --window 7d     → ventana custom
//
// Dependencias: reutiliza scripts/report-to-pdf-telegram.js (pipeline unificado HTML→PDF→Telegram).

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSnapshot } = require('./aggregator');
const { REPO_ROOT } = require('../lib/traceability');

const DOCS_QA_DIR = path.join(REPO_ROOT, 'docs', 'qa');
const REPORT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'report-to-pdf-telegram.js');

function parseArgs(argv) {
    const args = { window: '24h', prevWindow: '24h', dry: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry' || a === '--dry-run') args.dry = true;
        else if (a === '--window' && argv[i + 1]) args.window = argv[++i];
        else if (a === '--help' || a === '-h') {
            process.stdout.write('Uso: report-daily.js [--window 24h|7d|all] [--dry]\n');
            process.exit(0);
        }
    }
    return args;
}

function fmtUsd(n) {
    const v = Number(n || 0);
    return '$' + v.toFixed(4);
}
function fmtNum(n) {
    const v = Number(n || 0);
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
}
function fmtDur(ms) {
    const s = Math.round((ms || 0) / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return m + 'm ' + rem + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function trendArrow(current, previous) {
    if (!previous || previous === 0) return '—';
    const delta = (current - previous) / previous * 100;
    if (Math.abs(delta) < 1) return '→ 0%';
    const sign = delta > 0 ? '▲' : '▼';
    return `${sign} ${Math.abs(delta).toFixed(0)}%`;
}

function renderHtml({ snapshot, prev, window, generatedAt }) {
    const top5Agents = (snapshot.agents || []).slice(0, 5);
    const top5Issues = (snapshot.issues || []).slice(0, 5);
    const ttsByProvider = (snapshot.tts && snapshot.tts.by_provider) || [];

    const t = snapshot.totals || {};
    const pt = (prev && prev.totals) || {};

    const rowsAgents = top5Agents.map(a => `
        <tr>
            <td class="skill">${esc(a.skill)}</td>
            <td class="num">${fmtNum(a.sessions)}</td>
            <td class="num">${fmtNum(a.tokens_in + a.tokens_out)}</td>
            <td class="num">${fmtNum(a.cache_read + a.cache_write)}</td>
            <td class="num">${fmtDur(a.avg_duration_ms)}</td>
            <td class="usd">${fmtUsd(a.cost_usd)}</td>
        </tr>`).join('');

    const rowsIssues = top5Issues.map(i => `
        <tr>
            <td class="issue">#${esc(i.issue)}</td>
            <td class="num">${fmtNum(i.sessions)}</td>
            <td class="num">${fmtNum(i.tokens_in + i.tokens_out)}</td>
            <td class="num">${fmtDur(i.duration_ms)}</td>
            <td class="usd">${fmtUsd(i.cost_usd)}</td>
        </tr>`).join('');

    const rowsTts = ttsByProvider.map(p => `
        <tr>
            <td class="skill">${esc(p.provider)}</td>
            <td class="num">${fmtNum(p.tts_count)}</td>
            <td class="num">${fmtNum(p.tts_chars)}</td>
            <td class="num">${(p.tts_audio_seconds / 60).toFixed(1)} min</td>
            <td class="usd">${fmtUsd(p.tts_cost_usd)}</td>
        </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Reporte diario V3 — Consumo Pipeline</title>
<style>
    body { font-family: -apple-system, 'Segoe UI', sans-serif; color: #1a1a2e; padding: 24px; max-width: 900px; margin: 0 auto; }
    h1 { color: #16213e; border-bottom: 3px solid #0f3460; padding-bottom: 8px; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; }
    h2 { color: #0f3460; margin-top: 28px; border-left: 4px solid #0f3460; padding-left: 10px; }
    .totals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
    .kpi { background: #f4f6fb; padding: 12px; border-radius: 6px; }
    .kpi .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    .kpi .value { font-size: 20px; font-weight: 700; color: #0f3460; margin-top: 4px; }
    .kpi .trend { font-size: 12px; margin-top: 4px; color: #888; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
    th { background: #0f3460; color: white; text-align: left; padding: 8px 10px; }
    td { padding: 8px 10px; border-bottom: 1px solid #eee; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.usd { text-align: right; font-weight: 600; color: #0f3460; font-variant-numeric: tabular-nums; }
    td.skill, td.issue { font-weight: 600; }
    tr:nth-child(even) { background: #fafbfd; }
    .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 11px; color: #888; }
</style>
</head>
<body>
    <h1>Reporte diario V3 — Consumo del pipeline</h1>
    <div class="subtitle">Ventana: <b>${esc(window)}</b> · Generado: ${esc(generatedAt)}</div>

    <div class="totals">
        <div class="kpi"><div class="label">Sesiones</div><div class="value">${fmtNum(t.sessions)}</div><div class="trend">vs previo: ${trendArrow(t.sessions, pt.sessions)}</div></div>
        <div class="kpi"><div class="label">Tokens in+out</div><div class="value">${fmtNum((t.tokens_in || 0) + (t.tokens_out || 0))}</div><div class="trend">vs previo: ${trendArrow((t.tokens_in||0)+(t.tokens_out||0), (pt.tokens_in||0)+(pt.tokens_out||0))}</div></div>
        <div class="kpi"><div class="label">Costo estimado</div><div class="value">${fmtUsd(t.cost_usd)}</div><div class="trend">vs previo: ${trendArrow(t.cost_usd, pt.cost_usd)}</div></div>
        <div class="kpi"><div class="label">TTS (costo)</div><div class="value">${fmtUsd(t.tts_cost_usd)}</div><div class="trend">${fmtNum(t.tts_chars)} chars · ${((t.tts_audio_seconds||0)/60).toFixed(1)}min</div></div>
    </div>

    <h2>Top 5 agentes por costo</h2>
    <table>
        <thead><tr><th>Skill</th><th class="num">Sesiones</th><th class="num">Tokens</th><th class="num">Cache</th><th class="num">Dur. prom</th><th class="num">Costo</th></tr></thead>
        <tbody>${rowsAgents || '<tr><td colspan="6" style="text-align:center; color:#888;">Sin datos en la ventana</td></tr>'}</tbody>
    </table>

    <h2>Top 5 issues más caros</h2>
    <table>
        <thead><tr><th>Issue</th><th class="num">Sesiones</th><th class="num">Tokens</th><th class="num">Duración total</th><th class="num">Costo</th></tr></thead>
        <tbody>${rowsIssues || '<tr><td colspan="5" style="text-align:center; color:#888;">Sin datos en la ventana</td></tr>'}</tbody>
    </table>

    <h2>TTS por provider</h2>
    <table>
        <thead><tr><th>Provider</th><th class="num">Invocaciones</th><th class="num">Chars</th><th class="num">Audio</th><th class="num">Costo</th></tr></thead>
        <tbody>${rowsTts || '<tr><td colspan="5" style="text-align:center; color:#888;">Sin TTS registrado</td></tr>'}</tbody>
    </table>

    <div class="footer">
        Generado por <code>.pipeline/metrics/report-daily.js</code> · Schema V3 definido en issue #2477.<br>
        Costos: estimaciones basadas en pricing público por modelo (ver <code>lib/traceability.js</code> → MODEL_PRICING).
    </div>
</body>
</html>`;
}

function sendToTelegram(htmlPath, caption) {
    if (!fs.existsSync(REPORT_SCRIPT)) {
        process.stderr.write(`[report-daily] script de envío no encontrado: ${REPORT_SCRIPT}\n`);
        return false;
    }
    const html = fs.readFileSync(htmlPath, 'utf8');
    const r = spawnSync('node', [REPORT_SCRIPT, '--stdin', caption], {
        input: html,
        encoding: 'utf8',
        cwd: REPO_ROOT,
        windowsHide: true,
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return r.status === 0;
}

async function main() {
    const args = parseArgs(process.argv);

    const snapshot = await buildSnapshot({ window: args.window });
    const prev = null; // TODO futuro: calcular ventana previa equivalente. Hoy trendArrow cae a '—' sin pt.

    const generatedAt = new Date().toISOString();
    const html = renderHtml({ snapshot, prev, window: args.window, generatedAt });

    const dateTag = generatedAt.slice(0, 10);
    try { fs.mkdirSync(DOCS_QA_DIR, { recursive: true }); } catch (_) {}
    const htmlPath = path.join(DOCS_QA_DIR, `reporte-consumo-v3-${dateTag}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');
    process.stdout.write(`[report-daily] HTML: ${htmlPath}\n`);
    process.stdout.write(`[report-daily] Totales ${args.window}: sesiones=${snapshot.totals.sessions || 0} costo=${fmtUsd(snapshot.totals.cost_usd)} tts=${fmtUsd(snapshot.totals.tts_cost_usd)}\n`);

    if (args.dry) {
        process.stdout.write('[report-daily] --dry: no se envía a Telegram\n');
        return 0;
    }

    const ok = sendToTelegram(htmlPath, `📊 Reporte diario V3 — Consumo ${args.window} (${dateTag})`);
    return ok ? 0 : 1;
}

if (require.main === module) {
    main().then(code => process.exit(code || 0)).catch(e => { process.stderr.write(e.stack + '\n'); process.exit(1); });
}

module.exports = { renderHtml };
