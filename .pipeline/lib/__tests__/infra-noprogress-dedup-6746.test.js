// =============================================================================
// infra-noprogress-dedup-6746.test.js — REGRESIÓN del rebote de `review`.
//
// Qué se rompió (#6746, rechazo en `desarrollo/aprobacion`):
//   El bloque de escalado del barrido hacía `writeFileSync(needsHumanFlag)` y,
//   quince líneas más abajo, un `unlinkSync` del MISMO path — en el mismo tick
//   síncrono, sin guarda. Resultado: `yaEscalado` era SIEMPRE `false` y el
//   escalado por no-progreso re-notificaba (label + comentario en GitHub +
//   Telegram) en cada barrido que volviera a ver los mismos work-files.
//
// Qué fija este archivo (lo que pidió textualmente el rechazo):
//   "un test que corra dos ticks seguidos y asserte que el segundo NO vuelve a
//    escalar".
//
// A diferencia de los tests estructurales de `infra-noprogress.test.js` (que
// hacen regex sobre el fuente y por eso NO detectaron el bug), acá se ejecutan
// las MISMAS funciones de `pulpo.js` que corren en producción, sobre un tmpdir
// aislado vía `PIPELINE_DIR_OVERRIDE`.
//
// node --test
// =============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// El override tiene que estar ANTES del require: `PIPELINE` se congela al
// cargar el módulo. Sin esto los flags irían al `.pipeline/` real.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'noprogreso-dedup-'));
process.env.PIPELINE_DIR_OVERRIDE = TMP;
process.env.PULPO_NO_AUTOSTART = '1';

const { test } = require('node:test');
const assert = require('node:assert');

const pulpo = require('../../pulpo.js');
const noprogress = require('../infra-noprogress');

const {
    claimEscaladoHumano,
    claimEscaladoNotice,
    noprogresoNoticeFlag,
    limpiarNoprogresoNotices,
    appendInfraNoprogressRecord,
} = pulpo;

const ISSUE = 6746;
const PIPELINE_NAME = 'desarrollo';
const FASE = 'dev';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// Config mínima: `limpiarNoprogresoNotices` sólo necesita enumerar las fases.
const CONFIG = {
    pipelines: {
        desarrollo: { fases: ['dev', 'build', 'verificacion', 'aprobacion', 'entrega'] },
    },
};

/** Directorio `procesado/` de una fase dentro del tmpdir. */
function procesadoDir(fase = FASE) {
    return path.join(TMP, PIPELINE_NAME, fase, 'procesado');
}

/** Estado limpio entre tests: sin flags y sin audit trail. */
function reset() {
    fs.rmSync(path.join(TMP, PIPELINE_NAME), { recursive: true, force: true });
    fs.rmSync(path.join(TMP, 'audit'), { recursive: true, force: true });
    for (const fase of CONFIG.pipelines.desarrollo.fases) {
        fs.mkdirSync(procesadoDir(fase), { recursive: true });
    }
    fs.mkdirSync(path.join(TMP, 'audit'), { recursive: true });
}

/**
 * Un tick del barrido, en el MISMO orden que `pulpo.js`:
 *   1. veredicto del detector (lee el JSONL propiedad del Pulpo)
 *   2. si escala ⇒ claim del derecho a notificar (flag)
 *   3. registro `{kind:"reset"}` que corta el episodio en el audit trail
 * Si no escala, el carril infra appendea el registro del ciclo (como el barrido).
 */
function tick({ diffHash }) {
    const veredicto = noprogress.shouldEscalate({
        pipelineDir: TMP, issue: ISSUE, fase: FASE, diffHash, config: {},
    });
    if (!veredicto.escalar) {
        appendInfraNoprogressRecord({ issue: ISSUE, fase: FASE, diffHash, reboteInfraN: 1 });
        return { escalo: false, notifico: false, ciclos: veredicto.ciclos };
    }
    const { notificar } = claimEscaladoHumano({
        pipelineName: PIPELINE_NAME, fase: FASE, issue: ISSUE, causa: 'noprogreso',
    });
    appendInfraNoprogressRecord({ issue: ISSUE, fase: FASE, diffHash: null, kind: 'reset' });
    return { escalo: true, notifico: notificar, ciclos: veredicto.ciclos };
}

// -----------------------------------------------------------------------------
// EL test del rechazo: dos ticks seguidos, el segundo NO vuelve a escalar.
// -----------------------------------------------------------------------------
test('R1 · dos escalados seguidos del mismo episodio: el 2º NO vuelve a notificar', () => {
    reset();

    // Ciclo 1 — todavía no hay con qué comparar: no escala, sólo registra.
    const t0 = tick({ diffHash: HASH_A });
    assert.strictEqual(t0.escalo, false, 'el primer ciclo no puede escalar (nada que comparar)');

    // Ciclo 2 — mismo hash ⇒ escala Y notifica (es la primera vez del episodio).
    const t1 = tick({ diffHash: HASH_A });
    assert.strictEqual(t1.escalo, true, 'el 2º ciclo con el mismo diff dispara el breaker');
    assert.strictEqual(t1.notifico, true, 'el 1er escalado del episodio sí notifica');
    assert.ok(fs.existsSync(noprogresoNoticeFlag(procesadoDir(), ISSUE)),
        'el flag de dedup tiene que SOBREVIVIR al tick que lo escribió');

    // Ciclo 3 — el archivado del bloque de escalado es best-effort (`try {} catch {}`
    // sobre `moveFile`, y en Windows un lock lo hace fallar callado). Si falla, el
    // barrido siguiente vuelve a ver los mismos work-files y el issue sigue
    // rebotando: se acumula otro ciclo con el MISMO hash.
    const t2 = tick({ diffHash: HASH_A });
    assert.strictEqual(t2.escalo, false, 'el registro {kind:"reset"} puso el contador en cero');

    // Ciclo 4 — el contador volvió a llegar al umbral: el breaker dispara OTRA
    // VEZ dentro del mismo episodio (el issue nunca salió de `needs-human`).
    // Acá es donde el flag hace su trabajo. Con el bug viejo — `writeFileSync` y
    // `unlinkSync` del mismo path en el mismo tick — `yaEscalado` era siempre
    // false y salían un label, un comentario en GitHub y un Telegram DUPLICADOS.
    const t3 = tick({ diffHash: HASH_A });
    assert.strictEqual(t3.escalo, true, 'el breaker vuelve a disparar');
    assert.strictEqual(t3.notifico, false,
        'REGRESIÓN #6746: el 2º escalado del mismo episodio NO puede volver a notificar');
});

test('R1b · el claim es idempotente aunque se lo llame N veces en el mismo episodio', () => {
    reset();
    const llamar = () => claimEscaladoHumano({
        pipelineName: PIPELINE_NAME, fase: FASE, issue: ISSUE, causa: 'noprogreso',
    }).notificar;

    assert.strictEqual(llamar(), true, 'la primera notifica');
    for (let i = 0; i < 5; i++) {
        assert.strictEqual(llamar(), false, `la llamada ${i + 2} no puede volver a notificar`);
    }
});

// -----------------------------------------------------------------------------
// El corte del episodio: JSONL append-only + flag que muere al reentrar.
// -----------------------------------------------------------------------------
test('R2 · el registro {kind:"reset"} corta el contador sin borrar nada del audit trail', () => {
    reset();
    tick({ diffHash: HASH_A });
    const t1 = tick({ diffHash: HASH_A });
    assert.strictEqual(t1.escalo, true);

    const lineas = fs.readFileSync(noprogress.auditFile(TMP), 'utf8').trim().split('\n');
    assert.strictEqual(lineas.length, 2, 'el ciclo previo + el reset: el historial no se pisa');
    assert.strictEqual(JSON.parse(lineas[0]).diff_hash, HASH_A, 'el ciclo previo sigue ahí');
    assert.strictEqual(JSON.parse(lineas[1]).kind, 'reset', 'el corte se marca, no se borra');

    // Tras el reset el contador arranca de cero: aunque el hash siga igual, el
    // breaker necesita `noprogreso_max` ciclos NUEVOS para volver a disparar.
    const post = noprogress.shouldEscalate({
        pipelineDir: TMP, issue: ISSUE, fase: FASE, diffHash: HASH_A, config: {},
    });
    assert.strictEqual(post.escalar, false);
    assert.strictEqual(post.ciclos, 1);
});

test('R3 · CA-PO-3 — escalar → destrabar → reentrar deja el estado limpio y el 2º episodio SÍ notifica', () => {
    reset();

    // Episodio 1: escala y notifica; el 2º disparo del mismo episodio queda mudo.
    tick({ diffHash: HASH_A });
    assert.strictEqual(tick({ diffHash: HASH_A }).notifico, true);
    tick({ diffHash: HASH_A });                                   // re-acumula
    const mudo = tick({ diffHash: HASH_A });
    assert.strictEqual(mudo.escalo, true);
    assert.strictEqual(mudo.notifico, false, 'mudo mientras dura el episodio');

    // El humano quita `needs-human` ⇒ el intake genera un work-file fresco y
    // llama a `limpiarNoprogresoNotices`. Ése es el momento del destrabe.
    const borrados = limpiarNoprogresoNotices(PIPELINE_NAME, ISSUE, CONFIG);
    assert.strictEqual(borrados, 1, 'se limpió el flag de la fase que había escalado');
    assert.ok(!fs.existsSync(noprogresoNoticeFlag(procesadoDir(), ISSUE)));

    // Episodio 2: el breaker vuelve a armarse Y vuelve a notificar.
    tick({ diffHash: HASH_A });
    const t = tick({ diffHash: HASH_A });
    assert.strictEqual(t.escalo, true, 'el 2º episodio también escala');
    assert.strictEqual(t.notifico, true, 'y esta vez SÍ avisa: el flag estaba limpio');
});

test('R3b · la limpieza de reentrada es idempotente y no toca otros issues', () => {
    reset();
    claimEscaladoHumano({ pipelineName: PIPELINE_NAME, fase: FASE, issue: ISSUE, causa: 'noprogreso' });
    claimEscaladoHumano({ pipelineName: PIPELINE_NAME, fase: FASE, issue: 9999, causa: 'noprogreso' });

    assert.strictEqual(limpiarNoprogresoNotices(PIPELINE_NAME, ISSUE, CONFIG), 1);
    assert.strictEqual(limpiarNoprogresoNotices(PIPELINE_NAME, ISSUE, CONFIG), 0, 'idempotente');
    assert.ok(fs.existsSync(noprogresoNoticeFlag(procesadoDir(), 9999)),
        'el flag de otro issue no se toca');

    // Config vacía / rota: no explota (best-effort).
    assert.strictEqual(limpiarNoprogresoNotices(PIPELINE_NAME, ISSUE, {}), 0);
    assert.strictEqual(limpiarNoprogresoNotices(PIPELINE_NAME, ISSUE, null), 0);
    assert.strictEqual(limpiarNoprogresoNotices('inexistente', ISSUE, CONFIG), 0);
});

test('R3c · la limpieza barre la fase que escaló aunque no sea la de entrada', () => {
    reset();
    // El episodio escaló en `build`; el intake reingresa por `dev`. Si la
    // limpieza mirara sólo la fase de entrada, el flag de `build` quedaría vivo
    // para siempre y el próximo escalado de esa fase sería mudo (bug #6755).
    claimEscaladoNotice(noprogresoNoticeFlag(procesadoDir('build'), ISSUE));
    assert.strictEqual(limpiarNoprogresoNotices(PIPELINE_NAME, ISSUE, CONFIG), 1);
    assert.ok(!fs.existsSync(noprogresoNoticeFlag(procesadoDir('build'), ISSUE)));
});

// -----------------------------------------------------------------------------
// No-regresión: la rama `infra_threshold` conserva su flag propio y su conducta.
// -----------------------------------------------------------------------------
test('R4 · las dos causas usan flags distintos y no se pisan entre sí', () => {
    reset();
    const np = claimEscaladoHumano({ pipelineName: PIPELINE_NAME, fase: FASE, issue: ISSUE, causa: 'noprogreso' });
    const it = claimEscaladoHumano({ pipelineName: PIPELINE_NAME, fase: FASE, issue: ISSUE, causa: 'infra_threshold' });

    assert.notStrictEqual(np.flagPath, it.flagPath, 'RIESGO-5: flags separados');
    assert.ok(np.flagPath.endsWith(`.${ISSUE}.noprogreso-notified`));
    assert.ok(it.flagPath.endsWith(`.${ISSUE}.needs-human-notified`));
    assert.strictEqual(np.notificar, true);
    assert.strictEqual(it.notificar, true, 'la rama vieja notifica igual que antes');

    // Y el dedup de cada una es independiente.
    assert.strictEqual(claimEscaladoHumano({ pipelineName: PIPELINE_NAME, fase: FASE, issue: ISSUE, causa: 'infra_threshold' }).notificar, false);
    assert.strictEqual(claimEscaladoHumano({ pipelineName: PIPELINE_NAME, fase: FASE, issue: ISSUE, causa: 'noprogreso' }).notificar, false);

    // La limpieza de reentrada NO toca el flag de la rama vieja (#6755 es su
    // propio issue: acá sólo hay que no empeorarlo).
    limpiarNoprogresoNotices(PIPELINE_NAME, ISSUE, CONFIG);
    assert.ok(fs.existsSync(it.flagPath), 'el flag de infra_threshold sobrevive');
});

test('R5 · CA-7 — si el diff cambia no hay episodio, y por lo tanto tampoco flag', () => {
    reset();
    tick({ diffHash: HASH_A });
    const t = tick({ diffHash: HASH_B });
    assert.strictEqual(t.escalo, false, 'hubo progreso: no escala');
    assert.ok(!fs.existsSync(noprogresoNoticeFlag(procesadoDir(), ISSUE)),
        'sin escalado no se reclama ningún flag');
});

// -----------------------------------------------------------------------------
// Fail-open del claim: si el flag no se puede crear, preferimos avisar de más.
// -----------------------------------------------------------------------------
test('R6 · un flag que no se puede escribir NO deja el escalado mudo', () => {
    reset();
    // Path imposible (el "directorio" padre es un archivo) ⇒ ni EEXIST ni éxito.
    const archivo = path.join(TMP, 'no-soy-un-dir');
    fs.writeFileSync(archivo, 'x');
    assert.strictEqual(claimEscaladoNotice(path.join(archivo, 'sub', '.1.noprogreso-notified')), true,
        'ante un fallo de escritura se notifica: un needs-human mudo es peor que uno repetido');
});

test('R7 · limpieza del tmpdir', () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    assert.ok(!fs.existsSync(TMP));
});
