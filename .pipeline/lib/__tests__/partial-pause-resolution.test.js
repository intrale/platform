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

test('#5923 con mode !== partial_pause ⇒ 409 y CERO mutación (anti-replay)', () => {
    // `null` explícito NO dispara el default del helper: cubre el modo ilegible.
    for (const mode of ['running', 'paused', 'rest', null]) {
        const h = makeDeps(mode);
        for (const action of RESOLUTIONS) {
            const out = applyResolution({ action, authorizedBy: BY, deps: h.deps });
            assert.equal(out.status, 409, `${action} en modo ${mode} debe dar 409`);
            assert.match(out.body.msg, /no en partial_pause/);
        }
        assert.equal(h.calls.mark.length, 0, 'no se toca el allowlist');
        assert.equal(h.calls.clear.length, 0, 'no se levanta la pausa');
    }
});

test('#5923 si el estado del pipeline no se puede leer ⇒ 409, nunca mutación a ciegas', () => {
    const deps = { getPipelineMode: () => undefined, markDepRiskAccepted: () => { throw new Error('no debe llamarse'); },
                   clearPartialPause: () => { throw new Error('no debe llamarse'); } };
    for (const action of RESOLUTIONS) {
        assert.equal(applyResolution({ action, authorizedBy: BY, deps }).status, 409);
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
                const out = applyResolution({ action, authorizedBy: by, deps: realDeps(pp, calls) });
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

test('#5923 RESOLUTIONS coincide con los paths que rutea el callback-handler', () => {
    const path = require('path');
    const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
    const handler = require(path.join(REPO_ROOT, '.claude', 'hooks', 'commander', 'callback-handler.js'));
    for (const action of RESOLUTIONS) {
        assert.equal(handler.PP_ROUTES[action], `/api/partial-pause/${action}`,
            `${action} tiene que estar ruteado o el botón queda muerto`);
    }
    // `include-deps` ya existía y sigue ruteado.
    assert.equal(handler.PP_ROUTES['include-deps'], '/api/partial-pause/include-deps');
});
