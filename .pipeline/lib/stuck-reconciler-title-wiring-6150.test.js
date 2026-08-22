'use strict';

// =============================================================================
// #6150 rev-2 — Regresión del CABLEADO del título en el aviso de tareas frenadas.
//
// QUÉ NO ALCANZABA
// -----------------
// `stuck-reconciler-copy.test.js` cubre el copy con un `titleOf` SINTÉTICO
// (`() => 'Título'`). Con eso, los 8 casos que afirman "el título aparece"
// pasaban en verde mientras producción imprimía el número pelado: el defecto no
// estaba en el texto sino en QUÉ FUNCIÓN se le pasaba desde `pulpo.js`.
//
// LA COLISIÓN QUE ESTE ARCHIVO CLAVA
// -----------------------------------
// Los dos predicados leen la MISMA entrada de caché con la MISMA condición de
// frescura, en ramas COMPLEMENTARIAS:
//
//   suppression:'cache'  ⇐ needsHumanSource === 'cache-desconocida'
//                        ⇐ readFreshEntry(issue) es FALSY   (entrada vencida)
//   issueTitle(issue) != null                               (entrada fresca)
//                        ⇐ readFreshEntry(issue) es TRUTHY
//
// ⇒ entrada fresca: hay título pero NO hay aviso.
// ⇒ entrada vencida: hay aviso pero NO hay título.
//
// Por eso los tests de acá cablean el lector REAL (`buildStuckReconcilerDeps`)
// sobre un title-cache de verdad en disco, en el ÚNICO estado en que el aviso
// existe: entrada PRESENTE pero VENCIDA por TTL.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildStuckReconcilerDeps } = require('./stuck-reconciler-deps');
const { buildStuckAlertCopy, selectRealRisk } = require('./stuck-reconciler-copy');
const { DEFAULT_TITLE_CACHE_TTL_MS } = require('./title-cache-freshness');

const HORA = 60 * 60 * 1000;
const ISSUE = 6150;
const TITULO = 'Migrar el alta de negocio a la nueva API';

const CONFIG = {
    pipelines: {
        desarrollo: { fases: ['dev'], skills_por_fase: { dev: ['pipeline-dev'] } },
    },
};

/**
 * Monta un `.pipeline` temporal con un title-cache real y devuelve los deps
 * CABLEADOS DE PRODUCCIÓN (nada de mocks del lector).
 *
 * @param {number} edadMs antigüedad de `fetchedAt` respecto de `nowMs`
 */
function depsConCache(edadMs, nowMs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-6150-'));
    // `fetchedAt` es epoch ms — mismo formato que `.issue-title-cache.json` de
    // producción. Con un ISO string, `needsRefetch` compara contra NaN y toda
    // entrada parece fresca: el defecto se volvería invisible para el test.
    fs.writeFileSync(
        path.join(dir, '.issue-title-cache.json'),
        JSON.stringify({ [ISSUE]: { title: TITULO, state: 'OPEN', labels: [], fetchedAt: nowMs - edadMs } }),
    );
    return buildStuckReconcilerDeps({
        config: CONFIG,
        PIPELINE: dir,
        ROOT: dir,
        pauseFile: path.join(dir, '.paused'),
        ppMode: { mode: 'running' },
        nowMs,
    });
}

const riesgo = (nowMs) => ({
    issue: ISSUE, pipeline: 'desarrollo', fase: 'dev',
    action: 'none', suppression: 'cache', stuckSinceMs: nowMs - 2 * HORA,
});

// -----------------------------------------------------------------------------
// El invariante que hacía muerta la ruta del título
// -----------------------------------------------------------------------------

test('la rama que dispara el aviso es exactamente la rama sin entrada fresca', () => {
    const now = Date.now();
    const vencida = depsConCache(DEFAULT_TITLE_CACHE_TTL_MS + HORA, now);
    const fresca = depsConCache(60 * 1000, now);

    // Entrada vencida ⇒ 'cache-desconocida' ⇒ suppression:'cache' ⇒ hay aviso.
    assert.equal(vencida.hasNeedsHuman(ISSUE), 'cache-desconocida');
    // …y es JUSTO donde el lector fresh-only no tiene nada para dar.
    assert.equal(vencida.issueTitle(ISSUE), null);

    // Entrada fresca ⇒ hay título, pero esta rama NO produce aviso.
    assert.equal(fresca.hasNeedsHuman(ISSUE), false);
    assert.equal(fresca.issueTitle(ISSUE), TITULO);
});

// -----------------------------------------------------------------------------
// CA-3 — el lector de display sí entrega título en el estado que importa
// -----------------------------------------------------------------------------

test('el lector de display devuelve el título con la entrada vencida por TTL', () => {
    const now = Date.now();
    const deps = depsConCache(DEFAULT_TITLE_CACHE_TTL_MS + HORA, now);

    assert.equal(deps.issueTitle(ISSUE), null, 'el fresh-only sigue siendo fresh-only');
    assert.equal(deps.issueTitleForDisplay(ISSUE), TITULO, 'el de display tolera staleness');
});

test('el copy con el lector REAL nombra la tarea, no sólo su número', () => {
    const now = Date.now();
    const deps = depsConCache(DEFAULT_TITLE_CACHE_TTL_MS + HORA, now);
    const risks = selectRealRisk([riesgo(now)]);
    assert.equal(risks.length, 1, 'la decisión clasifica como riesgo real');

    // Cableado REAL: el dep de producción, no un `titleOf` sintético.
    const texto = buildStuckAlertCopy({ risks, nowMs: now, titleOf: deps.issueTitleForDisplay });

    assert.ok(texto.includes(TITULO), `el copy debe nombrar la tarea:\n${texto}`);
    assert.ok(texto.includes(`#${ISSUE}`), 'el número sigue presente como identificador estable');
    assert.ok(
        !/•\s*#6150\s*—/.test(texto),
        `regresión: volvió el número pelado sin título:\n${texto}`,
    );
});

test('sin entrada en la caché el copy sigue sin inventar título', () => {
    const now = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-6150-vacio-'));
    fs.writeFileSync(path.join(dir, '.issue-title-cache.json'), JSON.stringify({}));
    const deps = buildStuckReconcilerDeps({
        config: CONFIG, PIPELINE: dir, ROOT: dir,
        pauseFile: path.join(dir, '.paused'), ppMode: { mode: 'running' }, nowMs: now,
    });

    assert.equal(deps.issueTitleForDisplay(ISSUE), null, 'sin dato, null — nunca un placeholder');
    const texto = buildStuckAlertCopy({ risks: selectRealRisk([riesgo(now)]), nowMs: now, titleOf: deps.issueTitleForDisplay });
    assert.ok(texto.includes(`#${ISSUE}`), 'queda el número, que es lo único cierto');
    assert.ok(!texto.includes(TITULO));
});

test('un title-cache ilegible no tumba el aviso', () => {
    const now = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-6150-roto-'));
    fs.writeFileSync(path.join(dir, '.issue-title-cache.json'), '{ esto no es json');
    const deps = buildStuckReconcilerDeps({
        config: CONFIG, PIPELINE: dir, ROOT: dir,
        pauseFile: path.join(dir, '.paused'), ppMode: { mode: 'running' }, nowMs: now,
    });

    assert.equal(deps.issueTitleForDisplay(ISSUE), null);
    assert.doesNotThrow(() => buildStuckAlertCopy({
        risks: selectRealRisk([riesgo(now)]), nowMs: now, titleOf: deps.issueTitleForDisplay,
    }));
});

// -----------------------------------------------------------------------------
// El cableado en sí — lo que ningún test de módulo puede ver
// -----------------------------------------------------------------------------

test('pulpo.js le pasa al aviso el lector de display, no el fresh-only', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'pulpo.js'), 'utf8');
    const llamadas = fuente.match(/emitStuckReconcilerLiveness\([^)]*\)/g) || [];
    const invocaciones = llamadas.filter((l) => !/^emitStuckReconcilerLiveness\(res, agg, titleOf\)$/.test(l));

    assert.ok(invocaciones.length >= 1, 'debe existir al menos un call site');
    for (const call of invocaciones) {
        assert.ok(
            call.includes('issueTitleForDisplay'),
            `regresión de cableado: el aviso se alimenta de un lector fresh-only ⇒ título siempre nulo.\n  ${call}`,
        );
    }
});
