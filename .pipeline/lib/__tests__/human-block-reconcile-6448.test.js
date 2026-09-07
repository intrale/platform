// =============================================================================
// #6448 grupo E — SIN DOBLE CANDADO NI MARKERS HUÉRFANOS (punto 4 del issue)
//
// EL INCIDENTE (2026-08-24). #6431 fue frenado a las 13:29:23Z por el gate de
// decisión de arquitectura en `definicion`. A las 13:43:44Z el MISMO issue se
// volvió a bloquear en la fase `sizing`, esta vez con motivo "Label needs-human
// aplicado en GitHub" — o sea, por el label que había puesto el PRIMER bloqueo.
// Dos markers independientes sobre la misma causa: el operador ve el issue
// frenado dos veces, y al destrabar uno queda huérfano y el issue no vuelve al
// despacho.
//
// DIRECCIÓN DEL FAIL. Esta ruta QUITA FRENOS. Un bug de clasificación acá no
// ensucia el tablero: libera issues que un humano frenó a propósito. Por eso
// DESCARTAR es la excepción y CONSERVAR el trabajo es el default (CA-26).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar PIPELINE_DIR en un tmpdir ANTES de cargar el lib: `human-block` fija
// su raíz a tiempo de carga. Mismo patrón que `human-block.test.js`.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-reconcile-6448-'));
const FASES = { definicion: ['analisis', 'criterios', 'sizing'], desarrollo: ['dev', 'verificacion'] };
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

/** Config real del pipeline: qué skills existen en cada fase. */
const SKILLS_POR_FASE = {
    definicion: { skills_por_fase: { analisis: ['guru', 'security'], criterios: ['po', 'ux'], sizing: ['po'] } },
    desarrollo: { skills_por_fase: { dev: ['pipeline-dev'], verificacion: ['qa', 'tester'] } },
};

const dir = (pipe, fase, estado) => path.join(TMP_DIR, '.pipeline', pipe, fase, estado);

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

/** Escribe un marker de bloqueo humano con su `.reason.json`. */
function ponerMarker({ pipeline, phase, issue, skill, contenido = '', reason = {} }) {
    const file = path.join(dir(pipeline, phase, 'bloqueado-humano'), `${issue}.${skill}`);
    fs.writeFileSync(file, contenido);
    fs.writeFileSync(`${file}.reason.json`, JSON.stringify({
        issue, skill, phase, pipeline,
        reason: 'motivo', question: '¿pregunta?',
        blocked_at: '2026-08-24T13:29:23Z',
        ...reason,
    }, null, 2));
    return file;
}

const existe = (p) => fs.existsSync(p);

// =============================================================================
// listBlockedMarkers — la base de todo el barrido
// =============================================================================

test('listBlockedMarkers devuelve TODOS los markers, no el primero', () => {
    resetFs();
    ponerMarker({ pipeline: 'definicion', phase: 'analisis', issue: 6431, skill: 'definicion' });
    ponerMarker({ pipeline: 'definicion', phase: 'sizing', issue: 6431, skill: 'po' });
    ponerMarker({ pipeline: 'desarrollo', phase: 'dev', issue: 9999, skill: 'pipeline-dev' });

    const todos = hb.listBlockedMarkers(6431);
    assert.equal(todos.length, 2, 'el defecto era quedarse con el primero');
    assert.deepEqual(todos.map((m) => m.phase).sort(), ['analisis', 'sizing']);
    // Y no se lleva puesto a otro issue.
    assert.equal(hb.listBlockedMarkers(9999).length, 1);

    // `findBlockedMarker` queda intacto: otros call sites dependen de él.
    assert.ok(hb.findBlockedMarker(6431));
});

test('listBlockedMarkers ignora artefactos (.reason.json, .guidance.txt)', () => {
    resetFs();
    const f = ponerMarker({ pipeline: 'definicion', phase: 'analisis', issue: 6431, skill: 'definicion' });
    fs.writeFileSync(`${f}.guidance.txt`, 'orientación');
    assert.equal(hb.listBlockedMarkers(6431).length, 1,
        'un marker con tres artefactos no son cuatro bloqueos');
});

// =============================================================================
// CA-23 — al destrabar no queda NINGÚN marker en NINGUNA fase
// =============================================================================

test('CA-23: reconciliar barre los markers de TODAS las fases y devuelve el trabajo', () => {
    resetFs();
    const m1 = ponerMarker({ pipeline: 'definicion', phase: 'analisis', issue: 6431, skill: 'guru', contenido: 'issue: 6431\n' });
    const m2 = ponerMarker({ pipeline: 'definicion', phase: 'sizing', issue: 6431, skill: 'po', contenido: 'issue: 6431\n' });

    const rec = hb.reconcileBlockedMarkers({
        issue: 6431, unlocker: 'github:label-removed', skillsPorFase: SKILLS_POR_FASE,
    });

    assert.equal(rec.reconciled.length, 2);
    assert.equal(hb.listBlockedMarkers(6431).length, 0, 'CA-23: ningún marker huérfano en ninguna fase');
    assert.ok(!existe(m1) && !existe(m2));
    assert.ok(!existe(`${m1}.reason.json`), 'el `.reason.json` huérfano también se limpia');

    // El issue vuelve a estar disponible para el despacho, con su trabajo.
    assert.ok(existe(path.join(dir('definicion', 'analisis', 'pendiente'), '6431.guru')));
    assert.ok(existe(path.join(dir('definicion', 'sizing', 'pendiente'), '6431.po')));
    assert.deepEqual(rec.reconciled.map((r) => r.action), ['destrabado', 'destrabado']);
});

// =============================================================================
// CA-25 — la comprobación de destino existente se aplica POR CADA MARKER
// =============================================================================

test('CA-25: con dos markers y un destino ocupado, ningún work-file vivo se pisa', () => {
    resetFs();
    // El marker de `analisis` apunta a un destino que YA tiene un work-file
    // vivo: moverlo encima lo reescribiría vacío y destruiría trabajo real.
    const vivo = path.join(dir('definicion', 'analisis', 'pendiente'), '6431.guru');
    fs.writeFileSync(vivo, 'issue: 6431\nfase: analisis\nrebote: true\n');
    const m1 = ponerMarker({ pipeline: 'definicion', phase: 'analisis', issue: 6431, skill: 'guru' });
    const m2 = ponerMarker({ pipeline: 'definicion', phase: 'sizing', issue: 6431, skill: 'po', contenido: 'issue: 6431\n' });

    const rec = hb.reconcileBlockedMarkers({ issue: 6431, skillsPorFase: SKILLS_POR_FASE });

    assert.equal(fs.readFileSync(vivo, 'utf8'), 'issue: 6431\nfase: analisis\nrebote: true\n',
        'el work-file vivo NO puede quedar pisado por un archivo vacío');
    assert.ok(!existe(m1), 'el marker residual se borra');
    assert.ok(!existe(`${m1}.reason.json`));
    // Y el SEGUNDO marker se procesa igual: el bug era cortar en el primero.
    assert.ok(!existe(m2));
    assert.ok(existe(path.join(dir('definicion', 'sizing', 'pendiente'), '6431.po')));

    const acciones = rec.reconciled.map((r) => `${r.phase}:${r.action}`).sort();
    assert.deepEqual(acciones, ['analisis:residuo-eliminado', 'sizing:destrabado']);
});

// =============================================================================
// CA-26 — descartar es FAIL-CLOSED
// =============================================================================

test('A-7: el marker sintético declarado se DESCARTA, no se convierte en work-file', () => {
    resetFs();
    // El gate de decisión de arquitectura escribe un marker vacío con skill
    // `definicion`, que no existe en `skills_por_fase`. "Destrabarlo" fabricaría
    // un work-file `6431.definicion` para un skill inexistente, que se queda
    // dando vueltas para siempre.
    const m = ponerMarker({
        pipeline: 'definicion', phase: 'analisis', issue: 6431, skill: 'definicion',
        contenido: '', reason: { synthetic: true },
    });
    const rec = hb.reconcileBlockedMarkers({ issue: 6431, skillsPorFase: SKILLS_POR_FASE });

    assert.equal(rec.reconciled[0].action, 'descartado');
    assert.ok(!existe(m));
    assert.ok(!existe(path.join(dir('definicion', 'analisis', 'pendiente'), '6431.definicion')),
        'no se fabrica un work-file para un skill que no existe');
});

test('A-7 bis: `reportHumanBlock` declara `synthetic` sólo cuando corresponde', () => {
    resetFs();
    // (1) gate sin work-file activo ⇒ sintético.
    const r1 = hb.reportHumanBlock({
        issue: 7001, skill: 'definicion', phase: 'analisis', pipeline: 'definicion',
        reason: 'motivo', question: '¿pregunta?', moveFromActive: false, skipGithubLabel: true,
    });
    const meta1 = JSON.parse(fs.readFileSync(`${r1.marker_path}.reason.json`, 'utf8'));
    assert.equal(meta1.synthetic, true);

    // (2) con work-file activo que se mueve ⇒ NO sintético (es trabajo real).
    fs.writeFileSync(path.join(dir('desarrollo', 'dev', 'trabajando'), '7002.pipeline-dev'), 'issue: 7002\n');
    const r2 = hb.reportHumanBlock({
        issue: 7002, skill: 'pipeline-dev', phase: 'dev',
        reason: 'motivo', question: '¿pregunta?', skipGithubLabel: true,
    });
    const meta2 = JSON.parse(fs.readFileSync(`${r2.marker_path}.reason.json`, 'utf8'));
    assert.ok(!meta2.synthetic, 'un bloqueo sobre trabajo real nunca es sintético');
    resetFs();
});

test('CA-26: el fallback heurístico exige archivo vacío Y skill inexistente', () => {
    resetFs();
    // Marker legacy (sin `synthetic`), vacío, con skill QUE SÍ EXISTE en la
    // fase: es trabajo real que quedó vacío. Se CONSERVA.
    ponerMarker({ pipeline: 'definicion', phase: 'criterios', issue: 6431, skill: 'po', contenido: '' });
    let rec = hb.reconcileBlockedMarkers({ issue: 6431, skillsPorFase: SKILLS_POR_FASE });
    assert.equal(rec.reconciled[0].action, 'destrabado', 'skill válido ⇒ se conserva el trabajo');
    assert.ok(existe(path.join(dir('definicion', 'criterios', 'pendiente'), '6431.po')));

    resetFs();
    // Marker legacy con CONTENIDO y skill inexistente: hay trabajo adentro. Se
    // CONSERVA. Las dos condiciones, no una.
    ponerMarker({ pipeline: 'definicion', phase: 'criterios', issue: 6432, skill: 'inexistente', contenido: 'issue: 6432\n' });
    rec = hb.reconcileBlockedMarkers({ issue: 6432, skillsPorFase: SKILLS_POR_FASE });
    assert.equal(rec.reconciled[0].action, 'destrabado', 'archivo con contenido ⇒ se conserva el trabajo');

    resetFs();
    // Vacío Y skill inexistente ⇒ recién ahí se descarta.
    ponerMarker({ pipeline: 'definicion', phase: 'criterios', issue: 6433, skill: 'inexistente', contenido: '' });
    rec = hb.reconcileBlockedMarkers({ issue: 6433, skillsPorFase: SKILLS_POR_FASE });
    assert.equal(rec.reconciled[0].action, 'descartado');
});

test('CA-26 fail-closed: sin config resoluble se CONSERVA el trabajo', () => {
    for (const config of [null, undefined, {}, 'no-es-objeto', { otro: {} }]) {
        resetFs();
        ponerMarker({ pipeline: 'definicion', phase: 'criterios', issue: 6434, skill: 'inexistente', contenido: '' });
        const rec = hb.reconcileBlockedMarkers({ issue: 6434, skillsPorFase: config });
        assert.equal(rec.reconciled[0].action, 'destrabado',
            `con skillsPorFase=${JSON.stringify(config)} la duda tiene que conservar el trabajo`);
    }
    resetFs();
});

test('CA-26: el mapa plano de fases también se resuelve', () => {
    resetFs();
    ponerMarker({ pipeline: 'definicion', phase: 'criterios', issue: 6435, skill: 'inexistente', contenido: '' });
    const rec = hb.reconcileBlockedMarkers({ issue: 6435, skillsPorFase: { criterios: ['po', 'ux'] } });
    assert.equal(rec.reconciled[0].action, 'descartado');
});

// =============================================================================
// Robustez del barrido
// =============================================================================

test('el barrido no lanza y sigue con el resto cuando un marker falla', () => {
    resetFs();
    ponerMarker({ pipeline: 'definicion', phase: 'analisis', issue: 6436, skill: 'guru', contenido: 'x' });
    ponerMarker({ pipeline: 'definicion', phase: 'sizing', issue: 6436, skill: 'po', contenido: 'x' });

    // Un `.reason.json` corrupto no puede frenar el barrido entero.
    fs.writeFileSync(path.join(dir('definicion', 'analisis', 'bloqueado-humano'), '6436.guru.reason.json'), '{ roto');

    const rec = hb.reconcileBlockedMarkers({ issue: 6436, skillsPorFase: SKILLS_POR_FASE });
    assert.equal(rec.reconciled.length, 2, 'un fallo aislado no puede dejar el resto sin reconciliar');
    assert.equal(hb.listBlockedMarkers(6436).length, 0);
    resetFs();
});

test('issue sin markers e input basura: no-op sin lanzar', () => {
    resetFs();
    assert.deepEqual(hb.reconcileBlockedMarkers({ issue: 123456 }), { reconciled: [] });
    for (const malo of [undefined, {}, { issue: 'x' }, { issue: -1 }, { issue: 0 }]) {
        assert.deepEqual(hb.reconcileBlockedMarkers(malo), { reconciled: [] });
    }
});

// =============================================================================
// CA-29 — traza de cada destrabe
// =============================================================================

test('CA-29: cada marker reconciliado emite su traza con issue, fase y origen', () => {
    resetFs();
    ponerMarker({ pipeline: 'definicion', phase: 'analisis', issue: 6437, skill: 'guru', contenido: 'x' });
    ponerMarker({ pipeline: 'definicion', phase: 'sizing', issue: 6437, skill: 'po', contenido: 'x' });

    const trazas = [];
    hb.reconcileBlockedMarkers({
        issue: 6437, unlocker: 'github:label-removed', skillsPorFase: SKILLS_POR_FASE,
        io: { appendUnblockAudit: (r) => trazas.push(r) },
    });

    assert.equal(trazas.length, 2, 'una traza por marker, no una por barrido');
    for (const t of trazas) {
        assert.equal(t.issue, 6437);
        assert.equal(t.origin, 'github:label-removed');
        assert.ok(t.pipeline && t.phase && t.skill && t.action);
    }
    assert.deepEqual(trazas.map((t) => t.phase).sort(), ['analisis', 'sizing']);
    resetFs();
});

test('CA-29 bis: una traza que explota no puede frenar el destrabe', () => {
    resetFs();
    ponerMarker({ pipeline: 'definicion', phase: 'analisis', issue: 6438, skill: 'guru', contenido: 'x' });
    hb.reconcileBlockedMarkers({
        issue: 6438, skillsPorFase: SKILLS_POR_FASE,
        io: { appendUnblockAudit: () => { throw new Error('disco lleno'); } },
    });
    assert.equal(hb.listBlockedMarkers(6438).length, 0, 'el destrabe se completó igual');
    resetFs();
});

// =============================================================================
// CA-22 / CA-24 — el cableado en `pulpo.js`
// =============================================================================

const PULPO = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');

test('CA-22: la fase siguiente reconoce el bloqueo vivo y NO crea un segundo marker', () => {
    const rama = PULPO.indexOf('ya tiene bloqueo humano vivo en');
    assert.ok(rama > 0, 'la guarda de un-solo-bloqueo-por-causa tiene que existir');

    const desde = PULPO.lastIndexOf('const noVerificable = veredictoHumano.estado', rama);
    const bloque = PULPO.slice(desde, rama + 600);

    assert.match(bloque, /humanBlock\.listBlockedMarkers\(/,
        'se consulta si YA hay un bloqueo vivo antes de crear otro');
    assert.match(bloque, /if \(!noVerificable\)/,
        'la rama de bloqueo por precaución (#5856) queda intacta y sí escribe su marker');
    assert.match(bloque, /continue;/, 'el work-file NO se mueve: moverlo crearía el segundo marker');

    // La guarda va ANTES de crear el directorio, el `.reason.json` y el rename.
    const guarda = PULPO.indexOf('listBlockedMarkers', desde);
    const creacion = PULPO.indexOf("const blockedDir = path.join(fasePath(pipelineName, fase), 'bloqueado-humano')", desde);
    assert.ok(guarda > 0 && creacion > guarda,
        'reconocer el bloqueo existente va antes de fabricar el segundo');
});

test('CA-24: la reconciliación sólo se dispara por remoción VERIFICADA EN VIVO', () => {
    // Nunca por estado cacheado: la caché de labels tiene TTL de 10 min y un
    // destrabe fantasma revertiría una autorización explícita del operador.
    const ausente = PULPO.indexOf('label needs-human ya removido en GitHub');
    assert.ok(ausente > 0);
    const verificacion = PULPO.lastIndexOf('_verifyHumanBlockLive(issue)', ausente);
    assert.ok(verificacion > 0 && verificacion < ausente,
        'la rama AUSENTE cuelga de la relectura en vivo (#5856)');

    // Se ancla el final en el `catch` de la reconciliación en vez de contar
    // caracteres: una ventana fija se rompe cada vez que el bloque crece, sin
    // que haya regresión real (misma lección que #6012).
    const finReconciliacion = PULPO.indexOf('no se pudo reconciliar el marker', ausente);
    assert.ok(finReconciliacion > ausente, 'el bloque de reconciliación conserva su manejo de error');
    const bloque = PULPO.slice(ausente, finReconciliacion);
    assert.match(bloque, /humanBlock\.reconcileBlockedMarkers\(/);
    assert.match(bloque, /unlocker: 'github:label-removed'/);

    // Y el gate de decisión de arquitectura usa la MISMA relectura en vivo
    // antes de reconciliar, en vez del `continue` seco que cerraba el ciclo.
    const gate = PULPO.indexOf('const veredicto = designDecision.detectDesignDecision(');
    const finGate = PULPO.indexOf('detector de decisión de arquitectura falló', gate);
    const bloqueGate = PULPO.slice(gate, finGate);
    assert.match(bloqueGate, /_verifyHumanBlockLive\(/,
        'el gate no puede reconciliar por caché');
    assert.match(bloqueGate, /reconcileBlockedMarkers\(/,
        'el gate destraba el marker que él mismo puso, en vez de saltarlo para siempre');
});
