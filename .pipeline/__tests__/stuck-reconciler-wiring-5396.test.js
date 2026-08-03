// =============================================================================
// stuck-reconciler-wiring-5396.test.js — #5396, requisito SEC-0
//
// POR QUÉ ESTE ARCHIVO EXISTE
// ---------------------------
// Los tests del reconciler mockeaban `allowed: true` / `hasNeedsHuman: false` y
// pasaban en verde mientras producción seguía rota: el defecto no estaba en la
// decisión sino en el CABLEADO, que vivía inline en `pulpo.js` y por lo tanto no
// era testeable (16k líneas con side-effects al requerirlas).
//
// Acá se verifica la POLÍTICA REAL contra `buildStuckReconcilerDeps`, con el
// `ppMode` que devuelve el `partialPause.getPipelineMode()` de verdad, leído de
// un `.partial-pause.json` serializado en un tmpdir. Si alguien vuelve a
// reimplementar la allowlist a mano, estos tests se ponen rojos.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const partialPause = require('../lib/partial-pause');
const { buildStuckReconcilerDeps, evaluateSilenceHealth } = require('../lib/stuck-reconciler-deps');
const { runStuckPhaseReconciler } = require('../lib/stuck-phase-reconciler-runner');

const NOW = 1_800_000_000_000;
const HOUR = 3600000;

const CONFIG = {
    pipelines: {
        desarrollo: {
            fases: ['dev', 'validacion', 'verificacion', 'aprobacion'],
            skills_por_fase: { verificacion: ['qa', 'tester'] },
        },
    },
};

function tmpPipeline() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-wiring-5396-'));
    for (const fase of CONFIG.pipelines.desarrollo.fases) {
        for (const st of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
            fs.mkdirSync(path.join(dir, 'desarrollo', fase, st), { recursive: true });
        }
    }
    fs.mkdirSync(path.join(dir, 'servicios', 'github', 'pendiente'), { recursive: true });
    return dir;
}

/** Corre `fn` con `PIPELINE_DIR_OVERRIDE` apuntando al tmpdir (y lo restaura). */
function withPipelineDir(dir, fn) {
    const prevDir = process.env.PIPELINE_DIR_OVERRIDE;
    const prevEscape = process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    try { return fn(); } finally {
        if (prevDir === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prevDir;
        if (prevEscape === undefined) delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
        else process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH = prevEscape;
    }
}

function writeTitleCache(dir, entries) {
    fs.writeFileSync(path.join(dir, '.issue-title-cache.json'), JSON.stringify(entries));
}

function buildDeps(dir, over = {}) {
    return buildStuckReconcilerDeps({
        config: CONFIG,
        PIPELINE: dir,
        ROOT: dir,
        pauseFile: path.join(dir, '.paused'),
        ppMode: over.ppMode !== undefined ? over.ppMode : partialPause.getPipelineMode(),
        nowMs: NOW,
        deps: { log: () => { }, ...(over.deps || {}) },
    });
}

// -----------------------------------------------------------------------------
// CA-3 / SEC-0 — filtro de ola contra el cableado real
// -----------------------------------------------------------------------------

test('CA-3 anti-regresión: issue EN allowedIssues durante partial_pause → isAllowed true', () => {
    // Éste es el test que el bug `allowed_issues` (snake) vs `allowedIssues`
    // (camel) hacía fallar: el lambda viejo devolvía false para TODOS los issues
    // durante la ola, dejando el self-healing muerto justo cuando hace falta.
    const dir = tmpPipeline();
    fs.writeFileSync(path.join(dir, '.partial-pause.json'), JSON.stringify({
        allowed_issues: [5209, 5211, 5242],
        created_at: new Date(NOW).toISOString(),
        source: 'test-5396',
    }));

    withPipelineDir(dir, () => {
        const ppMode = partialPause.getPipelineMode();
        assert.equal(ppMode.mode, 'partial_pause', 'precondición: el modo real es partial_pause');
        assert.deepEqual(ppMode.allowedIssues, [5209, 5211, 5242]);
        assert.equal(ppMode.allowed_issues, undefined, 'el objeto normalizado NO expone snake_case');

        const deps = buildDeps(dir, { ppMode });
        assert.equal(deps.isAllowed(5209), true, 'un issue de la ola SÍ debe poder escalar');
        assert.equal(deps.isAllowed('5211'), true, 'acepta el issue como string');
        assert.equal(deps.isAllowed(742), false, 'residuo de julio fuera de la ola');
    });
});

test('CA-3: modo running sin escape hatch → isAllowed false para cualquier issue', () => {
    // Sin allowlist no hay ola vigente que acote el barrido (#5060): fail-closed.
    // Antes, fuera de `partial_pause` el lambda devolvía true y el reconciler
    // escalaba TODO el backlog histórico (22 de 25 issues eran residuo).
    const dir = tmpPipeline();
    withPipelineDir(dir, () => {
        const ppMode = partialPause.getPipelineMode();
        assert.equal(ppMode.mode, 'running');
        const deps = buildDeps(dir, { ppMode });
        for (const n of [742, 1094, 5209]) {
            assert.equal(deps.isAllowed(n), false, `#${n} no debe barrerse fuera de ola`);
        }
    });
});

test('CA-3: modo paused → isAllowed false', () => {
    const dir = tmpPipeline();
    fs.writeFileSync(path.join(dir, '.paused'), 'test');
    withPipelineDir(dir, () => {
        const ppMode = partialPause.getPipelineMode();
        assert.equal(ppMode.mode, 'paused');
        assert.equal(buildDeps(dir, { ppMode }).isAllowed(5209), false);
    });
});

test('CA-3: isAllowed rechaza entradas basura sin explotar', () => {
    const dir = tmpPipeline();
    withPipelineDir(dir, () => {
        const deps = buildDeps(dir, { ppMode: partialPause.getPipelineMode() });
        for (const bad of [null, undefined, 0, -1, 'abc', {}]) {
            assert.equal(deps.isAllowed(bad), false);
        }
    });
});

// -----------------------------------------------------------------------------
// CA-1 / CA-2 / SEC-1 / SEC-2 — origen de la supresión
// -----------------------------------------------------------------------------

test('CA-1: marker físico en bloqueado-humano/ → "marker" (fuente de verdad)', () => {
    const dir = tmpPipeline();
    fs.writeFileSync(path.join(dir, 'desarrollo', 'verificacion', 'bloqueado-humano', '5209.reconciler'), '');
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), 'marker');
});

test('CA-1: orden de label sin drenar en la cola → "cola"', () => {
    const dir = tmpPipeline();
    fs.writeFileSync(path.join(dir, 'servicios', 'github', 'pendiente', '5209-needs-human-block-1.json'), '{}');
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), 'cola');
});

test('CA-1: cola drenada + label ya aplicado en GitHub → "cache-label" (el dedupe sobrevive)', () => {
    // Éste es el corazón del bug: drenada la cola, el dedupe viejo se apagaba y
    // el mismo issue se re-escalaba y re-notificaba cada 10 minutos.
    const dir = tmpPipeline();
    writeTitleCache(dir, {
        5209: { title: 'algo', state: 'OPEN', labels: ['Ready', 'needs-human'], fetchedAt: NOW - 60000 },
    });
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), 'cache-label');
});

test('CA-1: precedencia marker > cola > cache', () => {
    const dir = tmpPipeline();
    fs.writeFileSync(path.join(dir, 'desarrollo', 'verificacion', 'bloqueado-humano', '5209.reconciler'), '');
    fs.writeFileSync(path.join(dir, 'servicios', 'github', 'pendiente', '5209-needs-human-x.json'), '{}');
    writeTitleCache(dir, { 5209: { state: 'OPEN', labels: ['needs-human'], fetchedAt: NOW } });
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), 'marker');
});

test('SEC-2: entrada con fetchedAt vencido → "cache-desconocida" (fail-closed)', () => {
    const dir = tmpPipeline();
    writeTitleCache(dir, {
        5209: { title: 'algo', state: 'OPEN', labels: ['needs-human'], fetchedAt: NOW - (3 * HOUR) },
    });
    // Reusa `title-cache-freshness.needsRefetch` (TTL 1h) — sin TTL nuevo.
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), 'cache-desconocida');
});

test('CA-2: sin entrada en caché → "cache-desconocida", nunca false', () => {
    const dir = tmpPipeline();
    writeTitleCache(dir, {});
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), 'cache-desconocida');
});

test('CA-2: caché ilegible o ausente → "cache-desconocida" (no explota)', () => {
    const dir = tmpPipeline();
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), 'cache-desconocida', 'archivo ausente');
    fs.writeFileSync(path.join(dir, '.issue-title-cache.json'), '{ json roto');
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), 'cache-desconocida', 'JSON corrupto');
});

test('SEC-1: sólo una entrada FRESCA y sin el label devuelve false (habilita escalar)', () => {
    const dir = tmpPipeline();
    writeTitleCache(dir, {
        5209: { title: 'algo', state: 'OPEN', labels: ['Ready', 'bug'], fetchedAt: NOW - 60000 },
    });
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), false);
});

test('SEC-1: la caché nunca habilita un escalado por ausencia de datos', () => {
    const dir = tmpPipeline();
    // Entrada pre-#3905 sin `state` → `needsRefetch` true → desconocida.
    writeTitleCache(dir, { 5209: { title: 'algo', labels: [], fetchedAt: NOW } });
    assert.equal(buildDeps(dir).hasNeedsHuman(5209), 'cache-desconocida');
});

test('isIssueOpen y issueTitle leen la misma caché con criterios distintos', () => {
    const dir = tmpPipeline();
    writeTitleCache(dir, {
        5209: { title: '  Titulo con espacios  ', state: 'OPEN', labels: [], fetchedAt: NOW - 60000 },
        5211: { title: 'Cerrado', state: 'CLOSED', labels: [], fetchedAt: NOW - (5 * HOUR) },
    });
    const deps = buildDeps(dir);
    assert.equal(deps.isIssueOpen(5209), true);
    assert.equal(deps.isIssueOpen(5211), false);
    assert.equal(deps.issueTitle(5209), 'Titulo con espacios');
    assert.equal(deps.issueTitle(5211), null, 'entrada stale → sin título (no miente)');
});

// -----------------------------------------------------------------------------
// Causa raíz 3 / CA-5 / CA-6 — el escalado planta el marker por su dueño
// -----------------------------------------------------------------------------

test('CA-5: escalate delega en reportHumanBlock (no encola el label a mano)', () => {
    const dir = tmpPipeline();
    const calls = [];
    const deps = buildDeps(dir, {
        deps: { humanBlock: { reportHumanBlock: (o) => { calls.push(o); return {}; } } },
    });

    deps.escalate(5209, 'ambigüedad (rechazo/cancelado/corrupto)', {
        pipeline: 'desarrollo', fase: 'verificacion', skills: ['tester'],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].issue, 5209);
    // #5396 rev-1 — skill REAL de la fase, no el sintético `reconciler`.
    assert.equal(calls[0].skill, 'tester');
    assert.ok(
        CONFIG.pipelines.desarrollo.skills_por_fase.verificacion.includes(calls[0].skill),
        'el skill del marker debe pertenecer a skills_por_fase[fase]',
    );
    // La procedencia self-healing ya no viaja en el nombre del skill: va en el reason.
    assert.match(calls[0].reason, /^\[self-healing\] /);
    assert.equal(calls[0].phase, 'verificacion');
    assert.equal(calls[0].pipeline, 'desarrollo');
    assert.match(calls[0].question, /¿Cómo destrabo #5209 en desarrollo\/verificacion\?/);

    // CA-6 / riesgo #1 — LOS DOS parámetros son necesarios: la guarda de
    // `reportHumanBlock` es `if (!pipeline || opts.moveFromActive !== false)`.
    // Sin ellos movería el deliverable de `listo/` y destruiría la evidencia.
    assert.equal(calls[0].moveFromActive, false);
    assert.ok(calls[0].pipeline, 'pipeline explícito → no busca marker activo');

    // Riesgo #6 — no debe quedar el enqueue manual del label.
    const cola = fs.readdirSync(path.join(dir, 'servicios', 'github', 'pendiente'));
    assert.deepEqual(cola, [], 'el label lo encola reportHumanBlock, no el dep');
});

test('CA-6: sin pipeline/fase explícitos NO escala (protege la evidencia)', () => {
    const dir = tmpPipeline();
    const calls = [];
    const deps = buildDeps(dir, {
        deps: { humanBlock: { reportHumanBlock: (o) => calls.push(o) } },
    });
    deps.escalate(5209, 'motivo', {});
    deps.escalate(5209, 'motivo', { pipeline: 'desarrollo' });
    deps.escalate(5209, 'motivo', { fase: 'verificacion' });
    assert.equal(calls.length, 0, 'fail-closed: mejor no escalar que mover el deliverable');
});

test('SEC-5.2: escalate valida el issue como entero positivo antes del path.join', () => {
    const dir = tmpPipeline();
    const calls = [];
    const deps = buildDeps(dir, {
        deps: { humanBlock: { reportHumanBlock: (o) => calls.push(o) } },
    });
    for (const bad of ['../../etc/passwd', -1, 0, 1.5, 'abc', null, undefined]) {
        deps.escalate(bad, 'motivo', { pipeline: 'desarrollo', fase: 'verificacion' });
    }
    assert.equal(calls.length, 0);
});

test('escalate best-effort: un reportHumanBlock que tira no propaga la excepción', () => {
    const dir = tmpPipeline();
    const deps = buildDeps(dir, {
        deps: { humanBlock: { reportHumanBlock: () => { throw new Error('disco lleno'); } } },
    });
    assert.doesNotThrow(() => deps.escalate(5209, 'motivo', { pipeline: 'desarrollo', fase: 'verificacion' }));
});

// -----------------------------------------------------------------------------
// CA-8 / CA-UX-1 / CA-UX-5 — la notificación
// -----------------------------------------------------------------------------

function notifyHarness(dir, over = {}) {
    const sent = [];
    const deps = buildDeps(dir, {
        deps: {
            sendTelegramWithMarkup: (text, markup, opts) => sent.push({ text, markup, opts }),
            humanBlock: { buildBlockedActionMarkup: (i) => ({ inline_keyboard: [[{ text: 'ok', url: `u/${i}` }]] }) },
            ...over,
        },
    });
    return { sent, deps };
}

test('CA-8: la notificación viaja en texto plano (sin parse_mode)', () => {
    const { sent, deps } = notifyHarness(tmpPipeline());
    deps.notify('🙋 #5209 necesita tu decisión', { issue: 5209, action: 'escalate' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].opts.plain, true, 'plain=true omite parse_mode en el payload');
    assert.equal(sent[0].opts.parseMode, undefined);
});

test('CA-UX-1: el escalado llega con los botones de acción rápida', () => {
    // `sendTelegramPlain` NO sirve acá: hardcodea el markup a null y mata los
    // botones. `reply_markup` es independiente del dialecto de parseo.
    const { sent, deps } = notifyHarness(tmpPipeline());
    deps.notify('🙋 #5209', { issue: 5209, action: 'escalate' });
    assert.ok(sent[0].markup, 'debe llevar reply_markup');
    assert.ok(Array.isArray(sent[0].markup.inline_keyboard));
});

test('CA-UX-1: si el markup no se puede armar, se envía igual el texto', () => {
    const { sent, deps } = notifyHarness(tmpPipeline(), {
        humanBlock: { buildBlockedActionMarkup: () => undefined },
    });
    deps.notify('🙋 #5209', { issue: 5209, action: 'escalate' });
    assert.equal(sent.length, 1, 'sin botones, pero la alerta llega');
    assert.equal(sent[0].markup, null);
});

test('CA-UX-1: un buildBlockedActionMarkup que tira no bloquea la alerta', () => {
    const { sent, deps } = notifyHarness(tmpPipeline(), {
        humanBlock: { buildBlockedActionMarkup: () => { throw new Error('token no firmable'); } },
    });
    deps.notify('🙋 #5209', { issue: 5209, action: 'escalate' });
    assert.equal(sent.length, 1);
});

test('el requeue notifica sin botones (los quick-actions son del bloqueo)', () => {
    const { sent, deps } = notifyHarness(tmpPipeline());
    deps.notify('🔧 re-encolé qa de #5209', { issue: 5209, action: 'requeue' });
    assert.equal(sent[0].markup, null);
});

test('CA-UX-5: notify no dispara audio TTS — sólo encola texto', () => {
    const dir = tmpPipeline();
    const sent = [];
    const deps = buildDeps(dir, {
        deps: {
            sendTelegramWithMarkup: (t, m, o) => sent.push({ t, m, o }),
            humanBlock: { buildBlockedActionMarkup: () => undefined },
        },
    });
    deps.notify('🙋 #5209', { issue: 5209, action: 'escalate' });
    assert.equal(sent.length, 1, 'un único saliente de texto; el audio queda para el circuit breaker');
});

test('sin sender cableado, notify es no-op (nunca tumba el tick)', () => {
    const deps = buildDeps(tmpPipeline());
    assert.doesNotThrow(() => deps.notify('hola', { issue: 5209, action: 'escalate' }));
});

// -----------------------------------------------------------------------------
// CA-4 end-to-end — dos ticks consecutivos sobre el MISMO estado
// -----------------------------------------------------------------------------

/**
 * Tick completo por el cableado real, sobre un sandbox. El `humanBlock` de
 * mentira planta el marker en el tmpdir (es lo único que el módulo real hace y
 * que el dedupe del tick siguiente necesita ver).
 */
function tickHarness(dir, ppMode) {
    const sent = [];
    const deps = buildStuckReconcilerDeps({
        config: CONFIG, PIPELINE: dir, ROOT: dir,
        pauseFile: path.join(dir, '.paused'),
        ppMode, nowMs: NOW,
        parallelPhases: [{ pipeline: 'desarrollo', fase: 'verificacion' }],
        deps: {
            log: () => { },
            sendTelegramWithMarkup: (text, markup, opts) => sent.push({ text, markup, opts }),
            readYamlSafe: (p) => {
                try {
                    const out = {};
                    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
                        const m = line.match(/^(\w+):\s*(.+)$/);
                        if (m) out[m[1]] = m[2].trim();
                    }
                    return out;
                } catch { return {}; }
            },
            humanBlock: {
                buildBlockedActionMarkup: (i) => ({ inline_keyboard: [[{ text: 'ok', url: `u/${i}` }]] }),
                reportHumanBlock: ({ issue, skill, phase, pipeline, moveFromActive }) => {
                    assert.equal(moveFromActive, false, 'jamás mover el deliverable de listo/');
                    assert.ok(pipeline, 'pipeline explícito obligatorio');
                    fs.writeFileSync(path.join(dir, pipeline, phase, 'bloqueado-humano', `${issue}.${skill}`), '');
                },
            },
        },
    });
    const res = runStuckPhaseReconciler(deps, { maxRequeueAttempts: 2, capPerTick: 5, staleThresholdMs: 15 * 60 * 1000 });
    return { res, sent };
}

test('CA-4 e2e: issue de la ola escala UNA vez; el segundo tick sobre el mismo estado calla', () => {
    const dir = tmpPipeline();
    // Issue varado: `qa` entregó rechazo, `tester` nunca entregó, nada vivo.
    fs.writeFileSync(
        path.join(dir, 'desarrollo', 'verificacion', 'listo', '5209.qa'),
        'issue: 5209\nfase: verificacion\npipeline: desarrollo\nresultado: rechazado\n',
    );
    fs.utimesSync(
        path.join(dir, 'desarrollo', 'verificacion', 'listo', '5209.qa'),
        new Date(NOW - HOUR), new Date(NOW - HOUR),
    );
    writeTitleCache(dir, {
        5209: { title: 'algo varado', state: 'OPEN', labels: ['Ready'], fetchedAt: NOW - 60000 },
    });
    const ppMode = { mode: 'partial_pause', allowedIssues: [5209] };

    const t1 = tickHarness(dir, ppMode);
    assert.equal(t1.res.escalated, 1, 'primer tick: escala');
    assert.equal(t1.sent.length, 1, 'exactamente UNA notificación');
    assert.equal(t1.sent[0].opts.plain, true, 'texto plano (CA-8)');
    assert.ok(t1.sent[0].markup, 'con botones (CA-UX-1)');
    assert.match(t1.sent[0].text, /algo varado/, 'con el título de la caché (CA-UX-2)');

    // El marker quedó plantado → el dedupe del tick siguiente lo ve.
    const t2 = tickHarness(dir, ppMode);
    assert.equal(t2.res.escalated, 0, 'segundo tick: NO re-escala');
    assert.equal(t2.sent.length, 0, 'y NO re-notifica — fin del loop de #5396');
    assert.equal(t2.res.suppressed.dedupe, 1);

    // CA-6: la evidencia sigue ahí después de los dos ticks.
    assert.deepEqual(fs.readdirSync(path.join(dir, 'desarrollo', 'verificacion', 'listo')), ['5209.qa']);
});

test('rebote review: reportHumanBlock fallido no contabiliza ni notifica una escalación inexistente', () => {
    const dir = tmpPipeline();
    fs.writeFileSync(
        path.join(dir, 'desarrollo', 'verificacion', 'listo', '5209.qa'),
        'issue: 5209\nfase: verificacion\npipeline: desarrollo\nresultado: rechazado\n',
    );
    fs.utimesSync(
        path.join(dir, 'desarrollo', 'verificacion', 'listo', '5209.qa'),
        new Date(NOW - HOUR), new Date(NOW - HOUR),
    );
    writeTitleCache(dir, {
        5209: { title: 'bloqueo imposible', state: 'OPEN', labels: ['Ready'], fetchedAt: NOW - 60000 },
    });
    const sent = [];
    const deps = buildStuckReconcilerDeps({
        config: CONFIG, PIPELINE: dir, ROOT: dir,
        pauseFile: path.join(dir, '.paused'),
        ppMode: { mode: 'partial_pause', allowedIssues: [5209] }, nowMs: NOW,
        parallelPhases: [{ pipeline: 'desarrollo', fase: 'verificacion' }],
        deps: {
            log: () => { },
            sendTelegramWithMarkup: (...args) => sent.push(args),
            humanBlock: {
                buildBlockedActionMarkup: () => null,
                reportHumanBlock: () => { throw new Error('filesystem sin escritura'); },
            },
        },
    });

    const res = runStuckPhaseReconciler(deps, {
        maxRequeueAttempts: 2, capPerTick: 5, staleThresholdMs: 15 * 60 * 1000,
    });
    assert.equal(res.escalated, 0, 'no informa una escalación que no ocurrió');
    assert.equal(res.skipped, 1);
    assert.equal(sent.length, 0, 'sin marker/label no notifica al operador');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'desarrollo', 'verificacion', 'bloqueado-humano')), []);
});

test('CA-3 e2e: el mismo issue fuera de la ola no escala ni notifica nunca', () => {
    const dir = tmpPipeline();
    fs.writeFileSync(
        path.join(dir, 'desarrollo', 'verificacion', 'listo', '742.qa'),
        'issue: 742\nfase: verificacion\npipeline: desarrollo\nresultado: rechazado\n',
    );
    fs.utimesSync(
        path.join(dir, 'desarrollo', 'verificacion', 'listo', '742.qa'),
        new Date(NOW - HOUR), new Date(NOW - HOUR),
    );
    writeTitleCache(dir, {
        742: { title: 'residuo de julio', state: 'OPEN', labels: ['Ready'], fetchedAt: NOW - 60000 },
    });

    // Pipeline SIN pausa parcial: antes de #5396 acá se barría todo el backlog.
    const { res, sent } = tickHarness(dir, { mode: 'running', allowedIssues: [] });
    assert.equal(res.escalated, 0);
    assert.equal(sent.length, 0, 'el operador no se entera de residuo fuera de ola');
    assert.equal(res.evaluados, 1, 'pero SÍ se evaluó (queda auditado, CA-7)');
    assert.equal(res.suppressed.ola, 1);
});

// -----------------------------------------------------------------------------
// CA-7 / CA-UX-3 / riesgo #2 — señal de vida del silencio
// -----------------------------------------------------------------------------

test('CA-7: 6 ticks mudos consecutivos con evaluados > 0 emiten la señal de vida', () => {
    let prev = null;
    const agg = { evaluados: 4, escalados: 0, requeued: 0, suprimidos_por_ola: 1, suprimidos_por_cache: 3 };
    const emitidos = [];
    for (let i = 1; i <= 8; i++) {
        const r = evaluateSilenceHealth(prev, agg);
        if (r.emitSignal) emitidos.push(i);
        prev = r.next;
    }
    assert.deepEqual(emitidos, [6], 'una sola señal, en el 6º tick de la racha');
});

test('CA-UX-3: silencio explicado 100% por el filtro de ola → NO se emite señal', () => {
    let prev = null;
    const agg = { evaluados: 3, escalados: 0, requeued: 0, suprimidos_por_ola: 3, suprimidos_por_cache: 0 };
    for (let i = 0; i < 20; i++) {
        const r = evaluateSilenceHealth(prev, agg);
        assert.equal(r.emitSignal, false, 'acotar a la ola es lo correcto, no una anomalía');
        prev = r.next;
    }
});

test('CA-7: cualquier acción resetea la racha', () => {
    let prev = null;
    const mudo = { evaluados: 2, escalados: 0, requeued: 0, suprimidos_por_cache: 2 };
    for (let i = 0; i < 5; i++) prev = evaluateSilenceHealth(prev, mudo).next;
    assert.equal(prev.streak, 5);

    prev = evaluateSilenceHealth(prev, { evaluados: 2, escalados: 1, requeued: 0 }).next;
    assert.equal(prev.streak, 0, 'escalar reinicia el contador');
    assert.equal(prev.signaled, false);
});

test('CA-7: un tick sin issues varados no cuenta como silencio sospechoso', () => {
    const r = evaluateSilenceHealth({ streak: 5, signaled: false }, { evaluados: 0, escalados: 0, requeued: 0 });
    assert.equal(r.emitSignal, false);
    assert.equal(r.next.streak, 0, 'no había nada que hacer: no es una anomalía');
});

test('CA-UX-3: la señal se emite como máximo una vez por racha', () => {
    let prev = null;
    const agg = { evaluados: 5, escalados: 0, requeued: 0, suprimidos_por_ola: 1, suprimidos_por_dedupe: 4 };
    let count = 0;
    for (let i = 0; i < 30; i++) {
        const r = evaluateSilenceHealth(prev, agg);
        if (r.emitSignal) count++;
        prev = r.next;
    }
    assert.equal(count, 1);
});

test('CA-7: la señal vuelve a estar disponible tras una racha nueva', () => {
    let prev = null;
    const mudo = { evaluados: 3, escalados: 0, requeued: 0, suprimidos_por_dedupe: 3 };
    for (let i = 0; i < 6; i++) prev = evaluateSilenceHealth(prev, mudo).next;
    assert.equal(prev.signaled, true);

    prev = evaluateSilenceHealth(prev, { evaluados: 1, escalados: 1, requeued: 0 }).next;
    let reEmit = false;
    for (let i = 0; i < 6; i++) {
        const r = evaluateSilenceHealth(prev, mudo);
        if (r.emitSignal) reEmit = true;
        prev = r.next;
    }
    assert.equal(reEmit, true, 'una racha nueva puede volver a avisar');
});

// -----------------------------------------------------------------------------
// #5396 rev-1 — CICLO DE DESTRABE: el marker debe ser DESPACHABLE
//
// Rechazo de `aprobacion` (rev-1): el marker se plantaba con el skill sintético
// `reconciler`, que no existe en `skills_por_fase[fase]`. Al destrabar
// (`unblockIssue`, o los botones 'Aprobar (unblock)' / 'Priorizar' que agrega
// este mismo PR), el work-item caía en `pendiente/` y entraba al despacho, donde
// el INVARIANTE skill∈fase de `pulpo.js:8596` lo rebotaba a `pendiente/` SIN
// registrar cooldown y mandaba un Telegram por tick.
//
// Estos tests recorren el ciclo COMPLETO contra el `human-block` real y aplican
// el mismo predicado del invariante del Pulpo sobre el resultado.
// -----------------------------------------------------------------------------

/**
 * Predicado del INVARIANTE de `pulpo.js:8596-8605`, replicado textualmente:
 *   const permitidos = config.pipelines[pipeline].skills_por_fase[fase] || [];
 *   if (!permitidos.includes(skill)) → rebote a pendiente/ + Telegram por tick
 */
function pulpoDispatchInvariant(config, pipeline, fase, skill) {
    const spf = ((config.pipelines || {})[pipeline] || {}).skills_por_fase || {};
    const permitidos = spf[fase] || [];
    return permitidos.includes(skill);
}

/** Crea un REPO root aislado y carga un `human-block` fresco apuntado ahí. */
function withRealHumanBlock(fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-unblock-5396-'));
    const pipelineDir = path.join(root, '.pipeline');
    for (const fase of CONFIG.pipelines.desarrollo.fases) {
        for (const st of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
            fs.mkdirSync(path.join(pipelineDir, 'desarrollo', fase, st), { recursive: true });
        }
    }
    fs.mkdirSync(path.join(pipelineDir, 'servicios', 'github', 'pendiente'), { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });

    const prev = {
        claude: process.env.CLAUDE_PROJECT_DIR,
        repo: process.env.PIPELINE_REPO_ROOT,
    };
    process.env.CLAUDE_PROJECT_DIR = root;
    process.env.PIPELINE_REPO_ROOT = root;
    // `human-block` congela PIPELINE_DIR al requerirse → hay que cargarlo fresco.
    const mods = ['../lib/human-block', '../lib/traceability'];
    for (const m of mods) delete require.cache[require.resolve(m)];
    const humanBlock = require('../lib/human-block');
    try {
        return fn({ root, pipelineDir, humanBlock });
    } finally {
        if (prev.claude === undefined) delete process.env.CLAUDE_PROJECT_DIR;
        else process.env.CLAUDE_PROJECT_DIR = prev.claude;
        if (prev.repo === undefined) delete process.env.PIPELINE_REPO_ROOT;
        else process.env.PIPELINE_REPO_ROOT = prev.repo;
        for (const m of mods) delete require.cache[require.resolve(m)];
    }
}

test('rev-1: escalate -> unblockIssue -> el work-item pasa el invariante skill-en-fase', () => {
    withRealHumanBlock(({ pipelineDir, humanBlock }) => {
        const deps = buildStuckReconcilerDeps({
            config: CONFIG,
            PIPELINE: pipelineDir,
            ROOT: pipelineDir,
            pauseFile: path.join(pipelineDir, '.paused'),
            ppMode: { mode: 'running' },
            nowMs: NOW,
            deps: { log: () => { }, humanBlock },
        });

        // 1) El reconciler escala: `tester` quedó `rechazado` (ambiguo).
        const ok = deps.escalate(5209, 'ambiguedad (rechazo/cancelado/corrupto): tester:rejected', {
            pipeline: 'desarrollo', fase: 'verificacion', skills: ['tester'],
        });
        assert.equal(ok, true, 'la escalacion debe registrarse');

        const bloqDir = path.join(pipelineDir, 'desarrollo', 'verificacion', 'bloqueado-humano');
        const bloqueados = fs.readdirSync(bloqDir);
        assert.ok(bloqueados.includes('5209.tester'), `marker esperado 5209.tester, hay: ${bloqueados}`);
        assert.ok(!bloqueados.includes('5209.reconciler'), 'el skill sintetico ya no se planta');

        // 2) El operador destraba — es lo que hacen los quick-actions de Telegram
        //    via executeQuickAction -> reactivateAllBlocked -> unblockIssue.
        const r = humanBlock.unblockIssue({ issue: 5209, guidance: 're-corre tester', unlocker: 'test' });
        assert.equal(r.ok, true);
        assert.equal(r.to_phase, 'verificacion');

        // 3) El work-item resultante ENTRA al despacho: el invariante lo acepta.
        const skill = require('../lib/workfile-name').skillFromFile(path.basename(r.marker_path));
        assert.equal(skill, 'tester');
        assert.equal(
            pulpoDispatchInvariant(CONFIG, 'desarrollo', 'verificacion', skill),
            true,
            'el invariante de pulpo.js debe aceptar el skill del marker destrabado',
        );

        const pendientes = fs.readdirSync(path.join(pipelineDir, 'desarrollo', 'verificacion', 'pendiente'));
        assert.ok(pendientes.includes('5209.tester'));
    });
});

test('rev-1: con el work-item ya destrabado en pendiente/, el tick NO re-escala', () => {
    // Verifica la afirmacion de la doc (CA-9): el marker destrabado cuenta como
    // `liveSkills` -> el detector dice `trabajo-vivo` -> decision `none`. Sin
    // esto habria una ventana de doble escalado entre el unblock y el spawn.
    const dir = tmpPipeline();
    writeTitleCache(dir, {
        5209: { state: 'OPEN', title: 'destrabado', labels: [], fetchedAt: new Date(NOW).toISOString() },
    });
    const fase = path.join(dir, 'desarrollo', 'verificacion');
    fs.writeFileSync(path.join(fase, 'listo', '5209.tester'), 'resultado: rechazado\n');
    const old = (NOW - HOUR) / 1000;
    fs.utimesSync(path.join(fase, 'listo', '5209.tester'), old, old);
    // Estado post-unblock: el work-item ya volvio a pendiente/.
    fs.writeFileSync(path.join(fase, 'pendiente', '5209.tester'), '');
    fs.writeFileSync(path.join(fase, 'pendiente', '5209.tester.guidance.txt'), 're-corre');

    const escalations = [];
    const sent = [];
    const deps = buildDeps(dir, {
        ppMode: { mode: 'running' },
        deps: {
            sendTelegramWithMarkup: (t) => sent.push(t),
            humanBlock: { reportHumanBlock: (o) => { escalations.push(o); return {}; } },
        },
    });
    deps.isAllowed = () => true;
    deps.readYaml = () => ({ resultado: 'rechazado' });

    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.escalated, 0, 'no re-escala sobre un work-item ya destrabado');
    assert.equal(escalations.length, 0);
    assert.equal(sent.length, 0, 'y por lo tanto no notifica');
});

test('rev-1 regresion: el skill sintetico "reconciler" habria rebotado contra el invariante', () => {
    // Test de contraste — documenta EXACTAMENTE el defecto que motivo el rechazo.
    assert.equal(
        pulpoDispatchInvariant(CONFIG, 'desarrollo', 'verificacion', 'reconciler'),
        false,
        'precondicion del bug: `reconciler` nunca fue un skill despachable',
    );
    assert.equal(pulpoDispatchInvariant(CONFIG, 'desarrollo', 'verificacion', 'tester'), true);
});

test('rev-1: el skill del marker se valida contra skills_por_fase, no se cree el que le pasan', () => {
    const dir = tmpPipeline();
    const calls = [];
    const deps = buildDeps(dir, {
        deps: { humanBlock: { reportHumanBlock: (o) => { calls.push(o); return {}; } } },
    });

    // Un skill que NO pertenece a la fase (de otra fase, sintetico, o un nombre
    // raro salido de un archivo) se descarta y cae al fallback determinista.
    deps.escalate(5209, 'motivo', {
        pipeline: 'desarrollo', fase: 'verificacion', skills: ['review', 'reconciler', '../../etc'],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].skill, 'qa', 'fallback: primer skill de skills_por_fase[verificacion]');
    assert.ok(pulpoDispatchInvariant(CONFIG, 'desarrollo', 'verificacion', calls[0].skill));
});

test('rev-1: "estado indeterminado" (sin skills imputados) igual planta un marker despachable', () => {
    const dir = tmpPipeline();
    const calls = [];
    const deps = buildDeps(dir, {
        deps: { humanBlock: { reportHumanBlock: (o) => { calls.push(o); return {}; } } },
    });
    deps.escalate(5209, 'estado indeterminado', { pipeline: 'desarrollo', fase: 'verificacion', skills: [] });
    assert.equal(calls.length, 1);
    assert.ok(pulpoDispatchInvariant(CONFIG, 'desarrollo', 'verificacion', calls[0].skill));
});

test('rev-1 fail-closed: fase sin skills_por_fase NO escala (marker sin salida seria spam)', () => {
    const dir = tmpPipeline();
    const calls = [];
    const logs = [];
    const deps = buildDeps(dir, {
        deps: {
            log: (_t, m) => logs.push(m),
            humanBlock: { reportHumanBlock: (o) => calls.push(o) },
        },
    });
    // `aprobacion` existe en `fases` pero CONFIG no le define skills_por_fase.
    const ok = deps.escalate(5209, 'motivo', { pipeline: 'desarrollo', fase: 'aprobacion', skills: ['review'] });
    assert.equal(ok, false);
    assert.equal(calls.length, 0, 'mejor no escalar que dejar un bloqueo sin salida');
    assert.ok(logs.some((m) => /sin skills_por_fase/.test(m)), 'el silencio queda logueado');
});

test('rev-1 e2e: el escalado del tick real deja un marker despachable', () => {
    // Cierra el ciclo por el RUNNER (no llamando a `escalate` a mano): un
    // deliverable `rechazado` de `tester` viejo -> escalate -> marker `5209.tester`.
    const dir = tmpPipeline();
    writeTitleCache(dir, {
        5209: { state: 'OPEN', title: 'issue de la ola', labels: [], fetchedAt: new Date(NOW).toISOString() },
    });
    const listo = path.join(dir, 'desarrollo', 'verificacion', 'listo');
    fs.writeFileSync(path.join(listo, '5209.tester'), 'resultado: rechazado\n');
    const old = (NOW - HOUR) / 1000;
    fs.utimesSync(path.join(listo, '5209.tester'), old, old);

    const escalations = [];
    const deps = buildDeps(dir, {
        ppMode: { mode: 'running' },
        deps: { humanBlock: { reportHumanBlock: (o) => { escalations.push(o); return {}; } } },
    });
    deps.isAllowed = () => true;                        // issue de la ola
    deps.readYaml = () => ({ resultado: 'rechazado' }); // verdict del deliverable
    deps.nowMs = NOW;

    const res = runStuckPhaseReconciler(deps, {});
    assert.equal(res.escalated, 1, `esperaba 1 escalacion, hubo ${JSON.stringify(res)}`);
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].skill, 'tester', 'el skill ambiguo real, no `reconciler`');
    assert.ok(pulpoDispatchInvariant(CONFIG, 'desarrollo', 'verificacion', escalations[0].skill));
    assert.equal(escalations[0].moveFromActive, false, 'CA-6: la evidencia de listo/ no se toca');
    assert.ok(fs.existsSync(path.join(listo, '5209.tester')), 'el deliverable sigue en listo/');
});
