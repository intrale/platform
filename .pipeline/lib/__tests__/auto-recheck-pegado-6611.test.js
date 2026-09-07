// =============================================================================
// #6611 REBOTE rev-1 — EL PEGADO DEL REAPER DE AUTO-DESTRABE
//
// EL DEFECTO QUE ESTO CIERRA (rechazo de `verificacion`, 2026-08-26). Los tests
// de la primera pasada cubrían el selector puro y `human-block` POR SEPARADO,
// nunca el pegado — y el defecto vivía exactamente ahí: `listBlockedIssues()`
// expone `marker_path`, `unblockIssue()` lee `blocked.file`. El reaper le pasaba
// la entrada del listado tal cual, así que `renameSync(undefined, …)` explotaba,
// el `catch` FABRICABA un archivo vacío en `pendiente/` y los dos `unlinkSync`
// fallaban en silencio. `unblockIssue` igual devolvía `{ok:true}`: marker
// DUPLICADO (`bloqueado-humano/` + `pendiente/`), el issue contado como
// bloqueado para siempre (la contradicción que cerró #6448), y el reaper
// re-destrabándolo en cada tick — 3 avisos de Telegram, 3 comentarios y 3
// `remove-label` por UN solo bloqueo, quemando el techo sin re-bloqueo real.
//
// DIRECCIÓN DEL FAIL. Un marker que no se puede mover es un destrabe que NO
// ocurrió: `unblockIssue` tiene que decir `{ok:false}` y no tocar nada, para que
// río abajo no se saque el label, no se comente y no se queme el techo.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-auto-recheck-pegado-6611-'));
const FASES = { desarrollo: ['dev', 'entrega'] };
for (const [pipe, fases] of Object.entries(FASES)) {
    for (const fase of fases) {
        for (const estado of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
            fs.mkdirSync(path.join(TMP_DIR, '.pipeline', pipe, fase, estado), { recursive: true });
        }
    }
}
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
const hb = require('../human-block');
const core = require('../brazo-desbloqueo-core');

const dir = (pipe, fase, estado) => path.join(TMP_DIR, '.pipeline', pipe, fase, estado);

const PR = 6593;
const HEAD_REF = 'agent/6145-delivery-merge';
const ISSUE = 6145;
const CONTENIDO_MARKER = 'issue: ' + ISSUE + '\nfase: entrega\n';

function resetFs() {
    for (const [pipe, fases] of Object.entries(FASES)) {
        for (const fase of fases) {
            for (const estado of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
                const d = dir(pipe, fase, estado);
                try { for (const f of fs.readdirSync(d)) fs.unlinkSync(path.join(d, f)); } catch { /* vacío */ }
            }
        }
    }
}

/** Marker REAL de bloqueo verificable, con contenido (los markers no son vacíos). */
function sembrarBloqueoVerificable({ issue = ISSUE, skill = 'delivery' } = {}) {
    const file = path.join(dir('desarrollo', 'entrega', 'bloqueado-humano'), issue + '.' + skill);
    fs.writeFileSync(file, CONTENIDO_MARKER);
    fs.writeFileSync(file + '.reason.json', JSON.stringify({
        reason: 'merge frenado por proteccion de rama',
        blocked_at: new Date().toISOString(),
        precondition: {
            type: 'verifiable',
            predicate: {
                kind: 'pr_merge_blocked', pr: PR, head_ref: HEAD_REF,
                observed: { httpStatus: 405, mergeStateStatus: 'BLOCKED', gate: 'branch-protection-other' },
            },
        },
    }));
    return file;
}

const OBS_VERDE = {
    [String(PR)]: {
        state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        statusCheckRollup: [], headRefName: HEAD_REF,
    },
};

/**
 * EL PEGADO REAL, tal cual lo corre `reapVerifiableHumanBlocks` en `pulpo.js`:
 * listar → seleccionar → destrabar. Un tick completo, sin red.
 */
function tick({ observations = OBS_VERDE } = {}) {
    const markers = hb.listBlockedIssues().filter(b =>
        b.precondition && b.precondition.type === 'verifiable'
        && b.precondition.predicate && b.precondition.predicate.kind === 'pr_merge_blocked');
    const { toRelease } = core.selectVerifiableHumanBlocksToRelease({
        markers, observations, counters: {}, maxAutoReleases: 3,
    });
    const resultados = [];
    for (const m of toRelease) {
        // Adaptación `marker_path` → `file`: el fix del rechazo rev-1.
        resultados.push(hb.unblockIssue({
            issue: m.issue, marker: { ...m, file: m.marker_path },
            unlocker: 'auto-recheck', guidance: 'auto',
        }));
    }
    return { candidatos: toRelease.length, resultados };
}

test('un tick del reaper mueve el marker de verdad: sale de bloqueado-humano, entra a pendiente CON su contenido y el .reason.json se borra', () => {
    resetFs();
    const origen = sembrarBloqueoVerificable();

    const { candidatos, resultados } = tick();

    assert.equal(candidatos, 1, 'el selector tiene que proponer el bloqueo verificable');
    assert.equal(resultados[0].ok, true, 'el destrabe tiene que reportar exito');
    assert.equal(fs.existsSync(origen), false, 'el marker NO puede seguir en bloqueado-humano/');
    assert.equal(fs.existsSync(origen + '.reason.json'), false, 'el .reason.json tiene que borrarse');

    const destino = path.join(dir('desarrollo', 'entrega', 'pendiente'), ISSUE + '.delivery');
    assert.equal(fs.existsSync(destino), true, 'el marker tiene que aparecer en pendiente/');
    assert.equal(
        fs.readFileSync(destino, 'utf8'), CONTENIDO_MARKER,
        'el marker re-encolado tiene que conservar su contenido, no ser un archivo fabricado vacio',
    );
});

test('tras el destrabe el issue deja de contarse como bloqueado (sin marker duplicado)', () => {
    resetFs();
    sembrarBloqueoVerificable();

    tick();

    const bloqueados = hb.listBlockedIssues().filter(b => b.issue === ISSUE);
    assert.deepEqual(bloqueados, [], 'listBlockedIssues() no puede seguir contando un issue ya destrabado');
});

test('cuatro ticks seguidos destraban UNA sola vez: el reaper no re-destraba en cada ciclo', () => {
    resetFs();
    sembrarBloqueoVerificable();

    let destrabesOk = 0;
    for (let i = 0; i < 4; i++) {
        const { resultados } = tick();
        destrabesOk += resultados.filter(r => r && r.ok).length;
    }

    assert.equal(destrabesOk, 1, 'UN bloqueo tiene que producir UN destrabe, no uno por tick');
});

test('unblockIssue devuelve ok:false y NO fabrica archivo cuando el marker no trae ruta utilizable', () => {
    resetFs();
    const origen = sembrarBloqueoVerificable();
    const [entrada] = hb.listBlockedIssues();

    // La forma EXACTA del bug: entrada del listado sin `file` ni `marker_path`.
    const res = hb.unblockIssue({
        issue: ISSUE, marker: { ...entrada, file: undefined, marker_path: undefined },
        unlocker: 'auto-recheck', guidance: 'auto',
    });

    assert.equal(res.ok, false, 'sin ruta de marker resoluble el destrabe NO ocurrio');
    const destino = path.join(dir('desarrollo', 'entrega', 'pendiente'), ISSUE + '.delivery');
    assert.equal(fs.existsSync(destino), false, 'no se puede fabricar un marker vacio en pendiente/');
    assert.equal(fs.existsSync(origen), true, 'el marker original tiene que quedar intacto');
});

test('unblockIssue acepta `marker_path` como ruta del marker (defensa del pegado)', () => {
    resetFs();
    const origen = sembrarBloqueoVerificable();
    const [entrada] = hb.listBlockedIssues();

    const res = hb.unblockIssue({ issue: ISSUE, marker: entrada, unlocker: 'auto-recheck', guidance: 'auto' });

    assert.equal(res.ok, true, 'la entrada de listBlockedIssues() tiene que ser utilizable tal cual');
    assert.equal(fs.existsSync(origen), false, 'el marker se movio de bloqueado-humano/');
    const destino = path.join(dir('desarrollo', 'entrega', 'pendiente'), ISSUE + '.delivery');
    assert.equal(fs.readFileSync(destino, 'utf8'), CONTENIDO_MARKER, 'con su contenido intacto');
});

test('unblockIssue devuelve ok:false si el marker ya no existe en disco (carrera con /unblock manual)', () => {
    resetFs();
    const origen = sembrarBloqueoVerificable();
    const [entrada] = hb.listBlockedIssues();
    fs.unlinkSync(origen);
    try { fs.unlinkSync(origen + '.reason.json'); } catch { /* ya no esta */ }

    const res = hb.unblockIssue({
        issue: ISSUE, marker: { ...entrada, file: entrada.marker_path },
        unlocker: 'auto-recheck', guidance: 'auto',
    });

    assert.equal(res.ok, false, 'marker inexistente => no-op benigno, no un destrabe fantasma');
    const destino = path.join(dir('desarrollo', 'entrega', 'pendiente'), ISSUE + '.delivery');
    assert.equal(fs.existsSync(destino), false, 'no se fabrica nada en pendiente/');
});

test('dismissBlockedIssue tambien es fail-closed cuando el marker no trae ruta utilizable', () => {
    resetFs();
    const origen = sembrarBloqueoVerificable();
    const [entrada] = hb.listBlockedIssues();

    const res = hb.dismissBlockedIssue({
        issue: ISSUE, marker: { ...entrada, file: undefined, marker_path: undefined },
        reason: 'x', unlocker: 'auto-recheck',
    });

    assert.equal(res.ok, false, 'descartar sin ruta resoluble tiene que fallar, no reportar exito');
    assert.equal(fs.existsSync(origen), true, 'el marker tiene que quedar intacto');
});

test('una lectura fallida del PR no destraba nada: el marker sigue en bloqueado-humano', () => {
    resetFs();
    const origen = sembrarBloqueoVerificable();

    const { candidatos } = tick({ observations: {} });

    assert.equal(candidatos, 0, 'sin observacion del PR no hay candidatos');
    assert.equal(fs.existsSync(origen), true, 'el marker no se mueve');
});
