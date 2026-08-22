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

/**
 * rev-2 (#6145) — el CLI ahora lee la config por `config-resolver`, que valida
 * el documento contra el schema y exige el manifiesto de producto al lado del
 * `.pipeline/` (partición #5174). El fixture copia el manifiesto REAL del repo:
 * si mañana la partición cambia de forma, este test se entera.
 */
const PRODUCT_MANIFEST = path.resolve(__dirname, '..', '..', 'pipeline.config.json');

/** Crea un `.pipeline/` completo de fixtures y devuelve su path. */
function makeFixture({ corromper = false, config = CONFIG_YAML } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm6145-'));
    const pipelineDir = path.join(root, '.pipeline');
    fs.mkdirSync(path.join(pipelineDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(pipelineDir, 'state'), { recursive: true });

    fs.writeFileSync(path.join(pipelineDir, 'agent-models.json'), JSON.stringify(AGENT_MODELS, null, 2));
    if (config !== null) fs.writeFileSync(path.join(pipelineDir, 'config.yaml'), config);
    fs.copyFileSync(PRODUCT_MANIFEST, path.join(root, 'pipeline.config.json'));
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
        // rev-2: los 400 gateos por NUESTRO flag de entorno ya no entran al
        // denominador. Para que gemini siga teniendo muestra suficiente y tasa
        // baja (el escenario que el techo `rol_acotado` protege), el fixture le
        // suma bloqueos por cupo, que sí son imputables al proveedor.
        ...repeat(250, () => entry('fallback_provider_disabled', 'gemini-google')),
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
        // rev-2: los tres eventos que rev-1 dejaba fuera de la taxonomía y del
        // total (el hueco de 261 que encontró el review), más uno inventado que
        // representa "evento nuevo del dispatcher que nadie declaró todavía".
        ...repeat(12, () => entry('provider_disabled', null, { primary_provider: 'nvidia-nim' })),
        ...repeat(9, () => entry('gated_no_fallbacks', null, { primary_provider: 'anthropic' })),
        ...repeat(4, () => entry('evento_nuevo_sin_declarar', 'cerebras')),
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
        const { thresholds: t, source } = cli.readThresholds(cli.readPipelineConfig(pipelineDir));
        assert.strictEqual(t.enabled, false, 'rollout gradual: apagado por default');
        assert.strictEqual(t.min_sample, 100, 'el valor viene del config de fixtures, no del default 200');
        assert.strictEqual(t.min_contribution_rate, 0.05);
        assert.strictEqual(t.max_days_without_win, 14);
        assert.strictEqual(t.min_survivors, 1);
        assert.match(source, /config\.yaml/, 'la procedencia queda declarada');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('un config.yaml reindentado sigue dando el umbral configurado, no el default', () => {
    // rev-2 (#6145) — BLOQUEANTE 4 del review. El parser regex propio de rev-1
    // era sensible a la indentación EXACTA: con un YAML equivalente pero
    // reindentado devolvía 0.05 en vez del 0.42 configurado, y sin una sola
    // advertencia. Justo el umbral que decide quién es candidato a baja.
    const reindentado = CONFIG_YAML
        .replace('    min_contribution_rate: 0.05', '    min_contribution_rate: 0.42')
        .replace('multi_provider:\n  health:', 'multi_provider:\n\n  health:');
    const { root, pipelineDir } = makeFixture({ config: reindentado });
    try {
        const { thresholds } = cli.readThresholds(cli.readPipelineConfig(pipelineDir));
        assert.strictEqual(thresholds.min_contribution_rate, 0.42, 'lo que el operador configuró, se aplica');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sin config.yaml el CLI falla explicito y no corre con defaults silenciosos', () => {
    // rev-2 (#6145) — antes esto devolvía los defaults y emitía un reporte que
    // parecía normal. Contrato de config-resolver para CLIs: "mensaje redactado
    // + exit 1, sin defaults silenciosos".
    const { root, pipelineDir } = makeFixture();
    try {
        fs.rmSync(path.join(pipelineDir, 'config.yaml'));
        assert.throws(
            () => cli.readPipelineConfig(pipelineDir),
            (err) => err.code === 'CONFIG_UNAVAILABLE',
            'la falla de configuración es explícita y tipada',
        );

        let salida = '';
        const fake = { write: (t) => { salida += t; } };
        const code = cli.main([`--pipeline-dir=${pipelineDir}`], { stdout: fake, stderr: fake });
        assert.strictEqual(code, 1, 'exit 1, no un reporte a medias');
        assert.match(salida, /no se pudo resolver la configuracion/);
        assert.ok(!salida.includes('CONCLUSIÓN'), 'no emite reporte');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('la seccion de permanencia ausente usa defaults pero lo declara en el reporte', () => {
    // La ausencia de una sección opcional NO es corrupción (config-resolver,
    // "lo que NO es un error"): es rollout gradual. Pero tampoco es invisible.
    const sinPermanence = CONFIG_YAML.split('  permanence:')[0];
    const { root, pipelineDir } = makeFixture({ config: sinPermanence });
    try {
        const { thresholds, source } = cli.readThresholds(cli.readPipelineConfig(pipelineDir));
        assert.strictEqual(thresholds.min_sample, contribution.DEFAULT_THRESHOLDS.min_sample);
        assert.match(source, /ausente de config\.yaml/);

        const r = run(pipelineDir);
        assert.match(r.thresholdsSource, /ausente de config\.yaml/, 'la procedencia viaja al reporte');
        const texto = cli.renderHuman(r, 'cmd');
        assert.match(texto, /Procedencia de los umbrales/, 'y se imprime para el operador');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('un proveedor ausente de config nunca es candidato aunque el barrido falle', () => {
    // rev-2 (#6145) — BLOQUEANTE 3 del review. La derivación real de
    // `readDeclaredProviders` (no un `declared` inyectado a mano) tiene que
    // fallar CERRADO: sin evidencia de declaración, NO declarado. En rev-1 el
    // fallback era `true` para todos, y kimi-moonshot entraba al criterio.
    const sinBloquesPorProveedor = CONFIG_YAML
        .split('quota_detector:')[0] + CONFIG_YAML.slice(CONFIG_YAML.indexOf('multi_provider:'));
    const { root, pipelineDir } = makeFixture({ config: sinBloquesPorProveedor });
    try {
        const cfg = cli.readPipelineConfig(pipelineDir);
        assert.strictEqual(cli.readProvidersDeclaredInConfig(cfg).size, 0, 'el barrido no encontró nada');

        const declared = cli.readDeclaredProviders(pipelineDir, fs, cfg);
        for (const [name, def] of Object.entries(declared)) {
            assert.strictEqual(def.declaredInConfig, false, `${name}: fail-closed, no fail-open`);
        }

        const r = run(pipelineDir);
        for (const [name, v] of Object.entries(r.verdicts)) {
            assert.strictEqual(v.verdict, contribution.VERDICT.SIN_DECLARAR, `${name}: sin declarar`);
            assert.notStrictEqual(v.verdict, contribution.VERDICT.CANDIDATO_BAJA);
        }
        assert.match(r.conclusion.join(' '), /ningún proveedor tiene calibración operativa/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('la derivacion real de declared marca sin_declarar solo a kimi-moonshot', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const declared = cli.readDeclaredProviders(pipelineDir, fs, cli.readPipelineConfig(pipelineDir));
        assert.strictEqual(declared.anthropic.billing, 'paid');
        assert.strictEqual(declared['openai-codex'].billing, 'paid');
        assert.strictEqual(declared.cerebras.declaredInConfig, true);
        assert.strictEqual(declared['gemini-google'].declaredInConfig, true);
        assert.strictEqual(declared['nvidia-nim'].declaredInConfig, true);
        assert.strictEqual(declared['kimi-moonshot'].declaredInConfig, false, '#6153');
        assert.ok(!('deterministic' in declared), 'el ejecutor local no es un proveedor de la cadena');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sin agent-models.json el CLI falla explicito: sin billing no hay invariante de pago', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        fs.rmSync(path.join(pipelineDir, 'agent-models.json'));
        assert.throws(
            () => cli.readDeclaredProviders(pipelineDir, fs, cli.readPipelineConfig(pipelineDir)),
            (err) => err.code === 'CONFIG_UNAVAILABLE',
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('el modo compacto conserva las cuatro columnas de decision sin truncar palabras', () => {
    // rev-2 (#6145) — el review probó que este test descartaba `r.table` y
    // re-renderizaba a mano, así que el cableado del flag en buildReport tenía
    // cobertura CERO. Ahora se asserta la tabla que el CLI produce de verdad.
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir, ['--compacto']);
        const header = r.table.split('\n')[0];

        assert.strictEqual(header.split('|').filter((c) => c.trim()).length, 4);
        assert.ok(header.includes('Recomendación'));
        assert.ok(r.table.includes('candidato a baja'), 'el veredicto no se abrevia ni se trunca');

        // Y sin el flag la tabla del CLI es la ancha: el flag hace algo.
        const ancha = run(pipelineDir).table.split('\n')[0];
        assert.ok(ancha.split('|').filter((c) => c.trim()).length > 4, 'el flag cambia la tabla emitida');
        assert.ok(ancha.includes('Último live-ping'));
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
    fs.copyFileSync(PRODUCT_MANIFEST, path.join(root, 'pipeline.config.json'));
    try {
        const r = run(pipelineDir);
        assert.strictEqual(r.integrity.chainOk, false, 'ventana sin archivos verificables');
        assert.strictEqual(r.integrity.noData, true, 'y la causa es que no hay datos');
        assert.strictEqual(r.integrity.chainBroken, false, 'NO es que la cadena esté rota');
        for (const v of Object.values(r.verdicts)) {
            assert.notStrictEqual(v.verdict, contribution.VERDICT.CANDIDATO_BAJA);
        }
        // rev-2 (#6145): "no hay datos" dejó de anunciarse como "cadena rota".
        assert.match(r.conclusion.join(' '), /no hay ni un archivo de dispatch/);
        assert.ok(
            !r.conclusion.join(' ').includes('0 archivo/s con integridad rota'),
            'la frase autocontradictoria de rev-1 ya no aparece',
        );
        assert.ok(r.table.includes(contribution.ABSENCE.SIN_MUESTRA));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// -----------------------------------------------------------------------------
// rev-2 (#6145) — cobertura de la superficie de CLI que el review señaló como
// no ejercitada: parseArgs y sus validaciones, --hasta, y main() con sus tres
// códigos de salida.
// -----------------------------------------------------------------------------

test('parseArgs valida los overrides de umbral y no los ignora en silencio', () => {
    const ok = cli.parseArgs(['--dias=15', '--umbral-muestra=50', '--umbral-tasa=0.42', '--umbral-dias=7']);
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.dias, 15);
    assert.deepStrictEqual(ok.overrides, {
        min_sample: 50, min_contribution_rate: 0.42, max_days_without_win: 7,
    });

    // Fuera de rango, no numérico, flag desconocido: TODOS reportan.
    const malo = cli.parseArgs(['--umbral-tasa=5', '--umbral-muestra=abc', '--dias=0', '--que-onda']);
    assert.strictEqual(malo.errors.length, 4, 'los cuatro errores se reportan, ninguno se traga');
    assert.match(malo.errors.join(' '), /--umbral-tasa/);
    assert.match(malo.errors.join(' '), /opcion desconocida: --que-onda/);
    assert.strictEqual(malo.overrides.min_contribution_rate, undefined, 'un valor inválido NO se aplica');
});

test('los overrides de linea de comando pisan al config y quedan declarados', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir, ['--umbral-tasa=0.9']);
        assert.strictEqual(r.thresholds.min_contribution_rate, 0.9);
        assert.strictEqual(r.thresholds.min_sample, 100, 'el resto sigue viniendo del config');
        assert.match(r.thresholdsSource, /overrides de linea de comando \(min_contribution_rate\)/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('--hasta acota la ventana y viaja en el comando reproducible', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        // La ventana termina ANTES del día 2: sólo entra el archivo del 17.
        const r = run(pipelineDir, ['--hasta=2026-08-17']);
        assert.strictEqual(r.integrity.filesChecked, 1, 'el día 2 queda fuera de la ventana');
        assert.strictEqual(r.window.hasta, '2026-08-17');
        assert.ok(!('nvidia-nim' in r.metrics), 'nvidia-nim sólo despacha el día 2');

        const cmd = cli.reproducibleCommand(cli.parseArgs([
            '--dias=30', '--hasta=2026-08-17', '--umbral-tasa=0.42', '--compacto',
        ]));
        // rev-2: sin --hasta el comando "reproducible" daba otra ventana y otros
        // números en cuanto pasaba un día.
        assert.match(cmd, /--hasta=2026-08-17/);
        assert.match(cmd, /--dias=30/);
        assert.match(cmd, /--umbral-tasa=0\.42/);
        assert.match(cmd, /--compacto/);

        const texto = cli.renderHuman(r, cli.reproducibleCommand(cli.parseArgs([
            `--pipeline-dir=${pipelineDir}`, '--dias=30', '--hasta=2026-08-17',
        ])));
        assert.match(texto, /Regenerar: node .+ --dias=30 --hasta=2026-08-17/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('main devuelve 0 con la ventana sana, 2 sin datos verificables y 1 ante error', () => {
    const { root, pipelineDir } = makeFixture();
    const capt = () => { const o = { s: '', write(t) { this.s += t; } }; return o; };
    try {
        const out = capt(); const err = capt();
        assert.strictEqual(cli.main([`--pipeline-dir=${pipelineDir}`], { stdout: out, stderr: err }), 0);
        assert.match(out.s, /CONCLUSIÓN/);
        assert.match(out.s, /Procedencia de los umbrales/);
        assert.strictEqual(err.s, '');

        // --json emite SOLO el JSON canónico, parseable.
        const j = capt();
        assert.strictEqual(cli.main([`--pipeline-dir=${pipelineDir}`, '--json'], { stdout: j, stderr: capt() }), 0);
        const parsed = JSON.parse(j.s);
        assert.strictEqual(parsed.integrity.chainOk, true);
        assert.ok(parsed.latencyDisclaimer.includes('#6152'), 'el gap de latencia viaja en el JSON');

        // Chain rota => 2 (no se decide, pero no es un error del CLI).
        const roto = makeFixture({ corromper: true });
        try {
            const o2 = capt();
            assert.strictEqual(cli.main([`--pipeline-dir=${roto.pipelineDir}`], { stdout: o2, stderr: capt() }), 2);
        } finally {
            fs.rmSync(roto.root, { recursive: true, force: true });
        }

        // Flag inválido => 1, sin emitir reporte.
        const o3 = capt(); const e3 = capt();
        assert.strictEqual(
            cli.main([`--pipeline-dir=${pipelineDir}`, '--umbral-tasa=9'], { stdout: o3, stderr: e3 }),
            1,
        );
        assert.strictEqual(o3.s, '', 'no emite reporte con argumentos inválidos');
        assert.match(e3.s, /--umbral-tasa/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('el costo de failover cierra contra las entradas leidas y nombra lo no clasificado', () => {
    // rev-2 (#6145) — el review reprodujo en vivo un hueco de 261 eventos entre
    // `entriesRead` y el total sobre el que se calculaban los porcentajes.
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir);
        assert.strictEqual(
            r.failoverCost.totalEvents,
            r.integrity.entriesRead,
            'el denominador de los porcentajes ES el total leído, sin huecos',
        );
        assert.strictEqual(r.failoverCost.reconciles, true);
        assert.strictEqual(r.failoverCost.operatorGating.events, 12, 'kill-switch contabilizado');
        assert.strictEqual(r.failoverCost.unclassified.events, 4, 'el evento nuevo se ve, no se traga');
        assert.match(r.conclusion.join(' '), /Nota de taxonomía/);
        assert.match(r.conclusion.join(' '), /evento_nuevo_sin_declarar/);

        // Y el kill-switch no le bajó la tasa a nadie.
        assert.strictEqual(r.metrics['nvidia-nim'].gatedByOperator, 12);
        assert.strictEqual(r.metrics['nvidia-nim'].evaluables, 300, 'sólo los 300 bloqueos por credencial');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('el gateo por observabilidad local no entra al denominador de gemini', () => {
    const { root, pipelineDir } = makeFixture();
    try {
        const r = run(pipelineDir);
        const g = r.metrics['gemini-google'];
        assert.strictEqual(g.gatedByLocalObservability, 400, 'los 400 gateos por flag propio, aparte');
        assert.strictEqual(g.evaluables, 260, '10 aportes + 250 bloqueos por cupo');
        assert.strictEqual(g.dominantBlock, 'observabilidad_local');
        assert.strictEqual(
            r.verdicts['gemini-google'].verdict,
            contribution.VERDICT.ROL_ACOTADO,
            'techo rol_acotado: el caso Gemini se recupera, no se da de baja',
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
