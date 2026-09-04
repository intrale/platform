// =============================================================================
// #5176 (rebote rev-3) — El render de `/allowlist` a ESCALA DE PRODUCCIÓN.
//
// POR QUÉ ESTE ARCHIVO EXISTE APARTE
// ----------------------------------
// Los tests de `ux-estado-operador-5176.test.js` usan fixtures de 2-3 issues y
// asertan sobre el CONTENIDO del render. Por eso pasaban en verde mientras el
// mensaje real, con el marker de producción (139 `allowed_issues`), medía 4652
// chars y el transporte lo recortaba a 4000: 16 issues perdidos sin aviso, pie
// del mensaje descartado y corte a mitad de token MarkdownV2.
//
// Un test de contenido NO puede ver ese defecto. Por eso acá se assertea sobre
// el LARGO del string emitido, con listas del tamaño real del marker y más
// grandes, y se pasa el render por la MISMA función de recorte que usa el
// transporte para verificar que no toca nada.
//
// Regla del archivo: ningún assert mira el contexto que se le pasa al template.
// Se dispara `/allowlist` de punta a punta y se mide lo que saldría por Telegram.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const commanderDet = require('../commander-deterministic');
const {
    safeTruncate,
    hasDanglingEscape,
    TELEGRAM_TEXT_LIMIT,
    HANDLER_TEXT_BUDGET,
} = require('../telegram-text-budget');
const allowlistBudget = require('../allowlist-render-budget');

// Tamaño del marker real de producción medido al momento del rebote.
const ESCALA_PRODUCCION = 139;

function mkTmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function writePartial(dir, marker) {
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify(marker));
}

function issuesSerie(n, start = 5000, step = 7) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(start + i * step);
    return out;
}

/** Render REAL de `/allowlist`: el string que le llega al operador. */
async function allowlistReply(dir) {
    const dispatcher = commanderDet.createDispatcher({
        pipelineRoot: dir,
        logsDir: path.join(dir, 'logs'),
        rateLimit: { burst: 100, ratePerMin: 600 },
    });
    const r = await dispatcher.dispatch({ text: '/allowlist', chat_id: '1' });
    assert.equal(r.status, 'ok');
    return r.reply;
}

/** Lo que el transporte encolaría: mismo recorte que `sendTelegramWithMarkup`. */
function emitidoPorTransporte(text) {
    return safeTruncate(text, TELEGRAM_TEXT_LIMIT);
}

// ─── El assert del rebote: LARGO, no contenido ──────────────────────────────

test('#5176 escala · con 139 issues el render entra en el saliente sin que el transporte lo recorte', async () => {
    const dir = mkTmp('allowlist-escala-');
    try {
        const issues = issuesSerie(ESCALA_PRODUCCION);
        writePartial(dir, { allowed_issues: issues, created_at: '2026-08-14T10:00:00.000Z' });

        const reply = await allowlistReply(dir);
        const emitido = emitidoPorTransporte(reply);

        // ESTE es el assert que faltaba: el LARGO. Antes del fix medía 4652.
        assert.ok(
            reply.length <= HANDLER_TEXT_BUDGET,
            `el render debe entrar en el presupuesto del handler: ${reply.length} > ${HANDLER_TEXT_BUDGET}`,
        );
        // Y el transporte no toca nada: lo emitido es EXACTAMENTE lo renderizado.
        assert.equal(
            emitido,
            reply,
            `el transporte no puede recortar el render (render=${reply.length}, emitido=${emitido.length})`,
        );
    } finally { rmrf(dir); }
});

test('#5176 escala · con 139 issues NO se pierde ninguno en el mensaje emitido', async () => {
    const dir = mkTmp('allowlist-escala-full-');
    try {
        const issues = issuesSerie(ESCALA_PRODUCCION);
        writePartial(dir, { allowed_issues: issues, created_at: '2026-08-14T10:00:00.000Z' });

        const emitido = emitidoPorTransporte(await allowlistReply(dir));

        const faltantes = issues.filter((n) => !emitido.includes(`#${n}`));
        assert.deepEqual(
            faltantes,
            [],
            `${faltantes.length} de ${issues.length} issues no llegaron al operador`,
        );
        // El pie del mensaje sobrevive: si se hubiera recortado, sería lo primero
        // en caer (es lo último del template).
        assert.match(emitido, /sin LLM/, 'el pie del mensaje no puede perderse');
        // Y el conteo declarado es el REAL, no el de lo mostrado.
        assert.match(emitido, new RegExp(`Issues admitidos \\(${ESCALA_PRODUCCION}\\)`));
    } finally { rmrf(dir); }
});

test('#5176 escala · el mensaje emitido nunca termina en un escape MarkdownV2 colgado', async () => {
    // El corte viejo caía en `✅ \#5887 · \(sin metadata\...` — backslash sin su
    // carácter escapado, que es el 400 `Can't parse entities` de pulpo.js.
    for (const n of [ESCALA_PRODUCCION, 500, 5000]) {
        const dir = mkTmp('allowlist-escape-');
        try {
            writePartial(dir, { allowed_issues: issuesSerie(n), created_at: '2026-08-14T10:00:00.000Z' });
            const emitido = emitidoPorTransporte(await allowlistReply(dir));
            assert.ok(
                !hasDanglingEscape(emitido),
                `con ${n} issues el emitido termina en un escape colgado: ${JSON.stringify(emitido.slice(-40))}`,
            );
        } finally { rmrf(dir); }
    }
});

// ─── Truncado EXPLÍCITO cuando ni la vista compacta entra ────────────────────

test('#5176 escala · si hay que descartar issues, el mensaje lo declara con el total real', async () => {
    const dir = mkTmp('allowlist-trunc-');
    try {
        const issues = issuesSerie(2000);
        writePartial(dir, { allowed_issues: issues, created_at: '2026-08-14T10:00:00.000Z' });

        const reply = await allowlistReply(dir);
        assert.ok(reply.length <= HANDLER_TEXT_BUDGET, `render=${reply.length}`);
        assert.equal(emitidoPorTransporte(reply), reply, 'el transporte sigue sin tener que recortar');

        // Truncado EXPLÍCITO: cuántos faltan y sobre qué total.
        assert.match(reply, /y \d+ más de los 2000 autorizados/);
        // Y el copy niega la lectura peligrosa: "está incompleta / se perdió".
        assert.match(reply, /NO está incompleta/);
        assert.match(reply, /Issues admitidos \(2000\)/);
    } finally { rmrf(dir); }
});

test('#5176 escala · listas chicas conservan la vista detallada (sin regresión de UX)', async () => {
    const dir = mkTmp('allowlist-detalle-');
    try {
        writePartial(dir, { allowed_issues: [5176, 5179], created_at: '2026-08-14T10:00:00.000Z' });
        const reply = await allowlistReply(dir);
        assert.match(reply, /✅ \\#5176/, 'con 2 issues se mantiene la fila detallada');
        assert.ok(!/más de los/.test(reply), 'no puede anunciar truncado si no truncó nada');
    } finally { rmrf(dir); }
});

// ─── Peor caso: los campos variables vienen del marker, no del código ────────

test('#5176 escala · marker con campos desbordados: el render sigue entrando', async () => {
    const dir = mkTmp('allowlist-patologico-');
    try {
        writePartial(dir, {
            allowed_issues: issuesSerie(ESCALA_PRODUCCION),
            // `allowed_skills` y `created_at` los escribe otro proceso: acá se
            // simula un marker corrupto/inflado para probar la cota, no el caso feliz.
            allowed_skills: Array.from({ length: 80 }, (_, i) => `skill-larguisimo-numero-${i}`),
            created_at: 'x'.repeat(4000),
        });
        fs.writeFileSync(path.join(dir, '.paused'), JSON.stringify({
            source: 'operador', detail: 'y'.repeat(3000),
        }));

        const reply = await allowlistReply(dir);
        assert.ok(
            reply.length <= HANDLER_TEXT_BUDGET,
            `ni con el marker inflado puede pasarse: ${reply.length} > ${HANDLER_TEXT_BUDGET}`,
        );
        assert.equal(emitidoPorTransporte(reply), reply);
        // El halt total sigue ganando y anunciándose (contrato §4, CA-UX-1).
        assert.match(reply, /halt total/);
        assert.match(reply, new RegExp(`hay ${ESCALA_PRODUCCION} issues autorizados`));
    } finally { rmrf(dir); }
});

test('#5176 escala · queda margen para el eco de transcripción del comando por audio', async () => {
    // El reply de un comando originado en audio viaja con el eco de la
    // transcripción PREPENDIDO en el mismo mensaje (pulpo.js). El presupuesto
    // del handler reserva ese margen: si no, un `/allowlist` por audio se
    // recortaba aunque el render solo entrara justo.
    const dir = mkTmp('allowlist-audio-');
    try {
        writePartial(dir, { allowed_issues: issuesSerie(ESCALA_PRODUCCION), created_at: '2026-08-14T10:00:00.000Z' });
        const reply = await allowlistReply(dir);
        // Eco en su peor caso: 200 chars crudos que el escape puede casi duplicar.
        const ecoPeorCaso = '\\.'.repeat(200) + '\n\n';
        const conEco = ecoPeorCaso + reply;
        assert.ok(
            conEco.length <= TELEGRAM_TEXT_LIMIT,
            `render + eco debe entrar en el saliente: ${conEco.length} > ${TELEGRAM_TEXT_LIMIT}`,
        );
    } finally { rmrf(dir); }
});

// ─── Cota del transporte: `safeTruncate` (red de seguridad) ──────────────────

test('#5176 safeTruncate · respeta la cota y nunca deja un escape colgado', () => {
    // Texto cuyo corte natural cae justo sobre un backslash de escape.
    const texto = 'a'.repeat(50) + '\\('.repeat(50);
    for (let limit = 40; limit <= 120; limit++) {
        const out = safeTruncate(texto, limit);
        assert.ok(out.length <= limit, `limit=${limit} → ${out.length}`);
        assert.ok(!hasDanglingEscape(out), `limit=${limit} dejó un escape colgado`);
    }
});

test('#5176 safeTruncate · no parte un par surrogate (los emojis del render son astrales)', () => {
    const texto = '🔴'.repeat(100); // cada emoji = 2 unidades de código
    for (let limit = 10; limit <= 60; limit++) {
        const out = safeTruncate(texto, limit);
        assert.ok(out.length <= limit);
        const last = out.charCodeAt(out.length - 1);
        assert.ok(
            !(last >= 0xD800 && last <= 0xDBFF),
            `limit=${limit} dejó media unidad de código al final`,
        );
    }
});

test('#5176 safeTruncate · el marcador de truncado no es metacarácter de MarkdownV2', () => {
    const out = safeTruncate('z'.repeat(100), 20);
    assert.equal(out.length, 20);
    // El marcador viejo eran tres puntos: en MarkdownV2 el `.` va escapado, así
    // que el propio indicador de truncado podía romper el parseo del mensaje.
    assert.ok(!out.endsWith('...'), 'el marcador no puede ser `...` sin escapar');
    assert.ok(out.endsWith('…'));
});

test('#5176 safeTruncate · texto que ya entra vuelve intacto y entradas raras no explotan', () => {
    assert.equal(safeTruncate('corto', 100), 'corto');
    assert.equal(safeTruncate('', 100), '');
    // El transporte hacía `text.length` sin validar: un no-string lo tumbaba.
    assert.equal(safeTruncate(null, 100), '');
    assert.equal(safeTruncate(undefined, 100), '');
    assert.equal(safeTruncate(12345, 100), '12345');
});

// ─── Unitarios del módulo de presupuesto ────────────────────────────────────

test('#5176 fitAllowlistRender · degrada a compacta antes de descartar issues', () => {
    const rows = issuesSerie(100).map((number) => ({ number }));
    const fit = allowlistBudget.fitAllowlistRender({
        rows,
        // Render de juguete: sólo lo que aporta la vista, para aislar la decisión.
        renderWith: (v) => (v.compact ? v['compact-list'] : rows.slice(0, v.shown).map((r) => `fila larguisima por issue ${r.number}\n`).join('')),
        budget: 1500,
    });
    assert.equal(fit.mode, 'compact');
    assert.equal(fit.truncated, false, 'la compacta entera entra: no debe descartar nada');
    assert.equal(fit.shown, 100);
});

test('#5176 fitAllowlistRender · el texto devuelto SIEMPRE mide <= budget', () => {
    for (const total of [0, 1, 20, 139, 1000]) {
        for (const budget of [80, 300, 1200, 3500]) {
            const rows = issuesSerie(total).map((number) => ({ number }));
            const fit = allowlistBudget.fitAllowlistRender({
                rows,
                renderWith: (v) => `CABECERA FIJA\n${v.compact ? v['compact-list'] : v.issues.map((r) => `  fila ${r.number}\n`).join('')}${v.truncated ? `\ny ${v['hidden-count']} más` : ''}`,
                budget,
            });
            assert.ok(
                fit.text.length <= budget,
                `total=${total} budget=${budget} → ${fit.text.length}`,
            );
            assert.equal(fit.truncated, fit.shown < total);
        }
    }
});

test('#5176 fitAllowlistRender · si el render explota, degrada en vez de tumbar el comando', () => {
    const rows = issuesSerie(50).map((number) => ({ number }));
    const fit = allowlistBudget.fitAllowlistRender({
        rows,
        renderWith: (v) => {
            if (v.shown > 10) throw new Error('boom');
            return `ok ${v.shown}`;
        },
        budget: 3500,
    });
    assert.equal(fit.shown, 10, 'se queda con la vista más grande que sí renderiza');
    assert.equal(fit.truncated, true);
});

test('#5176 clampSkillsDisplay · acota y declara el remanente', () => {
    assert.equal(allowlistBudget.clampSkillsDisplay([]), '');
    assert.equal(allowlistBudget.clampSkillsDisplay(['po', 'ux']), 'po, ux');
    const muchos = Array.from({ length: 60 }, (_, i) => `skill-${i}`);
    const display = allowlistBudget.clampSkillsDisplay(muchos, 60);
    assert.ok(display.length <= 60 + 12, `display demasiado largo: ${display.length}`);
    assert.match(display, /\+\d+ más$/);
});
