// =============================================================================
// operational-state-fail-closed-5113.test.js — CA-A7 / SEC-6 (#5113)
//
// DEGRADACION DEL STORE = DENEGAR. NUNCA VOLVER AL ARCHIVO LOCAL.
//
// Por que este test existe y por que es bloqueante
// ------------------------------------------------
// El fallback a filesystem es la "mejora" que cualquiera agregaria de buena fe
// la primera vez que el store timeoutea en produccion: "si DynamoDB no responde,
// leemos `.partial-pause.json` y seguimos". Ese parche resucita la ola anterior.
//
// Una allowlist local stale NO es un dato viejo: es una AUTORIZACION REVOCADA
// QUE VUELVE A ESTAR VIGENTE. El archivo del host guarda los issues que alguna
// vez estuvieron habilitados; si el gate cae ahi cuando el store degrada, el
// pipeline despacha agentes sobre trabajo que el operador ya saco de la ola —
// justo en el momento en que nadie esta mirando porque hay un incidente de red.
//
// Por eso la asercion central de la suite no es "devolvio false": es CERO
// LECTURAS del archivo local en ese camino, demostradas espiando `fs`. Un test
// que solo mirara el valor devuelto pasaria igual con un fallback que leyera el
// archivo y resultara vacio en el tmpdir del test.
//
// Lo que SI sigue siendo filesystem (D-3 / SEC-7): `.paused`, el halt total. Es
// el freno de ultimo recurso y el mecanismo de aborto del cutover. La suite lo
// usa ademas como CONTROL POSITIVO del espia: si el espia no viera ni siquiera
// el `.paused`, "cero lecturas del marker" no probaria nada.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/operational-state-fail-closed-5113.test.js
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
const WAVES = 'waves.json';

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
        opState: require('../operational-state'),
    };
    /* eslint-enable global-require */
}

/**
 * Corre `fn(dir)` con un tmpdir propio y el entorno AISLADO por `withEnv`
 * (#6258): las variables se restauran pase lo que pase, asi que el resultado de
 * un test no depende del orden en que corrio ni del entorno del proceso que lo
 * lanza. `undefined` BORRA la variable — es como se pide "ausente".
 *
 * El flag de sustrato viaja por `env` y NO se escribe a mano dentro del test:
 * un `process.env` suelto en el cuerpo sobrevive al test que lo escribio y
 * contamina a los que siguen.
 *
 * @param {Object<string, string|undefined>} env
 * @param {(dir: string) => void} fn
 */
function enTmp(env, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-failclosed-5113-'));
    try {
        return withEnv({
            PIPELINE_DIR_OVERRIDE: dir,
            PIPELINE_OPSTATE_DURABLE: undefined,
            PIPELINE_ALLOW_UNSCOPED_DISPATCH: undefined,
            ...env,
        }, () => fn(dir));
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

/**
 * Monta el backend en modo remoto con un driver fake. `failWith` simula la
 * degradacion del store (timeout de red, credenciales, throttling) sin red.
 *
 * El sink de degradacion se inyecta SIEMPRE: sin sink propio el backend
 * cablearia el canal real (`kernel-degradation-alert` + Telegram) desde un test.
 */
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

function errorDeRed() {
    return new Error('ETIMEDOUT: no hubo respuesta de la tabla de coordinacion');
}

/**
 * Deja el estado local con una allowlist que SI autorizaria a `issue`. Es la
 * trampa del test: si el backend degradado cayera al filesystem, el issue
 * revocado volveria a estar habilitado.
 *
 * @returns {string} ruta real del marker (la resuelve el propio modulo, no el test)
 */
function sembrarAllowlistLocalRevocada(partialPause, issue) {
    const marker = partialPause._paths().PARTIAL_FILE;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({
        allowed_issues: [issue],
        allowed_skills: ['pipeline-dev'],
        created_at: '1999-01-01T00:00:00.000Z',
        source: 'ola-anterior-ya-cerrada',
    }, null, 2));
    return marker;
}

/**
 * Corre `fn(registro)` espiando el modulo `fs` COMPARTIDO por el backend y por
 * `partial-pause` (`require('fs') === require('node:fs')`: es el mismo objeto,
 * y la resolucion de `fs.readFileSync` ocurre en cada llamada).
 *
 * El conteo es por BASENAME EXACTO, nunca por substring: el lock del marker se
 * llama `.partial-pause.json.lock` y contarlo como lectura del marker seria un
 * falso positivo que volveria inutil la asercion central.
 */
function espiandoFs(fn) {
    const registro = {
        lecturas: new Map(),   // contenido leido
        sondeos: new Map(),    // existencia / metadata
        escrituras: new Map(),
        borrados: new Map(),
    };
    const originales = new Map();

    const anotar = (mapa, p) => {
        const nombre = path.basename(String(p));
        mapa.set(nombre, (mapa.get(nombre) || 0) + 1);
    };
    const envolver = (nombreFn, mapa) => {
        if (typeof fs[nombreFn] !== 'function') return;
        const original = fs[nombreFn];
        originales.set(nombreFn, original);
        fs[nombreFn] = function espia(p, ...resto) {
            anotar(mapa, p);
            return original.call(fs, p, ...resto);
        };
    };

    for (const n of ['readFileSync', 'openSync', 'createReadStream']) envolver(n, registro.lecturas);
    for (const n of ['existsSync', 'statSync', 'lstatSync']) envolver(n, registro.sondeos);
    for (const n of ['writeFileSync', 'appendFileSync']) envolver(n, registro.escrituras);
    for (const n of ['unlinkSync', 'rmSync']) envolver(n, registro.borrados);

    try {
        fn(registro);
    } finally {
        for (const [n, original] of originales) fs[n] = original;
    }
    return registro;
}

/** Asercion central de la suite: el archivo local no se toco de ninguna forma. */
function assertCeroContactoConElArchivo(registro, archivo, etiqueta) {
    for (const [clase, mapa] of Object.entries(registro)) {
        assert.equal(mapa.get(archivo) || 0, 0,
            `${etiqueta}: hubo ${mapa.get(archivo)} ${clase} de \`${archivo}\`. `
            + 'El fallback a filesystem esta PROHIBIDO (CA-A7): una allowlist local stale no es '
            + 'un dato viejo, es una autorizacion revocada que vuelve a estar vigente.');
    }
}

// -----------------------------------------------------------------------------
// Control positivo del espia — sin esto, "cero lecturas" no prueba nada
// -----------------------------------------------------------------------------

test('CONTROL: en modo filesystem el espia SI ve la lectura del marker local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, () => {
    const { backend, partialPause } = freshModules();
    assert.equal(backend.isRemote(), false);
    sembrarAllowlistLocalRevocada(partialPause, 666);

    const registro = espiandoFs(() => {
        assert.equal(partialPause.isIssueAllowed(666), true,
            'en modo filesystem el archivo local ES la fuente de verdad');
    });

    assert.equal((registro.lecturas.get(MARKER) || 0) > 0, true,
        'el espia detecta las lecturas del marker: la asercion de "cero lecturas" es significativa');
}));

// -----------------------------------------------------------------------------
// CA-A7 · El gate deniega y NO cae al archivo local
// -----------------------------------------------------------------------------

test('CA-A7: con el store caido el gate DENIEGA y no lee el archivo local ni una vez', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    const { degradaciones } = montarRemoto(backend, { failWith: errorDeRed() });
    sembrarAllowlistLocalRevocada(partialPause, 666);

    const registro = espiandoFs(() => {
        assert.equal(partialPause.isIssueAllowed(666), false,
            'el issue de la ola anterior NO vuelve a estar autorizado por una caida de red');
    });

    assertCeroContactoConElArchivo(registro, MARKER, 'gate degradado');
    // CONTROL: el `.paused` SI se consulta — el espia estaba mirando de verdad.
    assert.equal((registro.sondeos.get('.paused') || 0) > 0, true,
        'el halt total sigue siendo filesystem (D-3): esa lectura debe existir');
    assert.equal(degradaciones.length > 0, true, 'la degradacion se reporta, no se traga');
}));

test('CA-A7: el gate por skill degrada a su politica de `running` y tampoco mira el archivo local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    montarRemoto(backend, { failWith: errorDeRed() });
    sembrarAllowlistLocalRevocada(partialPause, 666);

    const registro = espiandoFs(() => {
        // ASIMETRIA DELIBERADA DE PRODUCCION (#3680 / #5060): `isSkillAllowed`
        // NO comparte el fail-closed de `isIssueAllowed`. Los skills de esta
        // lista son componentes del control-plane (smoke-test de providers,
        // harnesses de diagnostico) que no consumen backlog, y en `running`
        // deben seguir corriendo. Con el store caido el modo colapsa a
        // `running`, asi que el gate por skill queda PERMISIVO.
        //
        // El test lo fija tal cual es, y demuestra que ese `true` viene de la
        // politica de `running` y NO del archivo local: un skill que no figura
        // en ninguna allowlist tambien pasa.
        assert.equal(partialPause.isSkillAllowed('pipeline-dev'), true);
        assert.equal(partialPause.isSkillAllowed('skill-que-no-figura-en-ninguna-allowlist'), true,
            'el permiso sale de la politica de `running`, no de los allowed_skills del archivo local');
    });

    assertCeroContactoConElArchivo(registro, MARKER, 'gate por skill degradado');
}));

test('CA-A7: la fachada `operational-state` tampoco abre un camino al archivo local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause, opState } = freshModules();
    montarRemoto(backend, { failWith: errorDeRed() });
    sembrarAllowlistLocalRevocada(partialPause, 666);

    const registro = espiandoFs(() => {
        assert.equal(opState.isIssueAllowed(666), false);
    });

    assertCeroContactoConElArchivo(registro, MARKER, 'fachada degradada');
}));

test('CA-A7: el modo degradado cae en `running` (fail-closed), no en la ola local stale', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    montarRemoto(backend, { failWith: errorDeRed() });
    sembrarAllowlistLocalRevocada(partialPause, 666);

    const registro = espiandoFs(() => {
        const modo = partialPause.getPipelineMode();
        assert.equal(modo.mode, 'running',
            'sin allowlist legible el modo es `running`, y en `running` el dispatch DENIEGA (#5060)');
        assert.deepEqual(modo.allowedIssues, [], 'no se hereda un solo issue del archivo local');
        assert.deepEqual(modo.allowedSkills, []);
        assert.equal(modo.source, null, 'ni siquiera la autoria de la ola vieja se filtra');
    });

    assertCeroContactoConElArchivo(registro, MARKER, 'getPipelineMode degradado');
}));

// -----------------------------------------------------------------------------
// CA-A7 · La capa de storage: las cuatro operaciones degradan sin tocar el disco
// -----------------------------------------------------------------------------

test('CA-A7: `readKey` degradado devuelve null y no lee el archivo local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    const { degradaciones } = montarRemoto(backend, { failWith: errorDeRed() });
    sembrarAllowlistLocalRevocada(partialPause, 666);

    let leido;
    const registro = espiandoFs(() => {
        leido = backend.readKeyWithVersion(backend.KEYS.PARTIAL_PAUSE);
    });

    assert.equal(leido.value, null, 'degradacion ⇒ null, nunca el contenido local');
    assert.equal(leido.version, null);
    assert.equal(leido.remote, true, 'sigue declarandose remoto: no hubo cambio de sustrato encubierto');
    assert.equal(leido.degraded, true);
    assert.match(leido.error.message, /ETIMEDOUT/);
    assertCeroContactoConElArchivo(registro, MARKER, 'readKey degradado');

    assert.equal(degradaciones.length, 1);
    assert.equal(degradaciones[0].ctx.stage, 'opstate:read:partial-pause');
    assert.equal(backend.getLastDegradation().stage, 'read:partial-pause');
    assert.equal(backend.describeMode().mode, 'remote', 'la degradacion NO revierte el modo a `fs`');
    assert.equal(backend.describeMode().degraded, true);
}));

test('CA-A7: el registro de olas degradado tampoco vuelve a `waves.json` local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    const { backend } = freshModules();
    montarRemoto(backend, { failWith: errorDeRed() });
    fs.writeFileSync(path.join(dir, WAVES), JSON.stringify({
        version: '1.0',
        meta: { updated_at: '1999-01-01T00:00:00.000Z' },
        active_wave: { wave_number: 1, wave_name: 'Ola vieja' },
        planned_waves: [], archived_waves: [], dependencies: [],
    }));

    let leido;
    const registro = espiandoFs(() => {
        leido = backend.readKeyWithVersion(backend.KEYS.WAVES);
    });

    assert.equal(leido.value, null);
    assert.equal(leido.degraded, true);
    assertCeroContactoConElArchivo(registro, WAVES, 'readKey(waves) degradado');
}));

test('CA-A7: `existsKey` degradado responde false aunque el archivo local exista', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    montarRemoto(backend, { failWith: errorDeRed() });
    const marker = sembrarAllowlistLocalRevocada(partialPause, 666);
    assert.equal(fs.existsSync(marker), true, 'precondicion: el archivo local existe');

    let existe;
    const registro = espiandoFs(() => {
        existe = backend.existsKey(backend.KEYS.PARTIAL_PAUSE);
    });

    assert.equal(existe, false, 'la existencia se decide en el store, no en el disco');
    assertCeroContactoConElArchivo(registro, MARKER, 'existsKey degradado');
}));

test('CA-A7: `writeKey` degradado falla y NO escribe el archivo local como consuelo', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    montarRemoto(backend, { failWith: errorDeRed() });
    const marker = sembrarAllowlistLocalRevocada(partialPause, 666);

    let res;
    const registro = espiandoFs(() => {
        res = backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113], source: 'ola-9.4' });
    });

    assert.equal(res.ok, false, 'la escritura degradada FALLA: el caller se entera');
    assert.equal(res.conflict, undefined, 'no es un conflicto de version: es degradacion');
    assert.match(res.error.message, /ETIMEDOUT/);
    assertCeroContactoConElArchivo(registro, MARKER, 'writeKey degradado');

    // El contenido local sigue siendo el de antes: no hay dos fuentes de verdad
    // ni una escritura "de respaldo" que despues alguien lea como autoritativa.
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).allowed_issues, [666]);
}));

test('CA-A7: `deleteKey` degradado falla y no borra el archivo local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    montarRemoto(backend, { failWith: errorDeRed() });
    const marker = sembrarAllowlistLocalRevocada(partialPause, 666);

    let res;
    const registro = espiandoFs(() => {
        res = backend.deleteKey(backend.KEYS.PARTIAL_PAUSE);
    });

    assert.equal(res.ok, false);
    assert.match(res.error.message, /ETIMEDOUT/);
    assertCeroContactoConElArchivo(registro, MARKER, 'deleteKey degradado');
    assert.equal(fs.existsSync(marker), true, 'el archivo local queda como estaba');
}));

// -----------------------------------------------------------------------------
// CA-A7 / D-3 · Lo unico que sigue viviendo en filesystem es el halt total
// -----------------------------------------------------------------------------

test('CA-A7 / D-3: con el store caido, `.paused` sigue frenando el pipeline desde filesystem', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    montarRemoto(backend, { failWith: errorDeRed() });
    sembrarAllowlistLocalRevocada(partialPause, 666);
    fs.writeFileSync(partialPause._paths().PAUSE_FILE, JSON.stringify({ source: 'manual', ts: new Date().toISOString() }));

    const registro = espiandoFs(() => {
        assert.equal(partialPause.getPipelineMode().mode, 'paused',
            'el freno de ultimo recurso NO depende de que el store responda');
        assert.equal(partialPause.isIssueAllowed(666), false);
    });

    assert.equal((registro.sondeos.get('.paused') || 0) > 0, true, '`.paused` se lee de disco a proposito (D-3)');
    assertCeroContactoConElArchivo(registro, MARKER, 'halt total con store caido');
}));

// -----------------------------------------------------------------------------
// CA-A7 · La degradacion es transitoria: recuperado el store, se sirve el remoto
// -----------------------------------------------------------------------------

test('CA-A7: recuperado el store se vuelve a servir el estado remoto, sin haber tocado el local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend, partialPause } = freshModules();
    const { driver } = montarRemoto(backend, { failWith: errorDeRed() });
    sembrarAllowlistLocalRevocada(partialPause, 666);

    const registro = espiandoFs(() => {
        // 1) Store caido: deniega, y el issue revocado sigue revocado.
        assert.equal(partialPause.isIssueAllowed(666), false);
        assert.equal(backend.getLastDegradation() !== null, true);

        // 2) La red vuelve y el operador declara la ola vigente en el store.
        driver._clearFailure();
        assert.equal(backend.writeKey(backend.KEYS.PARTIAL_PAUSE, {
            allowed_issues: [5113], allowed_skills: ['pipeline-dev'], source: 'ola-9.4',
        }).ok, true);

        // 3) El gate opera de nuevo contra el store: autoriza lo vigente y sigue
        //    denegando lo revocado, que es lo unico que el archivo local traia.
        assert.equal(partialPause.isIssueAllowed(5113), true);
        assert.equal(partialPause.isIssueAllowed(666), false,
            'la recuperacion no resucita la ola vieja del archivo local');
        assert.equal(backend.getLastDegradation(), null, 'una lectura sana limpia el rastro de degradacion');
    });

    assertCeroContactoConElArchivo(registro, MARKER, 'ciclo caida + recuperacion');
}));

test('CA-A7: la degradacion se reporta en CADA operacion afectada (no se silencia tras la primera)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    const { degradaciones } = montarRemoto(backend, { failWith: errorDeRed() });

    backend.readKey(backend.KEYS.PARTIAL_PAUSE);
    backend.readKey(backend.KEYS.WAVES);
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113] });
    backend.deleteKey(backend.KEYS.PARTIAL_PAUSE);

    assert.deepEqual(degradaciones.map((d) => d.ctx.stage), [
        'opstate:read:partial-pause',
        'opstate:read:waves',
        'opstate:write:partial-pause',
        'opstate:delete:partial-pause',
    ], 'cada operacion degradada nombra su etapa: el operador sabe que se rompio');
}));

// =============================================================================
// Rebote rev-5 — el hueco por el que la degradacion se colaba como "ausencia"
// =============================================================================
//
// Los tests de arriba inyectan el fallo como una EXCEPCION del driver, que es
// el camino que el backend ya clasificaba bien. El defecto real era otro y mas
// silencioso: el runner sincrono colapsaba `status === null` (hijo muerto por
// senal) a `code: 0`, o sea EXITO con stdout vacio. Eso llegaba al backend como
// `item: null`, que es "clave ausente" — una condicion legitima que
// explicitamente NO es degradacion. Sin `reportDegradation` no hay causa
// declarada, no hay alerta, y el tablero sigue en verde.
//
// Este test entra por el runner real (con `spawnSync` inyectado), no por el
// fake driver, porque es la unica forma de recorrer el mismo colapso.

test('CA-A7 (E2E): un `aws` muerto por senal se reporta como DEGRADACION, no como clave ausente', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    const infra = require('../provisioner-infra');

    const degradaciones = [];
    backend.setDegradationSink({ onDegraded: (err, ctx) => degradaciones.push({ err, ctx }) });

    // Runner REAL con un `spawnSync` que devuelve exactamente lo que devuelve
    // Node cuando el hijo muere por SIGKILL (OOM-kill del `aws`, CA-C6).
    const { runSync } = infra.createAwsCliRunnerSync(
        { AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
        { spawnSync: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }) },
    );
    backend._setDriverForTests({
        driver: infra.createAwsCliDynamoDriverSync({ runSync }),
        spec: { type: 'dynamodb_table', tableName: 'tabla-fake', keys: [] },
        projectId: PROJECT_ID,
        instanceId: PROJECT_ID,
        atomicUpdate: true,
    });

    const lectura = backend.readKeyWithVersion(backend.KEYS.WAVES);

    assert.equal(lectura.degraded, true,
        'la muerte por senal se leyo como "clave ausente": el pipeline operaria creyendo que NO HAY NINGUNA OLA');
    assert.equal(degradaciones.length, 1,
        'no se reporto degradacion: sin causa declarada el operador no se entera y el chip sigue en verde');
    assert.match(String(degradaciones[0].err.message), /SIGKILL/);
    assert.equal(backend.describeMode().degraded, true,
        'el chip del tablero no reflejaria la caida');
}));

// -----------------------------------------------------------------------------
// Vocabulario de claves: la guarda corre ANTES de bifurcar por sustrato
// -----------------------------------------------------------------------------

test('CA-A8: una clave fuera del vocabulario se rechaza en los DOS sustratos', () => enTmp({}, () => {
    const { backend } = freshModules();
    // Modo filesystem: `fileFor` ya rechazaba.
    assert.throws(() => backend.readKeyWithVersion('clave-inventada'), /desconocida/);

    // Modo remoto: antes NO se validaba — `fileFor` solo corre en el branch
    // local, y `validateRemoteValue` dejaba la cota de bytes en `undefined`
    // para una clave que no conoce, o sea payload SIN COTA (CA-A5 evadido).
    withEnv({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
        montarRemoto(backend);
        for (const op of [
            () => backend.readKeyWithVersion('clave-inventada'),
            () => backend.writeKey('clave-inventada', { a: 1 }, null),
            () => backend.deleteKey('clave-inventada', null),
            () => backend.existsKey('clave-inventada'),
        ]) {
            assert.throws(op, /desconocida/, 'una clave desconocida llego al store remoto');
        }
    });
}));

test('CA-A5: `validateRemoteValue` con clave desconocida aplica la cota MAS RESTRICTIVA, no ninguna', () => {
    const { backend } = freshModules();
    const minima = Math.min(...Object.values(backend.MAX_BYTES_FOR_KEY));
    const gordo = { relleno: 'x'.repeat(minima + 1024) };
    const r = backend.validateRemoteValue('clave-que-no-existe', gordo);
    assert.equal(r.ok, false, 'un payload sin clave conocida quedaba sin cota de bytes');
});

// -----------------------------------------------------------------------------
// CA-A5: la cota PRE-PARSE es por clave, no el maximo global
// -----------------------------------------------------------------------------

test('CA-A5: la cota pre-parse de `partial-pause` es la suya, no la (mas holgada) de `waves`', () => {
    const { backend } = freshModules();
    const capPartial = backend.maxResponseBytesFor(backend.KEYS.PARTIAL_PAUSE);
    const capWaves = backend.maxResponseBytesFor(backend.KEYS.WAVES);
    assert.ok(capPartial < capWaves,
        'con la cota global, un `partial-pause` de cientos de KB se parseaba entero antes de rechazarse');
    // Y la clave sale del SK que arma el propio backend, no de la respuesta.
    const { skFor } = require('../kernel-coordination-store');
    const args = ['get-item', '--table-name', 't', '--key',
        JSON.stringify({ PK: { S: PROJECT_ID }, SK: { S: skFor(backend.KEYS.PARTIAL_PAUSE) } }),
        '--consistent-read'];
    assert.equal(backend.keyFromCliArgs(args), backend.KEYS.PARTIAL_PAUSE);
    // Args sin `--key` ⇒ clave indeterminada ⇒ cota mas restrictiva (fail-closed).
    assert.equal(backend.keyFromCliArgs(['scan']), null);
    assert.equal(backend.maxResponseBytesFor(null), capPartial);
});

// -----------------------------------------------------------------------------
// Memoizacion de la lectura remota: barata SI, pero jamas cachear una caida
// -----------------------------------------------------------------------------

test('perf: la lectura remota se memoiza (N gates en un tick = 1 sola llamada al store)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    const { driver } = montarRemoto(backend);
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1] }, null);

    const antes = driver._calls.filter((c) => c.op === 'getItem').length;
    for (let i = 0; i < 20; i += 1) backend.readKey(backend.KEYS.PARTIAL_PAUSE);
    const nuevas = driver._calls.filter((c) => c.op === 'getItem').length - antes;

    assert.equal(nuevas, 1,
        `20 lecturas en el mismo tick dispararon ${nuevas} llamadas al store: en produccion cada una es un spawnSync BLOQUEANTE`);
}));

test('CA-A7: una lectura DEGRADADA nunca se memoiza (la caida se reintenta, no se congela)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    const { driver } = montarRemoto(backend, { failWith: errorDeRed() });

    for (let i = 0; i < 3; i += 1) {
        assert.equal(backend.readKeyWithVersion(backend.KEYS.WAVES).degraded, true);
    }
    assert.equal(driver._calls.filter((c) => c.failed).length, 3,
        'la degradacion quedo cacheada: extenderia la denegacion mas alla del incidente real');
}));

test('la escritura invalida la memoizacion (nadie lee un valor que acaba de cambiar)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    montarRemoto(backend);
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1] }, null);
    assert.deepEqual(backend.readKey(backend.KEYS.PARTIAL_PAUSE).allowed_issues, [1]);

    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1, 2] }, null);
    assert.deepEqual(backend.readKey(backend.KEYS.PARTIAL_PAUSE).allowed_issues, [1, 2],
        'el gate siguio viendo la allowlist vieja despues de que el operador la cambio');

    backend.deleteKey(backend.KEYS.PARTIAL_PAUSE, null);
    assert.equal(backend.readKey(backend.KEYS.PARTIAL_PAUSE), null,
        'el gate siguio viendo una allowlist borrada');
}));
