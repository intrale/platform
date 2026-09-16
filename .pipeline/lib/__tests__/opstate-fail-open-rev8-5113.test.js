// =============================================================================
// opstate-fail-open-rev8-5113.test.js — Los fail-open que sobrevivieron a rev-7
//
// Este archivo NO cubre "el store remoto se cayó". Eso ya lo cubre
// `operational-state-fail-closed-5113.test.js` y estaba bien. Cubre algo más
// incómodo: los tres caminos por los que la capa de storage nueva se comportaba
// como fail-OPEN **con el flag de cutover APAGADO**, que es el régimen vigente
// hoy en producción (`operational_state.durable: false`).
//
// El origen común de los tres es el mismo malentendido: en modo FILESYSTEM
// `readKeyWithVersion` NUNCA setea `degraded` — reporta el fallo por `error`.
// Todo lo que preguntaba sólo por `degraded` leía un marker ilegible (JSON
// truncado, EBUSY/EPERM transitorio de Windows — la misma razón por la que
// `atomicWriteFile` tiene retry) como "no había allowlist".
//
//   D-1 · `readAllowlistSnapshot()` → `previous: []` sobre un marker corrupto.
//         El gate de autoría de #3625 no veía NINGÚN removal, aceptaba la
//         mutación sin `authorizedBy` y el write pisaba la allowlist entera.
//   D-2 · `setPartialPause([])` reportaba "desactivada" cuando el store había
//         RECHAZADO el borrado (degradación o CAS perdido).
//   D-3 · El gate de SKILLS devolvía `true` ante degradación: una ventana de
//         ola con `allowed_skills` restringido habilitaba TODOS los skills.
//
// Más los adicionales del mismo origen: `readConfig()` cacheando el fallo (un
// flag de cutover que se apaga solo), `writeKey` remoto sin `expectedVersion`,
// `resumeAll` salteándose el gate, y el backup de `saveStateLocked` perdido en
// silencio.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/opstate-fail-open-rev8-5113.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFakeSyncDynamoDriver } = require('./fixtures/fake-sync-dynamo-driver');
const { withEnv } = require('../test-helpers/with-env');

const PROJECT_ID = 'intrale-platform';
const MARKER = '.partial-pause.json';

const MODULES = [
    require.resolve('../operational-state-backend'),
    require.resolve('../partial-pause'),
    require.resolve('../waves'),
    require.resolve('../operational-state'),
    require.resolve('../project-context'),
];

function freshModules() {
    for (const m of MODULES) delete require.cache[m];
    /* eslint-disable global-require */
    return {
        backend: require('../operational-state-backend'),
        partialPause: require('../partial-pause'),
        waves: require('../waves'),
    };
    /* eslint-enable global-require */
}

function enTmp(env, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-rev8-5113-'));
    try {
        return withEnv({
            PIPELINE_DIR_OVERRIDE: dir,
            PIPELINE_OPSTATE_DURABLE: undefined,
            PIPELINE_ALLOW_UNSCOPED_DISPATCH: undefined,
            // El gate de autoría en modo STRICT es lo que estos tests ejercitan:
            // en grace el rechazo se degrada a warning y D-1 no sería visible.
            PIPELINE_ALLOWLIST_STRICT_GATE: '1',
            ...env,
        }, () => fn(dir));
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

function markerPath(dir) { return path.join(dir, MARKER); }

/** Marker con allowlist real y legible. Es el estado "antes" de cada carrera. */
function sembrarMarkerSano(dir, issues) {
    fs.writeFileSync(markerPath(dir), JSON.stringify({
        allowed_issues: issues,
        allowed_skills: ['pipeline-dev'],
        created_at: '2026-09-09T10:00:00.000Z',
        source: 'ola-9.4',
    }, null, 2));
}

/**
 * Deja el marker ILEGIBLE con contenido a medio escribir. No es un caso
 * hipotético: es lo que queda en disco si el proceso muere entre el `write` y
 * el `rename`, o si otro proceso tiene el archivo tomado en Windows.
 */
function corromperMarker(dir) {
    fs.writeFileSync(markerPath(dir), '{"allowed_issues":[5113,5114,');
}

function montarRemoto(backend, { failWith = null } = {}) {
    const driver = createFakeSyncDynamoDriver({ failWith });
    const degradaciones = [];
    backend.setDegradationSink({ onDegraded: (err, ctx) => degradaciones.push({ err, ctx }) });
    backend._setDriverForTests({
        driver,
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: PROJECT_ID,
        instanceId: PROJECT_ID,
        atomicUpdate: true,
    });
    return { driver, degradaciones };
}

// =============================================================================
// D-1 · Un marker ilegible NO es una allowlist vacía
// =============================================================================

test('D-1: `readAllowlistSnapshot` degrada ante un marker CORRUPTO en modo filesystem', () => enTmp({}, (dir) => {
    const { backend, partialPause } = freshModules();
    assert.equal(backend.isRemote(), false, 'el test debe correr en el régimen vigente (filesystem)');

    corromperMarker(dir);

    // El canal por el que llega el fallo en modo filesystem es `error`, NUNCA
    // `degraded`. Se fija acá porque es la premisa que hacía fallar a D-1: si
    // esto alguna vez cambia, el fix de abajo deja de ser necesario y el test
    // que lo detecta es este.
    const raw = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(raw.degraded, false, 'en modo filesystem `degraded` es SIEMPRE false');
    assert.ok(raw.error, 'el fallo viaja por `error`');
    assert.equal(raw.value, null);

    const snap = partialPause.readAllowlistSnapshot();
    assert.equal(snap.degraded, true, 'un marker ilegible se estaba leyendo como "no había allowlist"');
    assert.deepEqual(snap.previous, [], 'no se inventa un previous');
    assert.equal(snap.expectedVersion, null,
        'sin lectura confiable NO hay versión que condicionar: `0` habría significado create-once');
}));

test('D-1: la ausencia legítima del marker NO se confunde con degradación', () => enTmp({}, () => {
    const { partialPause } = freshModules();
    // Sin marker en disco: es el estado normal pre-ola, no un fallo.
    const snap = partialPause.readAllowlistSnapshot();
    assert.equal(snap.degraded, false, 'ENOENT es ausencia confirmada, no degradación');
    assert.deepEqual(snap.previous, []);
    assert.equal(snap.expectedVersion, 0, 'create-once: "esperaba que NO existiera"');
}));

test('D-1: con el marker corrupto, una mutación SIN authorizedBy NO lo pisa', () => enTmp({}, (dir) => {
    const { partialPause } = freshModules();
    sembrarMarkerSano(dir, [5113, 5114]);
    const bytesAntes = fs.readFileSync(markerPath(dir), 'utf8');
    corromperMarker(dir);
    const bytesCorruptos = fs.readFileSync(markerPath(dir), 'utf8');

    // El caso peligroso EXACTO: un caller sin autoría propone una lista que
    // remueve issues. Con `previous: []` el gate no veía removals y dejaba
    // pasar la escritura; la allowlist entera se perdía y el audit registraba
    // "sin cambios".
    const res = partialPause.setPartialPause([9999], { source: 'caller-sin-autoria' });

    assert.equal(res.ok, false, 'la mutación se aplicó sobre un estado que no se pudo leer');
    assert.equal(res.degraded, true, 'el motivo debe ser la degradación, no otro rechazo');
    assert.match(res.msg, /degrad/i);
    assert.equal(fs.readFileSync(markerPath(dir), 'utf8'), bytesCorruptos,
        'el marker se PISÓ: el operador perdió la allowlist y encima sin registro del removal');
    assert.notEqual(bytesAntes, bytesCorruptos, 'el fixture no corrompió nada: el test no probó nada');
}));

test('D-1: `clearPartialPause` tampoco borra sobre un marker ilegible', () => enTmp({}, (dir) => {
    const { partialPause } = freshModules();
    corromperMarker(dir);

    const res = partialPause.clearPartialPause({
        source: 'poda', authorizedBy: 'commander:leo', justification: 'fin de ola',
    });

    assert.equal(res.ok, false);
    assert.equal(res.degraded, true);
    assert.equal(fs.existsSync(markerPath(dir)), true,
        'se borró un marker cuyo contenido nadie pudo leer: no hay forma de restaurarlo');
}));

// =============================================================================
// D-2 · Un borrado RECHAZADO no puede reportarse como "desactivada"
// =============================================================================

test('D-2: `setPartialPause([])` propaga el fallo del store en vez de reportar éxito', () => enTmp({}, (dir) => {
    const { backend, partialPause } = freshModules();
    sembrarMarkerSano(dir, [5113]);

    // El store rechaza el borrado por CAS perdido: otra instancia mutó la
    // allowlist entre nuestra lectura y nuestro delete.
    const deleteOriginal = backend.deleteKey;
    backend.deleteKey = () => ({ ok: false, existed: true, conflict: true });
    let res;
    try {
        res = partialPause.setPartialPause([], {
            source: 'poda-convergente',
            authorizedBy: 'commander:leo',
            justification: 'fin de ola',
        });
    } finally {
        backend.deleteKey = deleteOriginal;
    }

    // Los call-sites de esta rama son `pulpo.js` y la poda convergente que
    // causó el incidente #5060: un falso "desactivada" ahí es un freno que se
    // cree aplicado y no lo está.
    assert.equal(res.ok, false, 'el store rechazó el borrado y el caller recibió "desactivada"');
    assert.equal(res.conflict, true, 'el caller necesita distinguir el CAS perdido para reintentar');
    assert.equal(fs.existsSync(markerPath(dir)), true, 'coherente con el rechazo: el marker sigue ahí');
}));

test('D-2: `setPartialPause([])` con el sustrato degradado tampoco reporta éxito', () => enTmp({}, (dir) => {
    const { partialPause } = freshModules();
    corromperMarker(dir);

    const res = partialPause.setPartialPause([], {
        source: 'pulpo', authorizedBy: 'commander:leo', justification: 'limpieza',
    });

    assert.equal(res.ok, false);
    assert.equal(res.degraded, true);
    assert.deepEqual(res.allowedSkills, [], 'el shape de `setPartialPause` se mantiene para los callers');
}));

test('D-2: el camino feliz sigue reportando la desactivación', () => enTmp({}, (dir) => {
    const { partialPause } = freshModules();
    sembrarMarkerSano(dir, [5113]);

    const res = partialPause.setPartialPause([], {
        source: 'poda', authorizedBy: 'commander:leo', justification: 'fin de ola',
    });

    assert.equal(res.ok, true, 'el fix no puede romper el clear legítimo');
    assert.deepEqual(res.allowedIssues, []);
    assert.equal(fs.existsSync(markerPath(dir)), false, 'el marker se borró de verdad');
}));

// =============================================================================
// D-3 · El gate de skills, fail-closed ante degradación (modo filesystem)
// =============================================================================

test('D-3: un marker ilegible DENIEGA los skills (antes los habilitaba a todos)', () => enTmp({}, (dir) => {
    const { partialPause } = freshModules();
    // Ventana de ola que restringe explícitamente los skills habilitados...
    sembrarMarkerSano(dir, [5113]);
    assert.equal(partialPause.isSkillAllowed('pipeline-dev'), true, 'premisa: dentro de la ventana pasa');
    assert.equal(partialPause.isSkillAllowed('qa'), false, 'premisa: fuera de la ventana no pasa');

    // ...y el marker se vuelve ilegible.
    corromperMarker(dir);

    const modo = partialPause.getPipelineMode();
    assert.equal(modo.mode, 'running', 'el enum de `mode` NO cambia: lo consumen ~15 módulos');
    assert.equal(modo.degraded, true, 'la degradación viaja en un campo aditivo');
    assert.equal(partialPause.isSkillAllowed('qa'), false,
        'el skill que la ventana excluía quedaba HABILITADO por la caída del sustrato');
    assert.equal(partialPause.isSkillAllowed('pipeline-dev'), false,
        'ni siquiera el que estaba en la ventana: no se puede afirmar nada del estado');
    assert.equal(partialPause.isIssueAllowed(5113), false, 'el gate de issues ya denegaba, y sigue');
}));

test('D-3: `degraded` deniega issues incluso con el escape hatch prendido', () => enTmp({
    PIPELINE_ALLOW_UNSCOPED_DISPATCH: '1',
}, (dir) => {
    const { partialPause } = freshModules();
    corromperMarker(dir);

    // El hatch existe para dispatchar SIN ola vigente (diagnóstico), no para
    // dispatchar sin saber si hay ola vigente. Con el sustrato caído, el default
    // del hatch sería el backlog histórico entero: el incidente #5060.
    assert.equal(partialPause.isIssueAllowed(999), false,
        'el escape hatch abrió el dispatch sobre un estado ilegible');

    // Contraprueba: sin marker (ausencia CONFIRMADA) el hatch sí abre. Si esto
    // fallara, el test de arriba estaría pasando porque el hatch no funciona.
    fs.rmSync(markerPath(dir));
    const limpio = freshModules();
    assert.equal(limpio.partialPause.isIssueAllowed(999), true,
        'la ausencia confirmada NO es degradación: el hatch sigue siendo el hatch');
}));

test('D-3: `readPartialFileWithState` distingue ausencia de ilegibilidad', () => enTmp({}, (dir) => {
    const { partialPause } = freshModules();

    const ausente = partialPause.readPartialFileWithState();
    assert.equal(ausente.data, null);
    assert.equal(ausente.degraded, false, 'no hay marker: es un hecho, no un fallo');

    corromperMarker(dir);
    const ilegible = partialPause.readPartialFileWithState();
    assert.equal(ilegible.data, null);
    assert.equal(ilegible.degraded, true, 'los dos `null` tienen que poder distinguirse');
    assert.ok(ilegible.error, 'y el motivo tiene que llegar al log/alerta');
}));

// =============================================================================
// `resumeAll` · el chequeo de degradación corre ANTES del gate y de `.paused`
// =============================================================================

test('resumeAll: con el marker ilegible no levanta NADA (ni `.paused`)', () => enTmp({}, (dir) => {
    const { partialPause } = freshModules();
    const pausedFile = partialPause._paths().PAUSE_FILE;
    fs.writeFileSync(pausedFile, JSON.stringify({ source: 'manual', ts: '2026-09-09T10:00:00.000Z' }));
    corromperMarker(dir);

    const res = partialPause.resumeAll({ source: 'operador' });

    // El chequeo estaba DESPUÉS del gate de autoría: con `previous: []` el
    // `if (previous.length > 0)` no entraba y el gate se salteaba entero. O sea
    // que la única situación en la que no se sabe qué se está revocando era
    // también la única en la que nadie pedía autoría.
    assert.equal(res.degraded, true);
    assert.equal(res.removedFull, false, 'se levantó el halt total sin saber qué alcance quedaba vigente');
    assert.equal(res.removedPartial, false);
    assert.equal(fs.existsSync(pausedFile), true, '`.paused` tiene que seguir en pie');
    assert.equal(fs.existsSync(markerPath(dir)), true);
}));

test('resumeAll: con el estado legible sigue levantando ambas pausas', () => enTmp({}, (dir) => {
    const { partialPause } = freshModules();
    const pausedFile = partialPause._paths().PAUSE_FILE;
    fs.writeFileSync(pausedFile, JSON.stringify({ source: 'manual', ts: '2026-09-09T10:00:00.000Z' }));
    sembrarMarkerSano(dir, [5113]);

    const res = partialPause.resumeAll({ source: 'operador', authorizedBy: 'resume:operator' });

    assert.equal(res.removedFull, true, 'el fix no puede romper el /resume legítimo');
    assert.equal(res.removedPartial, true);
    assert.equal(fs.existsSync(pausedFile), false);
    assert.equal(fs.existsSync(markerPath(dir)), false);
}));

// =============================================================================
// `readConfig` · un flag de cutover no se apaga solo
// =============================================================================

test('config ILEGIBLE: no degrada a filesystem en silencio — deniega lectura y escritura', () => enTmp({}, (dir) => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'operational_state:\n  durable: true\n  [[[ yaml roto\n');
    sembrarMarkerSano(dir, [5113]);
    const { backend, partialPause } = freshModules();

    // Antes: `resolve()` tiraba, `readConfig()` se lo tragaba, devolvía `null` y
    // lo CACHEABA. `isRemote()` quedaba en `false` para siempre mientras la
    // flota seguía en remoto: dos fuentes de verdad, y CA-C1 fallando por la
    // puerta de atrás.
    const leido = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(leido.degraded, true, 'con la config ilegible no se sabe cuál es el sustrato');
    assert.equal(leido.error.opstateKind, 'config');
    assert.equal(leido.value, null, 'y NO se sirve el contenido del archivo local como si nada');

    assert.equal(backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1] }, 0).ok, false);
    assert.equal(backend.deleteKey(backend.KEYS.PARTIAL_PAUSE, 0).ok, false);
    assert.equal(partialPause.isIssueAllowed(5113), false, 'los gates denuncian el estado desconocido');
    assert.equal(partialPause.isSkillAllowed('pipeline-dev'), false);
}));

test('config ILEGIBLE: el fallo NO se cachea — cuando la config vuelve, el proceso se entera', () => enTmp({}, (dir) => {
    const cfg = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfg, 'operational_state:\n  durable: true\n  [[[ yaml roto\n');
    const { backend } = freshModules();
    assert.equal(backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE).degraded, true);

    // La config deja de estar rota. Sin restart, sin invalidar nada a mano: es
    // el escenario real de un YAML a medio escribir durante un segundo. Se
    // resuelve QUITÁNDOLA (vuelve a la ausencia legítima pre-cutover) en vez de
    // escribir una válida, para no atar este test al schema completo del
    // resolver — lo que se está probando es que el `error` no quedó memoizado.
    fs.rmSync(cfg);
    sembrarMarkerSano(dir, [5113]);

    const recuperado = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(recuperado.degraded, false, 'el `null` del fallo quedó memoizado hasta el próximo restart');
    assert.deepEqual(recuperado.value.allowed_issues, [5113]);
}));

test('config AUSENTE: es pre-cutover legítimo, no degradación (modo filesystem normal)', () => enTmp({}, (dir) => {
    // Sin `config.yaml`: tmpdirs de test, checkouts recién clonados. Colapsar
    // esto con "ilegible" dejaría el pipeline fail-closed en su estado normal.
    const { backend } = freshModules();
    sembrarMarkerSano(dir, [5113]);

    const leido = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    assert.equal(leido.degraded, false);
    assert.equal(leido.error, null);
    assert.deepEqual(leido.value.allowed_issues, [5113]);
    assert.equal(backend.isRemote(), false);
}));

// =============================================================================
// `writeKey` · el CAS remoto sin `expectedVersion` era un no-op silencioso
// =============================================================================

test('writeKey remoto SIN expectedVersion se rechaza (el CAS se cumplía siempre)', () => enTmp({
    PIPELINE_OPSTATE_DURABLE: '1',
}, () => {
    const { backend } = freshModules();
    montarRemoto(backend);
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1] }, 0);

    // Sin versión, el backend rellenaba el hueco con la que él mismo acababa de
    // leer: la `ConditionExpression` salía pero se cumplía SIEMPRE, y la ventana
    // protegida pasaba a ser `getItem→putItem` (microsegundos, sin carrera real)
    // en vez de la del dominio (`leer previous → evaluar gate → escribir`).
    const res = backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1, 2] });
    assert.equal(res.ok, false, 'un mutador nuevo reintroduce el lost update sin poner un test en rojo');
    assert.equal(res.error.opstateKind, 'cas');
    assert.match(res.error.message, /expectedVersion/);

    // `null` explícito es lo mismo que omitirlo: no es un "no me importa".
    assert.equal(backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1, 3] }, null).ok, false);
}));

test('writeKey: el rollback de emergencia DECLARA su excepción con el centinela', () => enTmp({
    PIPELINE_OPSTATE_DURABLE: '1',
}, () => {
    const { backend } = freshModules();
    montarRemoto(backend);
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1] }, 0);

    // El rollback corre bajo el lock de una transacción que YA falló y tiene que
    // ganar contra la versión que esa misma transacción movió. La excepción es
    // legítima; lo que no era legítimo es que fuera indistinguible de un olvido.
    const res = backend.writeKey(
        backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1, 2] }, backend.UNCONDITIONAL_WRITE,
    );
    assert.equal(res.ok, true);
    assert.equal(backend.readKey(backend.KEYS.PARTIAL_PAUSE).allowed_issues.length, 2);
}));

test('writeKey: en modo filesystem el expectedVersion sigue siendo opcional (sin cambio de conducta)', () => enTmp({}, () => {
    const { backend } = freshModules();
    // `withLockSync` sí excluye entre procesos del MISMO host, que es la única
    // concurrencia que existe pre-cutover. Exigir el CAS acá rompería callers
    // sin ganar nada.
    assert.equal(backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1] }).ok, true);
}));

test('el centinela UNCONDITIONAL_WRITE se usa en UN solo lugar de producción', () => {
    // Guardián de alcance: si el centinela empieza a aparecer en call-sites
    // nuevos deja de ser una excepción declarada y vuelve a ser el default
    // silencioso que este issue vino a cerrar. La lista es explícita a
    // propósito — sumar una entrada tiene que ser una decisión, no un descuido.
    const PERMITIDOS = new Set(['lib/waves.js']);

    const raiz = path.join(__dirname, '..', '..');
    const encontrados = [];
    const recorrer = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (['node_modules', '__tests__', 'tests', '.git', 'logs'].includes(e.name)) continue;
                recorrer(p);
            } else if (e.isFile() && e.name.endsWith('.js') && !e.name.includes('.test.')) {
                const src = fs.readFileSync(p, 'utf8');
                // La definición y el export viven en el propio backend.
                if (p.endsWith(`lib${path.sep}operational-state-backend.js`)) continue;
                if (src.includes('UNCONDITIONAL_WRITE')) {
                    encontrados.push(path.relative(raiz, p).split(path.sep).join('/'));
                }
            }
        }
    };
    recorrer(raiz);

    const inesperados = encontrados.filter((f) => !PERMITIDOS.has(f));
    assert.deepEqual(inesperados, [],
        `el write incondicional aparece en call-sites no declarados: ${inesperados.join(', ')}`);
});

// =============================================================================
// `saveStateLocked` · el respaldo perdido en silencio
// =============================================================================

test('saveState: si el estado previo no se puede LEER, el save avisa en vez de callarse', () => enTmp({}, (dir) => {
    const { waves } = freshModules();
    // `waves.json` presente pero ilegible: es el momento de MÁS riesgo — el
    // sustrato ya está dando problemas y estamos por sobreescribirlo.
    const corrupto = '{ "active_wave": { esto no parsea';
    fs.writeFileSync(path.join(dir, 'waves.json'), corrupto);

    const avisos = [];
    const warnOriginal = console.warn;
    console.warn = (msg) => avisos.push(String(msg));
    try {
        waves._internal.saveState({
            version: '1.0',
            meta: {
                created_at: '2026-09-09T10:00:00.000Z',
                updated_at: '2026-09-09T10:00:00.000Z',
                updated_by: 'test',
                source: 'manual',
            },
            active_wave: null,
            planned_waves: [],
            archived_waves: [],
            dependencies: [],
        }, { updated_by: 'test', source: 'manual' });
    } finally {
        console.warn = warnOriginal;
    }

    // Antes: `readKey()` colapsaba "no había estado previo" con "no lo pude
    // leer", `previousState` quedaba `null`, no se escribía backup y el write
    // seguía adelante SIN UN SOLO LOG. El operador se enteraba recién cuando
    // necesitaba el respaldo y no estaba.
    assert.ok(
        avisos.some((m) => /previo para el backup/i.test(m)),
        `el save sobreescribió sin respaldo y sin avisar. Avisos: ${JSON.stringify(avisos)}`,
    );

    // El save NO se aborta: el backup es defensa en profundidad y frenar el
    // registro de olas por una degradación transitoria sería peor que el riesgo
    // que cubre. Lo que cambia es que deja de ser mudo.
    const escrito = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
    assert.equal(escrito.meta.updated_by, 'test', 'el save legítimo no puede quedar bloqueado');
}));

test('saveState: con el estado previo legible el backup se escribe y no hay aviso', () => enTmp({}, (dir) => {
    const { waves } = freshModules();
    const previo = {
        version: '1.0',
        meta: {
            created_at: '2026-09-09T09:00:00.000Z',
            updated_at: '2026-09-09T09:00:00.000Z',
            updated_by: 'anterior',
            source: 'manual',
        },
        active_wave: null,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    };
    fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(previo, null, 2));

    const avisos = [];
    const warnOriginal = console.warn;
    console.warn = (msg) => avisos.push(String(msg));
    try {
        waves._internal.saveState(
            { ...previo, meta: { ...previo.meta, updated_by: 'test' } },
            { updated_by: 'test', source: 'manual' },
        );
    } finally {
        console.warn = warnOriginal;
    }

    assert.equal(avisos.some((m) => /previo para el backup/i.test(m)), false,
        'el camino sano no puede emitir la alerta de respaldo perdido');
    const archivados = fs.readdirSync(path.join(dir, 'archived')).filter((f) => f.startsWith('waves.'));
    assert.ok(archivados.length >= 1, 'el backup del camino sano dejó de escribirse');
}));
