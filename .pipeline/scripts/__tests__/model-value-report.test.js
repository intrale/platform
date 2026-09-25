// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// model-value-report.test.js — CLI read-only (#7519, CA-19 / CA-19b / CA-20).
//
// `main(argv, deps)` con TODO inyectado: `fsImpl` espía que registra cada
// primitiva de escritura, `auditLog` mock (el real hace mkdirSync + lockfile,
// SEC-R7), `configResolver` / `pricing` / hermanos fake, stdout/stderr
// capturados. Ninguna corrida toca el filesystem real.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const cli = require('../model-value-report');
const { canonicalJsonStringify } = require('../../lib/audit-log');
const { AUDIT_FILE } = require('../../lib/model-value-audit/audit');

const NOW = Date.parse('2026-09-21T12:00:00.000Z');
const PIPELINE_DIR = 'fixture-7519-cli';
const ROOT = path.resolve(PIPELINE_DIR);

const AGENT_MODELS_JSON = JSON.stringify({
    providers: { anthropic: { model: 'claude-opus-4-7' }, deterministic: { model: 'deterministic' } },
    skills: { guru: { provider: 'anthropic', model_override: 'claude-sonnet-4-6' }, doc: { provider: 'anthropic', model_override: 'claude-sonnet-4-6' } },
});
const TABLE = { anthropic: { 'claude-opus-4-7': { in: 15, out: 75 }, 'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-haiku-4-5': { in: 1, out: 5 } }, deterministic: { deterministic: { in: 0, out: 0 } } };
const CONFIG = {
    pipeline: { model_propagation: { enabled: false } },
    pipelines: { desarrollo: { skills_por_fase: { dev: ['backend-dev'], analisis: ['guru'], verificacion: ['doc'] } } },
};

const ESCRITURAS = ['writeFileSync', 'appendFileSync', 'unlinkSync', 'renameSync', 'rmSync', 'mkdirSync', 'writeFile', 'openSync', 'closeSync', 'chmodSync', 'copyFileSync', 'truncateSync', 'createWriteStream', 'rmdirSync', 'symlinkSync', 'utimesSync'];

function capt() { return { s: '', write(t) { this.s += String(t); return true; } }; }

function spawnRow(i) {
    return { ts: NOW - (i + 1) * 3600000, skill: 'guru', issue: String(7000 + i), provider: 'anthropic', exit_code: 0, duration_ms: 60000, death_kind: null, codepath: 'generalized' };
}
function modelRow(i) {
    return { ts: NOW - (i + 1) * 3600000, issue: String(7000 + i), skill: 'guru', provider: 'anthropic', model_effective: 'claude-sonnet-4-6', source: 'stream' };
}
function fuente(rows, estado = 'no_verificada') {
    return { rows, evaluable: true, integridad: { estado, broken: [], skipped: [], files: 1, lines: rows.length, rows: rows.length, sin_ts: 0, sin_issue: 0, filtradas: 0, lineas_corruptas: 0, schema_mismatch: false } };
}

function makeDeps(over = {}) {
    const writes = [];
    const reads = [];
    const fsImpl = {
        readFileSync(p, enc) {
            reads.push(String(p));
            if (String(p) === path.join(ROOT, 'agent-models.json')) return enc ? AGENT_MODELS_JSON : Buffer.from(AGENT_MODELS_JSON, 'utf8');
            throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
        },
        existsSync: () => false,
        statSync: () => { throw new Error('ENOENT'); },
        readdirSync: () => [],
    };
    for (const prim of ESCRITURAS) {
        fsImpl[prim] = (...args) => { writes.push({ prim, target: String(args[0]) }); return prim === 'openSync' ? 3 : undefined; };
    }
    const appendCalls = [];
    const auditLog = over.auditLog || {
        appendChained({ file, entry, fsImpl: f }) { appendCalls.push({ file, entry, fsImpl: f }); return { hash_self: 'h'.repeat(64), hash_prev: 'GENESIS', line: '' }; },
    };
    const resolverCalls = [];
    const configResolver = over.configResolver || { resolve(args) { resolverCalls.push(args); return CONFIG; } };
    const pricing = { invalidations: 0, invalidateCache() { this.invalidations++; }, pricingByProvider: () => TABLE };
    const sourcesCalls = [];
    const sources = over.sources || {
        spawn_exit: fuente([...Array(12).keys()].map(spawnRow), 'verificada'),
        rebound_events: fuente([]),
        effective_model: fuente([...Array(12).keys()].map(modelRow)),
        provider_cost: fuente([{ ts: NOW - 3600000, provider: 'anthropic', skill: 'guru', issue: '7000', tokens_in: 1e6, tokens_out: 1e6, cache: 'no_medido' }]),
        label_mutations: fuente([]),
        ventana: {},
    };
    const stdout = capt();
    const stderr = capt();
    return {
        writes, reads, appendCalls, resolverCalls, sourcesCalls, stdout, stderr, pricing,
        deps: {
            stdout, stderr, fsImpl, auditLog, configResolver, pricing,
            pricingFreshness: { evaluate: () => ({ stale: true, motivo: 'antiguedad', missing_models: [], sha256: 'b'.repeat(64), version: 1, updated_at: '2026-05-08T00:00:00Z', source_kind: 'json' }) },
            readSources: (args) => { sourcesCalls.push(args); return sources; },
            reboundSince: '2026-08-01T00:00:00.000Z',
            now: () => NOW,
            ...(over.deps || {}),
        },
    };
}

// ---------------------------------------------------------------------------
// CA-19 · parseArgs y flags
// ---------------------------------------------------------------------------
test('CA-19 / C1 · --dias=29 ⇒ exit 1 con "mínimo 30" en stderr y stdout vacio; --dias=30 pasa; no numerico ⇒ 1', () => {
    let f = makeDeps();
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--dias=29'], f.deps), 1);
    assert.match(f.stderr.s, /\[model-value-report\] --dias: mínimo 30 \(recibido 29\)/);
    assert.equal(f.stdout.s, '');
    assert.equal(f.resolverCalls.length, 0, 'no se llega a la config');

    f = makeDeps();
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--dias=30'], f.deps), 0);
    assert.equal(f.stderr.s, '');

    f = makeDeps();
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--dias=abc', '--json'], f.deps), 1);
    assert.equal(f.stdout.s, '');
    assert.match(f.stderr.s, /--dias: valor invalido/);

    const p = cli.parseArgs(['--dias=45.7']);
    assert.equal(p.dias, 45);
    assert.deepEqual(p.errors, []);
    assert.equal(cli.parseArgs([]).dias, 30);
    assert.equal(cli.parseArgs(['--dias=7']).errors.length, 1, 'el espejo no valida el minimo; este CLI si');
    assert.equal(cli.MIN_WINDOW_DAYS, 30);
});

test('CA-19 · --hasta invalido (2026-13-01, 2026-02-30, texto) ⇒ exit 1 y stdout vacio; valido fija el fin de la ventana', () => {
    for (const malo of ['2026-13-01', '2026-02-30', 'ayer', '']) {
        const f = makeDeps();
        assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, `--hasta=${malo}`, '--json'], f.deps), 1, malo);
        assert.equal(f.stdout.s, '');
        assert.match(f.stderr.s, /--hasta: formato invalido/);
    }
    const f = makeDeps();
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--hasta=2026-09-01', '--json'], f.deps), 0);
    const rep = JSON.parse(f.stdout.s);
    assert.equal(rep.ventana.to, '2026-09-01T23:59:59.999Z');
    assert.equal(f.sourcesCalls[0].to, Date.parse('2026-09-01T23:59:59.999Z'));
});

test('CA-19 · opcion desconocida y --pipeline-dir sin valor ⇒ exit 1', () => {
    let f = makeDeps();
    assert.equal(cli.main(['--umbral-tasa=0.5'], f.deps), 1);
    assert.match(f.stderr.s, /opcion desconocida: --umbral-tasa/);
    f = makeDeps();
    assert.equal(cli.main(['--pipeline-dir'], f.deps), 1);
    assert.match(f.stderr.s, /--pipeline-dir: valor requerido/);
});

test('CA-19 / C13 · --json emite SOLO JSON parseable con sha256 reproducible; stderr vacio', () => {
    const f = makeDeps();
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--json'], f.deps), 0);
    assert.equal(f.stderr.s, '');
    const rep = JSON.parse(f.stdout.s);
    assert.match(rep.sha256, /^[0-9a-f]{64}$/);
    const { sha256, ...sin } = rep;
    assert.equal(crypto.createHash('sha256').update(canonicalJsonStringify(sin), 'utf8').digest('hex'), sha256);
    assert.equal(f.stdout.s.trim().startsWith('{'), true);
    assert.equal(f.stdout.s.trim().endsWith('}'), true);
    assert.deepEqual(rep.advertencias, ['propagacion_apagada']);
    assert.equal(rep.skills.guru.veredicto, 'bajar');
    assert.equal(rep.skills.guru.evidencia.modelo_destino, 'claude-haiku-4-5');
    assert.equal(rep.generado_en, '2026-09-21T12:00:00.000Z');
    assert.equal(f.pricing.invalidations, 1);
});

test('CA-19 · salida humana con cabecera y Regenerar; --compacto ⇒ 4 columnas', () => {
    let f = makeDeps();
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--hasta=2026-09-21'], f.deps), 0);
    assert.match(f.stdout.s, /AUDITORÍA DE MODELOS POR AGENTE/);
    assert.match(f.stdout.s, /Regenerar: node \.pipeline\/scripts\/model-value-report\.js --dias=30 --hasta=2026-09-21\n/);
    const head = f.stdout.s.split('\n').find((l) => l.startsWith('| Skill |'));
    assert.equal(head.split('|').length, 14, '12 columnas');
    assert.match(f.stdout.s, /\| guru \| claude-sonnet-4-6 \| claude-sonnet-4-6 \| no \| 12 \|/);
    assert.match(f.stdout.s, /bajar de modelo/);

    f = makeDeps();
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--compacto'], f.deps), 0);
    const headC = f.stdout.s.split('\n').find((l) => l.startsWith('| Skill |'));
    assert.equal(headC, '| Skill | Modelo efectivo | Veredicto | n |');
    assert.match(f.stdout.s, /Regenerar: .* --compacto/);
});

test('CA-19 · --pipeline-dir=rel/dir ⇒ runAudit recibe path.resolve(rel/dir) (config, agent-models.json y fuentes)', () => {
    const f = makeDeps();
    cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--json'], f.deps);
    assert.deepEqual(f.resolverCalls, [{ pipelineDir: ROOT, reload: true }]);
    assert.equal(f.sourcesCalls[0].pipelineDir, ROOT);
    assert.deepEqual(f.reads, [path.join(ROOT, 'agent-models.json')]);
    assert.ok(path.isAbsolute(f.sourcesCalls[0].pipelineDir));
});

test('CA-19 · reproducibleCommand incluye --dias, --hasta y --compacto', () => {
    assert.equal(cli.reproducibleCommand({ dias: 45, hasta: '2026-09-01', compacto: true }), 'node .pipeline/scripts/model-value-report.js --dias=45 --hasta=2026-09-01 --compacto');
    assert.equal(cli.reproducibleCommand({ dias: 30 }), 'node .pipeline/scripts/model-value-report.js --dias=30');
    assert.equal(cli.AUDIT_FILE, AUDIT_FILE);
    assert.deepEqual(Object.keys(cli).sort(), ['AUDIT_FILE', 'DEFAULT_WINDOW_DAYS', 'MIN_WINDOW_DAYS', 'main', 'parseArgs', 'reproducibleCommand']);
});

test('deps.args con reloj fijo (patron del espejo) pisa los argumentos parseados', () => {
    const f = makeDeps({ deps: { now: undefined } });
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--json'], { ...f.deps, args: { now: NOW - 86400000 } }), 0);
    assert.equal(JSON.parse(f.stdout.s).generado_en, '2026-09-20T12:00:00.000Z');
});

// ---------------------------------------------------------------------------
// CA-19b · códigos de salida y --json puro
// ---------------------------------------------------------------------------
test('CA-19b · configResolver que lanza ⇒ exit 1, stdout vacio (tambien con --json), mensaje en stderr', () => {
    for (const flags of [[], ['--json']]) {
        const f = makeDeps({ configResolver: { resolve() { throw new Error('ConfigParseViolation: config.yaml:3:1'); } } });
        assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, ...flags], f.deps), 1);
        assert.equal(f.stdout.s, '');
        assert.match(f.stderr.s, /\[model-value-report\] ConfigParseViolation: config\.yaml:3:1/);
        assert.equal(f.writes.length, 0);
    }
});

test('CA-19b / SEC-R5 / SEC-R6 · appendChained que lanza con --registrar --json ⇒ exit 2, stdout vacio, stderr con "audit:"', () => {
    const f = makeDeps({ auditLog: { appendChained() { throw new Error('No se pudo adquirir lock'); } } });
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--registrar', '--json'], f.deps), 2);
    assert.equal(f.stdout.s, '');
    assert.match(f.stderr.s, /\[model-value-report\] audit: No se pudo adquirir lock/);
    // Sin --json también es 2 y no imprime el reporte (la decisión no quedó registrada).
    const g = makeDeps({ auditLog: { appendChained() { throw new Error('EACCES'); } } });
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--registrar'], g.deps), 2);
    assert.equal(g.stdout.s, '');
});

// ---------------------------------------------------------------------------
// CA-20 (c) · read-only por contrato, funcional
// ---------------------------------------------------------------------------
test('CA-20 · sin --registrar ⇒ CERO escrituras en el fsImpl espia y cero appendChained (json, humano y compacto)', () => {
    for (const flags of [[], ['--json'], ['--compacto'], ['--json', '--hasta=2026-09-01']]) {
        const f = makeDeps();
        assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, ...flags], f.deps), 0, flags.join(' '));
        assert.deepEqual(f.writes, [], `escrituras con ${flags.join(' ')}`);
        assert.equal(f.appendCalls.length, 0);
    }
});

test('CA-20 · con --registrar ⇒ exactamente UNA appendChained en <pipelineDir>/audit/model-value-audit.jsonl; nada sobre agent-models.json, config.yaml, state/ ni metrics/', () => {
    const f = makeDeps();
    assert.equal(cli.main([`--pipeline-dir=${PIPELINE_DIR}`, '--registrar', '--json'], f.deps), 0);
    const esperado = path.join(ROOT, 'audit', AUDIT_FILE);
    assert.equal(f.appendCalls.length, 1);
    assert.equal(f.appendCalls[0].file, esperado);
    assert.equal(f.appendCalls[0].fsImpl, f.deps.fsImpl, 'el fsImpl inyectado llega al audit-log');
    const rep = JSON.parse(f.stdout.s);
    assert.equal(f.appendCalls[0].entry.report_sha256, rep.sha256);
    assert.deepEqual(Object.keys(f.appendCalls[0].entry).sort(), ['agent_models_sha256', 'integridad', 'pricing', 'propagation_enabled', 'report_sha256', 'skills', 'ts', 'ventana']);
    // Las únicas primitivas del espía son las de ensureSecureAuditFile, todas sobre el path del audit.
    const auditDir = path.join(ROOT, 'audit');
    for (const w of f.writes) {
        assert.ok(['mkdirSync', 'openSync', 'closeSync', 'chmodSync'].includes(w.prim), `primitiva inesperada ${w.prim}`);
        if (w.prim === 'closeSync') continue;
        assert.ok(w.target === esperado || w.target === auditDir, `escritura fuera del audit: ${w.prim} ${w.target}`);
    }
    const prohibidos = [/agent-models\.json$/, /config\.yaml$/, /[\\/]state[\\/]/, /[\\/]metrics[\\/]/, /pricing/];
    for (const w of f.writes) for (const re of prohibidos) assert.ok(!re.test(w.target), `escritura prohibida: ${w.target}`);
    assert.ok(f.writes.some((w) => w.prim === 'openSync' && w.target === esperado), 'ensureSecureAuditFile abre el archivo del audit');
});

// ---------------------------------------------------------------------------
// Smoke real del binario (sin datos: sólo la validación de argumentos)
// ---------------------------------------------------------------------------
test('el script como proceso: --dias=7 ⇒ exit ≠ 0 con "mínimo 30" (C1) y process.exitCode = main()', () => {
    const script = path.join(__dirname, '..', 'model-value-report.js');
    let code = 0;
    let stderr = '';
    try {
        execFileSync(process.execPath, [script, '--dias=7'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch (err) {
        code = err.status;
        stderr = String(err.stderr || '');
    }
    assert.equal(code, 1);
    assert.match(stderr, /mínimo 30/);
    assert.match(require('node:fs').readFileSync(script, 'utf8'), /if \(require\.main === module\) \{\s*process\.exitCode = main\(\);/);
});
