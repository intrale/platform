// =============================================================================
// telegram-burst-grouper.test.js — Tests del agrupador de bursts (#3668).
//
// Cobertura de CA-2..CA-5 + S-1/S-5/S-10 + UX-1..UX-4.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const bg = require('../telegram-burst-grouper');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function mkTmpDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-grouper-'));
    return dir;
}

function writeQueueFile(dir, name, payload, mtimeMs) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    if (Number.isFinite(mtimeMs)) {
        const time = new Date(mtimeMs);
        fs.utimesSync(filePath, time, time);
    }
    return { name, path: filePath };
}

// =============================================================================
// CA-2 — Configuración de ventana
// =============================================================================
test('CA-2: telegram_burst_window_ms ausente → default 60000ms sin clamp', () => {
    const res = bg.loadBurstConfig({ configLoader: () => ({}) });
    assert.equal(res.windowMs, bg.BURST_WINDOW_DEFAULT_MS);
    assert.equal(res.clamped, false);
});

test('CA-2 / S-10: telegram_burst_window_ms debajo del mínimo → clamp a MIN', () => {
    const warnings = [];
    const res = bg.loadBurstConfig({
        configLoader: () => ({ telegram_burst_window_ms: 500 }),
        log: (_tag, msg) => warnings.push(msg),
    });
    assert.equal(res.windowMs, bg.BURST_WINDOW_MIN_MS);
    assert.equal(res.clamped, true);
    assert.ok(warnings.some(w => /debajo del mínimo/.test(w)), 'warning emitido');
});

test('CA-2 / S-10: telegram_burst_window_ms arriba del máximo → clamp a MAX', () => {
    const warnings = [];
    const res = bg.loadBurstConfig({
        configLoader: () => ({ telegram_burst_window_ms: 86_400_000 }), // 24h
        log: (_tag, msg) => warnings.push(msg),
    });
    assert.equal(res.windowMs, bg.BURST_WINDOW_MAX_MS);
    assert.equal(res.clamped, true);
    assert.ok(warnings.some(w => /arriba del máximo/.test(w)), 'warning emitido');
});

test('CA-2: telegram_burst_window_ms dentro del rango → pasa sin clamp', () => {
    const res = bg.loadBurstConfig({
        configLoader: () => ({ telegram_burst_window_ms: 90_000 }),
    });
    assert.equal(res.windowMs, 90_000);
    assert.equal(res.clamped, false);
});

test('CA-2: configLoader que tira excepción → default safe', () => {
    const res = bg.loadBurstConfig({
        configLoader: () => { throw new Error('boom'); },
    });
    assert.equal(res.windowMs, bg.BURST_WINDOW_DEFAULT_MS);
});

// =============================================================================
// CA-4 / S-1 — Sanitización MarkdownV2
// =============================================================================
test('CA-4 / S-1: sanitizeMarkdownV2 escapa caracteres de control', () => {
    const input = '*evil* _hack_ [link](url) `code` >quote';
    const out = bg.sanitizeMarkdownV2(input);
    // Todos los chars MarkdownV2 deben estar escapados con \.
    assert.match(out, /\\\*evil\\\*/);
    assert.match(out, /\\_hack\\_/);
    assert.match(out, /\\\[link\\\]\\\(url\\\)/);
    assert.match(out, /\\`code\\`/);
    assert.match(out, /\\>quote/);
});

test('CA-4: sanitizeMarkdownV2 normaliza CRLF/LF a espacios (anti CWE-117)', () => {
    const input = 'línea1\r\nlínea2\nlínea3';
    const out = bg.sanitizeMarkdownV2(input);
    assert.ok(!out.includes('\n'), 'sin saltos de línea');
    assert.ok(!out.includes('\r'), 'sin CR');
});

test('CA-4: sanitizeMarkdownV2 trunca a 200 chars (anti-DoS)', () => {
    const input = 'a'.repeat(500);
    const out = bg.sanitizeMarkdownV2(input);
    assert.ok(out.length <= 200);
});

test('CA-4: sanitizeMarkdownV2 con null/undefined → string vacío', () => {
    assert.equal(bg.sanitizeMarkdownV2(null), '');
    assert.equal(bg.sanitizeMarkdownV2(undefined), '');
});

// =============================================================================
// Helper: extractPidFromFilename
// =============================================================================
test('_extractPidFromFilename: parsea cross-provider-{ts}-{pid}.json', () => {
    assert.equal(bg._extractPidFromFilename('cross-provider-1234567890-9876.json'), '9876');
});

test('_extractPidFromFilename: fallback null si no matchea', () => {
    assert.equal(bg._extractPidFromFilename('random.json'), null);
    assert.equal(bg._extractPidFromFilename(null), null);
});

// =============================================================================
// CA-3 — Agrupamiento por burst
// =============================================================================
test('CA-3: burst con N=1 → no consolida (file queda solo en su grupo)', () => {
    const dir = mkTmpDir();
    const f1 = writeQueueFile(dir, 'cross-provider-1000-9999.json', {
        type: 'cross-provider-fallback',
        text: 'mensaje individual',
        meta: { skill: 'verificacion-sherlock', issue: 3668, pid: 9999 },
    }, 1700_000_000_000);
    const groups = bg.groupByBurst({
        fileEntries: [f1],
        windowMs: 60_000,
    });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].files.length, 1);
    // Si solo 1 file, formatConsolidatedMessage devuelve null (CA-3).
    const consolidated = bg.formatConsolidatedMessage(groups[0]);
    assert.equal(consolidated, null, 'singleton no consolida');
});

test('CA-3: 4 archivos con mismo skill/issue/pid/type → 1 grupo', () => {
    const dir = mkTmpDir();
    const base = 1700_000_000_000;
    const meta = { skill: 'verificacion-sherlock', issue: 3668, pid: 9999 };
    const f1 = writeQueueFile(dir, 'cross-provider-1000-9999.json', {
        type: 'cross-provider-fallback',
        text: 'intento 1',
        meta: { ...meta, fallback_provider: 'cerebras', error_class: 'rate_limit' },
    }, base + 0);
    const f2 = writeQueueFile(dir, 'cross-provider-1001-9999.json', {
        type: 'cross-provider-fallback',
        text: 'intento 2',
        meta: { ...meta, fallback_provider: 'gemini-google', error_class: 'quota_exhausted' },
    }, base + 2);
    const f3 = writeQueueFile(dir, 'cross-provider-1002-9999.json', {
        type: 'cross-provider-fallback',
        text: 'intento 3',
        meta: { ...meta, fallback_provider: 'nvidia-nim', error_class: 'timeout' },
    }, base + 5);
    const f4 = writeQueueFile(dir, 'cross-provider-1003-9999.json', {
        type: 'cross-provider-fallback',
        text: 'intento 4',
        meta: { ...meta, fallback_provider: 'groq', error_class: 'auth' },
    }, base + 7);

    const groups = bg.groupByBurst({
        fileEntries: [f1, f2, f3, f4],
        windowMs: 60_000,
    });
    assert.equal(groups.length, 1, '1 grupo con todos los archivos');
    assert.equal(groups[0].files.length, 4);
});

test('CA-3 / S-5: enumeración preserva provider+status+error_class de cada intento', () => {
    const dir = mkTmpDir();
    const base = 1700_000_000_000;
    const meta = { skill: 'verificacion-sherlock', issue: 3668, pid: 9999 };
    const files = [
        writeQueueFile(dir, 'cross-provider-1000-9999.json', {
            type: 'cross-provider-fallback',
            text: 't1',
            meta: { ...meta, fallback_provider: 'cerebras', error_class: 'rate_limit' },
        }, base + 0),
        writeQueueFile(dir, 'cross-provider-1001-9999.json', {
            type: 'cross-provider-fallback',
            text: 't2',
            meta: { ...meta, fallback_provider: 'gemini-google', error_class: 'quota_exhausted' },
        }, base + 2),
        writeQueueFile(dir, 'cross-provider-1002-9999.json', {
            type: 'cross-provider-fallback',
            text: 't3',
            meta: { ...meta, fallback_provider: 'nvidia-nim', error_class: 'timeout' },
        }, base + 5),
        writeQueueFile(dir, 'cross-provider-1003-9999.json', {
            type: 'cross-provider-fallback',
            text: 't4',
            meta: { ...meta, fallback_provider: 'groq', error_class: 'auth' },
        }, base + 7),
    ];
    const groups = bg.groupByBurst({ fileEntries: files, windowMs: 60_000 });
    const txt = bg.formatConsolidatedMessage(groups[0]);
    assert.ok(txt, 'consolidated message generado');
    // Header con count y skill+issue (sanitizado: `#` queda escapado).
    assert.match(txt, /4 intentos/);
    assert.match(txt, /skill=verificacion\\-sherlock/);
    // Cada provider debe aparecer enumerado, con offset relativo `[+Nms]`.
    assert.match(txt, /cerebras/);
    assert.match(txt, /gemini\\-google/);
    assert.match(txt, /nvidia\\-nim/);
    assert.match(txt, /groq/);
    // Cada error_class preservado.
    assert.match(txt, /rate_limit|rate\\_limit/);
    assert.match(txt, /quota_exhausted|quota\\_exhausted/);
    assert.match(txt, /timeout/);
    assert.match(txt, /auth/);
    // Offset relativo aparece al menos para el primer y último intento.
    assert.match(txt, /\[\+0ms\]/);
    assert.match(txt, /\[\+7ms\]/);
});

// =============================================================================
// S-3 — Restart mid-burst: pid+skill+issue hace que sobrevivan en mismo grupo.
// =============================================================================
test('S-3: archivos con mismo skill+issue pero distinto pid → grupos separados', () => {
    const dir = mkTmpDir();
    const base = 1700_000_000_000;
    const meta = { skill: 'verificacion-sherlock', issue: 3668 };
    const files = [
        writeQueueFile(dir, 'cross-provider-1000-1111.json', {
            type: 'cross-provider-fallback', text: 't1',
            meta: { ...meta, pid: 1111, fallback_provider: 'cerebras' },
        }, base + 0),
        writeQueueFile(dir, 'cross-provider-1001-2222.json', {
            type: 'cross-provider-fallback', text: 't2',
            meta: { ...meta, pid: 2222, fallback_provider: 'gemini-google' },
        }, base + 5),
    ];
    const groups = bg.groupByBurst({ fileEntries: files, windowMs: 60_000 });
    // 2 grupos diferentes por pid distinto (restart escenario).
    assert.equal(groups.length, 2);
});

// =============================================================================
// CA-2 — Ventana temporal: archivos fuera de window → grupos distintos
// =============================================================================
test('CA-2: archivos del mismo skill/pid pero >window separación → grupos distintos', () => {
    const dir = mkTmpDir();
    const base = 1700_000_000_000;
    const meta = { skill: 'verificacion-sherlock', issue: 3668, pid: 9999 };
    const files = [
        writeQueueFile(dir, 'cross-provider-1000-9999.json', {
            type: 'cross-provider-fallback', text: 't1',
            meta: { ...meta, fallback_provider: 'cerebras' },
        }, base + 0),
        writeQueueFile(dir, 'cross-provider-2000-9999.json', {
            type: 'cross-provider-fallback', text: 't2',
            meta: { ...meta, fallback_provider: 'gemini-google' },
        }, base + 120_000), // 2 minutos después
    ];
    const groups = bg.groupByBurst({ fileEntries: files, windowMs: 60_000 });
    assert.equal(groups.length, 2, '2 grupos: fuera de la ventana de 60s');
});

// =============================================================================
// Distintos skill o type → grupos separados
// =============================================================================
test('CA-2: archivos con distinto type → no se agrupan aunque coincidan pid+skill+issue', () => {
    const dir = mkTmpDir();
    const base = 1700_000_000_000;
    const baseMeta = { skill: 'verificacion-sherlock', issue: 3668, pid: 9999 };
    const files = [
        writeQueueFile(dir, 'cross-provider-1000-9999.json', {
            type: 'cross-provider-fallback', text: 't1',
            meta: { ...baseMeta, fallback_provider: 'cerebras' },
        }, base + 0),
        writeQueueFile(dir, 'cost-anomaly-1001-9999.json', {
            type: 'cost-anomaly', text: 'cost',
            meta: { ...baseMeta },
        }, base + 5),
    ];
    const groups = bg.groupByBurst({ fileEntries: files, windowMs: 60_000 });
    assert.equal(groups.length, 2, 'tipos distintos → grupos distintos');
});

// =============================================================================
// CA-4 — Sanitización MarkdownV2 en mensaje consolidado
// =============================================================================
test('CA-4: error.message con caracteres MarkdownV2 escapado en consolidado', () => {
    const dir = mkTmpDir();
    const base = 1700_000_000_000;
    const meta = { skill: 'verificacion-sherlock', issue: 3668, pid: 9999 };
    const files = [
        writeQueueFile(dir, 'cross-provider-1000-9999.json', {
            type: 'cross-provider-fallback', text: 't1',
            meta: { ...meta, fallback_provider: 'cer*ebras', error_class: '*evil*' },
        }, base + 0),
        writeQueueFile(dir, 'cross-provider-1001-9999.json', {
            type: 'cross-provider-fallback', text: 't2',
            meta: { ...meta, fallback_provider: 'g[em]ini', error_class: '_hack_\n[link](url)' },
        }, base + 5),
    ];
    const groups = bg.groupByBurst({ fileEntries: files, windowMs: 60_000 });
    const txt = bg.formatConsolidatedMessage(groups[0]);
    // No debe contener caracteres MarkdownV2 RAW sin escapar (excepto en bloque ```).
    // El bloque ``` queda como-is (es delimitador), pero el contenido enumerado
    // debe tener `*`, `[`, `_` escapados.
    assert.match(txt, /cer\\\*ebras/);
    assert.match(txt, /\\\*evil\\\*/);
    assert.match(txt, /g\\\[em\\\]ini/);
    assert.match(txt, /\\_hack\\_/);
    // CRLF/LF dentro del campo no debe romper la enumeración multilínea.
    assert.ok(!txt.includes('error_class: _hack_\n'), 'sin LF inyectado');
});

// =============================================================================
// UX-4 — Cap de enumeración
// =============================================================================
test('UX-4: burst con N>MAX_ENUMERATED_ATTEMPTS → muestra primeros + +N más', () => {
    const dir = mkTmpDir();
    const base = 1700_000_000_000;
    const meta = { skill: 'verificacion-sherlock', issue: 3668, pid: 9999 };
    const files = [];
    for (let i = 0; i < bg.MAX_ENUMERATED_ATTEMPTS + 3; i++) {
        files.push(writeQueueFile(dir, `cross-provider-${i}-9999.json`, {
            type: 'cross-provider-fallback', text: `t${i}`,
            meta: { ...meta, fallback_provider: `provider-${i}`, error_class: 'timeout' },
        }, base + i));
    }
    const groups = bg.groupByBurst({ fileEntries: files, windowMs: 60_000 });
    const txt = bg.formatConsolidatedMessage(groups[0]);
    assert.match(txt, /\+3 más/);
    assert.match(txt, /cross-provider-\d{4}-\d{2}-\d{2}\.jsonl/);
});

// =============================================================================
// CA-5 (S-4) — el módulo es puro y NO escribe audit log
// =============================================================================
test('CA-5 / S-4: groupByBurst es puro, NO escribe nada al filesystem', () => {
    const dir = mkTmpDir();
    const base = 1700_000_000_000;
    const meta = { skill: 'verificacion-sherlock', issue: 3668, pid: 9999 };
    const files = [
        writeQueueFile(dir, 'cross-provider-1000-9999.json', {
            type: 'cross-provider-fallback', text: 't1',
            meta: { ...meta, fallback_provider: 'cerebras' },
        }, base + 0),
        writeQueueFile(dir, 'cross-provider-1001-9999.json', {
            type: 'cross-provider-fallback', text: 't2',
            meta: { ...meta, fallback_provider: 'gemini-google' },
        }, base + 5),
    ];
    const before = fs.readdirSync(dir).sort();
    bg.groupByBurst({ fileEntries: files, windowMs: 60_000 });
    bg.formatConsolidatedMessage({ files: [], key: 'x' }); // dummy call
    const after = fs.readdirSync(dir).sort();
    assert.deepEqual(before, after, 'el módulo NO modifica filesystem');
});

// =============================================================================
// Defensive: archivo malformado (JSON inválido)
// =============================================================================
test('Defensive: archivo con JSON inválido → grupo __unparseable__ separado', () => {
    const dir = mkTmpDir();
    const malformedPath = path.join(dir, 'cross-provider-1000-9999.json');
    fs.writeFileSync(malformedPath, 'not json {');
    const malformed = { name: 'cross-provider-1000-9999.json', path: malformedPath };
    const ok = writeQueueFile(dir, 'cross-provider-1001-9999.json', {
        type: 'cross-provider-fallback', text: 't',
        meta: { skill: 's', issue: 3668, pid: 9999, fallback_provider: 'cerebras' },
    }, 1700_000_000_000);
    const groups = bg.groupByBurst({ fileEntries: [malformed, ok], windowMs: 60_000 });
    const unparseable = groups.find(g => g.key === '__unparseable__');
    assert.ok(unparseable, 'grupo __unparseable__ creado');
    assert.equal(unparseable.files.length, 1);
});

// =============================================================================
// extractAttemptSummary: campos por defecto
// =============================================================================
test('extractAttemptSummary: campos por defecto si meta vacío', () => {
    const summary = bg.extractAttemptSummary({ meta: {}, parsed: {} });
    assert.equal(summary.provider, 'desconocido');
    assert.ok(summary.status);
    assert.equal(summary.errorClass, '?');
});
