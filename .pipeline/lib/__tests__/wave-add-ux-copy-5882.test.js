// =============================================================================
// wave-add-ux-copy-5882.test.js — Contrato de copy del Commander (#5882).
//
// El núcleo técnico (CA-0..CA-7) lo cubre `wave-add-sync-integration-5882`.
// Este archivo cubre la ÚNICA superficie humana de la historia: el texto que el
// operador lee por Telegram cuando la promoción a la ola activa falla a medias.
// Fija los tres CA-UX vinculantes del contrato de definición (comment
// 5280850296, ratificado por el PO):
//
//   CA-UX-1 — el camino `landed === true` no puede responder el ✅ pelado del
//             happy path: el operador vería el mismo tilde verde ante una
//             anomalía de sync.
//   CA-UX-2 — léxico único: se dice "Allowlist", nunca "lista de despacho".
//   CA-UX-3 — el peor caso da pasos concretos con comandos textuales, distingue
//             estado conocido-malo de indeterminado, y no termina en
//             "requiere revisión manual".
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/wave-add-ux-copy-5882.test.js
// =============================================================================

'use strict';

process.env.PULPO_NO_AUTOSTART = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const partialPause = require('../partial-pause');
const waves = require('../waves');
const cd = require('../commander-deterministic');

const SRC_COMMANDER = path.join(__dirname, '..', 'commander-deterministic.js');

// -----------------------------------------------------------------------------
// Fixtures (mismo patrón que wave-add-sync-integration-5882.test.js)
// -----------------------------------------------------------------------------

function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-ux-5882-'));
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'desarrollo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    try { waves.invalidateCache(); } catch (_) {}
    try { cd._waveInternal.invalidateKnownIssuesCache(); } catch (_) {}
    return dir;
}

function teardown(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { waves.invalidateCache(); } catch (_) {}
    try { cd._waveInternal.invalidateKnownIssuesCache(); } catch (_) {}
    try { cd._waveInternal.setSyncLogger(null); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function writeWaves(dir, activeIssues) {
    const state = {
        version: '1.0',
        meta: {
            created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
            updated_by: 'fixture', source: 'manual', note: 'test #5882 UX',
        },
        active_wave: {
            number: 1,
            name: 'Ola activa — Test 5882',
            goal: 'coherencia waves↔partial-pause',
            started_at: '2026-08-01T00:00:00.000Z',
            issues: activeIssues.map((n) => ({ number: n, status: 'in_progress' })),
        },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(state, null, 2));
    try { waves.invalidateCache(); } catch (_) {}
}

function dropArtifact(dir, issue) {
    const target = path.join(dir, 'desarrollo', 'dev', 'pendiente');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, `${issue}.pipeline-dev`), `issue: ${issue}\n`);
}

function seedAllowlist(issues) {
    return partialPause.setPartialPause(issues, {
        source: 'wave-promote',
        authorizedBy: 'wave-promote',
        justification: 'seed test #5882 UX',
    });
}

// El `reply` sale escapado en MarkdownV2 (`partial\_sync\_failed`). Para asertar
// sobre el CONTENIDO y no sobre el escape, lo des-escapamos.
function plano(reply) {
    return String(reply).replace(/\\(.)/g, '$1');
}

/** Ejecuta `/wave add 1 #880001` con el entorno ya sembrado. */
async function runWaveAdd(dir) {
    const { reply } = await cd._waveInternal.handleWaveAdd({
        pipelineRoot: dir, waveNumber: 1, issueNumber: 880001,
        cooldown: null, chatId: 'leo', from: 'Leo',
    });
    return reply;
}

// -----------------------------------------------------------------------------
// Los cuatro caminos de respuesta que produce `handleWaveAdd` sobre la ola activa
// -----------------------------------------------------------------------------

/** Happy path: ambas escrituras entran. */
async function replyHappyPath() {
    const dir = setup();
    try {
        writeWaves(dir, [880002]); dropArtifact(dir, 880001); seedAllowlist([880002]);
        return await runWaveAdd(dir);
    } finally { teardown(dir); }
}

/** `landed === true`: el sync tiró error pero la Allowlist SÍ quedó escrita. */
async function replyLandedTrue() {
    const dir = setup();
    const original = partialPause.setPartialPause;
    try {
        writeWaves(dir, [880002]); dropArtifact(dir, 880001); seedAllowlist([880002]);
        cd._waveInternal.setSyncLogger(() => {});
        partialPause.setPartialPause = (issues, opts) => {
            original.call(partialPause, issues, opts);
            throw new Error('murió después del rename');
        };
        return await runWaveAdd(dir);
    } finally { partialPause.setPartialPause = original; teardown(dir); }
}

/** A · `landed === false` + rollback exitoso. El mensaje lleva un path interno. */
async function replyRollbackOk() {
    const dir = setup();
    const original = partialPause.setPartialPause;
    try {
        writeWaves(dir, [880002]); dropArtifact(dir, 880001); seedAllowlist([880002]);
        cd._waveInternal.setSyncLogger(() => {});
        partialPause.setPartialPause = () => { throw new Error('EACCES: /ruta/interna/secreta'); };
        return await runWaveAdd(dir);
    } finally { partialPause.setPartialPause = original; teardown(dir); }
}

/** B · `landed === false` y el rollback TAMPOCO salió: estado conocido-malo. */
async function replySinRollback() {
    const dir = setup();
    const originalSet = partialPause.setPartialPause;
    const originalRb = waves.rollbackIssueAdd;
    try {
        writeWaves(dir, [880002]); dropArtifact(dir, 880001); seedAllowlist([880002]);
        cd._waveInternal.setSyncLogger(() => {});
        partialPause.setPartialPause = () => { throw new Error('fallo de sync'); };
        waves.rollbackIssueAdd = () => { throw new Error('tampoco pude revertir'); };
        return await runWaveAdd(dir);
    } finally {
        partialPause.setPartialPause = originalSet;
        waves.rollbackIssueAdd = originalRb;
        teardown(dir);
    }
}

/** C · `landed === null`: no se pudo releer la Allowlist. */
async function replyIndeterminado() {
    const dir = setup();
    const originalSet = partialPause.setPartialPause;
    const originalMode = partialPause.getPipelineMode;
    try {
        writeWaves(dir, [880002]); dropArtifact(dir, 880001); seedAllowlist([880002]);
        cd._waveInternal.setSyncLogger(() => {});
        partialPause.setPartialPause = () => { throw new Error('fallo de escritura'); };
        let llamadas = 0;
        partialPause.getPipelineMode = function (...args) {
            llamadas += 1;
            if (llamadas > 1) throw new Error('no se puede leer el marker');
            return originalMode.apply(partialPause, args);
        };
        return await runWaveAdd(dir);
    } finally {
        partialPause.setPartialPause = originalSet;
        partialPause.getPipelineMode = originalMode;
        teardown(dir);
    }
}

/** Los tres mensajes de error, en orden [A rollback-ok, B conocido-malo, C indeterminado]. */
async function repliesDeError() {
    return [await replyRollbackOk(), await replySinRollback(), await replyIndeterminado()];
}

// =============================================================================
// CA-UX-1 — el camino `landed === true` no responde un ✅ limpio
// =============================================================================

test('CA-UX-1: la respuesta del camino landed===true DIFIERE de la del happy path', async () => {
    const anomalo = await replyLandedTrue();
    const feliz = await replyHappyPath();

    assert.notEqual(anomalo, feliz,
        'el operador no puede ver el mismo tilde verde ante una anomalía de sync');
    assert.ok(plano(anomalo).includes('⚠️'), `el aviso debe ser visible: ${anomalo}`);
    assert.ok(!plano(feliz).includes('⚠️'), 'el happy path queda intacto, sin aviso');
});

test('CA-UX-1: el aviso deja claro que el estado es coherente y no hace falta acción', async () => {
    const anomalo = plano(await replyLandedTrue());

    assert.ok(/sincronización con la Allowlist/i.test(anomalo), `nombra la anomalía: ${anomalo}`);
    assert.ok(/estado es coherente/i.test(anomalo), `informa coherencia: ${anomalo}`);
    assert.ok(/no hizo falta revertir/i.test(anomalo), 'aclara que no hubo rollback');
    // Es información, no alarma: no es un error ni manda a hacer nada.
    assert.ok(!anomalo.includes('partial_sync_failed'), 'no se le reporta como error al operador');
    assert.ok(!/Qué hacer/i.test(anomalo), 'no pide acción: el estado final ya es correcto');
});

test('CA-UX-1: el happy path sigue confirmando la promoción sin ruido', async () => {
    const feliz = plano(await replyHappyPath());

    assert.ok(feliz.includes('880001'), `confirma el issue: ${feliz}`);
    assert.ok(feliz.includes('✅'), 'mantiene el tilde verde del happy path');
    assert.ok(!/sincronización/i.test(feliz), 'sin bloque condicional cuando no hubo anomalía');
});

// =============================================================================
// CA-UX-2 — léxico único: "Allowlist", nunca "lista de despacho"
// =============================================================================

test('CA-UX-2: el término "lista de despacho" y sus variantes no existen en el código', () => {
    const src = fs.readFileSync(SRC_COMMANDER, 'utf8');
    for (const termino of ['lista de despacho', 'lista de admitidos', 'partial pause list']) {
        assert.ok(!new RegExp(termino, 'i').test(src),
            `término prohibido por CA-UX-2 presente en commander-deterministic.js: "${termino}"`);
    }
});

test('CA-UX-2: todos los mensajes nuevos usan el léxico "Allowlist"', async () => {
    const replies = [await replyLandedTrue(), ...(await repliesDeError())];

    for (const reply of replies) {
        const txt = plano(reply);
        assert.ok(!/lista de despacho/i.test(txt), `término prohibido en: ${txt}`);
        assert.ok(/Allowlist/.test(txt), `debe usar el léxico vigente "Allowlist": ${txt}`);
    }
});

test('CA-UX-2: los templates tampoco introducen el término prohibido', () => {
    const dir = path.join(__dirname, '..', 'commander', 'templates');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
        const txt = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.ok(!/lista de despacho/i.test(txt), `término prohibido en template ${f}`);
    }
});

// =============================================================================
// CA-UX-3 — el peor caso tiene pasos concretos, no "requiere revisión manual"
// =============================================================================

test('CA-UX-3: la frase "requiere revisión manual" no está en el copy', async () => {
    const src = fs.readFileSync(SRC_COMMANDER, 'utf8');
    assert.ok(!/Requiere revisión manual/i.test(src),
        'la frase que deja solo al operador no puede estar en el código');

    for (const reply of await repliesDeError()) {
        assert.ok(!/requiere revisión manual/i.test(plano(reply)), `frase rechazada en: ${reply}`);
    }
});

test('CA-UX-3: los caminos sin rollback dan pasos numerados con comandos textuales', async () => {
    const [, conocidoMalo, indeterminado] = await repliesDeError();

    for (const reply of [conocidoMalo, indeterminado]) {
        const txt = plano(reply);
        assert.ok(/Qué hacer:/.test(txt), `debe listar qué hacer: ${txt}`);
        assert.ok(/1\./.test(txt) && /2\./.test(txt) && /3\./.test(txt),
            `pasos numerados concretos: ${txt}`);
        assert.ok(/`allowlist`/.test(txt),
            `nombra el comando textual de diagnóstico: ${txt}`);
    }
});

test('CA-UX-3: el camino con rollback exitoso cierra diciendo cómo reintentar', async () => {
    const txt = plano(await replyRollbackOk());

    assert.ok(/NO quedó en la ola/.test(txt), `afirma el estado final: ${txt}`);
    assert.ok(/todo volvió a como estaba/.test(txt), 'tranquiliza: no quedó nada a medias');
    assert.ok(/\/wave add 1 #880001/.test(txt), `da el comando exacto para reintentar: ${txt}`);
});

test('CA-UX-3: se distingue estado CONOCIDO-malo de INDETERMINADO', async () => {
    const [, conocidoMalo, indeterminado] = await repliesDeError();

    assert.notEqual(plano(conocidoMalo), plano(indeterminado),
        'son dos situaciones distintas y el operador actúa distinto en cada una');
    assert.ok(/NO entró a la Allowlist/.test(plano(conocidoMalo)),
        `el conocido-malo afirma el estado: ${conocidoMalo}`);
    assert.ok(/no tengo certeza/.test(plano(indeterminado)),
        `el indeterminado declara la incertidumbre: ${indeterminado}`);
    assert.ok(/no toqué nada más/.test(plano(indeterminado)),
        'el indeterminado explica por qué no actuó');
});

test('CA-UX-3: los tres caminos comparten un solo error-kind partial_sync_failed', async () => {
    for (const reply of await repliesDeError()) {
        assert.ok(plano(reply).includes('partial_sync_failed'),
            `la diferenciación va en el cuerpo, no en el kind: ${reply}`);
    }
});

test('CA-UX-3: el e.message crudo NO se interpola en la respuesta a Telegram', async () => {
    const txt = plano(await replyRollbackOk());

    assert.ok(!txt.includes('EACCES'), `sin stack trace para el operador: ${txt}`);
    assert.ok(!txt.includes('/ruta/interna/secreta'), `sin leak de paths internos: ${txt}`);
});

// =============================================================================
// Integridad del canal: el escape de MarkdownV2 sigue vivo y los comandos que se
// sugieren son sintácticamente válidos (un comando que rebota es peor que nada).
// =============================================================================

test('el template wave-error no usa triple-brace (el escape MarkdownV2 sigue vivo)', () => {
    const tpl = fs.readFileSync(
        path.join(__dirname, '..', 'commander', 'templates', 'wave-error.md'), 'utf8');
    assert.ok(!/\{\{\{\s*message\s*\}\}\}/.test(tpl),
        'el texto deriva de input de Telegram: perder el escape es una vulnerabilidad');
    assert.ok(/\{\{\s*message\s*\}\}/.test(tpl), 'debe seguir interpolando el mensaje escapado');
});

test('el comando de reintento sugerido parsea contra el parser real', async () => {
    const m = plano(await replyRollbackOk()).match(/\/wave add (\d+) (#\d+)/);
    assert.ok(m, 'el copy debe sugerir el reintento con la sintaxis real');

    // `parseWaveArgs` es la fuente de verdad del schema (`add <ola> #<issue>`).
    const parsed = cd.parseWaveArgs(`add ${m[1]} ${m[2]}`);
    assert.ok(parsed, `el comando sugerido al operador debe parsear, no rebotar: ${m[0]}`);
    assert.equal(parsed.subcommand, 'add');
    assert.equal(parsed.waveNumber, Number(m[1]));
    assert.equal(parsed.issueNumber, Number(m[2].slice(1)));
});

test('el copy NO sugiere /wave remove sobre la ola activa (rebota por política A04)', async () => {
    const [, conocidoMalo] = await repliesDeError();
    const txt = plano(conocidoMalo);

    // Mandar al operador a `/wave remove <ola> #<issue>` sobre la ola ACTIVA lo
    // deja peor: el comando rebota con `active_wave_locked`. El copy sólo puede
    // nombrarlo para ADVERTIR que no aplica, nunca como paso a ejecutar.
    const sugerencias = txt.match(/\/wave remove \d+ #\d+/g);
    assert.equal(sugerencias, null,
        `no puede sugerir un comando que rebota: ${txt}`);
    assert.ok(/`\/wave remove` no aplica/.test(txt),
        `debe advertir explícitamente que esa vía no sirve acá: ${txt}`);
});
