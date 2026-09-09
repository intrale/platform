// =============================================================================
// operational-state-boot-no-fs-5113.test.js — CA-C1 (#5113, rebote rev-1)
//
// CON EL FLAG DE CUTOVER ENCENDIDO, EL BOOT DEL PULPO NO TOCA EL FILESYSTEM
// PARA LAS CLAVES MIGRADAS.
//
// Por que esta suite existe
// -------------------------
// El primer intento de #5113 migro `lib/waves.js` y `lib/partial-pause.js`, y
// corrio el grep de control del arquitecto — sobre `.pipeline/lib/*.js`. Los
// lectores que faltaban vivian en `.pipeline/scripts/` y en el bootstrap del
// propio `waves.js`, y ademas pedian el path con `_paths()` en vez de escribir
// el literal `'waves.json'`: invisibles para el grep Y para la regla
// `path-level` del guardrail.
//
// Resultado, reproducido por QA con un espia sobre `fs` y el flag en `1`:
//
//   - `ensureWavesFile()` creaba un `waves.json` LOCAL.
//   - `initWavesFromPartial()` leia `waves.json` y `.partial-pause.json` del
//     disco y sembraba una ola que escribia al disco.
//   - `backend.readKey('waves')` devolvia `null`.
//   - el pulpo logueaba "waves.json sembrado" sobre una ola que el pipeline no
//     veia, y la guarda de idempotencia del seeder — que resuelve
//     `hasActiveWave` — quedaba CIEGA en regimen remoto: volvia a sembrar sobre
//     estado ya migrado.
//
// Dos fuentes de verdad simultaneas, que es lo unico que CA-C1 prohibe.
//
// Que asegura esta suite
// ----------------------
// Que el camino de boot COMPLETO (`ensureWavesFile` → `initWavesFromPartial` →
// lectura de alcance de ola del desync-detector) tenga CERO contacto con
// `waves.json` / `.partial-pause.json` en modo remoto, demostrado espiando
// `fs`, y que lo que quede sembrado viva en el store. Un test que solo mirara
// el valor devuelto pasaria igual con un lector local intacto.
//
// El control positivo (modo filesystem) evita el otro falso verde: si el espia
// no viera NADA nunca, "cero contacto" no probaria nada.
//
// Ejecutar:
//   node --test .pipeline/lib/__tests__/operational-state-boot-no-fs-5113.test.js
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
const WAVES = 'waves.json';
const MARKER = '.partial-pause.json';

const MODULES = [
    require.resolve('../operational-state-backend'),
    require.resolve('../partial-pause'),
    require.resolve('../waves'),
    require.resolve('../operational-state'),
    require.resolve('../project-context'),
    require.resolve('../desync-detector'),
    require.resolve('../../scripts/init-waves-from-partial'),
];

function freshModules() {
    for (const m of MODULES) delete require.cache[m];
    /* eslint-disable global-require */
    return {
        backend: require('../operational-state-backend'),
        waves: require('../waves'),
        seeder: require('../../scripts/init-waves-from-partial'),
        desync: require('../desync-detector'),
    };
    /* eslint-enable global-require */
}

function enTmp(env, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstate-boot-5113-'));
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

/** Template versionado en git. NO es estado operativo: no migra, sigue en disco. */
function sembrarTemplate(dir) {
    fs.writeFileSync(path.join(dir, 'waves.json.template'), JSON.stringify({
        version: '1.0',
        meta: { created_at: '2026-01-01T00:00:00.000Z', next_wave_number: 1 },
        active_wave: null,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    }, null, 2));
}

/**
 * Estado LOCAL de una ola vieja. Es la trampa de la suite: si algun camino del
 * boot cayera al filesystem, el issue 9999 — que el operador ya saco de la ola —
 * volveria a sembrarse como ola activa.
 */
function sembrarEstadoLocalViejo(dir) {
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({
        allowed_issues: [9999],
        allowed_skills: ['pipeline-dev'],
        created_at: '1999-01-01T00:00:00.000Z',
        source: 'ola-anterior-ya-cerrada',
        wave_number: 42,
        wave_name: 'Ola fantasma del disco',
    }, null, 2));
    fs.writeFileSync(path.join(dir, WAVES), JSON.stringify({
        version: '1.0',
        meta: { created_at: '1999-01-01T00:00:00.000Z' },
        active_wave: null,
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    }, null, 2));
}

/**
 * Espia el `fs` COMPARTIDO. El conteo es por BASENAME EXACTO: el write atomico
 * pasa por `waves.json.tmp` y contarlo como contacto con `waves.json` seria un
 * falso positivo; contar el `.lock` del marker, tambien.
 */
function espiandoFs(fn) {
    const registro = {
        lecturas: new Map(),
        sondeos: new Map(),
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
    for (const n of ['writeFileSync', 'appendFileSync', 'renameSync']) envolver(n, registro.escrituras);
    for (const n of ['unlinkSync', 'rmSync']) envolver(n, registro.borrados);
    try {
        fn(registro);
    } finally {
        for (const [n, original] of originales) fs[n] = original;
    }
    return registro;
}

function assertCeroContacto(registro, archivo, etiqueta) {
    for (const [clase, mapa] of Object.entries(registro)) {
        assert.equal(mapa.get(archivo) || 0, 0,
            `${etiqueta}: hubo ${mapa.get(archivo)} ${clase} de \`${archivo}\` con el flag de `
            + 'cutover ENCENDIDO. Es la segunda fuente de verdad que CA-C1 prohibe: el pipeline '
            + 'lee el store y este camino lee/escribe el disco.');
    }
}

// -----------------------------------------------------------------------------
// Control positivo — sin esto, "cero contacto" no prueba nada
// -----------------------------------------------------------------------------

test('CONTROL: en modo filesystem el espia SI ve el boot tocando los dos archivos', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '0' }, (dir) => {
    const { waves, seeder } = freshModules();
    sembrarTemplate(dir);
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ allowed_issues: [7001] }, null, 2));

    const registro = espiandoFs(() => {
        waves.ensureWavesFile();
        seeder.initWavesFromPartial({ skipAlert: true });
    });

    const tocado = (a) => (registro.lecturas.get(a) || 0) + (registro.sondeos.get(a) || 0)
        + (registro.escrituras.get(a) || 0);
    assert.ok(tocado(WAVES) > 0, 'el espia no vio el boot tocando waves.json en modo FS');
    assert.ok(tocado(MARKER) > 0, 'el espia no vio el boot leyendo el marker en modo FS');
    assert.equal(fs.existsSync(path.join(dir, WAVES)), true);
}));

// -----------------------------------------------------------------------------
// CA-C1 — el camino de boot completo, con el flag encendido
// -----------------------------------------------------------------------------

test('CA-C1 · `ensureWavesFile` siembra en el STORE, no en un waves.json local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    const { backend, waves } = freshModules();
    montarRemoto(backend);
    sembrarTemplate(dir);

    const registro = espiandoFs(() => {
        const res = waves.ensureWavesFile();
        assert.equal(res.created, true);
        assert.equal(res.reason, 'from-template');
    });

    assertCeroContacto(registro, WAVES, 'ensureWavesFile');
    assert.equal(fs.existsSync(path.join(dir, WAVES)), false,
        'ensureWavesFile creo un waves.json local con el flag encendido');
    assert.notEqual(backend.readKey(backend.KEYS.WAVES), null,
        'el registro de olas no quedo en el store: el bootstrap no sembro nada donde el pipeline mira');
}));

test('CA-C1 · `ensureWavesFile` es idempotente contra el ESTADO REMOTO, no contra el disco', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    const { backend, waves } = freshModules();
    montarRemoto(backend);
    sembrarTemplate(dir);

    assert.equal(waves.ensureWavesFile().created, true);
    const segunda = waves.ensureWavesFile();
    assert.equal(segunda.created, false, 'la segunda pasada volvio a sembrar sobre estado ya migrado');
    assert.equal(segunda.reason, 'exists');
}));

test('CA-C1 · el seeder lee y escribe el STORE: cero contacto con los dos archivos locales', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    const { backend, waves, seeder } = freshModules();
    montarRemoto(backend);
    sembrarTemplate(dir);
    // Trampa: estado local de una ola ya cerrada.
    sembrarEstadoLocalViejo(dir);
    // Estado REAL, el unico que el seeder tiene derecho a ver.
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, {
        allowed_issues: [5113],
        allowed_skills: ['pipeline-dev'],
        created_at: '2026-09-08T00:00:00.000Z',
        source: 'ola-vigente',
    }, backend.UNCONDITIONAL_WRITE);

    let resultado;
    const registro = espiandoFs(() => {
        waves.ensureWavesFile();
        resultado = seeder.initWavesFromPartial({ skipAlert: true });
    });

    assertCeroContacto(registro, WAVES, 'initWavesFromPartial');
    assertCeroContacto(registro, MARKER, 'initWavesFromPartial');

    assert.equal(resultado.action, 'seeded');
    assert.deepEqual(resultado.allowlist, [5113],
        'el seeder sembro la allowlist del DISCO (ola cerrada) en vez de la del store');

    const enElStore = backend.readKey(backend.KEYS.WAVES);
    assert.deepEqual(enElStore.active_wave.issues.map((i) => i.number), [5113]);
    assert.equal(fs.existsSync(path.join(dir, WAVES)) && JSON.parse(fs.readFileSync(path.join(dir, WAVES), 'utf8')).active_wave, null,
        'el waves.json local quedo con la ola sembrada: hay dos fuentes de verdad');
}));

test('CA-C1 · la guarda de idempotencia del seeder resuelve contra el STORE (no re-siembra)', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    const { backend, seeder } = freshModules();
    montarRemoto(backend);
    // Ola ya activa EN EL STORE. En disco, un waves.json vacio — el estado que
    // hacia que la guarda vieja concluyera "no hay ola" y volviera a sembrar.
    sembrarEstadoLocalViejo(dir);
    backend.writeKey(backend.KEYS.WAVES, {
        version: '1.0',
        meta: { created_at: '2026-09-01T00:00:00.000Z', next_wave_number: 11 },
        active_wave: { number: 10, name: 'Ola vigente', goal: 'g', started_at: '2026-09-01T00:00:00.000Z', issues: [{ number: 5113, status: 'in_progress' }] },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    }, backend.UNCONDITIONAL_WRITE);
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113] }, backend.UNCONDITIONAL_WRITE);

    const res = seeder.initWavesFromPartial({ skipAlert: true });
    assert.equal(res.action, 'noop_already_seeded',
        'la guarda de idempotencia quedo ciega en regimen remoto y re-sembro sobre estado migrado');
    assert.equal(res.waveNumber, 10);
    assert.equal(backend.readKey(backend.KEYS.WAVES).active_wave.number, 10);
}));

test('CA-C1 · el alcance de ola del desync-detector sale del STORE', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    const { backend, desync } = freshModules();
    montarRemoto(backend);
    // Disco: ola fantasma con OTROS issues. Si el detector lo leyera, compararia
    // la allowlist efectiva contra estado stale y dispararia un desync falso —
    // con human-block incluido.
    fs.writeFileSync(path.join(dir, WAVES), JSON.stringify({
        version: '1.0',
        active_wave: { number: 42, name: 'fantasma', issues: [{ number: 9999, status: 'in_progress' }] },
    }, null, 2));
    backend.writeKey(backend.KEYS.WAVES, {
        version: '1.0',
        meta: {},
        active_wave: { number: 10, name: 'vigente', goal: 'g', started_at: '2026-09-01T00:00:00.000Z', issues: [{ number: 5113, status: 'in_progress' }] },
        planned_waves: [],
        archived_waves: [],
        dependencies: [],
    }, backend.UNCONDITIONAL_WRITE);

    let alcance;
    const registro = espiandoFs(() => { alcance = desync._internal.readWavesAllowlist(); });

    assertCeroContacto(registro, WAVES, 'desync-detector');
    assert.deepEqual(alcance, [5113],
        'el detector leyo el waves.json local: compara contra una ola que el pipeline no tiene');
}));

// -----------------------------------------------------------------------------
// CA-A7 — degradacion del store: abortar, jamas degradar a filesystem
// -----------------------------------------------------------------------------

test('CA-A7 · con el store caido el boot ABORTA y no cae al estado local', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    const { backend, waves, seeder } = freshModules();
    montarRemoto(backend, { failWith: new Error('ETIMEDOUT: la tabla de coordinacion no respondio') });
    sembrarTemplate(dir);
    sembrarEstadoLocalViejo(dir);

    let bootstrap;
    let resultado;
    const registro = espiandoFs(() => {
        bootstrap = waves.ensureWavesFile();
        resultado = seeder.initWavesFromPartial({ skipAlert: true });
    });

    assertCeroContacto(registro, WAVES, 'boot degradado');
    assertCeroContacto(registro, MARKER, 'boot degradado');

    assert.equal(bootstrap.created, false);
    assert.equal(bootstrap.reason, 'remote-degraded',
        'el bootstrap sembro sobre una lectura fallida: pisaria estado remoto vivo con el template');
    assert.equal(resultado.action, 'aborted_remote_degraded',
        'el seeder no distinguio "el store no responde" de "no hay ola": sembro a ciegas');
    assert.equal(fs.existsSync(path.join(dir, WAVES)) && JSON.parse(fs.readFileSync(path.join(dir, WAVES), 'utf8')).active_wave, null);
}));

// -----------------------------------------------------------------------------
// CA-A4 — el CAS es lo que resuelve la carrera entre instancias
// -----------------------------------------------------------------------------
//
// (rev-6) El test de abajo — dos `initWavesFromPartial` secuenciales — cubre la
// IDEMPOTENCIA del seeder, no el CAS: la segunda llamada corta en la guarda de
// `hasActiveWave` antes de intentar ningun write, asi que el
// `ConditionExpression` nunca se evalua. Se lo renombra a lo que realmente
// prueba y se agregan abajo los dos tests que SI ejercitan el CAS, forzando la
// carrera donde ocurre de verdad: entre el read y el write de `writeKey`.

test('boot idempotente · el seeder no re-siembra sobre una ola ya sembrada', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, (dir) => {
    const { backend, seeder } = freshModules();
    const { driver } = montarRemoto(backend);
    backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [5113] }, backend.UNCONDITIONAL_WRITE);

    // La segunda instancia leyo el estado ANTES de que la primera escribiera:
    // su `expectedVersion` queda stale. Se simula sembrando desde afuera entre
    // la lectura y el write, que es lo que pasa entre dos hosts.
    const primera = seeder.initWavesFromPartial({ skipAlert: true });
    assert.equal(primera.action, 'seeded');
    const versionTrasPrimera = backend.versionOf(backend.KEYS.WAVES);

    const segunda = seeder.initWavesFromPartial({ skipAlert: true });
    assert.equal(segunda.action, 'noop_already_seeded',
        'la segunda instancia re-sembro sobre la ola de la primera');
    assert.equal(backend.versionOf(backend.KEYS.WAVES), versionTrasPrimera,
        'la version del store avanzo: alguien piso el estado sembrado');
    assert.ok(driver._calls.some((c) => c.op === 'putItem'));
}));

// Interpone un efecto ENTRE el `getItem` y el `putItem` de `writeKey`: es el
// unico punto donde la carrera entre dos hosts es observable. Sin esto, dos
// llamadas secuenciales en el mismo proceso jamas colisionan (la segunda lee la
// version que dejo la primera) y el `ConditionExpression` pasa siempre.
function interponerEntreReadYWrite(driver, efecto) {
    const getItemOriginal = driver.getItem.bind(driver);
    let disparado = false;
    driver.getItem = (spec, key) => {
        const res = getItemOriginal(spec, key);
        if (!disparado) { disparado = true; efecto(); }
        return res;
    };
    return () => disparado;
}

test('CA-A4 · create-once: si otra instancia crea la clave entre el read y el write, el segundo NO pisa', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    const { driver } = montarRemoto(backend);
    const SK = require('../kernel-coordination-store').skFor(backend.KEYS.WAVES);

    // La otra instancia gana la carrera justo despues de que nosotros leimos
    // "no existe": nuestro write sale con `attribute_not_exists(#pk)` y pierde.
    const disparo = interponerEntreReadYWrite(driver, () => {
        driver._seed({
            PK: PROJECT_ID,
            SK,
            entityType: 'coordination',
            projectId: PROJECT_ID,
            schemaVersion: require('../kernel-store').SCHEMA_VERSION,
            body: {
                key: backend.KEYS.WAVES,
                value: { active_wave: 'ola-del-ganador', planned_waves: [] },
                version: 1,
                updatedBy: 'otra-instancia',
                updatedAt: Date.now(),
            },
        });
    });

    const res = backend.writeKey(backend.KEYS.WAVES, { active_wave: 'ola-del-perdedor', planned_waves: [] }, backend.UNCONDITIONAL_WRITE);

    assert.equal(disparo(), true, 'el efecto de carrera no se disparo: el test no probo nada');
    assert.equal(res.ok, false, 'el segundo escritor creo la clave igual: el create-once no excluye');
    assert.equal(res.conflict, true, 'la derrota del CAS no se reporto como conflicto');
    assert.equal(
        driver._raw(PROJECT_ID, SK).body.value.active_wave, 'ola-del-ganador',
        'el perdedor de la carrera piso el estado del ganador',
    );
    // El putItem SE intento (y la condicion lo rechazo). Si nunca se intento,
    // el test estaria pasando por una guarda previa y no por el CAS.
    const put = driver._calls.find((c) => c.op === 'putItem');
    assert.ok(put, 'no hubo putItem: el CAS no se ejercito');

    // La condicion de creacion sale del helper COMPARTIDO del coordination
    // store, no de una copia local. Estaba duplicada literal en los dos
    // modulos: dos definiciones del mismo `attribute_not_exists` divergen y una
    // de las dos se queda sin ganador unico.
    assert.deepEqual(
        put.condOpts,
        require('../kernel-coordination-store').buildCreateOnceWriteOptions(),
        'el backend emitio una condicion de creacion propia en vez de la compartida',
    );
}));

test('CA-A4 · lost update: un write con version stale pierde y no pisa al ganador', () => enTmp({ PIPELINE_OPSTATE_DURABLE: '1' }, () => {
    const { backend } = freshModules();
    const { driver } = montarRemoto(backend);
    const SK = require('../kernel-coordination-store').skFor(backend.KEYS.PARTIAL_PAUSE);

    // v1: allowlist inicial.
    const primera = backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1] }, backend.UNCONDITIONAL_WRITE);
    assert.equal(primera.ok, true);
    const versionLeida = primera.version;

    // Otra instancia avanza la version a v2 DESPUES de que nosotros leimos v1.
    const disparo = interponerEntreReadYWrite(driver, () => {
        const actual = driver._raw(PROJECT_ID, SK);
        driver._seed({
            ...actual,
            body: { ...actual.body, value: { allowed_issues: [2] }, version: actual.body.version + 1 },
        });
    });

    // Nuestro write llega con el `expectedVersion` que leimos: stale.
    const segunda = backend.writeKey(backend.KEYS.PARTIAL_PAUSE, { allowed_issues: [1, 999] }, versionLeida);

    assert.equal(disparo(), true, 'el efecto de carrera no se disparo: el test no probo nada');
    assert.equal(segunda.ok, false, 'el write con version stale se aplico: lost update');
    assert.equal(segunda.conflict, true, 'la derrota del CAS no se reporto como conflicto');
    assert.deepEqual(
        driver._raw(PROJECT_ID, SK).body.value.allowed_issues, [2],
        'el escritor stale piso la allowlist del ganador',
    );
}));
