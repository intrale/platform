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
        pipeline: 'desarrollo', fase: 'verificacion',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].issue, 5209);
    assert.equal(calls[0].skill, 'reconciler');
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
