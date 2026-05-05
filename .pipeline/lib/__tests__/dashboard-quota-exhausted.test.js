// =============================================================================
// Tests dashboard slice + render banner cuota Anthropic agotada — #2976.
//
// Cubre:
//   - CA-5  — slice computa `deterministicRunning` y `queuedSkills`
//             correctamente desde state.issueMatrix mockeado.
//   - CA-12 — HTML servido contiene "cuota Anthropic" como texto inicial
//             del banner (matching del CA-14 con `curl | grep`).
//   - CA-12 — un payload con `<script>alert(1)</script>` en error_type
//             aparece escapado en el HTML servido por escapeHtml() del
//             cliente — no como tag ejecutable. Validamos que la función
//             escapeHtml está embebida en el script y se invoca sobre
//             error_type/skills.
//   - CA-2  — sin flag activo, el slice devuelve `{ active: false, ... }`
//             y el HTML del banner queda con `data-active="false"` (oculto).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Dir temporal que actúa como `.pipeline/` para los tests. Setear ANTES de
// require() del módulo para que `DEFAULT_PIPELINE_DIR` se calcule sobre el
// override (env var resolvePipelineDir).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-test-quota-slice-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

const slices = require('../dashboard-slices');
const home = require('../../views/dashboard/home');

function flagFile() {
    return path.join(TMP_DIR, 'quota-exhausted.json');
}

function writeFlag(payload) {
    fs.writeFileSync(flagFile(), JSON.stringify(payload));
}

function clearFlag() {
    try { fs.unlinkSync(flagFile()); } catch { /* ignore */ }
}

function fakeState({ trabajando = [], pendiente = [] } = {}) {
    // issueMatrix shape mínimo que el slice consume: cada issue tiene
    // un map `fases[fase]` con entries `{estado, skill}`.
    const issueMatrix = {};
    for (const e of trabajando) {
        const id = String(e.issue || (1000 + Math.random() * 1000 | 0));
        issueMatrix[id] = issueMatrix[id] || { fases: {} };
        issueMatrix[id].fases.dev = issueMatrix[id].fases.dev || [];
        issueMatrix[id].fases.dev.push({ estado: 'trabajando', skill: e.skill });
    }
    for (const e of pendiente) {
        const id = String(e.issue || (2000 + Math.random() * 1000 | 0));
        issueMatrix[id] = issueMatrix[id] || { fases: {} };
        const fase = e.fase || 'dev';
        issueMatrix[id].fases[fase] = issueMatrix[id].fases[fase] || [];
        issueMatrix[id].fases[fase].push({ estado: 'pendiente', skill: e.skill });
    }
    return { issueMatrix };
}

// -----------------------------------------------------------------------------
// CA-2 — slice devuelve active:false cuando no hay flag
// -----------------------------------------------------------------------------

test('CA-2: sin flag → slice.active=false con counters en cero', () => {
    clearFlag();
    const out = slices.quotaExhaustedSlice(fakeState({
        trabajando: [{ skill: 'builder' }],
        pendiente: [{ skill: 'guru' }, { skill: 'po' }],
    }));
    assert.equal(out.active, false);
    assert.equal(out.deterministicRunning, 0);
    assert.deepEqual(out.queuedSkills, []);
});

// -----------------------------------------------------------------------------
// CA-5 — slice cuenta determinísticos corriendo y LLM esperando
// -----------------------------------------------------------------------------

test('CA-5: con flag activo, contar builder/tester/delivery/linter como determinísticos', () => {
    writeFlag({
        exhausted: true,
        resets_at: new Date(Date.now() + 3600000).toISOString(),
        detected_at: new Date(Date.now() - 60000).toISOString(),
        pattern_matched: 'usage_limit_error',
    });
    try {
        const out = slices.quotaExhaustedSlice(fakeState({
            trabajando: [
                { skill: 'builder' },
                { skill: 'tester' },
                { skill: 'delivery' },
                { skill: 'linter' },
                { skill: 'android-dev' }, // NO determinístico, no debe contar
            ],
            pendiente: [
                { skill: 'guru' },
                { skill: 'guru' },
                { skill: 'po' },
                { skill: 'builder' }, // determinístico en pendiente, no debe contar
            ],
        }));
        assert.equal(out.active, true);
        assert.equal(out.deterministicRunning, 4);
        // queuedSkills agrupado por skill, sorted desc por count
        const guru = out.queuedSkills.find(x => x.skill === 'guru');
        const po = out.queuedSkills.find(x => x.skill === 'po');
        assert.ok(guru && guru.count === 2);
        assert.ok(po && po.count === 1);
        // Builder NO debe estar (es determinístico, no se "encola por
        // falta de cuota").
        assert.equal(out.queuedSkills.find(x => x.skill === 'builder'), undefined);
        assert.equal(out.queuedCount, 3);
        assert.equal(out.error_type, 'usage_limit_error');
    } finally {
        clearFlag();
    }
});

test('CA-5: orden desc por count en queuedSkills', () => {
    writeFlag({
        exhausted: true,
        resets_at: new Date(Date.now() + 3600000).toISOString(),
        detected_at: new Date().toISOString(),
        pattern_matched: 'usage_limit_error',
    });
    try {
        const out = slices.quotaExhaustedSlice(fakeState({
            pendiente: [
                { skill: 'po', issue: 1 },
                { skill: 'guru', issue: 2 },
                { skill: 'guru', issue: 3 },
                { skill: 'guru', issue: 4 },
                { skill: 'security', issue: 5 },
                { skill: 'security', issue: 6 },
            ],
        }));
        assert.equal(out.queuedSkills[0].skill, 'guru');
        assert.equal(out.queuedSkills[0].count, 3);
        assert.equal(out.queuedSkills[1].skill, 'security');
        assert.equal(out.queuedSkills[1].count, 2);
        assert.equal(out.queuedSkills[2].skill, 'po');
        assert.equal(out.queuedSkills[2].count, 1);
    } finally {
        clearFlag();
    }
});

// -----------------------------------------------------------------------------
// CA-12 / CA-14 — HTML servido conditionally incluye "cuota Anthropic"
// según estado del flag (SSR para que `curl | grep` sea determinístico).
// -----------------------------------------------------------------------------

test('CA-14: HTML SIN flag NO contiene "cuota Anthropic" (curl|grep no debe matchear)', () => {
    clearFlag();
    const html = home.renderHomeHTML({ quotaState: { active: false } });
    assert.ok(!html.includes('cuota Anthropic'),
        'sin flag activo, el HTML no debe traer el texto del banner');
});

test('CA-14: HTML CON flag activo SÍ contiene "cuota Anthropic" en el title del banner', () => {
    const html = home.renderHomeHTML({
        quotaState: {
            active: true,
            error_type: 'usage_limit_error',
            detected_at: '2026-05-05T01:00:00.000Z',
            resets_at: '2026-05-05T05:00:00.000Z',
            resets_at_ms: Date.parse('2026-05-05T05:00:00.000Z'),
        },
    });
    assert.ok(html.includes('cuota Anthropic'),
        'con flag activo, el banner SSR debe incluir el texto literal');
    assert.ok(html.includes('Modo determinístico'),
        'el title debe seguir el formato exacto definido por CA-1');
});

test('CA-12: HTML siempre expone el banner con id quota-exhausted-banner', () => {
    // Tanto activo como inactivo, el elemento existe (con data-active
    // distinto). Esto permite al cliente mutar sin re-crear DOM cuando
    // el polling cambia el estado.
    const htmlOff = home.renderHomeHTML({ quotaState: { active: false } });
    const htmlOn = home.renderHomeHTML({
        quotaState: {
            active: true,
            error_type: 'usage_limit_error',
            detected_at: new Date().toISOString(),
            resets_at: new Date(Date.now() + 3600000).toISOString(),
            resets_at_ms: Date.now() + 3600000,
        },
    });
    assert.ok(htmlOff.includes('id="quota-exhausted-banner"'));
    assert.ok(htmlOn.includes('id="quota-exhausted-banner"'));
    assert.ok(htmlOff.includes('data-active="false"'));
    assert.ok(htmlOn.includes('data-active="true"'));
});

test('CA-12: tickQuotaExhausted está registrado en POLLS independientemente del flag', () => {
    const html = home.renderHomeHTML({ quotaState: { active: false } });
    assert.ok(html.includes('tickQuotaExhausted'),
        'la función de polling debe estar embebida en el script siempre (igual flag inactivo, el cliente sigue checkeando)');
    assert.ok(html.includes('/api/dash/quota-exhausted'),
        'el endpoint que sirve el slice debe ser fetcheado por el cliente');
});

// -----------------------------------------------------------------------------
// CA-10 — XSS: error_type con HTML malicioso queda escapado en el render
// -----------------------------------------------------------------------------

test('CA-10: el script cliente define escapeHtml y lo usa para error_type/skills', () => {
    const html = home.renderHomeHTML({ quotaState: { active: false } });
    // La función escapeHtml debe estar embebida en el script cliente.
    assert.ok(/function\s+escapeHtml\s*\(/.test(html),
        'escapeHtml debe estar definido en el script cliente');
    // Y el render del banner DEBE invocarla sobre los strings del JSON
    // (defensa en profundidad CA-10).
    assert.ok(html.includes('escapeHtml(d.error_type)') || html.includes("escapeHtml(d.error_type"),
        'escapeHtml debe aplicarse a error_type del slice');
});

test('CA-10: SSR escapa <script> en error_type — payload XSS no ejecutable', () => {
    const html = home.renderHomeHTML({
        quotaState: {
            active: true,
            error_type: '<script>alert(1)</script>',
            detected_at: '2026-05-05T01:00:00.000Z',
            resets_at: '2026-05-05T05:00:00.000Z',
            resets_at_ms: Date.parse('2026-05-05T05:00:00.000Z'),
        },
    });
    // El payload debe aparecer como entidades HTML, NO como tag.
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
        'error_type con HTML peligroso debe estar HTML-escapeado en el SSR');
    // Y NO debe aparecer el tag literal en ningún lugar nuevo (los <script>
    // que YA están en el template son solo para inyectar el JS del cliente).
    const dangerousMatches = html.match(/<script>alert\(1\)<\/script>/g);
    assert.equal(dangerousMatches, null,
        'el HTML servido NO debe contener el payload <script>alert(1)</script> sin escapar');
});

test('CA-10: SSR escapa quotes en detected_at/resets_at', () => {
    // Aunque ISO timestamps no llevan ", defensemos contra regresiones
    // donde un timestamp manipulado tenga caracteres HTML.
    const html = home.renderHomeHTML({
        quotaState: {
            active: true,
            error_type: 'usage_limit_error',
            detected_at: '"><img src=x onerror=alert(1)>',
            resets_at: '2026-05-05T05:00:00.000Z',
            resets_at_ms: Date.parse('2026-05-05T05:00:00.000Z'),
        },
    });
    // Los símbolos peligrosos deben aparecer escapeados.
    assert.ok(html.includes('&quot;&gt;&lt;img'),
        'caracteres HTML maliciosos en detected_at deben estar escapeados');
    // Y NO debe haber un onerror= ejecutable en el HTML.
    assert.ok(!html.includes('onerror=alert(1)>'),
        'el payload XSS no debe aparecer ejecutable');
});

// -----------------------------------------------------------------------------
// Defensa: el slice NUNCA tira aunque el state esté roto
// -----------------------------------------------------------------------------

test('Defensa: slice tolera state vacío sin tirar', () => {
    clearFlag();
    const out = slices.quotaExhaustedSlice({});
    assert.equal(out.active, false);
    assert.equal(out.deterministicRunning, 0);
});

test('Defensa: slice tolera state.issueMatrix con entries malformados', () => {
    writeFlag({
        exhausted: true,
        resets_at: new Date(Date.now() + 3600000).toISOString(),
        detected_at: new Date().toISOString(),
        pattern_matched: 'usage_limit_error',
    });
    try {
        const out = slices.quotaExhaustedSlice({
            issueMatrix: {
                'broken1': null,
                'broken2': { fases: null },
                'broken3': { fases: { dev: null } },
                'ok': { fases: { dev: [{ estado: 'pendiente', skill: 'guru' }] } },
            },
        });
        assert.equal(out.active, true);
        assert.equal(out.queuedCount, 1);
    } finally {
        clearFlag();
    }
});

// Cleanup global del dir temporal después de todos los tests del file.
test.after(() => {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});
