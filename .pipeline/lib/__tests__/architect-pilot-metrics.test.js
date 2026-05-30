// =============================================================================
// Tests — .pipeline/scripts/architect-pilot-metrics.js (#3644)
//
// Cubre los criterios de aceptación:
//
//   CA-IMPL-PILOT-METRICS-SOURCE  Policy-as-test bloqueante: el script NO lee
//                                 de paths no-append-only (.pipeline/logs/*,
//                                 pipeline-state-*, metrics/snapshot*).
//
//   CA-8                          Cómputo de las 4 métricas (latencia P50/P95,
//                                 tasa rechazo Fase 2, costo USD, ratio
//                                 qa:passed sin rebote) sobre fixtures de JSONL.
//
//   Robustez                      `prompt-injection-attempts.jsonl` ausente
//                                 (ENOENT) → `injection_attempts_n: 0` sin throw.
//
//   Idempotencia                  El bloque markdown auto-generado se inyecta
//                                 entre `<!-- pilot-metrics:auto -->` y
//                                 `<!-- /pilot-metrics:auto -->`; ejecutar 2
//                                 veces reemplaza, no duplica.
//
// Estrategia: tmpdir aislado por test, sin contaminar `.pipeline/audit/` real.
// `useGh: false` para no depender del subprocess `gh` durante los tests.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const metrics = require('../../scripts/architect-pilot-metrics');

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function mkTmpPipeline() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-pilot-test-'));
    const auditDir = path.join(dir, 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    return {
        pipelineDir: dir,
        auditDir,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    };
}

function writeJsonl(filePath, records) {
    const data = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    fs.writeFileSync(filePath, data, 'utf8');
}

function tokensRecord(overrides) {
    return {
        timestamp: '2026-05-29T12:00:00.000Z',
        issue_id: 4001,
        skill: 'architect',
        phase: 'criterios',
        model_requested: 'claude-sonnet-4-7',
        model_used: 'claude-sonnet-4-7',
        fallback_chain_used: [],
        tokens_in: 100,
        tokens_out: 50,
        cache_read: 0,
        cache_write: 0,
        cost_usd: 0.5,
        decision: 'signoff',
        signature_marker_hash: 'sha256:abc',
        ...overrides,
    };
}

function issueRecord(overrides) {
    return {
        number: 4001,
        createdAt: '2026-05-29T11:30:00.000Z',
        closedAt: null,
        labels: [
            { name: 'architect:enabled' },
            { name: 'area:pipeline' },
        ],
        ...overrides,
    };
}

// =============================================================================
// CA-IMPL-PILOT-METRICS-SOURCE  Policy-as-test: paths prohibidos en el source
// =============================================================================

test('CA-IMPL-PILOT-METRICS-SOURCE · script NO lee de paths no-append-only (A08 Integrity)', () => {
    const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'architect-pilot-metrics.js');
    const src = fs.readFileSync(scriptPath, 'utf8');

    // Los regex acá deben coincidir con cualquier uso real de paths prohibidos.
    // Los strings dentro de comentarios/documentación que mencionen los paths
    // para EXPLICAR la prohibición están permitidos (palabras como "PROHIBIDO",
    // "no-append-only", o el path entre backticks en un comentario).
    //
    // Detectamos uso real comprobando que el path no esté dentro de un
    // comentario de documentación. Heurística: extraer líneas no-comentario y
    // hacer grep ahí.
    const codeLines = src.split('\n').filter(line => {
        const trimmed = line.trim();
        // Excluir comentarios de línea, docblock y líneas que comienzan con
        // marcador de documentación.
        if (trimmed.startsWith('//')) return false;
        if (trimmed.startsWith('*')) return false;
        if (trimmed.startsWith('/*')) return false;
        if (trimmed === '*/') return false;
        return true;
    });
    const codeOnly = codeLines.join('\n');

    const forbidden = [
        /\.pipeline\/logs\//,                 // logs no son append-only
        /pipeline-state-/,                    // state snapshots son mutables
        /\.pipeline\/metrics\/snapshot/,      // metrics agregados son mutables
    ];

    for (const re of forbidden) {
        assert.equal(
            re.test(codeOnly),
            false,
            `path prohibido detectado en código del script: ${re}`,
        );
    }
});

test('CA-IMPL-PILOT-METRICS-SOURCE · runMetrics sólo abre archivos bajo audit/ del pipelineDir', () => {
    // Defensa funcional adicional: si el script tuviera un require a un módulo
    // que apunte a logs/state, este test fallaría porque `tmpdir/audit/` está
    // vacío y el output debe estar bien definido sin tocar otros paths.
    const tmp = mkTmpPipeline();
    try {
        const r = metrics.runMetrics({
            pipelineDir: tmp.pipelineDir,
            since: null,
            limit: 5,
            useGh: false,
        });
        // No throw, structure válida, sin pilot issues.
        assert.ok(r && r.payload);
        assert.equal(r.payload.pilot_issues.length, 0);
        assert.equal(r.payload.metrics.injection_attempts_n, 0);
        assert.equal(r.payload.metrics.cost_usd_total, 0);
    } finally {
        tmp.cleanup();
    }
});

// =============================================================================
// CA-8  Cómputo de las 4 métricas con fixtures de JSONL
// =============================================================================

test('CA-8 · computa las 4 métricas con fixtures de JSONL en tmpdir', () => {
    const tmp = mkTmpPipeline();
    try {
        // Fixture: 3 issues piloto, cada uno con criterios+aprobacion. Uno con
        // rebote en aprobacion. Issue 4003 con qa:passed.
        const tokens = [
            // Issue 4001 — flujo limpio: criterios signoff + aprobacion signoff.
            tokensRecord({
                issue_id: 4001,
                phase: 'criterios',
                decision: 'signoff',
                timestamp: '2026-05-29T12:00:00.000Z', // +30min desde createdAt
                cost_usd: 1.20,
            }),
            tokensRecord({
                issue_id: 4001,
                phase: 'aprobacion',
                decision: 'signoff',
                timestamp: '2026-05-29T14:00:00.000Z',
                cost_usd: 0.40,
            }),
            // Issue 4002 — rebote en aprobacion.
            tokensRecord({
                issue_id: 4002,
                phase: 'criterios',
                decision: 'signoff',
                timestamp: '2026-05-29T13:00:00.000Z', // +60min desde createdAt
                cost_usd: 1.50,
            }),
            tokensRecord({
                issue_id: 4002,
                phase: 'aprobacion',
                decision: 'rebote',
                timestamp: '2026-05-29T15:00:00.000Z',
                cost_usd: 0.40,
            }),
            // Issue 4003 — criterios signoff + qa:passed.
            tokensRecord({
                issue_id: 4003,
                phase: 'criterios',
                decision: 'signoff',
                timestamp: '2026-05-29T12:45:00.000Z', // +15min desde createdAt
                cost_usd: 1.00,
            }),
            // Issue NO piloto (ignorado por filtro).
            tokensRecord({
                issue_id: 9999,
                phase: 'criterios',
                decision: 'signoff',
                timestamp: '2026-05-29T18:00:00.000Z',
                cost_usd: 999.00,
            }),
        ];
        writeJsonl(path.join(tmp.auditDir, 'architect-tokens.jsonl'), tokens);

        // 2 intentos de injection registrados (issue arbitrario).
        writeJsonl(path.join(tmp.auditDir, 'prompt-injection-attempts.jsonl'), [
            { timestamp: '2026-05-29T10:00:00.000Z', issue_id: 4001, phase: 'criterios', source: 'body', pattern_matched: 'ignore previous', blocked: true, action_taken: 'rejected_issue_promotion' },
            { timestamp: '2026-05-29T10:05:00.000Z', issue_id: 4002, phase: 'criterios', source: 'comment', source_id: 'IC_abc', pattern_matched: 'nuevas instrucciones', blocked: true, action_taken: 'rejected_issue_promotion' },
        ]);

        const pilotIssues = [
            issueRecord({
                number: 4001,
                createdAt: '2026-05-29T11:30:00.000Z',
                labels: [{ name: 'architect:enabled' }],
            }),
            issueRecord({
                number: 4002,
                createdAt: '2026-05-29T12:00:00.000Z',
                labels: [{ name: 'architect:enabled' }],
            }),
            issueRecord({
                number: 4003,
                createdAt: '2026-05-29T12:30:00.000Z',
                labels: [{ name: 'architect:enabled' }, { name: 'qa:passed' }],
            }),
        ];

        const m = metrics.computeMetrics(tokens, [
            { timestamp: '2026-05-29T10:00:00.000Z' },
            { timestamp: '2026-05-29T10:05:00.000Z' },
        ], pilotIssues);

        // Latencia: [30, 60, 15] minutos → sorted [15, 30, 60]. P50 = 30, P95 ≈ 57.
        assert.equal(m.latency_criterios_to_signoff_min.n, 3);
        assert.equal(m.latency_criterios_to_signoff_min.p50, 30);
        // P95 con 3 datapoints: idx=(3-1)*0.95=1.9 → interp 30 + 0.9*(60-30)=57
        assert.equal(Math.round(m.latency_criterios_to_signoff_min.p95), 57);

        // Tasa rechazo Fase 2: 1 rebote sobre 2 records en aprobacion = 0.5.
        assert.equal(m.rejection_rate_fase2.n, 2);
        assert.equal(m.rejection_rate_fase2.rebotes, 1);
        assert.equal(m.rejection_rate_fase2.value, 0.5);

        // Costo USD: 1.20 + 0.40 + 1.50 + 0.40 + 1.00 = 4.50 (issue 9999 excluido).
        assert.equal(m.cost_usd_total, 4.50);

        // Ratio qa:passed sin rebote: issue 4003 tiene qa:passed y no tiene
        // rebote architect → 1 / 3 issues piloto.
        assert.equal(m.ratio_qa_passed_no_rebote.n, 3);
        assert.equal(m.ratio_qa_passed_no_rebote.qa_passed_count, 1);
        assert.equal(m.ratio_qa_passed_no_rebote.value, 1 / 3);

        // Injections: 2.
        assert.equal(m.injection_attempts_n, 2);
    } finally {
        tmp.cleanup();
    }
});

test('CA-8 · issue piloto con qa:passed PERO con rebote architect NO cuenta en el numerador', () => {
    // Numerador del ratio requiere: qa:passed AND no-rebote architect.
    const tokens = [
        tokensRecord({ issue_id: 5001, phase: 'aprobacion', decision: 'rebote' }),
    ];
    const pilotIssues = [
        issueRecord({
            number: 5001,
            labels: [{ name: 'architect:enabled' }, { name: 'qa:passed' }],
        }),
    ];
    const m = metrics.computeMetrics(tokens, [], pilotIssues);
    assert.equal(m.ratio_qa_passed_no_rebote.qa_passed_count, 0);
    assert.equal(m.ratio_qa_passed_no_rebote.value, 0);
});

test('CA-8 · cost_usd_total ignora records de issues NO piloto', () => {
    const tokens = [
        tokensRecord({ issue_id: 6001, cost_usd: 10 }),
        tokensRecord({ issue_id: 9999, cost_usd: 9999 }), // NO piloto
    ];
    const pilotIssues = [issueRecord({ number: 6001 })];
    const m = metrics.computeMetrics(tokens, [], pilotIssues);
    assert.equal(m.cost_usd_total, 10);
});

test('CA-8 · latencia rechaza valores negativos (timestamp signoff < createdAt — invalid)', () => {
    const tokens = [
        tokensRecord({
            issue_id: 7001,
            phase: 'criterios',
            decision: 'signoff',
            timestamp: '2026-05-29T10:00:00.000Z',
        }),
    ];
    const pilotIssues = [issueRecord({
        number: 7001,
        createdAt: '2026-05-29T12:00:00.000Z', // creado DESPUÉS del signoff (imposible)
    })];
    const m = metrics.computeMetrics(tokens, [], pilotIssues);
    // El sample con latencia negativa se descarta — n=0.
    assert.equal(m.latency_criterios_to_signoff_min.n, 0);
    assert.equal(m.latency_criterios_to_signoff_min.p50, null);
});

// =============================================================================
// Robustez: ENOENT del JSONL de injections → count 0
// =============================================================================

test('robustez · tolera prompt-injection-attempts.jsonl ausente (ENOENT → count: 0)', () => {
    const tmp = mkTmpPipeline();
    try {
        // Solo creamos tokens, NO el archivo de injections.
        writeJsonl(path.join(tmp.auditDir, 'architect-tokens.jsonl'), [
            tokensRecord({ issue_id: 8001 }),
        ]);
        assert.equal(
            fs.existsSync(path.join(tmp.auditDir, 'prompt-injection-attempts.jsonl')),
            false,
        );

        const r = metrics.runMetrics({
            pipelineDir: tmp.pipelineDir,
            since: null,
            limit: 5,
            useGh: false,
        });
        assert.equal(r.payload.metrics.injection_attempts_n, 0);
    } finally {
        tmp.cleanup();
    }
});

test('robustez · readJsonlSafe devuelve [] si el archivo no existe', () => {
    const tmp = mkTmpPipeline();
    try {
        const inexistente = path.join(tmp.auditDir, 'no-existe.jsonl');
        assert.deepEqual(metrics.readJsonlSafe(inexistente), []);
    } finally {
        tmp.cleanup();
    }
});

test('robustez · readJsonlSafe lanza si una línea está corrupta (fail-cerrado)', () => {
    const tmp = mkTmpPipeline();
    try {
        const filePath = path.join(tmp.auditDir, 'corrupto.jsonl');
        fs.writeFileSync(filePath, '{"valid":true}\nesto no es JSON\n{"otra":true}\n');
        assert.throws(() => metrics.readJsonlSafe(filePath));
    } finally {
        tmp.cleanup();
    }
});

// =============================================================================
// Idempotencia del marker `<!-- pilot-metrics:auto -->`
// =============================================================================

test('idempotencia · inyectar 2 veces reemplaza el bloque, NO duplica', () => {
    const tmp = mkTmpPipeline();
    try {
        const docPath = path.join(tmp.pipelineDir, 'rollout-plan.md');
        fs.writeFileSync(docPath, [
            '# Rollout plan',
            '',
            '## §2 Plan de piloto',
            '',
            metrics.MARKER_BEGIN,
            'CONTENIDO VIEJO',
            metrics.MARKER_END,
            '',
            '## §3 Otra sección',
            '',
        ].join('\n'));

        const block1 = `${metrics.MARKER_BEGIN}\n\n### Bloque v1\n\n${metrics.MARKER_END}`;
        const r1 = metrics.injectBlockIntoRolloutPlan(docPath, block1);
        assert.equal(r1.changed, true);

        const after1 = fs.readFileSync(docPath, 'utf8');
        const occurrencesBegin1 = after1.split(metrics.MARKER_BEGIN).length - 1;
        const occurrencesEnd1 = after1.split(metrics.MARKER_END).length - 1;
        assert.equal(occurrencesBegin1, 1, 'marker BEGIN debe aparecer 1 vez');
        assert.equal(occurrencesEnd1, 1, 'marker END debe aparecer 1 vez');
        assert.match(after1, /### Bloque v1/);
        assert.doesNotMatch(after1, /CONTENIDO VIEJO/);
        // §3 sigue intacta.
        assert.match(after1, /## §3 Otra sección/);

        // Segundo run con bloque distinto: reemplaza, no duplica.
        const block2 = `${metrics.MARKER_BEGIN}\n\n### Bloque v2\n\n${metrics.MARKER_END}`;
        const r2 = metrics.injectBlockIntoRolloutPlan(docPath, block2);
        assert.equal(r2.changed, true);

        const after2 = fs.readFileSync(docPath, 'utf8');
        const occurrencesBegin2 = after2.split(metrics.MARKER_BEGIN).length - 1;
        assert.equal(occurrencesBegin2, 1, 'marker BEGIN debe seguir apareciendo 1 vez');
        assert.match(after2, /### Bloque v2/);
        assert.doesNotMatch(after2, /### Bloque v1/);
    } finally {
        tmp.cleanup();
    }
});

test('idempotencia · ejecutar inyección con contenido idéntico no cambia el archivo', () => {
    const tmp = mkTmpPipeline();
    try {
        const docPath = path.join(tmp.pipelineDir, 'rollout-plan.md');
        const block = `${metrics.MARKER_BEGIN}\n\n### Bloque estable\n\n${metrics.MARKER_END}`;
        fs.writeFileSync(docPath, `# Doc\n\n${block}\n`);

        const r = metrics.injectBlockIntoRolloutPlan(docPath, block);
        assert.equal(r.changed, false, 'sin cambios cuando el bloque es idéntico');
    } finally {
        tmp.cleanup();
    }
});

test('idempotencia · si no hay marker en el doc, se agrega al final (defensive)', () => {
    const tmp = mkTmpPipeline();
    try {
        const docPath = path.join(tmp.pipelineDir, 'rollout-plan.md');
        fs.writeFileSync(docPath, '# Doc sin marker\n\nContenido previo.\n');

        const block = `${metrics.MARKER_BEGIN}\n\n### Bloque inicial\n\n${metrics.MARKER_END}`;
        const r = metrics.injectBlockIntoRolloutPlan(docPath, block);
        assert.equal(r.changed, true);

        const after = fs.readFileSync(docPath, 'utf8');
        assert.match(after, /Contenido previo\./);
        assert.match(after, /### Bloque inicial/);

        // Segundo run debe reemplazar in-place, no duplicar.
        const block2 = `${metrics.MARKER_BEGIN}\n\n### Bloque actualizado\n\n${metrics.MARKER_END}`;
        metrics.injectBlockIntoRolloutPlan(docPath, block2);
        const after2 = fs.readFileSync(docPath, 'utf8');
        const occurrences = after2.split(metrics.MARKER_BEGIN).length - 1;
        assert.equal(occurrences, 1);
        assert.match(after2, /### Bloque actualizado/);
        assert.doesNotMatch(after2, /### Bloque inicial/);
    } finally {
        tmp.cleanup();
    }
});

// =============================================================================
// Auxiliares: percentile, parseArgs, markdown rendering smoke
// =============================================================================

test('percentile · P50 sobre 1 elemento devuelve ese valor; vacío devuelve null', () => {
    assert.equal(metrics.percentile([], 0.5), null);
    assert.equal(metrics.percentile([42], 0.5), 42);
    assert.equal(metrics.percentile([1, 2, 3, 4, 5], 0.5), 3);
});

test('parseArgs · respeta defaults y parsea opciones', () => {
    const a = metrics.parseArgs([]);
    assert.equal(a.limit, 5);
    assert.equal(a.updateRolloutPlan, false);
    assert.equal(a.useGh, true);

    const b = metrics.parseArgs(['--limit=10', '--no-gh', '--update-rollout-plan', '--since=2026-05-01T00:00:00Z']);
    assert.equal(b.limit, 10);
    assert.equal(b.useGh, false);
    assert.equal(b.updateRolloutPlan, true);
    assert.equal(b.since, '2026-05-01T00:00:00Z');
});

test('markdown · render incluye los marcadores y la tabla', () => {
    const payload = {
        computed_at: '2026-05-30T15:00:00.000Z',
        since: null,
        limit: 5,
        pilot_issues: [{ number: 4001 }, { number: 4002 }],
        metrics: {
            latency_criterios_to_signoff_min: { p50: 30, p95: 60, n: 2 },
            rejection_rate_fase2: { value: 0.25, n: 4, rebotes: 1 },
            cost_usd_total: 5.50,
            ratio_qa_passed_no_rebote: { value: 0.50, n: 2, qa_passed_count: 1 },
            injection_attempts_n: 0,
        },
    };
    const md = metrics.renderMarkdownBlock(payload);
    assert.match(md, /<!-- pilot-metrics:auto -->/);
    assert.match(md, /<!-- \/pilot-metrics:auto -->/);
    assert.match(md, /Métricas del piloto/);
    assert.match(md, /Latencia P50/);
    assert.match(md, /25\.0%/); // rejection rate
    assert.match(md, /\$5\.50/); // cost
    assert.match(md, /#4001/);
    assert.match(md, /#4002/);
});
