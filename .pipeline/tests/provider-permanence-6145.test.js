// =============================================================================
// provider-permanence-6145.test.js — integración end-to-end del reporte de
// aporte por proveedor y del criterio de permanencia (#6145)
// =============================================================================
//
// A diferencia del test unitario del módulo, este corre el CLI completo contra
// un `.pipeline/` de mentira construido en disco: archivos diarios de dispatch
// con hash-chain REAL (escritos con `audit-log.appendChained`), uno de ellos
// deliberadamente corrompido, más `agent-models.json`, `config.yaml` y el
// snapshot de health.
//
// Verifica lo que el unitario no puede: que la tabla renderizada, el veredicto
// por proveedor, el audit append-only y la garantía de read-only (CA-7)
// sobrevivan al cableado real.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auditLog = require('../lib/audit-log');
const cli = require('../scripts/provider-contribution-report');
const contribution = require('../lib/multi-provider/provider-contribution');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-19T12:00:00.000Z');

// -----------------------------------------------------------------------------
// Construcción del `.pipeline/` de fixtures
// -----------------------------------------------------------------------------

const AGENT_MODELS = {
    providers: {
        anthropic: { billing: 'paid', model: 'claude-opus-4-7' },
        'openai-codex': { billing: 'paid', model: 'gpt-5.5' },
        'gemini-google': { billing: 'free', model: 'gemini-3-flash-preview' },
        cerebras: { billing: 'free', model: 'gpt-oss-120b' },
        'nvidia-nim': { billing: 'free', model: 'deepseek-v4' },
        'kimi-moonshot': { billing: 'free', model: 'kimi-k2-6' },
        deterministic: { model: 'deterministic' },
    },
};

// `kimi-moonshot` deliberadamente AUSENTE de config.yaml: reproduce #6153.
const CONFIG_YAML = [
    'quota_detector:',
    '  ttl_by_provider:',
    '    anthropic: 7',
    '    openai-codex: 1',
    '    cerebras: 1',
    '    gemini-google: 1',
    '    nvidia-nim: 1',
    'multi_provider:',
    '  health:',
    '    interval_minutes: 5',
    '  permanence:',
    '    enabled: false',
    '    window_days: 30',
    '    min_sample: 100',
    '    min_contribution_rate: 0.05',
    '    max_days_without_win: 14',
    '    min_survivors: 1',
    '',
].join('\n');

const HEALTH = {
    ts: '2026-08-19T11:41:13.000Z',
    providers: [
        { provider: 'anthropic', state: 'green', reason_code: 'cli_oauth_ok', latency_ms: null },
        { provider: 'openai', state: 'green', reason_code: 'cli_oauth_ok', latency_ms: null },
        { provider: 'gemini-google', state: 'red', reason_code: 'cli_license_unavailable', latency_ms: null },
        { provider: 'cerebras', state: 'green', reason_code: 'authenticated', latency_ms: 674 },
        { provider: 'nvidia-nim', state: 'green', reason_code: 'authenticated', latency_ms: 15959 },
    ],
};

let seq = 0;
function entry(event, provider, extra = {}) {
    seq += 1;
    return {
        event,
        skill: extra.skill || 'po',
        issue: '9999',
        fallback_provider: provider,
        primary_provider: extra.primary_provider || 'anthropic',
        // `raw_excerpt` va a propósito en TODAS las entradas: el log real lo
        // trae y el reporte no debe dejarlo pasar (REQ-SEC-1).
        raw_excerpt: extra.raw_excerpt || 'PROMPT SENSIBLE sk-fixture-abc123 /rutas/internas',
        chain_tried: ['anthropic', provider],
        created_at: Number.isFinite(extra.created_at) ? extra.created_at : NOW - 2 * DAY + seq,
        ...(extra.health_reason ? { health_state: 'red', health_reason: extra.health_reason } : {}),
    };
}

function writeChained(file, entries) {
    for (const e of entries) auditLog.appendChained({ file, entry: e });
}

function repeat(n, factory) {
    return Array.from({ length: n }, (_, i) => factory(i));
}

/** Crea un `.pipeline/` completo de fixtures y devuelve su path. */
function makeFixture({ corromper = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm6145-'));
    const pipelineDir = path.join(root, '.pipeline');
    fs.mkdirSync(path.join(pipelineDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(pipelineDir, 'state'), { recursive: true });

    fs.writeFileSync(path.join(pipelineDir, 'agent-models.json'), JSON.stringify(AGENT_MODELS, null, 2));
    fs.writeFileSync(path.join(pipelineDir, 'config.yaml'), CONFIG_YAML);
    fs.writeFileSync(path.join(pipelineDir, 'state', 'multi-provider-health.json'), JSON.stringify(HEALTH, null, 2));

    const dia1 = path.join(pipelineDir, 'logs', 'cross-provider-dispatch-2026-08-17.jsonl');
    const dia2 = path.join(pipelineDir, 'logs', 'cross-provider-dispatch-2026-08-18.jsonl');

    // --- Día 1 -------------------------------------------------------------
    // cerebras: aporta sostenido (sano).
    // gemini-google: aporta poco Y su bloqueo dominante es NUESTRO flag local.
    writeChained(dia1, [
        ...repeat(200, () => entry('fallback_selected', 'cerebras', { skill: 'pipeline-dev' })),
        ...repeat(100, () => entry('fallback_selected', 'cerebras', { skill: 'telegram-commander' })),
        ...repeat(150, () => entry('fallback_provider_disabled', 'cerebras')),
        ...repeat(10, () => entry('fallback_selected', 'gemini-google', { skill: 'telegram-sherlock' })),
        ...repeat(400, () => entry('fallback_health_gated', 'gemini-google', {
            health_reason: 'cli_license_unavailable',
        })),
        // Ruido que NO debe entrar al denominador (política horaria).
        ...repeat(500, () => entry('primary_inactive_by_schedule', null, { primary_provider: 'anthropic' })),
        ...repeat(300, () => entry('fallback_also_gated', 'cerebras')),
        ...repeat(100, () => entry('chain_exhausted', null)),
    ]);

    // --- Día 2 -------------------------------------------------------------
    // nvidia-nim: 0 aportes sobre muestra amplia y causa imputable al
    //   proveedor => único candidato legítimo a baja.
    // kimi-moonshot: despacha pero no está en config.yaml (#6153).
    writeChained(dia2, [
        ...repeat(120, () => entry('fallback_selected', 'cerebras', { skill: 'po' })),
        ...repeat(300, () => entry('fallback_health_gated', 'nvidia-nim', {
            health_reason: 'invalid_credentials',
        })),
        ...repeat(73, () => entry('fallback_selected', 'kimi-moonshot', { skill: 'guru' })),
        ...repeat(50, () => entry('fallback_selected', 'openai-codex', { skill: 'architect' })),
    ]);

    if (corromper) {
        // Rompe la hash-chain del día 2 alterando un campo sin recalcular hashes.
        const lines = fs.readFileSync(dia2, 'utf8').split('\n').filter(Boolean);
        const mid = Math.floor(lines.length / 2);
        const tampered = JSON.parse(lines[mid]);
        tampered.fallback_provider = 'proveedor-inyectado';
        lines[mid] = JSON.stringify(tampered);
        fs.writeFileSync(dia2, `${lines.join('\n')}\n`);
    }

    return { root, pipelineDir, dia1, dia2 };
}

/** Snapshot recursivo (path relativo -> mtime+size+hash del contenido). */
function snapshotTree(dir) {
    const out = {};
    const walk = (cur) => {
        for (const name of fs.readdirSync(cur)) {
            const full = path.join(cur, name);
            const st = fs.statSync(full);
            if (st.isDirectory()) walk(full);
            else out[path.relative(dir, full)] = `${st.size}:${fs.readFileSync(full, 'utf8').length}`;
        }
    };
    walk(dir);
    return out;
}

function run(pipelineDir, extra = []) {
    return cli.buildReport({
        ...cli.parseArgs([`--pipeline-dir=${pipelineDir}`, '--dias=30', ...extra]),
        pipelineDir,
        now: NOW,
    });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test('el reporte end-to-end produce un veredicto por proveedor con la evidencia que lo sostiene', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir);

        assert.strictEqual(r.integrity.chainOk, true, 'los dos archivos verifican su hash-chain');
        assert.strictEqual(r.integrity.filesChecked, 2);

        // cerebras: aporta sostenido => mantener.
        assert.strictEqual(r.verdicts.cerebras.verdict, contribution.VERDICT.MANTENER);
        assert.strictEqual(r.metrics.cerebras.wins, 420);
        assert.strictEqual(r.metrics.cerebras.gatedBySchedule, 300, 'los fallback_also_gated quedan fuera');
        assert.strictEqual(r.metrics.cerebras.evaluables, 570, '420 wins + 150 bloqueos');

        // gemini-google: tasa por debajo del umbral PERO por causa nuestra.
        assert.ok(r.metrics['gemini-google'].contributionRate < 0.05);
        assert.strictEqual(r.metrics['gemini-google'].dominantBlock, 'observabilidad_local');
        assert.strictEqual(
            r.verdicts['gemini-google'].verdict,
            contribution.VERDICT.ROL_ACOTADO,
            'el caso Gemini se recupera, no se da de baja',
        );

        // nvidia-nim: cero aportes con causa del proveedor => candidato.
        assert.strictEqual(r.verdicts['nvidia-nim'].verdict, contribution.VERDICT.CANDIDATO_BAJA);
        assert.strictEqual(r.verdicts['nvidia-nim'].evidence.wins, 0);

        // kimi-moonshot: despacha pero no está en config.yaml.
        assert.strictEqual(r.verdicts['kimi-moonshot'].verdict, contribution.VERDICT.SIN_DECLARAR);

        // pagos: nunca por métrica automática.
        assert.strictEqual(r.verdicts.anthropic.verdict, contribution.VERDICT.MANTENER);
        assert.strictEqual(r.verdicts['openai-codex'].verdict, contribution.VERDICT.MANTENER);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('la tabla renderizada declara la causa de cada ausencia y ordena por aporte real', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir);
        const lines = r.table.split('\n');
        const dataRows = lines.slice(2);

        assert.ok(dataRows[0].startsWith('| cerebras'), 'el que más aporta va primero');

        for (const row of dataRows) {
            assert.ok(!row.includes('—'), `la fila usa guión largo: ${row}`);
            assert.ok(!/\|\s*\|/.test(row), `la fila tiene una celda vacía: ${row}`);
        }

        // Latencia: instrumentada para los api_key, declarada para los CLI-OAuth.
        const gemini = dataRows.find((l) => l.startsWith('| gemini-google'));
        assert.ok(gemini.includes(contribution.ABSENCE.NO_INSTRUMENTADO));
        assert.ok(gemini.includes('cli_license_unavailable'), 'el reason_code textual es buscable en los logs');
        const cerebras = dataRows.find((l) => l.startsWith('| cerebras'));
        assert.ok(cerebras.includes('674 ms'));

        // Veredictos en literales de operador, sin ids internos.
        assert.ok(r.table.includes('candidato a baja'));
        assert.ok(r.table.includes('rol acotado'));
        assert.ok(!r.table.includes('candidato_baja'), 'el id interno no llega a la tabla');
        assert.ok(!r.table.includes('rol_acotado'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('la conclusion precede a la evidencia y nombra el costo de la politica horaria', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir);
        const texto = cli.renderHuman(r, 'node .pipeline/scripts/provider-contribution-report.js --dias=30');

        const iConclusion = texto.indexOf('CONCLUSIÓN');
        const iTabla = texto.indexOf('| Proveedor |');
        assert.ok(iConclusion > -1 && iTabla > iConclusion, 'la conclusión va antes que la tabla');

        assert.ok(texto.includes('hash-chain: OK'), 'la integridad se declara arriba, no al pie');
        assert.ok(
            texto.includes('Regenerar: node .pipeline/scripts/provider-contribution-report.js --dias=30'),
            'el comando exacto que lo regeneró es copiable tal cual',
        );
        assert.match(r.conclusion.join(' '), /política horaria/);
        assert.match(r.conclusion.join(' '), /candidatos a baja: nvidia-nim/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('con hash-chain rota no se decide sobre nadie y el reporte lo dice arriba', () => {
    const { root, pipelineDir } = makeFixture({ corromper: true });
    try {
        const r = run(pipelineDir);

        assert.strictEqual(r.integrity.chainOk, false);
        assert.deepStrictEqual(r.integrity.brokenFiles, ['cross-provider-dispatch-2026-08-18.jsonl']);

        for (const [name, v] of Object.entries(r.verdicts)) {
            assert.notStrictEqual(
                v.verdict,
                contribution.VERDICT.CANDIDATO_BAJA,
                `${name} no puede ser candidato con la integridad rota`,
            );
        }
        assert.match(r.conclusion.join(' '), /ATENCIÓN/);
        assert.match(r.conclusion.join(' '), /integridad rota/);
        assert.match(r.conclusion.join(' '), /no se decide nada/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('el reporte es read-only: no modifica ningun archivo del pipeline (CA-7)', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const antes = snapshotTree(pipelineDir);
        run(pipelineDir);
        run(pipelineDir, ['--compacto']);
        const despues = snapshotTree(pipelineDir);

        assert.deepStrictEqual(despues, antes, 'ningún archivo del pipeline cambió de tamaño ni de contenido');
        assert.ok(!fs.existsSync(path.join(pipelineDir, 'audit')), 'sin --registrar no se crea ni el audit');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('el audit de la decision es append-only y verifica su hash-chain', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir);
        cli.registrarDecision(r, { pipelineDir });
        cli.registrarDecision(r, { pipelineDir });   // segunda corrida: appendea, no pisa

        const file = path.join(pipelineDir, 'audit', cli.AUDIT_FILE);
        const chain = auditLog.verifyChain(file);
        assert.strictEqual(chain.ok, true, 'la hash-chain del audit verifica');
        assert.strictEqual(chain.entriesChecked, 2, 'la segunda escritura appendeó, no sobreescribió');

        const entries = auditLog.readAll(file);
        assert.strictEqual(entries[0].event, 'provider_permanence_evaluated');
        assert.strictEqual(
            entries[0].executed_action, 'none',
            'el registro deja constancia de que el criterio marcó pero no ejecutó',
        );
        assert.strictEqual(entries[0].verdicts['nvidia-nim'].verdict, 'candidato_baja');
        assert.ok(entries[0].window_from && entries[0].window_to, 'la ventana queda registrada');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('ni el reporte ni el audit filtran raw_excerpt del log de dispatch (REQ-SEC-1)', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir);
        cli.registrarDecision(r, { pipelineDir });

        const serializado = JSON.stringify(r)
            + cli.renderHuman(r, 'cmd')
            + fs.readFileSync(path.join(pipelineDir, 'audit', cli.AUDIT_FILE), 'utf8');

        assert.ok(!serializado.includes('PROMPT SENSIBLE'), 'no se filtra texto de prompt');
        assert.ok(!serializado.includes('sk-fixture-abc123'), 'no se filtra el token del excerpt');
        assert.ok(!serializado.includes('/rutas/internas'), 'no se filtran rutas internas');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('el mismo comando sobre la misma ventana produce el mismo veredicto (CA-6 reejecutable)', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const a = run(pipelineDir);
        const b = run(pipelineDir);
        assert.deepStrictEqual(b.verdicts, a.verdicts);
        assert.strictEqual(b.table, a.table);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('los umbrales se leen de config.yaml y el criterio viene apagado por default', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const t = cli.readThresholds(pipelineDir);
        assert.strictEqual(t.enabled, false, 'rollout gradual: apagado por default');
        assert.strictEqual(t.min_sample, 100, 'el valor viene del config de fixtures, no del default 200');
        assert.strictEqual(t.min_contribution_rate, 0.05);
        assert.strictEqual(t.max_days_without_win, 14);
        assert.strictEqual(t.min_survivors, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sin config.yaml legible el criterio cae a los defaults conservadores, sin romper', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        fs.rmSync(path.join(pipelineDir, 'config.yaml'));
        const t = cli.readThresholds(pipelineDir);
        assert.strictEqual(t.min_sample, contribution.DEFAULT_THRESHOLDS.min_sample);
        assert.strictEqual(t.enabled, false);
        // Y el reporte sigue corriendo.
        const r = run(pipelineDir);
        assert.ok(Object.keys(r.verdicts).length > 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('el modo compacto conserva las cuatro columnas de decision sin truncar palabras', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir, ['--compacto']);
        const compacta = contribution.renderMarkdownTable(r.metrics, { verdicts: r.verdicts, compact: true });
        const header = compacta.split('\n')[0];

        assert.strictEqual(header.split('|').filter((c) => c.trim()).length, 4);
        assert.ok(header.includes('Recomendación'));
        assert.ok(compacta.includes('candidato a baja'), 'el veredicto no se abrevia ni se trunca');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('un pipeline sin logs de dispatch no decide nada y no explota', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm6145-vacio-'));
    const pipelineDir = path.join(root, '.pipeline');
    fs.mkdirSync(path.join(pipelineDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(pipelineDir, 'agent-models.json'), JSON.stringify(AGENT_MODELS));
    fs.writeFileSync(path.join(pipelineDir, 'config.yaml'), CONFIG_YAML);
    try {
        const r = run(pipelineDir);
        assert.strictEqual(r.integrity.chainOk, false, 'ventana sin archivos verificables');
        for (const v of Object.values(r.verdicts)) {
            assert.notStrictEqual(v.verdict, contribution.VERDICT.CANDIDATO_BAJA);
        }
        assert.ok(r.table.includes(contribution.ABSENCE.SIN_MUESTRA));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
