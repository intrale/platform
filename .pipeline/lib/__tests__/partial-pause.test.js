// Tests de .pipeline/lib/partial-pause.js (issue #2490)
// Valida precedencia paused > partial_pause > running, allowlist, y normalización.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar el módulo a un tmp dir
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-partial-pause-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

delete require.cache[require.resolve('../partial-pause')];
const pp = require('../partial-pause');

function resetFs() {
    const { PARTIAL_FILE, PAUSE_FILE } = pp._paths();
    try { fs.unlinkSync(PARTIAL_FILE); } catch {}
    try { fs.unlinkSync(PAUSE_FILE); } catch {}
}

test('getPipelineMode retorna running cuando no hay ningún marker', () => {
    resetFs();
    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'running');
    assert.deepEqual(state.allowedIssues, []);
});

// #5060 — ejecución solo por olas. Sin allowlist no hay ola vigente que acote
// el dispatch, así que el gate deniega en vez de permitir. Antes de este fix
// devolvía `true` para todo, y eso hizo que al cerrarse la ola 8 el pipeline
// dispatchara ~100 issues del backlog histórico (incidente 2026-07-26).
test('isIssueAllowed deniega todo issue cuando no hay allowlist (fail-closed #5060)', () => {
    resetFs();
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    assert.equal(pp.getPipelineMode().mode, 'running');
    assert.equal(pp.isIssueAllowed(2490), false);
    assert.equal(pp.isIssueAllowed('2491'), false);
    assert.equal(pp.isIssueAllowed('#9999'), false);
});

test('el escape hatch PIPELINE_ALLOW_UNSCOPED_DISPATCH=1 reabre el dispatch sin ola (#5060)', () => {
    resetFs();
    process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH = '1';
    try {
        assert.equal(pp.isIssueAllowed(2490), true);
        assert.equal(pp.isIssueAllowed('#9999'), true);
    } finally {
        delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    }
    // Al apagarlo vuelve a fail-closed, sin estado pegajoso entre llamadas.
    assert.equal(pp.isIssueAllowed(2490), false);
});

test('allowlist que queda vacía tras la poda no reabre el backlog (#5060)', () => {
    resetFs();
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    pp.setPartialPause([2490, 2491], { source: 'telegram' });
    assert.equal(pp.isIssueAllowed(2490), true);
    // Esto es exactamente lo que hace la poda convergente #4753 al cerrar la ola.
    pp.setPartialPause([], { source: 'wave-promote:autoresolve-reductive', authorizedBy: 'wave-promote' });
    assert.equal(pp.getPipelineMode().mode, 'running');
    assert.equal(pp.isIssueAllowed(2490), false);
    assert.equal(pp.isIssueAllowed(9999), false);
});

test('los skills del control-plane siguen habilitados sin allowlist (#5060)', () => {
    resetFs();
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    // El fail-closed acota el BACKLOG, no los harnesses de diagnóstico.
    assert.equal(pp.isSkillAllowed('multi-provider-smoke-test'), true);
});

test('setPartialPause con [2490, 2491] activa partial_pause', () => {
    resetFs();
    const result = pp.setPartialPause([2490, 2491], { source: 'telegram' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.allowedIssues, [2490, 2491]);

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'partial_pause');
    assert.deepEqual(state.allowedIssues, [2490, 2491]);
    assert.equal(state.source, 'telegram');
    assert.ok(state.createdAt);
});

test('isIssueAllowed respeta allowlist en modo partial_pause', () => {
    resetFs();
    pp.setPartialPause([2490, 2491]);
    assert.equal(pp.isIssueAllowed(2490), true);
    assert.equal(pp.isIssueAllowed(2491), true);
    assert.equal(pp.isIssueAllowed(2500), false);
    assert.equal(pp.isIssueAllowed('#2490'), true);
    assert.equal(pp.isIssueAllowed('9999'), false);
});

test('setPartialPause normaliza strings, "#prefix" y descarta valores inválidos', () => {
    resetFs();
    const result = pp.setPartialPause(['#2490', '2491', 'abc', 0, -5, null, '  2492 '], { source: 'test' });
    assert.deepEqual(result.allowedIssues, [2490, 2491, 2492]);
});

test('setPartialPause deduplica y ordena', () => {
    resetFs();
    const result = pp.setPartialPause([2491, 2490, 2491, 2490, 2492]);
    assert.deepEqual(result.allowedIssues, [2490, 2491, 2492]);
});

test('setPartialPause con lista vacía elimina el marker', () => {
    resetFs();
    pp.setPartialPause([2490]);
    assert.equal(pp.getPipelineMode().mode, 'partial_pause');

    const result = pp.setPartialPause([]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.allowedIssues, []);
    assert.equal(pp.getPipelineMode().mode, 'running');
});

test('clearPartialPause elimina el marker y reporta si existía', () => {
    resetFs();
    pp.setPartialPause([2490]);
    const r1 = pp.clearPartialPause();
    assert.equal(r1.existed, true);
    assert.equal(pp.getPipelineMode().mode, 'running');

    const r2 = pp.clearPartialPause();
    assert.equal(r2.existed, false);
});

test('precedencia: .paused gana sobre .partial-pause.json', () => {
    resetFs();
    pp.setPartialPause([2490, 2491]);

    // Simular pausa completa
    const { PAUSE_FILE } = pp._paths();
    fs.writeFileSync(PAUSE_FILE, new Date().toISOString());

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'paused');
    assert.equal(pp.isIssueAllowed(2490), false);  // incluso el allowed queda bloqueado
    assert.equal(pp.isIssueAllowed(2491), false);
});

test('resumeAll elimina ambos markers', () => {
    resetFs();
    pp.setPartialPause([2490]);
    const { PAUSE_FILE } = pp._paths();
    fs.writeFileSync(PAUSE_FILE, new Date().toISOString());

    const result = pp.resumeAll();
    assert.equal(result.removedFull, true);
    assert.equal(result.removedPartial, true);
    assert.equal(pp.getPipelineMode().mode, 'running');
});

test('resumeAll sin markers es no-op', () => {
    resetFs();
    const result = pp.resumeAll();
    assert.equal(result.removedFull, false);
    assert.equal(result.removedPartial, false);
});

test('JSON corrupto → modo running (fail-open, no se cuelga)', () => {
    resetFs();
    const { PARTIAL_FILE } = pp._paths();
    fs.writeFileSync(PARTIAL_FILE, '{malformed json');

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'running');
});

test('JSON válido sin allowed_issues → modo running', () => {
    resetFs();
    const { PARTIAL_FILE } = pp._paths();
    fs.writeFileSync(PARTIAL_FILE, JSON.stringify({ other_field: 'x' }));

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'running');
});

test('allowed_issues vacío en el JSON → modo running', () => {
    resetFs();
    const { PARTIAL_FILE } = pp._paths();
    fs.writeFileSync(PARTIAL_FILE, JSON.stringify({ allowed_issues: [] }));

    const state = pp.getPipelineMode();
    assert.equal(state.mode, 'running');
});

test('isIssueAllowed(null|undefined|"abc") retorna false sin error', () => {
    resetFs();
    pp.setPartialPause([2490]);
    assert.equal(pp.isIssueAllowed(null), false);
    assert.equal(pp.isIssueAllowed(undefined), false);
    assert.equal(pp.isIssueAllowed('abc'), false);
});

// ----- isIssueAllowedInState (#2957) ------------------------------------------
//
// La variante "in state" no toca filesystem: recibe el estado ya leído. Permite
// a callers que iteran muchos issues en un mismo tick (counters de cola)
// reutilizar la misma decisión sin pagar IO por elemento.

test('isIssueAllowedInState — modo running deniega sin allowlist (#5060)', () => {
    delete process.env.PIPELINE_ALLOW_UNSCOPED_DISPATCH;
    const state = { mode: 'running', allowedIssues: [] };
    assert.equal(pp.isIssueAllowedInState(2490, state), false);
    assert.equal(pp.isIssueAllowedInState('#9999', state), false);
});

test('isIssueAllowedInState — modo paused bloquea todo', () => {
    const state = { mode: 'paused', allowedIssues: [] };
    assert.equal(pp.isIssueAllowedInState(2490, state), false);
    assert.equal(pp.isIssueAllowedInState('#9999', state), false);
});

test('isIssueAllowedInState — modo partial_pause respeta allowlist', () => {
    const state = { mode: 'partial_pause', allowedIssues: [2891] };
    assert.equal(pp.isIssueAllowedInState(2891, state), true);
    assert.equal(pp.isIssueAllowedInState('2891', state), true);
    assert.equal(pp.isIssueAllowedInState('#2891', state), true);
    // Issues fuera del allowlist (caso del bug #2957: contadores incluían estos)
    assert.equal(pp.isIssueAllowedInState(2892, state), false);
    assert.equal(pp.isIssueAllowedInState(2893, state), false);
    assert.equal(pp.isIssueAllowedInState(2914, state), false);
});

test('isIssueAllowedInState — entradas inválidas no rompen', () => {
    const state = { mode: 'partial_pause', allowedIssues: [2891] };
    assert.equal(pp.isIssueAllowedInState(null, state), false);
    assert.equal(pp.isIssueAllowedInState(undefined, state), false);
    assert.equal(pp.isIssueAllowedInState('abc', state), false);
    // state inválido también es seguro
    assert.equal(pp.isIssueAllowedInState(2891, null), false);
    assert.equal(pp.isIssueAllowedInState(2891, {}), false);
});

test('isIssueAllowedInState — partial_pause con allowedIssues no-array es seguro', () => {
    const state = { mode: 'partial_pause' };
    assert.equal(pp.isIssueAllowedInState(2891, state), false);
});

// ─── #4030 — Metadata estructurada de la ola (campos aditivos) ──────────────

function readPartialRaw() {
    const { PARTIAL_FILE } = pp._paths();
    return JSON.parse(fs.readFileSync(PARTIAL_FILE, 'utf8'));
}

test('#4030: setPartialPause persiste wave_number/wave_name/wave_goal cuando se proveen por opts', () => {
    resetFs();
    pp.setPartialPause([4030], {
        source: 'telegram:commander',
        waveNumber: 4,
        waveName: 'Memoria + dashboard operativo núcleo',
        waveGoal: 'Núcleo operativo.',
    });
    const raw = readPartialRaw();
    assert.equal(raw.wave_number, 4);
    assert.equal(raw.wave_name, 'Memoria + dashboard operativo núcleo');
    assert.equal(raw.wave_goal, 'Núcleo operativo.');
});

test('#4030: setPartialPause NO escribe los campos de ola cuando no se proveen', () => {
    resetFs();
    pp.setPartialPause([4030], { source: 'telegram' });
    const raw = readPartialRaw();
    assert.equal('wave_number' in raw, false);
    assert.equal('wave_name' in raw, false);
    assert.equal('wave_goal' in raw, false);
});

test('#4030: setPartialPauseAtomic persiste los campos de ola saneados (cap + strip prefijo)', () => {
    resetFs();
    pp.setPartialPauseAtomic([4030], {
        source: 'wave-promote-atomic',
        authorizedBy: 'wave-promote',
        waveNumber: 5,
        waveName: 'Ola 5 — Título con prefijo',
        waveGoal: 'g'.repeat(600),
    });
    const raw = readPartialRaw();
    assert.equal(raw.wave_number, 5);
    assert.equal(raw.wave_name, 'Título con prefijo', 'strip del prefijo "Ola N — "');
    assert.equal(raw.wave_goal.length, 500, 'cap de goal a 500');
});

test('#4030: meta de ola inválida (number ≤0 / name no-string) NO se persiste', () => {
    resetFs();
    pp.setPartialPause([4030], {
        source: 'telegram',
        waveNumber: 0,
        waveName: 'Nombre',
    });
    const raw = readPartialRaw();
    assert.equal('wave_number' in raw, false);
    assert.equal('wave_name' in raw, false);
});

test('#4030: sanitizeWaveMetaForWrite strip de control-chars', () => {
    const m = pp.sanitizeWaveMetaForWrite({ waveNumber: 4, waveName: 'Mem\x00oria\x1f' });
    assert.equal(m.wave_name, 'Memoria');
    assert.equal(m.wave_number, 4);
});

// -----------------------------------------------------------------------------
// #4832 — readFullPauseOrigin (fail-closed): distingue pausa auto-generada por
// corrupción de config (recuperable) de pausa manual/legacy (persistente).
// -----------------------------------------------------------------------------

function writePauseFile(content) {
    const { PAUSE_FILE } = pp._paths();
    fs.writeFileSync(PAUSE_FILE, content);
}

test('#4832: marker JSON con source=config-corruption-halt → recuperable', () => {
    resetFs();
    writePauseFile(JSON.stringify({
        source: 'config-corruption-halt',
        ts: '2026-07-21T00:00:00.000Z',
        detail: 'YAML inválido (línea 3, col 1)',
    }));
    const origin = pp.readFullPauseOrigin();
    assert.equal(origin.source, 'config-corruption-halt');
});

test('#4832: marker ISO plano legacy → manual (NO recuperable)', () => {
    resetFs();
    writePauseFile('2026-07-21T00:00:00.000Z');
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

test('#4832: marker JSON con otro source → manual (NO recuperable)', () => {
    resetFs();
    writePauseFile(JSON.stringify({ source: 'manual', ts: '2026-07-21T00:00:00.000Z' }));
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

test('#4832: marker JSON sin campo source → manual (NO recuperable)', () => {
    resetFs();
    writePauseFile(JSON.stringify({ ts: '2026-07-21T00:00:00.000Z' }));
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

test('#4832: marker JSON malformado → manual (NO recuperable)', () => {
    resetFs();
    writePauseFile('{ source: "config-corruption-halt"');  // JSON roto
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

test('#4832: marker vacío → manual (NO recuperable)', () => {
    resetFs();
    writePauseFile('   ');
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

test('#4832: sin marker .paused → unknown (NO recuperable)', () => {
    resetFs();
    const origin = pp.readFullPauseOrigin();
    assert.equal(origin.source, 'unknown');
    assert.equal(origin.raw, null);
});

test('#4832: source config-corruption-halt como substring pero no exacto → manual', () => {
    resetFs();
    writePauseFile(JSON.stringify({ source: 'config-corruption-halt-manual' }));
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

// -----------------------------------------------------------------------------
// #5399 — endurecimiento del lector + allowlist positiva de auto-levantado.
// -----------------------------------------------------------------------------

test('#5399: readFullPauseOrigin rechaza objetos con __proto__ sin contaminar el prototipo', () => {
    resetFs();
    // Payload clásico de prototype pollution. Un `{ ...defaults, ...parsed }` o
    // un deep-merge acá contaminaría Object.prototype para todo el proceso.
    writePauseFile('{"source":"config-corruption-halt","__proto__":{"polluted":"si"},'
        + '"constructor":{"prototype":{"polluted2":"si"}}}');
    const origin = pp.readFullPauseOrigin();
    assert.equal(origin.source, 'config-corruption-halt');
    assert.equal(({}).polluted, undefined, 'Object.prototype quedó limpio');
    assert.equal(({}).polluted2, undefined, 'Object.prototype quedó limpio');
    assert.equal(Object.prototype.polluted, undefined);
});

test('#5399: readFullPauseOrigin devuelve el source literal en rawSource sin relajar el veredicto', () => {
    resetFs();
    writePauseFile(JSON.stringify({
        source: 'dashboard:wizard:pausa',
        ts: '2026-08-02T08:00:00.000Z',
        detail: 'pausa del wizard',
    }));
    const origin = pp.readFullPauseOrigin();
    // Veredicto fail-closed intacto (contrato #4832)...
    assert.equal(origin.source, 'manual');
    // ...pero la autoría literal viaja para que el restart la copie verbatim.
    assert.equal(origin.rawSource, 'dashboard:wizard:pausa');
    assert.equal(origin.ts, '2026-08-02T08:00:00.000Z');
    assert.equal(origin.detail, 'pausa del wizard');
});

test('#5399: isAutoLiftableSource decide por pertenencia exacta a la allowlist positiva', () => {
    assert.equal(pp.isAutoLiftableSource('config-corruption-halt'), true);
    // Todo lo demás es false — incluido lo "no humano" (prohibido decidir por negación).
    for (const v of ['manual', 'unknown', 'telegram', 'restart', 'kernel-cutover-degraded-halt',
        'config-corruption-halt-manual', 'CONFIG-CORRUPTION-HALT', ' config-corruption-halt',
        '', null, undefined, 0, 1, true, {}, [], ['config-corruption-halt']]) {
        assert.equal(pp.isAutoLiftableSource(v), false, `${JSON.stringify(v)} no es auto-levantable`);
    }
    assert.deepEqual([...pp.AUTO_LIFTABLE_SOURCES], ['config-corruption-halt']);
    assert.equal(Object.isFrozen(pp.AUTO_LIFTABLE_SOURCES), true);
});

test('#5399: setFullPause persiste el source recibido en vez de descartarlo', () => {
    resetFs();
    const res = pp.setFullPause({
        source: 'dashboard:wizard:pausa',
        authorizedBy: 'pause:dashboard',
        justification: 'el operador pausó desde el wizard',
    });
    assert.equal(res.ok, true);
    assert.equal(res.source, 'dashboard:wizard:pausa');
    assert.equal(res.autoLiftable, false);
    const { PAUSE_FILE } = pp._paths();
    const marker = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
    assert.equal(marker.source, 'dashboard:wizard:pausa');
    assert.ok(marker.ts, 'el marker deja de ser un ISO pelado y lleva ts propio');
    assert.equal(marker.detail, 'el operador pausó desde el wizard');
    // El modo del pipeline sigue siendo `paused` (nada del contrato viejo se rompe).
    assert.equal(pp.getPipelineMode().mode, 'paused');
    // Y la autoría no habilita auto-levantado.
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
    assert.equal(pp.readFullPauseOrigin().rawSource, 'dashboard:wizard:pausa');
});

test('#5399: setFullPause sin source explícito degrada a unknown, nunca a auto-levantable', () => {
    resetFs();
    const res = pp.setFullPause({ justification: 'sin autoría declarada' });
    assert.equal(res.source, 'unknown');
    assert.equal(res.autoLiftable, false);
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

test('#5399: setFullPause sanitiza el detail antes de persistirlo en el marker', () => {
    resetFs();
    pp.setFullPause({
        source: 'telegram',
        authorizedBy: 'commander:leo',
        justification: 'pausa por incidente, token AKIAIOSFODNN7EXAMPLE en el log',
    });
    const { PAUSE_FILE } = pp._paths();
    const marker = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
    assert.equal(marker.detail.includes('AKIAIOSFODNN7EXAMPLE'), false,
        'el marker no persiste el secreto crudo');
});
