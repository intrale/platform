// =============================================================================
// Tests de `pr-mergeability-watcher.js` (#4966).
//
// Sin red y sin FS real salvo donde se testea el FS explícitamente (ahí:
// `os.tmpdir()` con cleanup). Todo el I/O entra por `deps`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const watcher = require('../pr-mergeability-watcher');
const rewind = require('../pipeline-rewind');

const {
    decideMergeability,
    screenCandidate,
    normalizeConfig,
    sanitizeState,
    buildMergeConflictEvent,
    runWatcherPoll,
    resolveContained,
    assertNotSymlink,
    statePath,
    eventsPath,
    REASONS,
    EVENT_SOURCE,
    EVENT_FIELDS,
} = watcher;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Fixture de "token" para probar la redaccion. Armado por CONCATENACION: escrito
// literal, el secret-scan de pre-commit bloquea el commit (y hace bien: no puede
// distinguir un fixture de un token filtrado).
const FAKE_GH_TOKEN = 'gh' + 'p_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

const REPO = 'intrale/platform';
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const MIN_GAP = 60_000;

function obs(overrides) {
    return {
        repo: REPO,
        pr: 4610,
        issue: 4509,
        headRefOid: OID_A,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        ...overrides,
    };
}

/**
 * Corre una secuencia de observaciones encadenando el `nextEntry`, tal como lo
 * hace el adaptador entre polls.
 */
function runSequence(muestras, { start = 1, t0 = 1_000_000, gap = MIN_GAP * 2 } = {}) {
    let entry = null;
    const pasos = [];
    muestras.forEach((m, i) => {
        const r = decideMergeability({
            prevEntry: entry,
            observation: obs(m.observation || m),
            pollSeq: m.pollSeq !== undefined ? m.pollSeq : start + i,
            now: m.now !== undefined ? m.now : t0 + i * gap,
            minPollIntervalMs: MIN_GAP,
        });
        entry = r.nextEntry;
        pasos.push(r);
    });
    return pasos;
}

function prFixture(overrides) {
    return {
        number: 4610,
        state: 'OPEN',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        headRefOid: OID_A,
        headRefName: 'agent/4509-android-dev',
        baseRefName: 'main',
        headRepositoryOwner: { login: 'intrale' },
        isCrossRepository: false,
        updatedAt: '2026-09-06T00:00:00Z',
        url: 'https://github.com/intrale/platform/pull/4610',
        ...overrides,
    };
}

const CFG_ON = {
    enabled: true,
    expected_repo: REPO,
    expected_owner: 'intrale',
    expected_base: 'main',
    candidate_limit: 20,
    min_poll_interval_ms: MIN_GAP,
    gh_timeout_ms: 5000,
    state_entry_ttl_hours: 72,
};

const WAVE = { number: 10, issues: [{ number: 4509 }, { number: 4966 }, { number: 7000 }] };

/**
 * Arma un `deps` con storage en memoria. Devuelve también los artefactos para
 * poder asertar sobre ellos.
 */
function memDeps({ candidates, detail, wave = WAVE, state = null, clock, onWrite } = {}) {
    const jsonl = [];
    const escrituras = [];
    let current = state;
    let t = (clock && clock.start) || 1_000_000;
    const step = (clock && clock.step) || MIN_GAP * 2;
    return {
        jsonl,
        escrituras,
        get state() { return current; },
        deps: {
            pipelineRoot: path.join(os.tmpdir(), 'no-usado-porque-todo-esta-inyectado'),
            now: () => { const v = t; t += step; return v; },
            getActiveWave: () => wave,
            fetchCandidates: async () => (typeof candidates === 'function' ? candidates() : candidates),
            fetchPrDetail: async (n) => (typeof detail === 'function' ? detail(n) : detail),
            readState: () => current,
            writeState: (s) => {
                current = JSON.parse(JSON.stringify(s));
                escrituras.push(current);
                if (onWrite) onWrite(current);
            },
            appendEvent: (rec) => jsonl.push(rec),
        },
    };
}

// =============================================================================
// 1 · CAPA PURA — secuencia de dos observaciones (CA-2)
// =============================================================================

test('CA-2 · UNKNOWN -> CONFLICTING -> CONFLICTING emite recién en la tercera observación', () => {
    const pasos = runSequence([
        { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' },
        { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
        { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    ]);
    assert.deepStrictEqual(
        pasos.map((p) => [p.action, p.reason]),
        [
            ['observe', REASONS.UNKNOWN_STATE],
            ['observe', REASONS.SINGLE_SAMPLE],
            ['emit', REASONS.CONFIRMED_CONFLICT],
        ],
    );
    assert.strictEqual(pasos[2].nextEntry.emitted, true);
    assert.strictEqual(pasos[2].nextEntry.observations.length, 2);
});

test('CA-2 · una sola muestra conflictiva no emite (single_sample)', () => {
    const [p] = runSequence([{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }]);
    assert.strictEqual(p.action, 'observe');
    assert.strictEqual(p.reason, REASONS.SINGLE_SAMPLE);
    assert.strictEqual(p.nextEntry.emitted, false);
});

test('CA-2 · mergeStateStatus DIRTY alcanza como señal de conflicto aunque mergeable no lo diga', () => {
    const pasos = runSequence([
        { mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' },
        { mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' },
    ]);
    assert.strictEqual(pasos[1].action, 'emit');
});

test('CA-3 · flapping CONFLICTING -> MERGEABLE -> CONFLICTING no emite y reinicia la secuencia', () => {
    const pasos = runSequence([
        { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
        { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
        { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    ]);
    assert.deepStrictEqual(
        pasos.map((p) => [p.action, p.reason]),
        [
            ['observe', REASONS.SINGLE_SAMPLE],
            ['reset', REASONS.FLAPPING],
            ['observe', REASONS.SINGLE_SAMPLE],
        ],
    );
    assert.ok(pasos.every((p) => p.action !== 'emit'));
    assert.strictEqual(pasos[1].nextEntry.observations.length, 0);
});

test('CA-3 · headRefOid distinto entre muestras corta la secuencia (head_changed)', () => {
    const pasos = runSequence([
        { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefOid: OID_A },
        { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefOid: OID_B },
    ]);
    assert.strictEqual(pasos[1].action, 'observe');
    assert.strictEqual(pasos[1].reason, REASONS.HEAD_CHANGED);
    assert.strictEqual(pasos[1].nextEntry.observations.length, 1);
    assert.strictEqual(pasos[1].nextEntry.headRefOid, OID_B);
});

test('CA-3 · dos muestras del MISMO poll no confirman nada (same_poll)', () => {
    const pasos = runSequence([
        { observation: {}, pollSeq: 7, now: 1_000_000 },
        { observation: {}, pollSeq: 7, now: 1_000_000 + MIN_GAP * 5 },
    ]);
    assert.strictEqual(pasos[1].action, 'noop');
    assert.strictEqual(pasos[1].reason, REASONS.SAME_POLL);
    assert.strictEqual(pasos[1].nextEntry.emitted, false);
});

test('CA-3 · polls consecutivos demasiado juntos tampoco confirman (same_poll)', () => {
    const pasos = runSequence([
        { observation: {}, pollSeq: 1, now: 1_000_000 },
        { observation: {}, pollSeq: 2, now: 1_000_000 + MIN_GAP - 1 },
    ]);
    assert.strictEqual(pasos[1].action, 'noop');
    assert.strictEqual(pasos[1].reason, REASONS.SAME_POLL);
    // La muestra ancla se conserva: el próximo poll con gap suficiente confirma.
    assert.strictEqual(pasos[1].nextEntry.observations.length, 1);
    const tercero = decideMergeability({
        prevEntry: pasos[1].nextEntry,
        observation: obs(),
        pollSeq: 3,
        now: 1_000_000 + MIN_GAP * 3,
        minPollIntervalMs: MIN_GAP,
    });
    assert.strictEqual(tercero.action, 'emit');
});

test('CA-3 · reloj no monótono (ts retrocede) reinicia sin emitir', () => {
    const pasos = runSequence([
        { observation: {}, pollSeq: 1, now: 5_000_000 },
        { observation: {}, pollSeq: 2, now: 1_000_000 },
    ]);
    assert.strictEqual(pasos[1].action, 'noop');
    assert.strictEqual(pasos[1].reason, REASONS.CLOCK_NOT_MONOTONIC);
    assert.strictEqual(pasos[1].nextEntry.emitted, false);
    assert.strictEqual(pasos[1].nextEntry.observations.length, 1);
    assert.strictEqual(pasos[1].nextEntry.observations[0].ts, 1_000_000);
});

test('CA-3 · pollSeq que retrocede también dispara clock_not_monotonic', () => {
    const pasos = runSequence([
        { observation: {}, pollSeq: 9, now: 1_000_000 },
        { observation: {}, pollSeq: 4, now: 1_000_000 + MIN_GAP * 3 },
    ]);
    assert.strictEqual(pasos[1].reason, REASONS.CLOCK_NOT_MONOTONIC);
});

// =============================================================================
// 2 · CAPA PURA — idempotencia y reapertura (CA-4)
// =============================================================================

test('CA-4 · tras emitir, un nuevo conflicto del mismo HEAD es already_emitted', () => {
    const pasos = runSequence([{}, {}, {}]);
    assert.strictEqual(pasos[1].action, 'emit');
    assert.strictEqual(pasos[2].action, 'noop');
    assert.strictEqual(pasos[2].reason, REASONS.ALREADY_EMITTED);
});

test('CA-4 · recuperación comprobada tras un evento emitido habilita una secuencia nueva', () => {
    const pasos = runSequence([
        {},
        {},
        { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
        {},
        {},
    ]);
    assert.strictEqual(pasos[1].action, 'emit');
    assert.strictEqual(pasos[2].action, 'reset');
    assert.strictEqual(pasos[2].nextEntry.emitted, false);
    assert.ok(Number.isFinite(pasos[2].nextEntry.lastHealthyAt));
    assert.strictEqual(pasos[3].action, 'observe');
    assert.strictEqual(pasos[4].action, 'emit', 'la recuperación reabre la secuencia');
});

test('CA-4 · headRefOid nuevo tras un evento emitido habilita una secuencia nueva', () => {
    const pasos = runSequence([
        {},
        {},
        { headRefOid: OID_B },
        { headRefOid: OID_B },
    ]);
    assert.strictEqual(pasos[1].action, 'emit');
    assert.strictEqual(pasos[2].reason, REASONS.HEAD_CHANGED);
    assert.strictEqual(pasos[2].nextEntry.emitted, false);
    assert.strictEqual(pasos[3].action, 'emit');
});

test('CA-4 · un PR sano que nunca tuvo conflicto se registra como recovered, no como flapping', () => {
    const [p] = runSequence([{ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }]);
    assert.strictEqual(p.action, 'reset');
    assert.strictEqual(p.reason, REASONS.RECOVERED);
});

test('BLOCKED por CODEOWNERS con mergeable MERGEABLE no es conflicto', () => {
    const [p] = runSequence([{ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }]);
    assert.strictEqual(p.action, 'reset');
    assert.notStrictEqual(p.action, 'emit');
});

test('BEHIND sin señal de conflicto es no concluyente, no evento', () => {
    const pasos = runSequence([
        { mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND' },
        { mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND' },
    ]);
    assert.ok(pasos.every((p) => p.action !== 'emit'));
    assert.strictEqual(pasos[1].reason, REASONS.UNKNOWN_STATE);
});

// =============================================================================
// 3 · CAPA PURA — entradas inválidas (CA-3)
// =============================================================================

test('CA-3 · observación con shape inválido es no-op schema_invalid', () => {
    for (const bad of [null, undefined, [], 'x', {}, obs({ headRefOid: 'no-hex' }), obs({ mergeable: 5 })]) {
        const r = decideMergeability({
            prevEntry: null, observation: bad, pollSeq: 1, now: 1, minPollIntervalMs: MIN_GAP,
        });
        assert.strictEqual(r.action, 'noop', JSON.stringify(bad));
        assert.ok([REASONS.SCHEMA_INVALID, REASONS.INVALID_ID].includes(r.reason), r.reason);
    }
});

test('CA-3 · IDs no numéricos o negativos son invalid_id', () => {
    for (const bad of [obs({ pr: 0 }), obs({ pr: -3 }), obs({ pr: '4610; rm -rf /' }), obs({ issue: null })]) {
        const r = decideMergeability({
            prevEntry: null, observation: bad, pollSeq: 1, now: 1, minPollIntervalMs: MIN_GAP,
        });
        assert.strictEqual(r.reason, REASONS.INVALID_ID);
    }
});

test('CA-3 · pollSeq o now inválidos no permiten decidir', () => {
    assert.strictEqual(
        decideMergeability({ prevEntry: null, observation: obs(), pollSeq: 0, now: 1 }).reason,
        REASONS.SCHEMA_INVALID,
    );
    assert.strictEqual(
        decideMergeability({ prevEntry: null, observation: obs(), pollSeq: 1, now: NaN }).reason,
        REASONS.SCHEMA_INVALID,
    );
});

test('un prevEntry corrupto se descarta en vez de heredarse', () => {
    const r = decideMergeability({
        prevEntry: { repo: REPO, pr: 4610, headRefOid: OID_A, observations: 'no-array', emitted: true },
        observation: obs(),
        pollSeq: 2,
        now: 2_000_000,
        minPollIntervalMs: MIN_GAP,
    });
    assert.strictEqual(r.action, 'observe');
    assert.strictEqual(r.nextEntry.emitted, false);
});

// =============================================================================
// 4 · UNIVERSO DE CANDIDATOS (CA-1)
// =============================================================================

const CFG_NORM = normalizeConfig(CFG_ON);
const WAVE_SET = new Set([4509, 4966]);

test('CA-1 · un PR que cumple todas las condiciones es candidato', () => {
    const r = screenCandidate(prFixture(), CFG_NORM, WAVE_SET);
    assert.deepStrictEqual(r, { ok: true, issue: 4509 });
});

test('CA-1 · cada condición incumplida da su propio motivo tipado', () => {
    const casos = [
        [prFixture({ state: 'CLOSED' }), REASONS.NOT_OPEN],
        [prFixture({ state: 'MERGED' }), REASONS.NOT_OPEN],
        [prFixture({ baseRefName: 'develop' }), REASONS.UNEXPECTED_BASE],
        [prFixture({ headRepositoryOwner: { login: 'atacante' } }), REASONS.FORK_OR_CROSS_REPO],
        [prFixture({ headRepositoryOwner: null }), REASONS.FORK_OR_CROSS_REPO],
        [prFixture({ isCrossRepository: true }), REASONS.FORK_OR_CROSS_REPO],
        [prFixture({ url: 'https://github.com/otro/repo/pull/4610' }), REASONS.UNEXPECTED_REPO],
        [prFixture({ headRefName: 'docs/algo' }), REASONS.NO_AGENT_BRANCH],
        [prFixture({ headRefName: 'agent/api-pelada-agents-parity' }), REASONS.NO_AGENT_BRANCH],
        [prFixture({ headRefName: 'agent/9999-fuera-de-ola' }), REASONS.NOT_IN_ACTIVE_WAVE],
        [null, REASONS.SCHEMA_INVALID],
    ];
    for (const [pr, esperado] of casos) {
        const r = screenCandidate(pr, CFG_NORM, WAVE_SET);
        assert.strictEqual(r.ok, false, JSON.stringify(pr && pr.headRefName));
        assert.strictEqual(r.reason, esperado, JSON.stringify(pr && (pr.headRefName || pr.state)));
    }
});

test('CA-9 · la limitación de cobertura es explícita: agent/<slug> sin número queda fuera', () => {
    // Caso vivo verificado: PR #3839, rama `agent/api-pelada-agents-parity`.
    const r = screenCandidate(
        prFixture({ number: 3839, headRefName: 'agent/api-pelada-agents-parity' }),
        CFG_NORM,
        WAVE_SET,
    );
    assert.strictEqual(r.reason, REASONS.NO_AGENT_BRANCH);
});

test('CA-1 · el prefijo agent/<issue>- no matchea por número parcial', () => {
    // `agent/45090-x` NO debe leerse como issue 4509.
    const r = screenCandidate(prFixture({ headRefName: 'agent/45090-x' }), CFG_NORM, WAVE_SET);
    assert.strictEqual(r.reason, REASONS.NOT_IN_ACTIVE_WAVE);
});

// =============================================================================
// 5 · CONFIG (CA-7)
// =============================================================================

test('CA-7 · nace apagado: sólo el booleano true enciende', () => {
    assert.strictEqual(normalizeConfig(undefined).enabled, false);
    assert.strictEqual(normalizeConfig({}).enabled, false);
    assert.strictEqual(normalizeConfig({ enabled: 'true' }).enabled, false);
    assert.strictEqual(normalizeConfig({ enabled: 1 }).enabled, false);
    assert.strictEqual(normalizeConfig({ enabled: true }).enabled, true);
});

test('CA-7 · los límites se clampean EN CÓDIGO, no se confían al YAML', () => {
    const c = normalizeConfig({ candidate_limit: 100000, gh_timeout_ms: 1, min_poll_interval_ms: -5, state_entry_ttl_hours: 99999 });
    assert.strictEqual(c.candidateLimit, 100);
    assert.strictEqual(c.ghTimeoutMs, 1000);
    assert.strictEqual(c.minPollIntervalMs, 1000);
    assert.strictEqual(c.stateEntryTtlMs, 24 * 30 * 3_600_000);
});

test('CA-7 · un repo con charset inválido cae al default, no viaja al argv', () => {
    assert.strictEqual(normalizeConfig({ expected_repo: 'intrale/platform; rm -rf /' }).repo, 'intrale/platform');
    assert.strictEqual(normalizeConfig({ expected_repo: '$(whoami)/x' }).repo, 'intrale/platform');
});

test('el config.yaml de HEAD trae la sección apagada', () => {
    const yaml = fs.readFileSync(path.join(__dirname, '..', '..', 'config.yaml'), 'utf8');
    const m = /^pr_mergeability_watcher:\r?\n([\s\S]*?)(?=\r?\n[a-zA-Z_]+:)/m.exec(yaml);
    assert.ok(m, 'la sección pr_mergeability_watcher debe existir en config.yaml');
    assert.ok(/^\s+enabled:\s*false\s*$/m.test(m[1]), 'debe nacer con enabled: false');
});

// =============================================================================
// 6 · ESTADO — validación, corrupción, rutas
// =============================================================================

test('CA-3 · estado corrupto o con shape inesperado se rechaza entero', () => {
    const malos = [
        'no-es-objeto',
        [],
        { version: 99, pollSeq: 0, entries: {} },
        { version: 1, pollSeq: -1, entries: {} },
        { version: 1, pollSeq: 0, entries: [] },
        { version: 1, pollSeq: 0, entries: { 'intrale/platform#1': { repo: REPO, pr: 1 } } },
        // clave que no se corresponde con el contenido (estado manipulado)
        { version: 1, pollSeq: 0, entries: { 'otro/repo#9': { repo: REPO, pr: 1, headRefOid: OID_A, observations: [] } } },
    ];
    for (const mal of malos) {
        const r = sanitizeState(mal);
        assert.strictEqual(r.ok, false, JSON.stringify(mal));
        assert.strictEqual(r.reason, REASONS.STATE_CORRUPT);
    }
});

test('estado ausente arranca vacío sin error', () => {
    const r = sanitizeState(null);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.state, { version: 1, pollSeq: 0, entries: {} });
});

test('CA-4 · las rutas salen de constantes internas y están contenidas bajo .pipeline/', () => {
    const root = path.join(os.tmpdir(), 'pipeline-fake');
    assert.strictEqual(statePath(root), path.join(root, 'state', 'pr-mergeability-watcher.json'));
    assert.strictEqual(eventsPath(root), path.join(root, 'audit', 'pr-mergeability-events.jsonl'));
});

test('CA-3 · un intento de escape de path se rechaza con path_escape', () => {
    const root = path.join(os.tmpdir(), 'pipeline-fake');
    assert.throws(
        () => resolveContained(root, ['..', '..', 'etc', 'passwd']),
        (e) => e.code === REASONS.PATH_ESCAPE,
    );
    assert.throws(() => resolveContained('', ['state']), (e) => e.code === REASONS.PATH_ESCAPE);
});

test('CA-4 · escribir sobre un symlink se rechaza antes del rename', () => {
    const fakeFs = { lstatSync: () => ({ isSymbolicLink: () => true }) };
    assert.throws(
        () => assertNotSymlink('/tmp/x', fakeFs),
        (e) => e.code === REASONS.PATH_ESCAPE,
    );
    // Un archivo normal no molesta; uno inexistente tampoco.
    assert.doesNotThrow(() => assertNotSymlink('/tmp/x', { lstatSync: () => ({ isSymbolicLink: () => false }) }));
    assert.doesNotThrow(() => assertNotSymlink('/tmp/x', { lstatSync: () => { throw new Error('ENOENT'); } }));
});

// =============================================================================
// 7 · ADAPTADOR — poll completo
// =============================================================================

test('CA-7 · con enabled:false el poll no toca GitHub ni el disco', async () => {
    let tocado = false;
    const r = await runWatcherPoll({
        config: { ...CFG_ON, enabled: false },
        deps: {
            fetchCandidates: async () => { tocado = true; return { ok: true, candidates: [] }; },
            writeState: () => { tocado = true; },
            appendEvent: () => { tocado = true; },
        },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.reason, REASONS.DISABLED);
    assert.strictEqual(tocado, false);
});

test('CA-6 · dos polls confirman el conflicto, emiten el evento y lo dejan en el JSONL', async () => {
    const conflictivo = prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    const ctx = memDeps({
        candidates: { ok: true, candidates: [prFixture()], invalid: [] },
        detail: { ok: true, pr: conflictivo },
    });

    const p1 = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(p1.ok, true);
    assert.deepStrictEqual(p1.events, [], 'una sola muestra no emite');

    const p2 = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(p2.events.length, 1, 'la segunda observación confirma');

    // --- el evento respeta el shape cerrado del consumidor (CA-11) ----------
    const ev = p2.events[0];
    assert.deepStrictEqual(Object.keys(ev).sort(), [...EVENT_FIELDS].sort());
    assert.strictEqual(ev.source, EVENT_SOURCE);
    assert.strictEqual(ev.repo, REPO);
    assert.strictEqual(ev.pr, 4610);
    assert.strictEqual(ev.issue, 4509);
    assert.strictEqual(ev.headRefOid, OID_A);

    // --- y el JSONL de auditoría conserva lo que el shape cerrado no admite -
    const emitido = ctx.jsonl.find((l) => l.decision === 'emit');
    assert.ok(emitido, 'el emit tiene que quedar en el JSONL');
    assert.strictEqual(emitido.reason, REASONS.CONFIRMED_CONFLICT);
    assert.strictEqual(emitido.wave, 10);
    assert.strictEqual(emitido.observations.length, 2);
    for (const o of emitido.observations) {
        assert.ok(typeof o.ts === 'string' && o.ts.endsWith('Z'), 'timestamps ISO8601');
        assert.ok(Number.isInteger(o.poll_seq));
        assert.ok(typeof o.merge_state_status === 'string');
    }
    assert.ok(emitido.observations[1].poll_seq > emitido.observations[0].poll_seq);
    assert.strictEqual(emitido.head_ref_oid, OID_A);
    assert.strictEqual(emitido.issue, 4509);
});

test('CA-11 · el evento emitido pasa validateMergeConflictEvent de pipeline-rewind', async () => {
    const ctx = memDeps({
        candidates: { ok: true, candidates: [prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })] },
        detail: { ok: true, pr: prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) },
    });
    await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    const p2 = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    const veredicto = rewind.validateMergeConflictEvent(p2.events[0]);
    assert.strictEqual(veredicto.ok, true, JSON.stringify(veredicto));
    assert.strictEqual(veredicto.issueNum, 4509);
    assert.strictEqual(veredicto.pr, 4610);
});

test('CA-11 · las constantes del evento no divergen de las del consumidor', () => {
    assert.strictEqual(EVENT_SOURCE, rewind.MERGE_CONFLICT_SOURCE);
    assert.deepStrictEqual([...EVENT_FIELDS], [...rewind.MERGE_CONFLICT_EVENT_FIELDS]);
    const ev = buildMergeConflictEvent({ repo: REPO, pr: 1, issue: 2, headRefOid: OID_A, detectedAt: 1 });
    assert.deepStrictEqual(Object.keys(ev).sort(), [...rewind.MERGE_CONFLICT_EVENT_FIELDS].sort());
});

test('CA-4 · tras un restart (estado releído del disco) no se duplica el evento', async () => {
    const conflictivo = prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    const ctx = memDeps({
        candidates: { ok: true, candidates: [conflictivo] },
        detail: { ok: true, pr: conflictivo },
    });
    await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    const p2 = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(p2.events.length, 1);

    // "Restart": deps nuevas, mismo estado persistido, reloj que sigue avanzando.
    const persistido = ctx.state;
    const ctx2 = memDeps({
        candidates: { ok: true, candidates: [conflictivo] },
        detail: { ok: true, pr: conflictivo },
        state: persistido,
        clock: { start: 9_000_000 },
    });
    const p3 = await runWatcherPoll({ config: CFG_ON, deps: ctx2.deps });
    assert.deepStrictEqual(p3.events, [], 'no puede re-emitir tras el restart');
    assert.strictEqual(ctx2.jsonl.some((l) => l.reason === REASONS.ALREADY_EMITTED), true);
});

test('CA-1 · issue fuera de la ola activa es no-op auditado (caso vivo PR #4610 -> #4509)', async () => {
    const ctx = memDeps({
        candidates: { ok: true, candidates: [prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })] },
        detail: { ok: true, pr: prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) },
        wave: { number: 10, issues: [{ number: 4966 }] }, // 4509 NO está
    });
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.deepStrictEqual(r.events, []);
    const linea = ctx.jsonl.find((l) => l.reason === REASONS.NOT_IN_ACTIVE_WAVE);
    assert.ok(linea, 'el descarte tiene que quedar auditado');
    assert.strictEqual(linea.pr, 4610);
});

test('CA-1 · dos PRs abiertos para el mismo issue son ambiguous_association, ninguno se observa', async () => {
    const a = prFixture({ number: 4610, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    const b = prFixture({
        number: 4611,
        headRefOid: OID_B,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        url: 'https://github.com/intrale/platform/pull/4611',
    });
    let detailCalls = 0;
    const ctx = memDeps({
        candidates: { ok: true, candidates: [a, b] },
        detail: () => { detailCalls += 1; return { ok: true, pr: a }; },
    });
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.deepStrictEqual(r.events, []);
    assert.strictEqual(detailCalls, 0, 'ni siquiera se gasta un pr view en un issue ambiguo');
    const ambiguos = ctx.jsonl.filter((l) => l.reason === REASONS.AMBIGUOUS_ASSOCIATION);
    assert.strictEqual(ambiguos.length, 2, 'se auditan los dos PRs del grupo');
});

test('CA-1 · cero candidatos válidos no produce nada y no rompe', async () => {
    const ctx = memDeps({ candidates: { ok: true, candidates: [], invalid: [] } });
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.events, []);
});

test('no se gasta un pr view en PRs que el list ya muestra sanos', async () => {
    let detailCalls = 0;
    const ctx = memDeps({
        candidates: { ok: true, candidates: [prFixture({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })] },
        detail: () => { detailCalls += 1; return { ok: true, pr: prFixture() }; },
    });
    await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(detailCalls, 0);
});

test('CA-3 · un fallo de GitHub en el list corta el poll como no-op auditado', async () => {
    for (const reason of [REASONS.GH_TIMEOUT, REASONS.RATE_LIMITED, REASONS.NON_ZERO_EXIT, REASONS.JSON_PARSE_FAILED]) {
        const ctx = memDeps({ candidates: { ok: false, reason } });
        const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, reason);
        assert.deepStrictEqual(r.events, []);
        assert.ok(ctx.jsonl.some((l) => l.reason === reason && l.decision === 'noop'));
    }
});

test('CA-3 · un fallo del pr view descarta ESE PR, no el poll entero', async () => {
    const ok = prFixture({ number: 7001, headRefName: 'agent/7000-x', url: 'https://github.com/intrale/platform/pull/7001' });
    const ctx = memDeps({
        candidates: { ok: true, candidates: [prFixture(), ok] },
        detail: (n) => (n === 4610
            ? { ok: false, reason: REASONS.RATE_LIMITED }
            : { ok: true, pr: { ...ok, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } }),
    });
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(r.ok, true);
    assert.ok(ctx.jsonl.some((l) => l.pr === 4610 && l.reason === REASONS.RATE_LIMITED));
    assert.ok(ctx.jsonl.some((l) => l.pr === 7001 && l.reason === REASONS.SINGLE_SAMPLE));
});

test('CA-3 · elementos con shape inválido del list se auditan y se descartan', async () => {
    const ctx = memDeps({ candidates: { ok: true, candidates: [], invalid: [4610, null] } });
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(ctx.jsonl.filter((l) => l.reason === REASONS.SCHEMA_INVALID).length, 2);
});

test('CA-3 · si el pr view devuelve un PR que ya no califica, se descarta con su motivo', async () => {
    const ctx = memDeps({
        candidates: { ok: true, candidates: [prFixture()] },
        detail: { ok: true, pr: prFixture({ state: 'CLOSED', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) },
    });
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.deepStrictEqual(r.events, []);
    assert.ok(ctx.jsonl.some((l) => l.reason === REASONS.NOT_OPEN));
});

test('CA-3 · estado corrupto en disco arranca de cero, audita y no emite', async () => {
    const ctx = memDeps({
        candidates: { ok: true, candidates: [prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })] },
        detail: { ok: true, pr: prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) },
        state: { version: 1, pollSeq: 'no-es-numero', entries: { basura: true } },
    });
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.events, [], 'nunca se emite sobre un estado no validado');
    assert.ok(ctx.jsonl.some((l) => l.reason === REASONS.STATE_CORRUPT));
    assert.strictEqual(r.pollSeq, 1, 'el contador reinicia con el estado');
});

test('CA-3 · JSON inválido en el archivo de estado no lanza', async () => {
    const ctx = memDeps({ candidates: { ok: true, candidates: [] } });
    ctx.deps.readState = () => { throw new SyntaxError('Unexpected token } in JSON'); };
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(r.ok, true);
    assert.ok(ctx.jsonl.some((l) => l.reason === REASONS.STATE_CORRUPT));
});

test('CA-7 · una excepción arbitraria de una dependencia NO se propaga', async () => {
    const boom = new Error('la dependencia explotó');
    for (const key of ['fetchCandidates', 'fetchPrDetail', 'writeState', 'getActiveWave']) {
        const ctx = memDeps({
            candidates: { ok: true, candidates: [prFixture()] },
            detail: { ok: true, pr: prFixture() },
        });
        ctx.deps[key] = () => { throw boom; };
        let r;
        await assert.doesNotReject(async () => { r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps }); });
        assert.ok(r && typeof r.ok === 'boolean', key);
        if (key === 'getActiveWave') {
            // getActiveWave se envuelve aparte: sin ola no hay universo que observar.
            assert.strictEqual(r.reason, REASONS.NO_ACTIVE_WAVE);
        } else if (key === 'fetchPrDetail') {
            assert.strictEqual(r.ok, false);
        } else {
            assert.strictEqual(r.ok, false, key);
            assert.strictEqual(r.reason, REASONS.INTERNAL_ERROR, key);
        }
    }
});

test('CA-3 · sin ola activa el watcher no observa nada', async () => {
    for (const wave of [null, {}, { number: 10, issues: [] }, { number: 10, issues: 'x' }]) {
        const ctx = memDeps({ candidates: { ok: true, candidates: [prFixture()] }, wave });
        const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
        assert.strictEqual(r.reason, REASONS.NO_ACTIVE_WAVE);
        assert.deepStrictEqual(r.events, []);
    }
});

test('CA-3 · un fallo al escribir el JSONL no tumba el poll', async () => {
    const ctx = memDeps({ candidates: { ok: true, candidates: [] } });
    ctx.deps.appendEvent = () => { throw new Error('EACCES'); };
    ctx.deps.getActiveWave = () => null;
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(r.ok, true);
    assert.ok(Array.isArray(r.auditWriteErrors) && r.auditWriteErrors.length > 0);
});

test('el pollSeq es monótono y se persiste entre polls', async () => {
    const ctx = memDeps({ candidates: { ok: true, candidates: [] } });
    const seqs = [];
    for (let i = 0; i < 3; i += 1) {
        seqs.push((await runWatcherPoll({ config: CFG_ON, deps: ctx.deps })).pollSeq);
    }
    assert.deepStrictEqual(seqs, [1, 2, 3]);
    assert.strictEqual(ctx.state.pollSeq, 3);
});

test('las entradas huérfanas se podan cuando el PR desaparece del barrido', async () => {
    const conflictivo = prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    const ctx = memDeps({ candidates: { ok: true, candidates: [conflictivo] }, detail: { ok: true, pr: conflictivo } });
    await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(Object.keys(ctx.state.entries).length, 1);

    // El PR se cerró: ya no aparece en el `pr list` (lista NO truncada).
    const ctx2 = memDeps({ candidates: { ok: true, candidates: [] }, state: ctx.state, clock: { start: 9_000_000 } });
    await runWatcherPoll({ config: CFG_ON, deps: ctx2.deps });
    assert.deepStrictEqual(Object.keys(ctx2.state.entries), []);
});

test('con la lista truncada por --limit la poda por ausencia NO borra: sólo el TTL', async () => {
    const conflictivo = prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    const ctx = memDeps({ candidates: { ok: true, candidates: [conflictivo] }, detail: { ok: true, pr: conflictivo } });
    await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });

    // limit 1 y 1 candidato distinto ⇒ la página vino llena: no se puede
    // distinguir "cerrado" de "quedó fuera de la página".
    const otro = prFixture({ number: 7001, headRefName: 'agent/7000-x', url: 'https://github.com/intrale/platform/pull/7001' });
    const ctx2 = memDeps({
        candidates: { ok: true, candidates: [otro] },
        detail: { ok: true, pr: otro },
        state: ctx.state,
        clock: { start: 9_000_000 },
    });
    await runWatcherPoll({ config: { ...CFG_ON, candidate_limit: 1 }, deps: ctx2.deps });
    assert.ok(ctx2.state.entries[`${REPO}#4610`], 'la entrada sobrevive: la lista estaba truncada');

    // Con el TTL vencido sí se poda.
    const ctx3 = memDeps({
        candidates: { ok: true, candidates: [otro] },
        detail: { ok: true, pr: otro },
        state: ctx2.state,
        clock: { start: 9_000_000 + 100 * 3_600_000 },
    });
    await runWatcherPoll({ config: { ...CFG_ON, candidate_limit: 1 }, deps: ctx3.deps });
    assert.strictEqual(ctx3.state.entries[`${REPO}#4610`], undefined, 'el TTL sí la poda');
});

// =============================================================================
// 8 · FS real (tmpdir): persistencia atómica + append-only
// =============================================================================

test('CA-4/CA-6 · el poll escribe estado atómico y JSONL append-only en el FS real', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prmw-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const conflictivo = prFixture({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    let t0 = 1_000_000;
    const deps = {
        pipelineRoot: root,
        now: () => { const v = t0; t0 += MIN_GAP * 2; return v; },
        getActiveWave: () => WAVE,
        fetchCandidates: async () => ({ ok: true, candidates: [conflictivo] }),
        fetchPrDetail: async () => ({ ok: true, pr: conflictivo }),
    };

    await runWatcherPoll({ config: CFG_ON, deps });
    const p2 = await runWatcherPoll({ config: CFG_ON, deps });
    assert.strictEqual(p2.events.length, 1);

    const estado = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    assert.strictEqual(estado.version, 1);
    assert.strictEqual(estado.pollSeq, 2);
    assert.strictEqual(estado.entries[`${REPO}#4610`].emitted, true);
    assert.strictEqual(sanitizeState(estado).ok, true, 'lo escrito debe poder releerse');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'state')), ['pr-mergeability-watcher.json'],
        'el .tmp del write atómico no queda colgado');

    const lineas = fs.readFileSync(eventsPath(root), 'utf8').trim().split('\n');
    assert.ok(lineas.length >= 2, 'append-only: el JSONL acumula, no se pisa');
    for (const l of lineas) JSON.parse(l); // una línea = un JSON válido
    const emit = lineas.map((l) => JSON.parse(l)).find((r) => r.decision === 'emit');
    assert.ok(emit && emit.event && emit.event.source === EVENT_SOURCE);
});

test('CA-3 · un pipelineRoot inválido termina en path_escape sin escribir nada', async () => {
    const r = await runWatcherPoll({ config: CFG_ON, deps: { pipelineRoot: null } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, REASONS.PATH_ESCAPE);
});

// =============================================================================
// 9 · Seguridad: nada de secretos en la salida
// =============================================================================

test('CA-5 · ninguna salida del watcher filtra tokens, headers ni env', async () => {
    const ctx = memDeps({
        candidates: {
            ok: false,
            reason: REASONS.NON_ZERO_EXIT,
            stderr: `gh: HTTP 401 Authorization: Bearer ${FAKE_GH_TOKEN}`,
        },
    });
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    const serializado = JSON.stringify([r, ctx.jsonl]);
    assert.ok(!/ghp_[A-Za-z0-9]{16,}/.test(serializado), 'no puede aparecer un token');
    assert.ok(!/GH_TOKEN|GITHUB_TOKEN/.test(serializado));
});

test('CA-5 · el mensaje de una excepción interna se redacta antes de salir', async () => {
    const ctx = memDeps({ candidates: { ok: true, candidates: [] } });
    ctx.deps.writeState = () => { throw new Error(`falló con token ${FAKE_GH_TOKEN}`); };
    const r = await runWatcherPoll({ config: CFG_ON, deps: ctx.deps });
    assert.strictEqual(r.ok, false);
    assert.ok(!/ghp_[A-Za-z0-9]{16,}/.test(JSON.stringify(r)));
    assert.ok(/REDACTED/.test(r.message));
});

test('el módulo no usa shell ni ejecución sincrónica de comandos', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'pr-mergeability-watcher.js'), 'utf8');
    assert.ok(!/shell:\s*true/.test(src));
    assert.ok(!/execSync|spawnSync|child_process/.test(src.replace(/^\/\/.*$/gm, '')));
});

test('con un fsImpl doble el estado se escribe sin delegar en waves.atomicWriteFile', async () => {
    const escrituras = [];
    const appends = [];
    const fakeFs = {
        lstatSync: () => ({ isSymbolicLink: () => false }),
        mkdirSync: () => {},
        readFileSync: () => { const e = new Error('ENOENT'); throw e; },
        writeFileSync: (p, data) => escrituras.push({ p, data }),
        appendFileSync: (p, data) => appends.push({ p, data }),
    };
    const root = path.join(os.tmpdir(), 'prmw-fake-root');
    const r = await runWatcherPoll({
        config: CFG_ON,
        deps: {
            pipelineRoot: root,
            fsImpl: fakeFs,
            now: () => 1_000_000,
            getActiveWave: () => WAVE,
            fetchCandidates: async () => ({ ok: true, candidates: [] }),
        },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(escrituras.length, 1);
    assert.strictEqual(escrituras[0].p, statePath(root));
    assert.strictEqual(JSON.parse(escrituras[0].data).pollSeq, 1);
});

test('CA-4 · el writer por defecto rechaza un symlink en el path del estado', async () => {
    const fakeFs = {
        lstatSync: () => ({ isSymbolicLink: () => true }),
        mkdirSync: () => {},
        readFileSync: () => { throw new Error('ENOENT'); },
        writeFileSync: () => { throw new Error('no debería llegar acá'); },
        appendFileSync: () => {},
    };
    const r = await runWatcherPoll({
        config: CFG_ON,
        deps: {
            pipelineRoot: path.join(os.tmpdir(), 'prmw-symlink'),
            fsImpl: fakeFs,
            now: () => 1_000_000,
            getActiveWave: () => WAVE,
            fetchCandidates: async () => ({ ok: true, candidates: [] }),
        },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, REASONS.PATH_ESCAPE);
});
