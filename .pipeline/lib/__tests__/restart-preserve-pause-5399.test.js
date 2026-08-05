// =============================================================================
// #5399 — restart.js reescribía `.paused` con un ISO pelado y borraba la
// autoría de la pausa: el pipeline quedaba pausado para siempre.
//
// Evidencia del defecto (2026-08-02): tras un `/restart` a las 09:28 el
// pipeline estuvo 1h33 sin despachar. No fue cuota ni recursos: fue una pausa
// automática que, al perder su `source`, se leyó como manual y por eso el
// auto-recovery de #4832 nunca la levantó.
//
// Un test nombrado por cada escenario Gherkin de `po` (CA-2..CA-6, CA-9, CA-13)
// más el endurecimiento de parsing (CA-10). Todo aislado a un tmpdir vía
// PIPELINE_DIR_OVERRIDE: no toca el `.paused` real ni el audit log real.
//
// NOTA: no se hace `require('../../restart.js')` a propósito — es un script con
// side effects (mata procesos, lanza componentes). Lo que se ejerce es la rama
// viva que ese script invoca: `preserveFullPause` / `setFullPause`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Aislar el módulo a un tmp dir ANTES de requerirlo.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-restart-preserve-5399-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;
fs.mkdirSync(path.join(TMP_DIR, 'audit'), { recursive: true });

// Mockear notify-telegram: los tests no deben spamear el canal real.
const notifyMod = require.resolve('../notify-telegram');
require.cache[notifyMod] = {
    id: notifyMod, filename: notifyMod, loaded: true,
    exports: { notifyTelegram() {} },
};

delete require.cache[require.resolve('../partial-pause')];
delete require.cache[require.resolve('../partial-pause-audit')];
const pp = require('../partial-pause');
const audit = require('../partial-pause-audit');

const { PAUSE_FILE, PARTIAL_FILE } = pp._paths();
const AUDIT_FILE = audit._paths().AUDIT_FILE;

function resetFs() {
    try { fs.unlinkSync(PAUSE_FILE); } catch {}
    try { fs.unlinkSync(PARTIAL_FILE); } catch {}
    try { fs.unlinkSync(PAUSE_FILE + '.lock'); } catch {}
}

function writeMarker(content) {
    fs.writeFileSync(PAUSE_FILE, typeof content === 'string' ? content : JSON.stringify(content));
}

function readMarker() {
    return JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
}

function auditEntries() {
    let raw = '';
    try { raw = fs.readFileSync(AUDIT_FILE, 'utf8'); } catch { return []; }
    return raw.split('\n').filter(l => l.trim()).map(l => {
        try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
}

// -----------------------------------------------------------------------------
// Escenario: restart preserva una pausa automatica recuperable y el pipeline se
// reanuda solo. (CA-2, CA-3)
// -----------------------------------------------------------------------------
test('restart preserva una pausa automatica recuperable y el pipeline se reanuda solo', () => {
    resetFs();
    const original = {
        source: 'config-corruption-halt',
        ts: '2026-08-02T09:20:00.000Z',
        detail: 'YAML invalido (linea 3, col 1)',
    };
    writeMarker(original);

    const res = pp.preserveFullPause();

    assert.equal(res.ok, true, 'la preservacion se aplico');
    assert.equal(res.existed, true);
    // CA-2: verbatim. El mismo source y el MISMO ts que antes del restart.
    const after = readMarker();
    assert.equal(after.source, original.source);
    assert.equal(after.ts, original.ts);
    assert.equal(after.detail, original.detail);
    // Constancia de que fue heredada por el restart.
    assert.equal(after.preservedFrom.by, 'restart');
    assert.ok(typeof after.preservedFrom.at === 'string' && after.preservedFrom.at.length > 0);
    // CA-3: sigue siendo candidata a auto-levantado — que es lo que el Pulpo
    // consulta en su ciclo de ~30s para reanudar el dispatch.
    assert.equal(pp.readFullPauseOrigin().source, 'config-corruption-halt');
    assert.equal(pp.isAutoLiftableSource(pp.readFullPauseOrigin().source), true);
    assert.equal(res.autoLiftable, true);
});

// -----------------------------------------------------------------------------
// Escenario: restart preserva una pausa humana y no la levanta solo. (CA-4)
// -----------------------------------------------------------------------------
test('restart preserva una pausa humana y no la levanta solo', () => {
    resetFs();
    const original = {
        source: 'telegram',
        ts: '2026-08-02T08:00:00.000Z',
        detail: 'pausa total solicitada por el operador via /pausar',
    };
    writeMarker(original);

    const res = pp.preserveFullPause();

    assert.equal(res.ok, true);
    const after = readMarker();
    // La autoria humana viaja verbatim: no se degrada ni se sintetiza.
    assert.equal(after.source, 'telegram');
    assert.equal(after.ts, original.ts);
    assert.equal(after.preservedFrom.by, 'restart');
    // Y NO se auto-levanta: requiere destrabe explicito.
    assert.equal(res.autoLiftable, false);
    assert.equal(pp.isAutoLiftableSource(after.source), false);
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

// -----------------------------------------------------------------------------
// Escenario: una pausa automatica deliberadamente no recuperable sigue sin
// levantarse. Regresion #5135 — `kernel-cutover-degraded-halt` es automatica
// pero exige rollback manual. (CA-5)
// -----------------------------------------------------------------------------
test('una pausa automatica deliberadamente no recuperable sigue sin levantarse', () => {
    resetFs();
    writeMarker({
        source: 'kernel-cutover-degraded-halt',
        ts: '2026-08-02T07:00:00.000Z',
        detail: 'encendido durable abortado: el store degrado a filesystem',
    });

    const res = pp.preserveFullPause();

    assert.equal(res.ok, true);
    const after = readMarker();
    // Se preserva (no se pierde el registro del abort)...
    assert.equal(after.source, 'kernel-cutover-degraded-halt');
    assert.equal(after.ts, '2026-08-02T07:00:00.000Z');
    // ...pero NO entra a la allowlist positiva de auto-levantado.
    assert.equal(res.autoLiftable, false);
    assert.equal(pp.isAutoLiftableSource('kernel-cutover-degraded-halt'), false);
    assert.equal(pp.AUTO_LIFTABLE_SOURCES.includes('kernel-cutover-degraded-halt'), false);
    // Y el lector fail-closed la reporta como manual → el Pulpo no la levanta.
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

// -----------------------------------------------------------------------------
// Escenario: archivo de pausa en formato viejo. (CA-6, CA-10)
// -----------------------------------------------------------------------------
test('archivo de pausa en formato viejo no rompe el arranque', () => {
    const casos = [
        { nombre: 'ISO plano legacy', contenido: '2026-08-02T09:28:00.000Z' },
        { nombre: 'vacio', contenido: '   ' },
        { nombre: 'JSON malformado', contenido: '{ source: "config-corruption-halt"' },
        { nombre: 'array', contenido: '["config-corruption-halt"]' },
        { nombre: 'null literal', contenido: 'null' },
        { nombre: 'primitivo numerico', contenido: '42' },
        { nombre: 'primitivo string JSON', contenido: '"config-corruption-halt"' },
        { nombre: 'marker gigante (>64KB)', contenido: JSON.stringify({
            source: 'config-corruption-halt',
            ts: '2026-08-02T09:00:00.000Z',
            detail: 'x'.repeat(70 * 1024),
        }) },
    ];
    for (const caso of casos) {
        resetFs();
        writeMarker(caso.contenido);
        // No tira: el arranque sobrevive.
        const origin = pp.readFullPauseOrigin();
        assert.equal(origin.source, 'manual', `${caso.nombre} → manual (fail-closed)`);
        assert.equal(pp.isAutoLiftableSource(origin.source), false, `${caso.nombre} → no auto-levantable`);
        // CA-6: deja registro de que la autoria no pudo determinarse.
        assert.ok(origin.undetermined, `${caso.nombre} → deja motivo de autoria indeterminada`);

        // Y preservarlo tampoco rompe ni promueve.
        const res = pp.preserveFullPause();
        assert.equal(res.ok, true, `${caso.nombre} → preservacion sin throw`);
        assert.equal(res.autoLiftable, false, `${caso.nombre} → sigue sin auto-levantarse`);
        assert.equal(readMarker().source, 'manual', `${caso.nombre} → marker queda manual`);
        assert.ok(readMarker().undetermined, `${caso.nombre} → el marker registra la indeterminacion`);
    }
});

test('el marker gigante se rechaza sin parsearlo y preserva el tamano acotado', () => {
    resetFs();
    assert.equal(pp.MAX_PAUSE_MARKER_BYTES, 64 * 1024);
    writeMarker({ source: 'config-corruption-halt', detail: 'y'.repeat(80 * 1024) });
    const origin = pp.readFullPauseOrigin();
    assert.equal(origin.source, 'manual');
    assert.equal(origin.undetermined, 'marker_demasiado_grande');
    assert.equal(origin.raw, null, 'ni siquiera se leyo el contenido');
});

// -----------------------------------------------------------------------------
// Escenario: el restart nunca promueve la autoria de una pausa. (CA-9)
// -----------------------------------------------------------------------------
test('el restart nunca promueve la autoria de una pausa', () => {
    const markersNoAutoLevantables = [
        JSON.stringify({ source: 'telegram', ts: '2026-08-01T10:00:00.000Z' }),
        JSON.stringify({ source: 'dashboard:wizard:pausa', ts: '2026-08-01T10:00:00.000Z' }),
        JSON.stringify({ source: 'manual', ts: '2026-08-01T10:00:00.000Z' }),
        JSON.stringify({ source: 'kernel-cutover-degraded-halt', ts: '2026-08-01T10:00:00.000Z' }),
        // Cuasi-match: substring, prefijo, sufijo y variantes de caja.
        JSON.stringify({ source: 'config-corruption-halt-manual' }),
        JSON.stringify({ source: 'x-config-corruption-halt' }),
        JSON.stringify({ source: 'CONFIG-CORRUPTION-HALT' }),
        JSON.stringify({ source: ' config-corruption-halt ' }),
        // Tipos no-string en `source`.
        JSON.stringify({ source: 1 }),
        JSON.stringify({ source: true }),
        JSON.stringify({ source: { toString: 'config-corruption-halt' } }),
        JSON.stringify({ source: ['config-corruption-halt'] }),
        JSON.stringify({ ts: '2026-08-01T10:00:00.000Z' }),
        '2026-08-01T10:00:00.000Z',
        '',
    ];
    for (const m of markersNoAutoLevantables) {
        resetFs();
        writeMarker(m);
        const res = pp.preserveFullPause();
        // Assert sobre CONTENIDO del marker, no sobre existsSync.
        const after = readMarker();
        assert.equal(pp.isAutoLiftableSource(after.source), false,
            `marker ${m.slice(0, 60)} NO debe quedar auto-levantable`);
        assert.equal(res.autoLiftable, false, `resultado de ${m.slice(0, 60)} no auto-levantable`);
        assert.equal(pp.readFullPauseOrigin().source, 'manual',
            `relectura de ${m.slice(0, 60)} sigue siendo manual`);
    }
});

test('preservar N veces es idempotente sobre la autoria y el timestamp (re-exec #2880)', () => {
    resetFs();
    writeMarker({
        source: 'config-corruption-halt',
        ts: '2026-08-02T09:20:00.000Z',
        detail: 'YAML invalido',
    });
    for (let i = 0; i < 4; i++) pp.preserveFullPause();
    const after = readMarker();
    assert.equal(after.source, 'config-corruption-halt');
    assert.equal(after.ts, '2026-08-02T09:20:00.000Z', 'el ts original sobrevive N re-ejecuciones');
    assert.equal(after.preservedFrom.by, 'restart');
    assert.equal(pp.isAutoLiftableSource(after.source), true);
});

test('preservar sin pausa previa no crea una pausa de la nada', () => {
    resetFs();
    const res = pp.preserveFullPause();
    assert.equal(res.ok, false);
    assert.equal(res.existed, false);
    assert.equal(fs.existsSync(PAUSE_FILE), false, 'no se materializo ningun marker');
});

// -----------------------------------------------------------------------------
// Escenario: cada preservacion deja auditoria aplicada. (CA-13)
// -----------------------------------------------------------------------------
test('cada preservacion deja auditoria aplicada', () => {
    resetFs();
    const antes = auditEntries().length;
    writeMarker({
        source: 'config-corruption-halt',
        ts: '2026-08-02T09:20:00.000Z',
        detail: 'YAML invalido',
    });

    pp.preserveFullPause();

    const entries = auditEntries();
    assert.ok(entries.length > antes, 'se agrego al menos una entry');
    const entry = entries[entries.length - 1];
    // CA-13: la entry se APLICA (write), no se rechaza por enum.
    assert.equal(entry.action, 'write');
    assert.notEqual(entry.action, 'reject');
    assert.equal(entry.authorized_by, 'restart:preserve-pause');
    assert.equal(entry.authorized_by_rejected_reason, undefined,
        'el authorizedBy no fue rechazado por el enum');
    // Identifica la autoria heredada.
    assert.equal(entry.inherited_source, 'config-corruption-halt');
    assert.equal(entry.inherited_ts, '2026-08-02T09:20:00.000Z');
    assert.equal(entry.preserved, true);
    assert.equal(entry.full_pause, true);
    assert.equal(entry.auto_liftable, true);
    // Preservar NO toca la allowlist: sin removals, el gate no se ensancha.
    assert.deepEqual(entry.diff, { added: [], removed: [] });
});

test('la auditoria de una pausa legacy registra que la autoria no pudo determinarse', () => {
    resetFs();
    writeMarker('2026-08-02T09:28:00.000Z');
    pp.preserveFullPause();
    const entries = auditEntries();
    const entry = entries[entries.length - 1];
    assert.equal(entry.action, 'write');
    assert.equal(entry.authorized_by, 'restart:preserve-pause');
    assert.equal(entry.authorship_undetermined, 'marker_legacy_no_json');
    assert.equal(entry.auto_liftable, false);
});

// -----------------------------------------------------------------------------
// `--paused` sin pausa previa = pausa NUEVA del operador → humana.
// -----------------------------------------------------------------------------
test('restart --paused sin pausa previa crea una pausa humana no auto-levantable', () => {
    resetFs();
    const res = pp.setFullPause({
        source: 'restart',
        authorizedBy: 'restart:preserve-pause',
        justification: 'restart --paused (pausa nueva solicitada por el operador)',
    });
    assert.equal(res.ok, true);
    assert.equal(res.existedBefore, false);
    assert.equal(res.autoLiftable, false);
    const after = readMarker();
    assert.equal(after.source, 'restart');
    assert.ok(after.ts);
    assert.equal(pp.readFullPauseOrigin().source, 'manual');
});

test('un marker legacy conserva su timestamp original al preservarse', () => {
    resetFs();
    writeMarker('2026-08-02T09:28:00.000Z');
    const res = pp.preserveFullPause();
    assert.equal(res.ok, true);
    const after = readMarker();
    // El ISO plano se rescata como `ts`: el operador sigue viendo desde cuándo
    // está pausado el pipeline, aunque la autoría no se pueda determinar.
    assert.equal(after.ts, '2026-08-02T09:28:00.000Z');
    assert.equal(after.source, 'manual');
    assert.equal(after.undetermined, 'marker_legacy_no_json');
    assert.equal(res.autoLiftable, false);
});

test('un marker legacy ilegible como fecha no inventa un timestamp falso', () => {
    resetFs();
    writeMarker('no soy una fecha');
    const res = pp.preserveFullPause();
    assert.equal(res.ok, true);
    const after = readMarker();
    assert.equal(after.source, 'manual');
    assert.ok(after.ts, 'cae a `now` en vez de quedar sin ts');
    assert.equal(Number.isFinite(Date.parse(after.ts)), true);
    assert.equal(res.autoLiftable, false);
});
