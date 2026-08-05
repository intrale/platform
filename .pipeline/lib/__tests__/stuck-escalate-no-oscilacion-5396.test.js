// =============================================================================
// stuck-escalate-no-oscilacion-5396.test.js — #5396, causa raíz 3 + riesgo #1
//
// El `escalate` viejo encolaba SÓLO el label `needs-human` y nunca creaba el
// marker físico. Sin marker, `servicio-reconciler.reconcileLabelToFilesystem`
// veía un `needs-human` fantasma, le aplicaba `isNeedsHumanStaleByProgress()`
// (#4222), encolaba `remove-label` ~30s después… y en el tick siguiente el
// reconciler lo volvía a poner. Add/remove en loop, sobre el mismo issue.
//
// Estos tests corren contra el FILESYSTEM REAL (tmpdir) porque el punto es
// justamente que el marker se escriba donde el otro reconciler lo va a buscar.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { reconcileLabelToFilesystem, decidirFasePlaceholder } = require('../../servicio-reconciler');

const CHILD = path.join(__dirname, '_stuck-escalate-child-5396.js');

/**
 * Monta un repo de mentira con un deliverable en `listo/` y corre el escalado
 * real en un proceso hijo (ver el worker: `human-block` fija su root al cargar).
 */
function escalarEnSandbox() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-escalate-5396-'));
    const PIPELINE = path.join(tmpRoot, '.pipeline');
    for (const fase of ['dev', 'verificacion']) {
        for (const st of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
            fs.mkdirSync(path.join(PIPELINE, 'desarrollo', fase, st), { recursive: true });
        }
    }
    fs.mkdirSync(path.join(PIPELINE, 'servicios', 'github', 'pendiente'), { recursive: true });

    // La EVIDENCIA que el detector usa para decidir: no puede desaparecer.
    const deliverable = 'issue: 5209\nfase: verificacion\npipeline: desarrollo\nresultado: rechazado\n';
    fs.writeFileSync(path.join(PIPELINE, 'desarrollo', 'verificacion', 'listo', '5209.qa'), deliverable);

    const r = spawnSync(process.execPath, [CHILD, tmpRoot], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmpRoot, PIPELINE_REPO_ROOT: tmpRoot },
    });
    assert.equal(r.status, 0, `worker falló: ${r.stderr || r.stdout}`);
    const res = JSON.parse(r.stdout);
    assert.ok(res.ok, `worker abortó: ${res.error}`);
    return { res, tmpRoot, deliverable };
}

/**
 * Nombre del marker que `escalate` DEBE plantar, DERIVADO del sandbox.
 *
 * #5396 rev-1 — el marker dejó de ser el skill sintético `<issue>.reconciler` y
 * pasa a ser un skill DESPACHABLE, validado contra `skills_por_fase[fase]` (la
 * misma lista que usa el invariante skill∈fase de `pulpo.js`). El worker escala
 * SIN imputar skills (`meta.skills` vacío), así que la regla que aplica es el
 * fallback determinista documentado en `escalate`: el PRIMER skill de la fase.
 *
 * Se deriva en vez de hardcodear para que el test exprese el CONTRATO y no un
 * literal: si el sandbox cambia sus `skills_por_fase`, el test sigue siendo
 * válido en lugar de romperse (o peor, pasar por casualidad).
 */
function markerEsperado(res) {
    const permitidos = res.skillsPorFase || [];
    assert.ok(permitidos.length > 0, 'el sandbox debe declarar skills_por_fase para la fase escalada');
    return `5209.${permitidos[0]}`;
}

test('CA-6 (bloqueante): escalar NO destruye el deliverable de listo/', () => {
    // Riesgo #1 — `reportHumanBlock` mueve el work-item activo (y `listo` está
    // entre los estados activos) salvo que reciba `pipeline` explícito Y
    // `moveFromActive: false`. Sin eso, el escalado se comía la evidencia.
    const { res, deliverable } = escalarEnSandbox();
    assert.deepEqual(res.listo, ['5209.qa'], 'el deliverable sigue en listo/');
    assert.equal(res.listoContenido, deliverable, 'y sigue intacto, no vaciado');
});

test('causa raíz 3: escalar planta el marker físico en bloqueado-humano/', () => {
    const { res } = escalarEnSandbox();
    assert.ok(
        res.bloqueados.includes(markerEsperado(res)),
        `marker ausente: se esperaba ${markerEsperado(res)} en ${JSON.stringify(res.bloqueados)}`,
    );
});

test('CA-5: el label lo encola reportHumanBlock (un solo comando, sin doble)', () => {
    // Riesgo #6 — si sobreviviera el `writeFileSync` manual habría DOS órdenes.
    const { res } = escalarEnSandbox();
    const labels = res.cola.filter((n) => n.includes('needs-human'));
    assert.equal(labels.length, 1, `se esperaba una sola orden de label: ${JSON.stringify(res.cola)}`);
});

test('CA-5: con el marker presente, reconcileLabelToFilesystem SALTEA el issue', () => {
    // Éste es el eslabón que cierra el bucle add/remove: `blockedByIssue` se arma
    // desde `listBlockedIssues()` y el `continue` de la línea 490 evita que
    // `isNeedsHumanStaleByProgress` encole el `remove-label`.
    const { res } = escalarEnSandbox();
    assert.ok(res.listBlocked.some((b) => b.issue === 5209), 'listBlockedIssues() debe verlo');

    const blockedByIssue = new Map();
    for (const b of res.listBlocked) {
        if (!blockedByIssue.has(b.issue)) blockedByIssue.set(b.issue, []);
        blockedByIssue.get(b.issue).push(b);
    }

    const removidos = [];
    const ghIssues = [{ number: 5209, labels: ['Ready', 'needs-human', 'area:pipeline'] }];
    reconcileLabelToFilesystem(ghIssues, blockedByIssue, {
        enqueueLabelRemove: (issue, label) => removidos.push({ issue, label }),
        logStaleOrder: () => { },
    });

    assert.deepEqual(removidos, [], 'no debe encolar remove-label: el bloqueo es real');
});

test('anti-regresión: SIN marker el mismo escenario SÍ encola remove-label (el bug viejo)', () => {
    // Demuestra que el test anterior no pasa por casualidad. El escalado viejo
    // sólo encolaba el label, así que `blockedByIssue` quedaba vacío: acá se
    // reproduce ese estado y el `remove-label` aparece — la otra mitad del par
    // add/remove que el operador veía oscilar en `svc-github.log`.
    //
    // El veredicto de avance físico se inyecta (`globalOrder` + `findFurthest`)
    // para que el caso sea determinístico y la función corte en la rama stale,
    // que hace `continue` SIN escribir placeholders en el filesystem.
    // El orden DEBE contener la fase que elige `decidirFasePlaceholder` para
    // estos labels (definicion/analisis); si no, `placeholderIdx` es -1, el
    // veredicto sale `stale: false` y la función cae a escribir el placeholder
    // en el filesystem real.
    assert.deepEqual(
        decidirFasePlaceholder(['Ready', 'needs-human', 'area:pipeline']),
        { pipeline: 'definicion', phase: 'analisis', skill: 'guru' },
    );
    const globalOrder = [
        { pipeline: 'definicion', phase: 'analisis' },
        { pipeline: 'desarrollo', phase: 'verificacion' },
    ];
    const staleOpts = {
        globalOrder,
        findFurthest: () => 1, // el issue progresó más allá del placeholder
        logStaleOrder: () => { },
    };
    const ghIssues = [{ number: 5209, labels: ['Ready', 'needs-human', 'area:pipeline'] }];

    const sinMarker = [];
    reconcileLabelToFilesystem(ghIssues, new Map(), {
        ...staleOpts,
        enqueueLabelRemove: (issue, label) => sinMarker.push({ issue, label }),
    });
    assert.equal(sinMarker.length, 1, 'sin marker se dispara el remove-label');
    assert.equal(sinMarker[0].issue, 5209);

    const conMarker = [];
    // El `skill` acá es irrelevante para el guard (corta por PRESENCIA de entrada
    // en el mapa), pero se usa `qa` —un skill real de `skills_por_fase`— para no
    // contradecir lo que planta `escalate` desde #5396 rev-1. Un `reconciler`
    // acá describiría un marker que el código ya no genera.
    reconcileLabelToFilesystem(ghIssues, new Map([[5209, [{ issue: 5209, skill: 'qa' }]]]), {
        ...staleOpts,
        enqueueLabelRemove: (issue, label) => conMarker.push({ issue, label }),
    });
    assert.deepEqual(conMarker, [], 'con marker el guard corta antes: se acabó la oscilación');
});

test('CA-4: el escalado es idempotente — el segundo tick no duplica el marker', () => {
    const { res } = escalarEnSandbox();
    // `reportHumanBlock` escribe el marker `<issue>.<skill>` más su artefacto
    // `<marker>.reason.json` (metadata del bloqueo, que `listBlockedIssues`
    // filtra). Sólo contamos markers reales.
    const markers = res.segundaPasada.bloqueados.filter(
        (n) => n.startsWith('5209.') && !n.endsWith('.reason.json'),
    );
    assert.deepEqual(markers, [markerEsperado(res)], 'un marker por (issue, skill), no uno por tick');
    assert.deepEqual(res.segundaPasada.listo, ['5209.qa'], 'el deliverable sobrevive a los dos escalados');
});

test('CA-1: tras escalar, hasNeedsHuman devuelve "marker" y el tick siguiente calla', () => {
    const { res } = escalarEnSandbox();
    assert.equal(res.hasNeedsHumanTrasEscalar, 'marker');
});

test('riesgo #3: el worker aborta si human-block resuelve a otro root', () => {
    // Guarda de seguridad del propio test: nunca debe escribir en el `.pipeline`
    // real. Si `REPO_ROOT` no coincide con el sandbox, el worker sale sin tocar
    // nada y reporta el error.
    const otro = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-otro-root-'));
    const r = spawnSync(process.execPath, [CHILD, path.join(otro, 'inexistente')], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: otro, PIPELINE_REPO_ROOT: otro },
    });
    const res = JSON.parse(r.stdout);
    assert.equal(res.ok, false);
    assert.match(res.error, /REPO_ROOT divergente/);
});
