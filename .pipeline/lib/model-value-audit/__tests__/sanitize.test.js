'use strict';

// Tests de `sanitize.js` (#7517): whitelists desde la config resuelta,
// enums cerrados, `stripForOutput` y anti-inyección (SEC-3 / SEC-5b / SEC-7b).

const test = require('node:test');
const assert = require('node:assert');

const sz = require('../sanitize');
const handoff = require('../../handoff');

// Config resuelta mínima: dos pipelines con `skills_por_fase` (mismo shape que
// `configResolver.resolve()` devuelve hoy).
const CONFIG = {
    pipelines: {
        definicion: {
            skills_por_fase: {
                analisis: ['guru', 'security'],
                criterios: ['po', 'architect', 'ux'],
                sizing: ['planner'],
            },
        },
        desarrollo: {
            skills_por_fase: {
                validacion: ['guru', 'po', 'ux'],
                dev: ['pipeline-dev', 'backend-dev', 'android-dev'],
                verificacion: ['tester', 'qa'],
                aprobacion: ['review', 'po'],
                entrega: ['delivery'],
            },
        },
    },
};

const AGENT_MODELS = {
    providers: {
        anthropic: {},
        'openai-codex': {},
        antigravity: {},
        deterministic: {},
    },
};

function whitelists() {
    return {
        skills: sz.allowedSkills(CONFIG),
        phases: sz.allowedPhases(CONFIG),
        providers: sz.allowedProviders(AGENT_MODELS),
    };
}

function fila(over = {}) {
    return {
        ts: Date.parse('2026-09-10T12:00:00.000Z'),
        skill: 'guru',
        issue: '7517',
        provider: 'anthropic',
        exit_code: 0,
        duration_ms: 1000,
        death_kind: 'normal',
        codepath: 'generalized',
        ...over,
    };
}

/**
 * Construye en runtime un texto que dispara `detectInjection` a partir de la
 * fuente de cada regex de la denylist: sin grupos opcionales, primera
 * alternativa de cada `(?:a|b)`, primer char de cada clase, `\s+` → espacio.
 * Así el repo no contiene ningún literal de la denylist (SEC-7b).
 */
function derivarPayload(re) {
    let s = re.source;
    s = s.replace(/\\b/g, '');
    for (let i = 0; i < 3; i++) {
        s = s.replace(/\(\?:([^()]*)\)\?/g, '');
        s = s.replace(/\(\?:([^()]*)\)/g, (m, g) => g.split('|')[0]);
    }
    s = s.replace(/\[([^\]]+)\]/g, (m, g) => g[0]);
    s = s.replace(/\\s[+*]/g, ' ');
    s = s.replace(/([a-zá])\?/gi, '$1');
    s = s.replace(/\\/g, '');
    return s.replace(/\s+/g, ' ').trim();
}

// -----------------------------------------------------------------------------
// Whitelists (CA-12)
// -----------------------------------------------------------------------------

test('allowedSkills devuelve la union de skills_por_fase de todos los pipelines (dispatchableActors real)', () => {
    const skills = sz.allowedSkills(CONFIG);
    assert.ok(skills instanceof Set);
    assert.deepStrictEqual([...skills].sort(), [
        'android-dev', 'architect', 'backend-dev', 'delivery', 'guru', 'pipeline-dev', 'planner', 'po', 'qa', 'review', 'security', 'tester', 'ux',
    ]);
});

test('allowedPhases devuelve la union de las fases de todos los pipelines', () => {
    assert.deepStrictEqual([...sz.allowedPhases(CONFIG)].sort(), [
        'analisis', 'aprobacion', 'criterios', 'dev', 'entrega', 'sizing', 'validacion', 'verificacion',
    ]);
    assert.deepStrictEqual([...sz.allowedPhases({})], []);
});

test('allowedProviders acepta la config o el resultado {ok, config} de loadAndValidate', () => {
    assert.deepStrictEqual([...sz.allowedProviders(AGENT_MODELS)].sort(), ['anthropic', 'antigravity', 'deterministic', 'openai-codex']);
    assert.deepStrictEqual([...sz.allowedProviders({ ok: true, config: AGENT_MODELS })].sort(), ['anthropic', 'antigravity', 'deterministic', 'openai-codex']);
    assert.deepStrictEqual([...sz.allowedProviders(null)], []);
});

test('resolveWhitelists propaga la excepcion del configResolver con el mismo mensaje (SEC-5b)', () => {
    const configResolver = { resolve: () => { const e = new Error('ConfigSchemaViolation: pipelines.desarrollo.skills_por_fase invalido'); e.name = 'ConfigSchemaViolation'; throw e; } };
    const agentModels = { loadAndValidate: () => ({ ok: true, config: AGENT_MODELS }) };
    assert.throws(
        () => sz.resolveWhitelists({ pipelineDir: '/fake', configResolver, agentModels }),
        (err) => err.name === 'ConfigSchemaViolation' && err.message === 'ConfigSchemaViolation: pipelines.desarrollo.skills_por_fase invalido',
    );
});

test('resolveWhitelists pasa reload:true al resolver, lanza si agent-models no valida y arma los tres Sets', () => {
    const llamadas = [];
    const configResolver = { resolve: (opts) => { llamadas.push(opts); return CONFIG; } };
    const ok = sz.resolveWhitelists({ pipelineDir: '/fake', configResolver, agentModels: { loadAndValidate: () => ({ ok: true, config: AGENT_MODELS }) } });
    assert.deepStrictEqual(llamadas, [{ pipelineDir: '/fake', reload: true }]);
    assert.ok(ok.skills.has('guru') && ok.phases.has('dev') && ok.providers.has('anthropic'));

    assert.throws(
        () => sz.resolveWhitelists({ pipelineDir: '/fake', configResolver, agentModels: { loadAndValidate: () => ({ ok: false, errors: [{ x: 1 }] }) } }),
        /agent-models\.json no valida/,
    );
});

// -----------------------------------------------------------------------------
// sanitizeRows — descarte entero + conteos (CA-12 / SEC-3b)
// -----------------------------------------------------------------------------

test('sanitizeRows deja pasar filas validas intactas y devuelve conteos en cero', () => {
    const res = sz.sanitizeRows([fila(), fila({ issue: null, death_kind: null, codepath: null })], whitelists());
    assert.strictEqual(res.rows.length, 2);
    assert.deepStrictEqual(res.rows[0], fila());
    assert.strictEqual(res.rows[1].issue, null);
    assert.deepStrictEqual(res.desconocidos, { skills: 0, providers: 0, models: 0, phases: 0, death_kinds: 0, codepaths: 0, issues: 0, numericos: 0 });
});

test('los providers historicos nvidia-nim, cerebras y gemini-google cuentan en desconocidos.providers y no aparecen en rows', () => {
    const rows = [fila({ provider: 'nvidia-nim' }), fila({ provider: 'cerebras' }), fila({ provider: 'gemini-google' }), fila()];
    const res = sz.sanitizeRows(rows, whitelists());
    assert.strictEqual(res.desconocidos.providers, 3);
    assert.strictEqual(res.rows.length, 1);
    const dump = JSON.stringify(res);
    for (const p of ['nvidia-nim', 'cerebras', 'gemini-google']) assert.ok(!dump.includes(p), `${p} no debe aparecer en la salida`);
});

test('skill fuera de la whitelist ⇒ desconocidos.skills y la fila se descarta entera', () => {
    const res = sz.sanitizeRows([fila({ skill: 'commander' }), fila({ skill: 42 })], whitelists());
    assert.strictEqual(res.desconocidos.skills, 2);
    assert.deepStrictEqual(res.rows, []);
    assert.ok(!JSON.stringify(res).includes('commander'));
});

test('death_kind fuera del enum, rechazado_en_fase fuera de las fases y codepath desconocido se cuentan por categoria', () => {
    const res = sz.sanitizeRows([
        fila({ death_kind: 'sudden' }),
        fila({ rechazado_en_fase: 'produccion' }),
        fila({ rechazado_en_fase: 'verificacion' }),
        fila({ codepath: 'x' }),
        fila({ codepath: 'premature-death' }),
    ], whitelists());
    assert.strictEqual(res.desconocidos.death_kinds, 1);
    assert.strictEqual(res.desconocidos.phases, 1);
    assert.strictEqual(res.desconocidos.codepaths, 1);
    assert.strictEqual(res.rows.length, 2);
    assert.ok(Object.isFrozen(sz.DEATH_KINDS) && Object.isFrozen(sz.CODEPATHS));
    assert.deepStrictEqual([...sz.DEATH_KINDS], ['normal', 'agent-death', 'provider-death', 'credential-death']);
    assert.deepStrictEqual([...sz.CODEPATHS], ['generalized', 'legacy', 'premature-death']);
});

test('exit_code no numerico ⇒ fila descartada; strings estrictamente numericos se aceptan', () => {
    const res = sz.sanitizeRows([fila({ exit_code: 'abc' }), fila({ duration_ms: '1500', exit_code: '1' }), fila({ tokens_in: NaN })], whitelists());
    assert.strictEqual(res.desconocidos.numericos, 2);
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.rows[0].duration_ms, 1500);
    assert.strictEqual(res.rows[0].exit_code, 1);
});

test('exit_code null (muerte por senal del writer) ⇒ fila conservada con exit_code null, nunca 0 (CA-12 / SEC-3b)', () => {
    const res = sz.sanitizeRows([fila({ exit_code: null, duration_ms: 1884243, death_kind: 'agent-death' }), fila({ exit_code: undefined })], whitelists());
    assert.strictEqual(res.desconocidos.numericos, 0);
    assert.strictEqual(res.rows.length, 2);
    assert.strictEqual(res.rows[0].exit_code, null);
    assert.strictEqual(res.rows[0].duration_ms, 1884243);
    assert.strictEqual(res.rows[1].exit_code, null);
    assert.ok(res.rows.every((r) => r.exit_code !== 0), 'null no se coacciona a 0');
    // Mismo criterio para el resto de los numericos.
    const costo = sz.sanitizeRows([fila({ tokens_in: null, tokens_out: null })], whitelists());
    assert.deepStrictEqual([costo.rows[0].tokens_in, costo.rows[0].tokens_out], [null, null]);
});

test('exit_code "", " ", [], {}, true, false, Infinity ⇒ desconocidos.numericos y fila descartada (no se coacciona con Number())', () => {
    const malos = ['', ' ', [], {}, true, false, Infinity, -Infinity, '0x10', '1e3', ' 1', '1 '];
    const res = sz.sanitizeRows(malos.map((v) => fila({ exit_code: v })), whitelists());
    assert.strictEqual(res.desconocidos.numericos, malos.length);
    assert.strictEqual(res.rows.length, 0);
    for (const v of ['', ' ', [], true]) assert.strictEqual(sz.safeNumber(v), undefined, `safeNumber(${JSON.stringify(v)})`);
    assert.strictEqual(sz.safeNumber(null), null);
    assert.strictEqual(sz.safeNumber(undefined), null);
    assert.strictEqual(sz.safeNumber(137), 137);
    assert.strictEqual(sz.safeNumber('-1'), -1);
    assert.strictEqual(sz.safeNumber('2.5'), 2.5);
});

test('passthrough acotado: solo ts/source/label/action/cache se copian; cualquier otra clave se ignora', () => {
    assert.deepStrictEqual([...sz.PASSTHROUGH_FIELDS], ['ts', 'source', 'label', 'action', 'cache']);
    const res = sz.sanitizeRows([fila({
        source: 'observed', label: 'qa:failed', action: 'label', cache: 'no_medido',
        __proto__polluted: 'x', extra: 'ignorado', constructor: 'y', 'ignore previous': 'z',
    })], whitelists());
    assert.strictEqual(res.rows.length, 1);
    const r = res.rows[0];
    assert.deepStrictEqual(Object.keys(r).sort(), ['action', 'cache', 'codepath', 'death_kind', 'duration_ms', 'exit_code', 'issue', 'label', 'provider', 'skill', 'source', 'ts']);
    assert.strictEqual(r.extra, undefined);
    assert.strictEqual(r['ignore previous'], undefined);
});

test('issue ../x y 12345678 ⇒ desconocidos.issues; null se conserva; numero valido se devuelve como string (A3)', () => {
    const res = sz.sanitizeRows([fila({ issue: '../x' }), fila({ issue: '12345678' }), fila({ issue: null }), fila({ issue: 7517 })], whitelists());
    assert.strictEqual(res.desconocidos.issues, 2);
    assert.deepStrictEqual(res.rows.map((r) => r.issue), [null, '7517']);
    assert.strictEqual(sz.safeIssue(null), null);
    assert.strictEqual(sz.safeIssue(undefined), null);
    assert.strictEqual(sz.safeIssue('0000001'), '0000001');
    assert.strictEqual(sz.safeIssue('12345678'), undefined);
    assert.strictEqual(sz.safeIssue('7517abc'), undefined);
});

test('model_effective se renormaliza con normalizeModelId; null se conserva; basura cuenta en models', () => {
    const res = sz.sanitizeRows([
        fila({ model_effective: 'Claude-Opus-5[1m]' }),
        fila({ model_effective: null }),
        fila({ model_effective: 'modelo con espacios!' }),
    ], whitelists());
    assert.strictEqual(res.desconocidos.models, 1);
    assert.deepStrictEqual(res.rows.map((r) => r.model_effective), ['claude-opus-5', null]);
    assert.strictEqual(sz.safeModel('claude-opus-5'), 'claude-opus-5');
    assert.strictEqual(sz.safeModel('no válido'), null);
});

test('las filas de label-mutations (sin skill ni provider) pasan la sanitizacion', () => {
    const res = sz.sanitizeRows([{ ts: 1, issue: '6145', label: 'qa:failed', action: 'label' }], whitelists());
    assert.strictEqual(res.rows.length, 1);
    assert.deepStrictEqual(res.rows[0], { ts: 1, issue: '6145', label: 'qa:failed', action: 'label' });
});

test('sanitizeRows exige whitelists como Sets y tolera rows no-array o filas nulas', () => {
    assert.throws(() => sz.sanitizeRows([], {}), /whitelists/);
    assert.deepStrictEqual(sz.sanitizeRows(null, whitelists()).rows, []);
    const res = sz.sanitizeRows([null, 'x', fila()], whitelists());
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.desconocidos.skills, 2);
});

// -----------------------------------------------------------------------------
// stripForOutput (CA-18 / A2)
// -----------------------------------------------------------------------------

test('stripForOutput quita ESC, LS, RLO, CR/LF y zero-width, hace String y acota a 120 sin tocar ids ni fechas', () => {
    const ESC = String.fromCharCode(0x1b);
    const LS = String.fromCharCode(0x2028);
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const BOM = String.fromCharCode(0xfeff);
    const DEL = String.fromCharCode(0x7f);
    const C1 = String.fromCharCode(0x85);

    const entrada = `${ESC}[31mclaude-opus-5${LS} 2026-09-21${RLO}\r\n${ZWSP}${BOM}${DEL}${C1}\tfin`;
    const salida = sz.stripForOutput(entrada);
    for (const ch of [ESC, LS, RLO, ZWSP, BOM, DEL, C1, '\r', '\n', '\t']) assert.ok(!salida.includes(ch), `no debe contener U+${ch.charCodeAt(0).toString(16)}`);
    assert.ok(salida.includes('claude-opus-5'));
    assert.ok(salida.includes('2026-09-21'));
    assert.strictEqual(salida, '[31mclaude-opus-5 2026-09-21fin');

    assert.strictEqual(sz.stripForOutput({}), '[object Object]');
    assert.strictEqual(sz.stripForOutput(null), 'null');
    assert.strictEqual(sz.stripForOutput(42), '42');
    const largo = sz.stripForOutput('a'.repeat(500));
    assert.strictEqual(largo.length, 120);
    assert.strictEqual(sz.OUTPUT_MAX_CHARS, 120);

    // El rango del body `[\r\n\t-^_]` habría destruido esto: acá queda intacto.
    assert.strictEqual(sz.stripForOutput('android-dev 2026-09-21 A1 claude-opus-5 48,0 % :.-_'), 'android-dev 2026-09-21 A1 claude-opus-5 48,0 % :.-_');
});

// -----------------------------------------------------------------------------
// Anti-inyección (CA-19 / SEC-7b)
// -----------------------------------------------------------------------------

test('un skill con salto de linea y un payload derivado de handoff.INJECTION_PATTERNS no sobrevive a sanitizeRows', () => {
    assert.ok(Array.isArray(handoff.INJECTION_PATTERNS) && handoff.INJECTION_PATTERNS.length >= 12);

    const payloads = handoff.INJECTION_PATTERNS.map(derivarPayload);
    // Cada payload derivado dispara el detector ANTES de sanitizar.
    for (const p of payloads) {
        assert.ok(handoff.detectInjection(`${p} x`).hits.length > 0, `el payload derivado no dispara el detector: ${JSON.stringify(p)}`);
    }

    const rows = payloads.map((p) => fila({ skill: `guru\n${p}` }));
    rows.push(fila({ skill: `guru\r\n${payloads[0]}`, provider: `anthropic\n${payloads[1]}` }));
    rows.push(fila({ rechazado_en_fase: `dev\n${payloads[2]}` }));
    rows.push(fila({ model_effective: `claude-opus-5 ${payloads[3]}` }));
    rows.push(fila({ issue: `7517\n${payloads[4]}` }));

    const res = sz.sanitizeRows(rows, whitelists());
    assert.deepStrictEqual(res.rows, []);
    const dump = JSON.stringify(res);
    for (const p of payloads) assert.ok(!dump.includes(p), 'el payload no debe aparecer en la salida');
    assert.ok(!dump.includes('\n'));
    assert.strictEqual(handoff.detectInjection(dump).hits.length, 0);
    assert.strictEqual(res.desconocidos.skills, payloads.length + 1);
    assert.strictEqual(res.desconocidos.phases, 1);
    assert.strictEqual(res.desconocidos.models, 1);
    assert.strictEqual(res.desconocidos.issues, 1);
});
