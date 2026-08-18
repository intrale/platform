// =============================================================================
// partial-pause-resolution.test.js — Endpoints nuevos de "pausa parcial
// trabada" y su gate de request (issue #5923).
//
// Estos 2 endpoints (`keep-original`, `cancel-partial-pause`) NACEN con gate:
// se copia el molde de `/api/allowlist-candidates` (loopback + Origin/Referer +
// Content-Type estricto), NO el de `include-deps`, que no tiene ningún control
// de request (CSRF preexistente → issue #5929, fuera de alcance).
//
// Se testea la lógica pura: `dashboard.js` no exporta nada y requerirlo levanta
// el server real en el 3200, así que meterlo en un test tumbaría el dashboard
// de producción.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../dashboard-request-gate');
const { applyResolution, RESOLUTIONS } = require('../partial-pause-resolution');

const JSON_CT = { 'content-type': 'application/json' };

// ─── Gate de request ─────────────────────────────────────────────────────────

test('#5923 gate: request no-loopback ⇒ 403', () => {
    for (const remote of ['10.0.0.5', '192.168.1.20', '203.0.113.7', '::ffff:10.0.0.1', '']) {
        const r = gate.evaluateLocalMutationGate({ remoteAddress: remote, method: 'POST', headers: JSON_CT });
        assert.equal(r.ok, false, `${remote} debe rechazarse`);
        assert.equal(r.status, 403);
    }
});

test('#5923 gate: loopback en sus 4 formas pasa', () => {
    for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
        assert.equal(gate.isLoopbackAddress(remote), true, `${remote} es loopback`);
        assert.equal(gate.evaluateLocalMutationGate({ remoteAddress: remote, headers: JSON_CT }).ok, true);
    }
});

test('#5923 gate: Origin ajeno ⇒ 403 (anti-CSRF desde el browser del operador)', () => {
    for (const origin of ['http://evil.com', 'https://localhost:3200', 'http://localhost:8080', 'null']) {
        const r = gate.evaluateLocalMutationGate({
            remoteAddress: '127.0.0.1', method: 'POST', headers: { ...JSON_CT, origin },
        });
        assert.equal(r.ok, false, `Origin ${origin} debe rechazarse`);
        assert.equal(r.status, 403);
        assert.match(r.msg, /cross-origin/);
    }
});

test('#5923 gate: Referer ajeno ⇒ 403, y un prefijo tramposo no cuela', () => {
    const r = gate.evaluateLocalMutationGate({
        remoteAddress: '127.0.0.1', headers: { ...JSON_CT, referer: 'http://localhost:3200.evil.com/x' },
    });
    assert.equal(r.status, 403, 'localhost:3200.evil.com no es localhost:3200');
    assert.equal(gate.evaluateLocalMutationGate({
        remoteAddress: '127.0.0.1', headers: { ...JSON_CT, referer: 'http://localhost:3200/' },
    }).ok, true);
});

test('#5923 gate: sin Content-Type application/json ⇒ 415', () => {
    for (const ct of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
        const headers = ct === undefined ? {} : { 'content-type': ct };
        const r = gate.evaluateLocalMutationGate({ remoteAddress: '127.0.0.1', method: 'POST', headers });
        assert.equal(r.ok, false, `Content-Type "${ct}" debe rechazarse`);
        assert.equal(r.status, 415);
    }
    // El charset no invalida el tipo.
    assert.equal(gate.evaluateLocalMutationGate({
        remoteAddress: '127.0.0.1', headers: { 'content-type': 'application/json; charset=utf-8' },
    }).ok, true);
});

test('#5923 gate: sin Origin ni Referer pasa (curl / callback-handler no son vector CSRF)', () => {
    assert.equal(gate.evaluateLocalMutationGate({ remoteAddress: '127.0.0.1', headers: JSON_CT }).ok, true);
});

test('#5923 sanitizeAuthorizedBy conserva al operador real y descarta basura', () => {
    assert.equal(gate.sanitizeAuthorizedBy('telegram:111222333'), 'telegram:111222333');
    assert.equal(gate.sanitizeAuthorizedBy('commander:leo'), 'commander:leo');
    for (const basura of ['', null, undefined, 'con espacios', 'x\ninyectado', '../../etc', '<script>', {}]) {
        assert.equal(gate.sanitizeAuthorizedBy(basura), 'dashboard-local', `${JSON.stringify(basura)} → fallback`);
    }
    assert.equal(gate.sanitizeAuthorizedBy('a'.repeat(500)).length, 120, 'se acota');
});

// ─── Resolución ──────────────────────────────────────────────────────────────

// Origen registrado en el enum cerrado de #3625. Usar `telegram:<from.id>` acá
// (como se hacía antes) dejaba el valor FUERA del enum, y los tests no lo veían
// porque los fakes no consultaban el validador real.
const BY = 'telegram:operator';

function makeDeps(mode = 'partial_pause', overrides = {}) {
    const calls = { mark: [], clear: [], depsState: 0 };
    return {
        calls,
        deps: {
            getPipelineMode: () => ({ mode, allowedIssues: [5923, 5924], allowedSkills: [], depSources: { 5924: 'auto-deps' } }),
            markDepRiskAccepted: (opts) => { calls.mark.push(opts); return { ok: true, allowedIssues: [5923, 5924], allowedSkills: [] }; },
            clearPartialPause: (opts) => { calls.clear.push(opts); return { ok: true, existed: true }; },
            clearDepsState: () => { calls.depsState++; },
            ...overrides,
        },
    };
}

// #6118 — Las dos acciones nuevas operan sobre UN issue, así que sin ese
// parámetro el request es inválido y muere en 400 antes de leer nada. Para
// ejercitar el anti-replay (que es lo que estos tests miden) hay que mandarles
// un issue válido; si no, se estaría midiendo la validación de entrada.
const NEEDS_ISSUE = new Set(['include-deps-for-issue', 'mute-alert']);
const issueFor = (action) => (NEEDS_ISSUE.has(action) ? 6033 : undefined);

test('#5923 con mode !== partial_pause ⇒ 409 y CERO mutación (anti-replay)', () => {
    // `null` explícito NO dispara el default del helper: cubre el modo ilegible.
    for (const mode of ['running', 'paused', 'rest', null]) {
        const h = makeDeps(mode);
        for (const action of RESOLUTIONS) {
            const out = applyResolution({ action, authorizedBy: BY, issue: issueFor(action), deps: h.deps });
            assert.equal(out.status, 409, `${action} en modo ${mode} debe dar 409`);
            assert.match(out.body.msg, /no en partial_pause/);
        }
        assert.equal(h.calls.mark.length, 0, 'no se toca el allowlist');
        assert.equal(h.calls.clear.length, 0, 'no se levanta la pausa');
    }
});

test('#5923 si el estado del pipeline no se puede leer ⇒ 409, nunca mutación a ciegas', () => {
    const deps = { getPipelineMode: () => undefined, markDepRiskAccepted: () => { throw new Error('no debe llamarse'); },
                   clearPartialPause: () => { throw new Error('no debe llamarse'); },
                   setPartialPause: () => { throw new Error('no debe llamarse'); },
                   mute: () => { throw new Error('no debe llamarse'); } };
    for (const action of RESOLUTIONS) {
        assert.equal(applyResolution({ action, authorizedBy: BY, issue: issueFor(action), deps }).status, 409);
    }
});

test('#6118 las acciones por issue rechazan con 400 un issue que no es `^\\d{1,7}$`', () => {
    // El entero viene del cliente. Se valida ANTES de leer estado y antes de
    // cualquier mutación: un `../` o un `1e9` no llega a tocar nada.
    for (const action of NEEDS_ISSUE) {
        for (const malo of [undefined, '', 'abc', '12a', '../6033', '6033;rm', '12345678', '-5', '1.5', null]) {
            const h = makeDeps();
            const out = applyResolution({ action, authorizedBy: BY, issue: malo, deps: h.deps });
            assert.equal(out.status, 400, `${action} con issue=${JSON.stringify(malo)} debe dar 400`);
            assert.equal(h.calls.mark.length + h.calls.clear.length, 0, 'cero mutación');
        }
    }
});

test('#5923 keep-original deja el allowlist igual y marca el riesgo como asumido', () => {
    const h = makeDeps();
    const out = applyResolution({ action: 'keep-original', authorizedBy: BY, operatorRef: '111222333', deps: h.deps });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.deepEqual(out.body.allowedIssues, [5923, 5924], 'no suma ni saca nada');
    assert.equal(h.calls.mark.length, 1, 'usa el merge no destructivo, no una reescritura del marker');
    assert.equal(h.calls.mark[0].authorizedBy, BY, 'origen del enum cerrado (#3625)');
    assert.match(h.calls.mark[0].justification, /111222333/, 'el from.id real queda trazado en el audit');
    assert.equal(h.calls.depsState, 1, 'limpia el state para que la alerta no reincida');
    assert.ok(out.body.msg.length > 0, 'mensaje concreto para el toast del operador');
});

test('#5923 cancel-partial-pause levanta la pausa pasando el operador real al gate', () => {
    const h = makeDeps();
    const out = applyResolution({ action: 'cancel-partial-pause', authorizedBy: BY, operatorRef: '111222333', deps: h.deps });
    assert.equal(out.status, 200);
    assert.equal(out.body.existed, true);
    assert.equal(h.calls.clear.length, 1);
    assert.equal(h.calls.clear[0].authorizedBy, BY, 'origen del enum cerrado (#3625)');
    assert.match(h.calls.clear[0].justification, /111222333/, 'el from.id real queda trazado en el audit');
    assert.ok(h.calls.clear[0].justification.length > 0, 'el audit trail necesita justificación');
    assert.equal(h.calls.depsState, 1);
});

test('#5923 si el gate de autorización de partial-pause rechaza ⇒ 403, no 200 mentiroso', () => {
    const h = makeDeps('partial_pause', { clearPartialPause: () => ({ ok: false, rejected: true }) });
    const out = applyResolution({ action: 'cancel-partial-pause', authorizedBy: BY, deps: h.deps });
    assert.equal(out.status, 403);
    assert.equal(out.body.ok, false);
    assert.equal(h.calls.depsState, 0, 'no limpia el state si no se aplicó nada');
});

test('#5923 una acción fuera del contrato ⇒ 404 sin consultar siquiera el modo', () => {
    let consultas = 0;
    const deps = { getPipelineMode: () => { consultas++; return { mode: 'partial_pause' }; } };
    for (const action of ['include-deps', '../kill-agent', '', null, 'KEEP-ORIGINAL']) {
        const out = applyResolution({ action, authorizedBy: BY, deps });
        assert.equal(out.status, 404, `${action} no es resolución de este endpoint`);
    }
    assert.equal(consultas, 0);
});

// ─── Integración contra el módulo REAL (regresión de B1/B2/B3) ───────────────
//
// Los fakes de arriba no pueden detectar pérdida de estado: devuelven el echo de
// su input. Estos tests corren `applyResolution` contra el `partial-pause` real
// con `PIPELINE_DIR_OVERRIDE` y assertean el CONTENIDO del marker después de la
// resolución, que es donde vivían los 3 bloqueantes.

const fs = require('fs');
const os = require('os');
const nodePath = require('path');

function withRealPipelineDir(fn) {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'pp5923-'));
    const prevDir = process.env.PIPELINE_DIR_OVERRIDE;
    const prevStrict = process.env.PARTIAL_PAUSE_STRICT_AUTH;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    // Módulos con estado de path resuelto por env: se recargan limpios.
    delete require.cache[require.resolve('../partial-pause')];
    delete require.cache[require.resolve('../partial-pause-audit')];
    try {
        const pp = require('../partial-pause');
        const marker = nodePath.join(dir, '.partial-pause.json');
        return fn({ pp, dir, marker, writeMarker: (o) => fs.writeFileSync(marker, JSON.stringify(o, null, 2)),
                    readMarker: () => (fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null) });
    } finally {
        if (prevDir === undefined) delete process.env.PIPELINE_DIR_OVERRIDE; else process.env.PIPELINE_DIR_OVERRIDE = prevDir;
        if (prevStrict === undefined) delete process.env.PARTIAL_PAUSE_STRICT_AUTH; else process.env.PARTIAL_PAUSE_STRICT_AUTH = prevStrict;
        delete require.cache[require.resolve('../partial-pause')];
        delete require.cache[require.resolve('../partial-pause-audit')];
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

function realDeps(pp, calls) {
    return {
        getPipelineMode: pp.getPipelineMode,
        markDepRiskAccepted: pp.markDepRiskAccepted,
        clearPartialPause: pp.clearPartialPause,
        clearDepsState: () => { calls.depsState++; },
    };
}

test('#5923 B1 keep-original NO borra allowed_skills ni la metadata de ola', () => {
    withRealPipelineDir(({ pp, writeMarker, readMarker }) => {
        writeMarker({
            allowed_issues: [5923, 5924],
            allowed_skills: ['qa', 'tester'],
            wave_number: 9,
            wave_name: 'Ola Puente',
            wave_goal: 'kernel multiproducto',
            dep_sources: { 5924: 'auto-deps' },
            authorization_ttls: { 5924: '2026-09-01T00:00:00.000Z' },
            created_at: '2026-08-01T00:00:00.000Z',
            source: 'wave-promote',
        });
        const calls = { depsState: 0 };
        const out = applyResolution({ action: 'keep-original', authorizedBy: BY, operatorRef: '111', deps: realDeps(pp, calls) });

        assert.equal(out.status, 200);
        const after = readMarker();
        assert.ok(after, 'el marker sigue existiendo');
        assert.deepEqual(after.allowed_issues, [5923, 5924], 'allowlist intacto');
        assert.deepEqual(after.allowed_skills, ['qa', 'tester'], '#3680: allowed_skills NO se pierde');
        assert.equal(after.wave_number, 9, '#4030: wave_number NO se pierde');
        assert.equal(after.wave_name, 'Ola Puente', '#4030: wave_name NO se pierde');
        assert.equal(after.wave_goal, 'kernel multiproducto', '#4030: wave_goal NO se pierde');
        assert.deepEqual(after.dep_sources, { 5924: 'auto-deps' }, 'dep_sources preservado');
        assert.deepEqual(after.authorization_ttls, { 5924: '2026-09-01T00:00:00.000Z' }, '#3625: TTLs preservados');
        assert.equal(after.created_at, '2026-08-01T00:00:00.000Z', 'created_at no se reescribe');
        assert.equal(after.source, 'wave-promote', 'el origen del allowlist no cambia por aceptar el riesgo');
        assert.equal(after.accepted_dep_risk, true, 'lo único que cambia es el flag');
    });
});

test('#5923 B2 keep-original con pausa parcial SÓLO por skills NO levanta la pausa', () => {
    withRealPipelineDir(({ pp, writeMarker, readMarker }) => {
        // Modo soportado desde #3680: allowed_issues vacío + allowed_skills.
        writeMarker({ allowed_issues: [], allowed_skills: ['qa'], created_at: '2026-08-01T00:00:00.000Z', source: 'wave-promote' });
        assert.equal(pp.getPipelineMode().mode, 'partial_pause', 'precondición: la pausa está activa por skills');

        const calls = { depsState: 0 };
        const out = applyResolution({ action: 'keep-original', authorizedBy: BY, operatorRef: '111', deps: realDeps(pp, calls) });

        assert.equal(out.status, 200);
        const after = readMarker();
        assert.ok(after, 'el marker NO fue borrado: keep-original no puede levantar la pausa');
        assert.deepEqual(after.allowed_skills, ['qa'], 'los skills siguen habilitados');
        assert.equal(pp.getPipelineMode().mode, 'partial_pause', 'el pipeline sigue en pausa parcial');
        // El toast tiene que describir lo que realmente quedó, no "0 issues" a secas.
        assert.match(out.body.msg, /skill/, 'el mensaje refleja el scope real (skills), no miente');
    });
});

test('#5923 B3 el origen viaja en el enum: mismo resultado con el gate estricto ON', () => {
    for (const strict of ['0', '1']) {
        withRealPipelineDir(({ pp, writeMarker, readMarker }) => {
            process.env.PARTIAL_PAUSE_STRICT_AUTH = strict;
            writeMarker({ allowed_issues: [5923], created_at: '2026-08-01T00:00:00.000Z', source: 'wave-promote' });
            const calls = { depsState: 0 };
            const out = applyResolution({ action: 'cancel-partial-pause', authorizedBy: BY, operatorRef: '111', deps: realDeps(pp, calls) });
            assert.equal(out.status, 200, `con STRICT=${strict} el botón tiene que funcionar igual`);
            assert.equal(readMarker(), null, 'la pausa parcial se levantó de verdad');
        });
    }
});

test('#5923 B3 un authorizedBy fuera del enum ⇒ 403 y CERO mutación', () => {
    // Antes esto pasaba por grace period, ensuciando el audit y muriendo con strict.
    for (const by of ['telegram:12345', 'dashboard-local', '', null, 'inventado:x']) {
        withRealPipelineDir(({ pp, writeMarker, readMarker }) => {
            writeMarker({ allowed_issues: [5923], allowed_skills: ['qa'], created_at: 'x', source: 'wave-promote' });
            const calls = { depsState: 0 };
            for (const action of RESOLUTIONS) {
                const out = applyResolution({
                    action, authorizedBy: by, issue: issueFor(action), deps: realDeps(pp, calls),
                });
                assert.equal(out.status, 403, `${JSON.stringify(by)} no está en el enum ⇒ 403`);
            }
            assert.ok(readMarker(), 'ninguna mutación se aplicó');
            assert.equal(calls.depsState, 0, 'ni siquiera se limpia el deps-state');
        });
    }
});

test('#5923 keep-original es idempotente: dos taps no degradan el estado', () => {
    withRealPipelineDir(({ pp, writeMarker, readMarker }) => {
        writeMarker({ allowed_issues: [5923], allowed_skills: ['qa'], wave_number: 9, created_at: 'x', source: 'wave-promote' });
        const calls = { depsState: 0 };
        applyResolution({ action: 'keep-original', authorizedBy: BY, deps: realDeps(pp, calls) });
        const first = readMarker();
        applyResolution({ action: 'keep-original', authorizedBy: BY, deps: realDeps(pp, calls) });
        const second = readMarker();
        assert.deepEqual(second.allowed_issues, first.allowed_issues);
        assert.deepEqual(second.allowed_skills, first.allowed_skills);
        assert.equal(second.wave_number, 9, 'la wave metadata sobrevive a N aplicaciones');
    });
});

test('#5923 markDepRiskAccepted es fail-closed si no hay pausa parcial vigente', () => {
    withRealPipelineDir(({ pp, readMarker }) => {
        // Sin marker en disco.
        const r1 = pp.markDepRiskAccepted({ authorizedBy: BY });
        assert.equal(r1.ok, false);
        assert.equal(r1.reason, 'no_partial_pause');
        assert.equal(readMarker(), null, 'no crea un marker de la nada');
    });
    withRealPipelineDir(({ pp, writeMarker }) => {
        // Marker que no habilita nada: tampoco es pausa parcial.
        writeMarker({ allowed_issues: [], allowed_skills: [], source: 'x' });
        assert.equal(pp.markDepRiskAccepted({ authorizedBy: BY }).reason, 'no_partial_pause');
    });
});

test('#6118 cada acción ruteada desde Telegram existe en RESOLUTIONS (nada de botones muertos)', () => {
    const path = require('path');
    const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
    const handler = require(path.join(REPO_ROOT, '.claude', 'hooks', 'commander', 'callback-handler.js'));
    // La dirección del chequeo se invierte respecto de #5923: ahora RESOLUTIONS
    // es un SUPERCONJUNTO de lo ruteado desde Telegram, porque
    // `cancel-partial-pause` sigue siendo una resolución válida (la usa el
    // dashboard) pero ya no tiene botón. Lo que no puede pasar es lo inverso:
    // una ruta de Telegram sin implementación del otro lado.
    for (const [action, route] of Object.entries(handler.PP_ROUTES)) {
        assert.ok(RESOLUTIONS.includes(action) || action === 'include-deps',
            `${action} se rutea pero no está implementado ⇒ botón muerto`);
        assert.equal(route, `/api/partial-pause/${action}`);
    }
});

test('#6118 CA-6 `cancel-partial-pause` sigue implementado pero YA NO se rutea desde Telegram', () => {
    const path = require('path');
    const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
    const handler = require(path.join(REPO_ROOT, '.claude', 'hooks', 'commander', 'callback-handler.js'));
    // Sigue siendo una resolución legítima: el dashboard la ofrece, y ahí el
    // alcance global es lo que el operador está mirando.
    assert.ok(RESOLUTIONS.includes('cancel-partial-pause'));
    // Pero no tiene ruta: un tap sobre un mensaje viejo del chat muere en el
    // lookup, sin request saliente. Ese es el corazón del CA-6.
    assert.equal(handler.PP_ROUTES['cancel-partial-pause'], undefined,
        'con ruta, un callback_data histórico o forjado seguiría liberando todo el backlog');
    assert.equal(handler.PP_META['cancel-partial-pause'], undefined,
        'sin meta tampoco puede pedir confirmación ni rearmar el teclado');
});

// =============================================================================
// #6118 — Las dos resoluciones nuevas de la alerta de dependencias faltantes.
//
// `mute-alert` silencia sin tocar nada; `include-deps-for-issue` habilita SÓLO
// las dependencias del issue que titula esa alerta. Las dos derivan el conjunto
// de dependencias del state del SERVIDOR: el tap sólo trae el número de issue,
// porque el set no entra en los 64 bytes del `callback_data`.
// =============================================================================

const copy6118 = require('../partial-pause-deps-copy');

/**
 * Deps con el state de dependencias cargado y spies que EXPLOTAN si se invoca
 * una primitiva de mutación. No devuelven `false`: tiran, así que el test falla
 * con el stack del culpable y no con un assert genérico al final.
 */
function depsCon6118(stateMissing, overrides = {}) {
    const calls = { mutes: [], sets: [], mark: [], clear: [], dropped: [], depsState: 0 };
    return {
        calls,
        deps: {
            getPipelineMode: () => ({
                mode: 'partial_pause',
                allowedIssues: [6033, 6040],
                allowedSkills: ['qa'],
                depSources: { 6040: 'auto-deps' },
            }),
            readDepsState: () => ({ missing: stateMissing }),
            alertSignature: require('../partial-pause-deps').alertSignature,
            mute: (sig, meta) => {
                calls.mutes.push({ sig, meta });
                return { ok: true, signature: sig, expiresAt: 1700086400000, ttlMs: 24 * 3600 * 1000 };
            },
            setPartialPause: (list, opts) => {
                calls.sets.push({ list, opts });
                return { ok: true, allowedIssues: list };
            },
            markDepRiskAccepted: (o) => {
                calls.mark.push(o);
                return { ok: true, allowedIssues: [6033, 6040], allowedSkills: ['qa'] };
            },
            clearPartialPause: () => { throw new Error('clearPartialPause NO puede invocarse desde estas ramas'); },
            dropIssueFromDepsState: (n) => { calls.dropped.push(n); },
            clearDepsState: () => { calls.depsState++; },
            muteTtlMs: 24 * 3600 * 1000,
            ...overrides,
        },
    };
}

// ─── CA-9 · silenciar no muta la selección ───────────────────────────────────

test('#6118 CA-9 mute-alert no toca NINGUNA primitiva que cambie los issues habilitados', () => {
    const h = depsCon6118({ 6033: [6032] }, {
        setPartialPause: () => { throw new Error('mute-alert no puede escribir el marker'); },
        markDepRiskAccepted: () => { throw new Error('mute-alert no puede marcar riesgo asumido'); },
    });
    const out = applyResolution({
        action: 'mute-alert', authorizedBy: BY, issue: 6033, operatorRef: '111222333', deps: h.deps,
    });

    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(h.calls.mutes.length, 1, 'lo único que hace es persistir el silencio');
    assert.equal(h.calls.depsState, 0, 'ni siquiera limpia el state: el issue SIGUE frenado');
});

test('#6118 mute-alert usa la firma VIGENTE del state, no la que traía el mensaje', () => {
    // El operador aprieta un botón emitido cuando faltaba sólo #6032, pero desde
    // entonces apareció #6031. Se silencia la situación de AHORA.
    const h = depsCon6118({ 6033: [6032, 6031] });
    const out = applyResolution({ action: 'mute-alert', authorizedBy: BY, issue: 6033, deps: h.deps });

    assert.deepEqual(h.calls.mutes[0].meta.deps, [6032, 6031]);
    assert.equal(h.calls.mutes[0].sig, '6033:6031,6032', 'firma derivada del state, normalizada');
    assert.equal(out.body.signature, '6033:6031,6032');
});

test('#6118 mute-alert propaga el operador y el TTL configurado al store', () => {
    const h = depsCon6118({ 6033: [6032] });
    applyResolution({ action: 'mute-alert', authorizedBy: BY, issue: 6033, operatorRef: '111222333', deps: h.deps });
    assert.equal(h.calls.mutes[0].meta.operatorRef, '111222333', 'CA-12: queda quién lo pidió');
    assert.equal(h.calls.mutes[0].meta.ttlMs, 24 * 3600 * 1000, 'CA-13: la ventana sale de config');
    assert.equal(h.calls.mutes[0].meta.issue, 6033);
});

test('#6118 mute-alert sobre un issue que ya no está frenado ⇒ 409 y cero escritura', () => {
    // Anti-replay natural: el tap llegó tarde, la situación ya se resolvió.
    for (const state of [{}, { 6040: [6041] }, { 6033: [] }]) {
        const h = depsCon6118(state, { mute: () => { throw new Error('no hay nada que silenciar'); } });
        const out = applyResolution({ action: 'mute-alert', authorizedBy: BY, issue: 6033, deps: h.deps });
        assert.equal(out.status, 409);
        assert.match(out.body.operatorMsg, /#6033 ya no está esperando dependencias/);
    }
});

test('#6118 mute-alert con el state ilegible ⇒ 409, nunca un silencio a ciegas', () => {
    const h = depsCon6118({}, {
        readDepsState: () => { throw new Error('archivo corrupto'); },
        mute: () => { throw new Error('no puede silenciar sin saber qué'); },
    });
    assert.equal(applyResolution({ action: 'mute-alert', authorizedBy: BY, issue: 6033, deps: h.deps }).status, 409);
});

// ─── CA-5 · el include queda acotado al issue de la alerta ───────────────────

test('#6118 CA-5 include-deps-for-issue agrega SÓLO las deps del issue del request', () => {
    // Escenario Gherkin: #6033 depende de #6032 y #6040 de #6041. El tap sobre
    // la alerta de #6033 no puede arrastrar a #6041.
    const h = depsCon6118({ 6033: [6032], 6040: [6041] });
    const out = applyResolution({ action: 'include-deps-for-issue', authorizedBy: BY, issue: 6033, deps: h.deps });

    assert.equal(out.status, 200);
    assert.equal(h.calls.sets.length, 1);
    assert.deepEqual(h.calls.sets[0].list, [6032, 6033, 6040], 'suma #6032 a lo que ya estaba habilitado');
    assert.ok(!h.calls.sets[0].list.includes(6041), 'la dependencia del OTRO issue alertado no se toca');
    assert.deepEqual(out.body.addedDeps, [6032]);
});

test('#6118 include-deps-for-issue saca del state sólo al issue resuelto', () => {
    const h = depsCon6118({ 6033: [6032], 6040: [6041] });
    applyResolution({ action: 'include-deps-for-issue', authorizedBy: BY, issue: 6033, deps: h.deps });
    assert.deepEqual(h.calls.dropped, [6033]);
    assert.equal(h.calls.depsState, 0, 'borrar el state entero volvería invisible a #6040');
});

test('#6118 include-deps-for-issue preserva skills, dep_sources y metadata de la ola', () => {
    // `setPartialPause` reescribe el marker desde sus argumentos: lo que no se
    // le pasa, se pierde. Habilitar una dependencia no puede borrar la identidad
    // de la ola activa como daño colateral.
    const h = depsCon6118({ 6033: [6032] }, {
        readMarkerRaw: () => ({ wave_number: 9, wave_name: 'Ola Puente', wave_goal: 'kernel multiproducto' }),
    });
    applyResolution({ action: 'include-deps-for-issue', authorizedBy: BY, issue: 6033, deps: h.deps });

    const opts = h.calls.sets[0].opts;
    assert.deepEqual(opts.allowedSkills, ['qa']);
    assert.equal(opts.waveNumber, 9);
    assert.equal(opts.waveName, 'Ola Puente');
    assert.equal(opts.waveGoal, 'kernel multiproducto');
    assert.equal(opts.depSources['6032'], 'auto-deps', 'la dep nueva queda trazada como automática');
    assert.equal(opts.depSources['6040'], 'auto-deps', 'las previas se preservan');
    assert.equal(opts.acceptedDepRisk, false, 'ya no hay riesgo asumido: se incluyeron las deps');
    assert.equal(opts.authorizedBy, BY);
});

test('#6118 include-deps-for-issue sobre un issue que ya no está frenado ⇒ 409 sin escribir', () => {
    const h = depsCon6118({ 6040: [6041] }, {
        setPartialPause: () => { throw new Error('no hay nada que incluir'); },
    });
    const out = applyResolution({ action: 'include-deps-for-issue', authorizedBy: BY, issue: 6033, deps: h.deps });
    assert.equal(out.status, 409);
    assert.equal(h.calls.sets.length, 0);
});

// ─── CA-1 / CA-7 · frontera del copy ─────────────────────────────────────────

test('#6118 CA-1 todo `operatorMsg` va sin jerga; el `msg` del dashboard la conserva', () => {
    const escenarios = [
        ['mute-alert', 6033, { 6033: [6032] }, 200],
        ['include-deps-for-issue', 6033, { 6033: [6032, 6031, 6030] }, 200],
        ['keep-original', 6033, { 6033: [6032] }, 200],
        ['mute-alert', 6033, {}, 409],
        ['include-deps-for-issue', 6033, {}, 409],
    ];
    for (const [action, issue, state, esperado] of escenarios) {
        const h = depsCon6118(state);
        const out = applyResolution({ action, authorizedBy: BY, issue, deps: h.deps });
        assert.equal(out.status, esperado, `${action} → ${esperado}`);
        assert.ok(out.body.operatorMsg, `${action} tiene que redactar el texto del operador`);
        assert.deepEqual(copy6118.findForbiddenTerms(out.body.operatorMsg), [],
            `${action}: jerga filtrada a Telegram en "${out.body.operatorMsg}"`);
    }
});

test('#6118 CA-14 el `msg` interno del dashboard NO se empobrece', () => {
    // La prohibición de jerga es de la superficie de Telegram. Acá "allowlist"
    // es el término correcto y el operador del dashboard lo entiende.
    const h = depsCon6118({ 6033: [6032] });
    const out = applyResolution({ action: 'keep-original', authorizedBy: BY, issue: 6033, deps: h.deps });
    assert.match(out.body.msg, /allowlist/, 'el dashboard mantiene su vocabulario');
    assert.doesNotMatch(out.body.operatorMsg, /allowlist/i, 'Telegram no lo ve');
});

test('#6118 CA-7 el 403 de autorización también habla en criollo para Telegram', () => {
    const h = depsCon6118({ 6033: [6032] });
    const out = applyResolution({ action: 'mute-alert', authorizedBy: 'inventado:x', issue: 6033, deps: h.deps });
    assert.equal(out.status, 403);
    assert.match(out.body.msg, /enum|autorización|registrado/i, 'el detalle técnico queda del lado del dashboard');
    assert.equal(out.body.operatorMsg, 'No pude aplicar el cambio: la autorización fue rechazada.');
    assert.equal(h.calls.mutes.length, 0, 'sin autorización no se silencia nada');
});
