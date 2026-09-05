'use strict';

// =============================================================================
// credential-rotation-e2e.test.js — rotación de credenciales SIN REINICIO,
// end-to-end (#5802 · split de #5793 · paraguas #5440)
//
// QUÉ DEMUESTRA ESTE ARCHIVO Y POR QUÉ NO ALCANZABA CON LOS TESTS QUE YA HAY
// ---------------------------------------------------------------------------
// Cada pieza ya tiene su test unitario y los tres pasan hoy:
//
//   * #5797  caché versionada, `resetVaultCache(scope)` y single-flight
//            → `lib/__tests__/credentials-vault-5353.test.js`
//   * #5798  snapshot aislado por lanzamiento
//            → `lib/__tests__/credentials-snapshot-5798.test.js`
//   * #5794  presupuesto de retry único y fallo cerrado
//            → `lib/__tests__/credential-auth-retry.test.js`
//
// Los tres verdes NO demuestran lo que este issue tiene que demostrar. Un test
// por módulo prueba que cada pieza cumple SU contrato contra un doble de las
// otras dos; la pregunta operativa —"¿una credencial rotada surte efecto sin
// reiniciar el coordinador?"— sólo se responde encadenándolas: el reset tiene
// que invalidar la caché QUE EL SNAPSHOT LEE, y el snapshot re-resuelto tiene
// que traer material que el provider ACEPTE cuando el anterior fue rechazado.
// Si esas tres piezas se desincronizan —un reset que no alcanza la capa que el
// snapshot consulta, un snapshot que se sirve de una memo que el reset no
// tocó— cada test unitario sigue en verde y la rotación en producción no surte
// efecto hasta el restart. Eso es exactamente lo que este archivo cierra.
//
// LA COSTURA ES REAL, NO SIMULADA
// -------------------------------
// Acá NO se duplica caché, generación, clasificador ni presupuesto. Se usan los
// contratos públicos tal cual salen de `main`:
//
//   `resetVaultCache` / `resetVaultCacheAll` / `scopesInvalidables`  (#5797)
//   `createCredentialSnapshot` / `SNAPSHOT_DESTINATIONS`            (#5798)
//   `runWithCredentialRetry` / `createOperation` / `EVENT_FIELDS`   (#5794)
//
// Lo ÚNICO doblado es la frontera del mundo exterior: el driver del vault (el
// almacén remoto) y el spawn del provider (el proceso hijo). Todo lo que está
// entre esas dos fronteras es código de producción.
//
// EL PROVIDER FAKE VALIDA DE VERDAD
// ---------------------------------
// La decisión de diseño que le da valor al archivo: el provider fake NO acepta
// cualquier cosa. Compara el material que le llegó en el snapshot contra la key
// que él considera vigente y rechaza con la señal tipada `authentication_rejected`
// si no coincide. Consecuencia: el camino de retry sólo termina en verde si la
// invalidación acotada REALMENTE sacó el material viejo de la caché y la
// re-resolución REALMENTE trajo el nuevo. Un `invalidate` que no invalida deja
// este archivo en rojo aunque los tres tests unitarios sigan pasando.
//
// EVIDENCIA Y SECRETOS
// --------------------
// La allowlist de evidencia se DERIVA de `EVENT_FIELDS` (#5794), no se copia:
// una segunda lista se desincroniza en el primer campo nuevo y dejaría media
// superficie sin verificar. Los canarios (`CANARIO-…`) se buscan completos Y
// por fragmentos sobre TODO lo que el harness captura: evidencia serializada,
// eventos, excepciones (incluido `stack`) y las capturas de stdout/stderr.
//
// Higiene de fixtures: material sintético con prefijo `FAKE-`; material que
// nunca puede aparecer en un canal auditable con prefijo `CANARIO-`.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sv = require('../lib/secret-vault');
const { buildParameterPath, createInMemoryVaultDriver } = sv;

const cred = require('../lib/credentials');
const {
    createCredentialSnapshot,
    resetVaultCache,
    resetVaultCacheAll,
    scopesInvalidables,
    redactSnapshot,
    SNAPSHOT_DESTINATIONS,
    VAULT_RESET_ERROR_CODES,
} = cred;

const retry = require('../lib/credential-auth-retry');
const {
    runWithCredentialRetry,
    createOperation,
    RETRY_EVENTS,
    CLOSE_REASONS,
    RETRY_ERROR_CODES,
    RETRY_BUDGET,
    EVENT_FIELDS,
    CredentialRetryError,
} = retry;

const { AUTH_REJECTED_CLASS } = require('../lib/agent-launcher/dispatch-with-fallback');

// -----------------------------------------------------------------------------
// Fixtures del vault
// -----------------------------------------------------------------------------

const PREFIX = '/test5802';
const PROJECT = 'kernel';
const HOST = 'hostRotacionE2E';

// El destino de un lanzamiento de agente y su único scope autorizado, leídos
// del catálogo real: un literal acá se desincronizaría del catálogo el día que
// #5798 agregue o mueva un destino.
const DESTINO = 'agent-child';
const SCOPE = SNAPSHOT_DESTINATIONS[DESTINO].scopes[0];
const PROVIDER = 'anthropic';
const ENV_DEL_PROVIDER = 'ANTHROPIC_API_KEY';

function cfg(over = {}) {
    return {
        enabled: true,
        prefix: PREFIX,
        projectId: PROJECT,
        hostId: HOST,
        cache_ttl_seconds: 300,
        required_scopes: [],
        shared_secrets: [],
        max_cached_tenants: 8,
        ...over,
    };
}

/**
 * Material de UNA generación del vault. El valor de la key lleva el número de
 * generación para poder afirmar CUÁL generación llegó al destino sin persistir
 * el valor en ninguna evidencia.
 */
function materialGen(n) {
    return {
        providers: {
            anthropic: { api_key: `CANARIO-anthropic-gen-${n}` },
            openai: { api_key: `CANARIO-openai-gen-${n}` },
        },
        telegram: {
            bot_token: `CANARIO-telegram-bot-gen-${n}`,
            chat_id: 'FAKE-telegram-chat-id',
            // Ancla de autorización del destino `pulpo-telegram` (CA-5 de
            // #5798). Sin ella ese destino falla cerrado con código propio, así
            // que tiene que estar sembrada para poder usarlo como el "ámbito
            // sano" que el reset acotado NO debe tocar.
            leo_operator_chat_id: 'FAKE-leo-operator-chat-id',
        },
    };
}

/** Valor efectivo de la key del provider en una generación dada. */
function keyDeGen(n) {
    return materialGen(n).providers[PROVIDER].api_key;
}

function parametrosDe(material) {
    const parameters = {};
    for (const [scope, valor] of Object.entries(material)) {
        parameters[buildParameterPath({
            prefix: PREFIX, projectId: PROJECT, hostId: HOST, scope, tier: 'host',
        })] = valor;
    }
    return parameters;
}

/**
 * Driver del vault con los tres controles que el in-memory pelado no da:
 *
 *   - `rotar(n)`   reemplaza el material por el de la generación `n`, que es lo
 *                  que hace un operador al rotar en el store remoto;
 *   - `cerrar()` / `abrir()`  puerta async para dejar una lectura EN VUELO y
 *                  meterle un reset en el medio (el camino sync la ignora: no
 *                  puede intercalar dentro de un tick);
 *   - `calls`      contador de lecturas FÍSICAS que sobrevive a la rotación —
 *                  la única forma de distinguir un HIT de caché de una lectura
 *                  real, que es la mitad de lo que este archivo mide.
 */
function driverRotable({ gen = 1, abierta = true } = {}) {
    let base = createInMemoryVaultDriver({ parameters: parametrosDe(materialGen(gen)), secrets: {} });
    let generacion = gen;
    const calls = [];
    let liberar;
    let puerta = new Promise((res) => { liberar = res; });
    if (abierta) liberar();

    return {
        kind: 'rotable',
        calls,
        get generacion() { return generacion; },
        rotar(n) {
            generacion = n;
            base = createInMemoryVaultDriver({ parameters: parametrosDe(materialGen(n)), secrets: {} });
        },
        abrir() { liberar(); },
        cerrar() { puerta = new Promise((res) => { liberar = res; }); },
        getParametersByPathSync(root) {
            calls.push({ op: 'getParametersByPath', root });
            return base.getParametersByPathSync(root);
        },
        getSecretValueSync(name) {
            calls.push({ op: 'getSecretValue', name });
            return base.getSecretValueSync(name);
        },
        async getParametersByPath(root) {
            await puerta;
            calls.push({ op: 'getParametersByPath', root });
            return base.getParametersByPathSync(root);
        },
        async getSecretValue(name) {
            await puerta;
            calls.push({ op: 'getSecretValue', name });
            return base.getSecretValueSync(name);
        },
    };
}

/** Cede el event loop para que un vuelo llegue a la puerta antes del reset. */
async function tick(n = 10) {
    for (let i = 0; i < n; i += 1) await new Promise((res) => setImmediate(res));
}

// -----------------------------------------------------------------------------
// Un LANZAMIENTO: pide su snapshot aislado por la costura pública de #5798.
//
// Esta es la función que el coordinador de retry inyecta como `createSnapshot`,
// así que la re-resolución del retry y el snapshot inicial pasan EXACTAMENTE
// por el mismo camino de producción. Un atajo acá (devolver un objeto armado a
// mano en la re-resolución) invalidaría todo el archivo: el bug que buscamos
// vive justo en esa costura.
// -----------------------------------------------------------------------------
function lanzar(driver, { scope = SCOPE, provider = PROVIDER, now, destination = DESTINO } = {}) {
    return createCredentialSnapshot({
        destination,
        scopes: [scope],
        provider,
        vaultConfig: cfg(),
        vaultDriver: driver,
        logger: () => {},
        now,
    });
}

// -----------------------------------------------------------------------------
// Provider fake que VALIDA. Acepta sólo la key que considera vigente; con
// cualquier otra emite la proyección tipada `authentication_rejected` con la
// misma forma que produce el dispatcher (#5795).
// -----------------------------------------------------------------------------
function providerFake({ keyVigente, operationId = 'op-5802' }) {
    const intentos = [];
    return {
        intentos,
        rotarA(nuevaKey) { keyVigente = nuevaKey; },
        /** Veredicto con la forma de `onSpawnExit`. */
        ejecutar({ snapshot, attempt, provider, path: camino }) {
            const recibida = snapshot && snapshot.env ? snapshot.env[ENV_DEL_PROVIDER] : null;
            const aceptada = recibida === keyVigente;
            intentos.push({ attempt, provider, path: camino, aceptada });
            if (aceptada) return { errorClass: null, authenticationRejection: null, pid: 4000 + attempt };
            return {
                errorClass: 'auth',
                authenticationRejection: Object.freeze({
                    kind: AUTH_REJECTED_CLASS,
                    provider,
                    operationId,
                    path: camino,
                    attempt,
                    signal: Object.freeze({
                        source: 'cli-stream-json',
                        code: 'authentication_error',
                        status: 401,
                        type: null,
                    }),
                }),
            };
        },
    };
}

// -----------------------------------------------------------------------------
// Sink de evidencia con allowlist DERIVADA de `EVENT_FIELDS`.
//
// Se deriva a propósito (la observación del análisis técnico): duplicar la
// lista dejaría que un campo nuevo del coordinador entre a la evidencia sin que
// nadie lo mire. `launch` y `opaque_version` son los DOS campos propios del
// harness — identidad del lanzamiento y de la versión rotada, ninguno derivado
// del material.
// -----------------------------------------------------------------------------
const CAMPOS_PROPIOS_DEL_HARNESS = Object.freeze(['launch_id', 'opaque_version', 'status']);
const ALLOWLIST_EVIDENCIA = Object.freeze([...EVENT_FIELDS, ...CAMPOS_PROPIOS_DEL_HARNESS]);

function sinkDeEvidencia() {
    const eventos = [];
    const registros = [];
    const stdout = [];
    const stderr = [];

    /** Proyecta por la allowlist: lo que no está declarado NO entra. */
    const proyectar = (crudo) => {
        const salida = {};
        for (const campo of ALLOWLIST_EVIDENCIA) {
            if (crudo[campo] !== undefined) salida[campo] = crudo[campo];
        }
        return Object.freeze(salida);
    };

    return {
        eventos,
        registros,
        stdout,
        stderr,
        /** Sink que se le pasa a `runWithCredentialRetry` como `emit`. */
        emit(ev) { eventos.push(ev); registros.push(proyectar(ev)); },
        /** Registro propio del harness (lanzamiento, versión opaca, estado). */
        registrar(crudo) { const r = proyectar(crudo); registros.push(r); return r; },
        capturarStdout(linea) { stdout.push(String(linea)); },
        capturarStderr(linea) { stderr.push(String(linea)); },
        /**
         * TODO lo capturado, serializado en un solo string. Es sobre esto que
         * se busca el canario: si un valor se filtró por cualquiera de los
         * canales, aparece acá.
         */
        serializarTodo(extra = []) {
            const partes = [
                JSON.stringify(registros),
                JSON.stringify(eventos),
                stdout.join('\n'),
                stderr.join('\n'),
            ];
            for (const e of extra) {
                if (e instanceof Error) {
                    partes.push(String(e.message), String(e.stack || ''), JSON.stringify(e, Object.getOwnPropertyNames(e)));
                } else {
                    partes.push(JSON.stringify(e));
                }
            }
            return partes.join('\n');
        },
    };
}

/**
 * Busca un canario COMPLETO y por FRAGMENTOS. Los fragmentos importan tanto
 * como el valor entero: un log que imprime "los primeros 8 caracteres para
 * identificar la key" filtra material igual, sólo que despacio.
 */
function assertSinCanario(texto, valor, contexto) {
    assert.ok(!texto.includes(valor), `${contexto}: aparece el canario COMPLETO "${valor}"`);
    // Fragmentos significativos: la parte discriminante del valor, no el prefijo
    // genérico `CANARIO-` que el propio nombre del fixture repite.
    const cola = valor.slice(-12);
    assert.ok(!texto.includes(cola), `${contexto}: aparece un FRAGMENTO del canario ("${cola}")`);
    const medio = valor.slice(8, 24);
    if (medio.length >= 8) {
        assert.ok(!texto.includes(medio), `${contexto}: aparece un FRAGMENTO del canario ("${medio}")`);
    }
}

// La caché y las generaciones son estado de MÓDULO: cada test arranca en frío
// para que un HIT de otro test no invente (ni tape) una lectura física.
test.beforeEach(() => { resetVaultCacheAll(); });

// =============================================================================
// CA-1 · `resetVaultCache()` invalida todas las capas y una generación vieja no
//        repuebla la nueva
// =============================================================================

test('CA-1 · el ambito del lanzamiento es invalidable segun el inventario real', () => {
    // Si esto falla, todo el resto del archivo estaría probando un scope que el
    // contrato no reconoce — y el fallo real (fail-closed de #5794) quedaría
    // enmascarado por un fixture inventado.
    assert.ok(scopesInvalidables().includes(SCOPE),
        `el scope "${SCOPE}" del destino "${DESTINO}" tiene que estar en scopesInvalidables()`);
});

test('CA-1 · tras rotar y resetear, el lanzamiento siguiente lee material nuevo SIN reiniciar', async () => {
    const d = driverRotable({ gen: 1 });

    const primero = await lanzar(d);
    assert.equal(primero.env[ENV_DEL_PROVIDER], keyDeGen(1));
    assert.equal(d.calls.length, 1, 'una lectura fisica');

    // Segundo lanzamiento sin rotar: HIT de caché, sin tocar el vault.
    await lanzar(d);
    assert.equal(d.calls.length, 1, 'el segundo lanzamiento se sirve de la memo');

    // Rotación en el store + invalidación acotada. Ningún módulo se recarga,
    // ningún proceso se reinicia: es el mismo `require` en el mismo proceso.
    d.rotar(2);
    const res = resetVaultCache(SCOPE);
    assert.equal(res.scope, SCOPE);
    assert.equal(res.invalidadas, 1, 'la entrada del ambito estaba en la memo y se fue');

    const tercero = await lanzar(d);
    assert.equal(tercero.env[ENV_DEL_PROVIDER], keyDeGen(2),
        'el lanzamiento posterior al reset usa la generacion NUEVA');
    assert.equal(d.calls.length, 2, 'el reset obligo a una lectura fisica nueva');
});

test('CA-1 · una lectura EN VUELO de la generacion vieja no repuebla la memo ya reseteada', async () => {
    const d = driverRotable({ gen: 1, abierta: false });

    // Lanzamiento que se queda esperando en la puerta, con la generación 1.
    const enVuelo = lanzar(d);
    await tick();
    assert.equal(d.calls.length, 0, 'la puerta sigue cerrada: todavia no leyo');

    // El operador rota y invalida MIENTRAS la lectura vieja sigue en vuelo.
    // Ésta es la carrera que convierte una revocación en un no-op silencioso
    // por el TTL entero si el compare-and-swap de generación no está.
    d.rotar(2);
    resetVaultCache(SCOPE);

    d.abrir();
    const snapshot = await enVuelo;

    assert.equal(snapshot.env[ENV_DEL_PROVIDER], keyDeGen(2),
        'al caller le llega la generacion NUEVA: la vieja se descarta, no se devuelve');
    assert.equal(d.calls.length, 2, 'la publicacion vetada obligo a releer');

    // Y lo que quedó EN LA MEMO también es la nueva: el reset no fue deshecho.
    const siguiente = await lanzar(d);
    assert.equal(d.calls.length, 2, 'hit de memo, no hubo tercera lectura');
    assert.equal(siguiente.env[ENV_DEL_PROVIDER], keyDeGen(2),
        'la generacion vieja no repoblo la memo despues del reset');
});

test('CA-1 · el reset es ACOTADO: no se lleva puesto otro ambito ni otro destino', async () => {
    const d = driverRotable({ gen: 1 });

    // Se precalientan DOS ámbitos distintos, cada uno con su destino real.
    // `pulpo-telegram` no autoriza ningún provider: su scope es `telegram`, que
    // no es material por provider. Se pasa `null` explícito (no `undefined`,
    // que el default del helper volvería a completar con `anthropic`).
    await lanzar(d, { scope: 'providers', provider: PROVIDER, destination: 'agent-child' });
    await lanzar(d, { scope: 'telegram', provider: null, destination: 'pulpo-telegram' });
    const trasPrecalentar = d.calls.length;
    assert.ok(trasPrecalentar >= 2, 'los dos ambitos se leyeron fisicamente');

    const res = resetVaultCache('providers');
    assert.equal(res.invalidadas, 1, 'invalido exactamente UNA entrada, la de su ambito');

    // `telegram` sigue caliente: rotar `providers` no puede costar una lectura
    // del vault por cada ámbito sano.
    await lanzar(d, { scope: 'telegram', provider: null, destination: 'pulpo-telegram' });
    assert.equal(d.calls.length, trasPrecalentar, 'el ambito no invalidado sigue en HIT');

    // Y el que sí se invalidó relee.
    await lanzar(d);
    assert.ok(d.calls.length > trasPrecalentar, 'el ambito invalidado releyo');
});

test('CA-1 · el reset es idempotente y fail-closed ante un ambito no declarado', async () => {
    const d = driverRotable({ gen: 1 });
    await lanzar(d);

    assert.equal(resetVaultCache(SCOPE).invalidadas, 1);
    assert.equal(resetVaultCache(SCOPE).invalidadas, 0,
        'la segunda llamada seguida no es un error: es un no-op');

    // Un comodín NO es un scope. Que `'*'` a veces signifique "todo" es
    // exactamente la ambigüedad que el contrato cierra.
    for (const invalido of ['*', '', null, undefined, 42, {}, 'ambito-inexistente']) {
        assert.throws(
            () => resetVaultCache(invalido),
            (e) => {
                assert.equal(e.code, VAULT_RESET_ERROR_CODES.INVALID_SCOPE);
                return true;
            },
            `resetVaultCache(${JSON.stringify(invalido)}) tiene que fallar cerrado`,
        );
    }
});

// =============================================================================
// CA-2 · Las solicitudes concurrentes comparten una sola lectura física
// =============================================================================

test('CA-2 · N lanzamientos concurrentes del mismo destino comparten UNA lectura fisica', async () => {
    const d = driverRotable({ gen: 1, abierta: false });

    const vuelos = [lanzar(d), lanzar(d), lanzar(d), lanzar(d)];
    await tick();
    assert.equal(d.calls.length, 0, 'la puerta sigue cerrada: nadie leyo todavia');

    d.abrir();
    const snapshots = await Promise.all(vuelos);

    assert.equal(d.calls.length, 1, 'los cuatro lanzamientos se colgaron del MISMO vuelo');
    for (const s of snapshots) {
        assert.equal(s.env[ENV_DEL_PROVIDER], keyDeGen(1), 'todos recibieron el mismo material');
    }

    // Aislamiento de #5798: coalescer la LECTURA no puede compartir el OBJETO.
    // Un snapshot compartido convierte una mutación de un lanzamiento en una
    // mutación de todos los demás.
    for (let i = 1; i < snapshots.length; i += 1) {
        assert.notStrictEqual(snapshots[i], snapshots[0], 'cada lanzamiento tiene su objeto');
        assert.notStrictEqual(snapshots[i].env, snapshots[0].env, 'cada lanzamiento tiene su env');
    }

    // Y después del vuelo el resultado quedó en la memo, no en el registro de
    // vuelos: un lanzamiento posterior tampoco lee.
    await lanzar(d);
    assert.equal(d.calls.length, 1, 'hit de memo tras cerrar el vuelo');
});

test('CA-2 · el TTL de 300 s vence solo y la lectura NO lo refresca', async () => {
    const d = driverRotable({ gen: 1 });
    let reloj = 1_700_000_000_000;
    const now = () => reloj;

    await lanzar(d, { now });
    assert.equal(d.calls.length, 1);

    // Dentro de la ventana: HIT. Y leer no extiende la vigencia — si la
    // refrescara, un pipeline con lanzamientos continuos nunca releería y la
    // revocación no surtiría efecto jamás sin restart.
    reloj += 299_000;
    await lanzar(d, { now });
    assert.equal(d.calls.length, 1, 'sigue siendo HIT dentro del TTL');

    reloj += 2_000;
    d.rotar(2);
    const vencido = await lanzar(d, { now });
    assert.equal(d.calls.length, 2, 'pasados los 300 s la entrada vence por su cuenta');
    assert.equal(vencido.env[ENV_DEL_PROVIDER], keyDeGen(2),
        'el vencimiento del TTL tambien trae la generacion nueva, sin reset de por medio');
});

// =============================================================================
// CA-3 · Un lanzamiento posterior usa la nueva versión opaca sin reiniciar el
//        coordinador
// =============================================================================

test('CA-3 · dos lanzamientos del MISMO proceso usan versiones opacas distintas', async () => {
    const d = driverRotable({ gen: 1 });
    const sink = sinkDeEvidencia();

    // La versión opaca es un identificador que el operador asigna al rotar. NO
    // se deriva del material —ni hash, ni prefijo, ni longitud—: un valor
    // derivado del secreto es material del secreto en la evidencia, sólo que
    // disfrazado de metadato.
    const versionDe = new Map([[1, 'v-2026-09-05T00:00:00Z-a'], [2, 'v-2026-09-05T00:07:00Z-b']]);

    const primero = await lanzar(d);
    const evPrimero = sink.registrar({
        launch_id: 'launch-1',
        scope: SCOPE,
        opaque_version: versionDe.get(1),
        status: 'ok',
        snapshot_keys: primero.keys.length,
        ts: new Date(1).toISOString(),
    });

    // Rotación operativa: material nuevo en el store + invalidación acotada.
    // Sin `restart.js`, sin matar el proceso, sin recargar módulos.
    d.rotar(2);
    resetVaultCache(SCOPE);

    const segundo = await lanzar(d);
    const evSegundo = sink.registrar({
        launch_id: 'launch-2',
        scope: SCOPE,
        opaque_version: versionDe.get(2),
        status: 'ok',
        snapshot_keys: segundo.keys.length,
        ts: new Date(2).toISOString(),
    });

    assert.notEqual(primero.env[ENV_DEL_PROVIDER], segundo.env[ENV_DEL_PROVIDER],
        'el material efectivo cambio entre lanzamientos');
    assert.notEqual(evPrimero.opaque_version, evSegundo.opaque_version,
        'la evidencia correlaciona dos versiones opacas distintas');
    assert.equal(evSegundo.launch_id, 'launch-2');

    // El snapshot YA ENTREGADO al lanzamiento anterior permanece estable: la
    // rotación no puede reescribir retroactivamente lo que un hijo ya recibió.
    assert.equal(primero.env[ENV_DEL_PROVIDER], keyDeGen(1),
        'el snapshot del lanzamiento 1 no fue mutado por la rotacion posterior');

    // Y la evidencia no lleva un solo valor del vault.
    const texto = sink.serializarTodo();
    assertSinCanario(texto, keyDeGen(1), 'evidencia de CA-3 (generacion vieja)');
    assertSinCanario(texto, keyDeGen(2), 'evidencia de CA-3 (generacion nueva)');
});

// =============================================================================
// CA-4 · Tras el retry permitido, otro fallo impide el lanzamiento fail-closed
// =============================================================================

/**
 * Un intento de lanzamiento a través del coordinador REAL, con la invalidación
 * REAL (`resetVaultCache`) y el snapshot REAL (`createCredentialSnapshot`).
 * Sólo el spawn está doblado.
 */
function correrIntento({ operation, driver, provider, sink, camino = 'primary', destination = DESTINO }) {
    return runWithCredentialRetry({
        operation,
        destination,
        provider: PROVIDER,
        path: camino,
        execute: (ctx) => provider.ejecutar(ctx),
        createSnapshot: ({ now }) => lanzar(driver, { now, destination }),
        // `invalidate` y el catálogo de destinos son los de producción: no se
        // inyecta un doble, porque la costura entre el coordinador y la caché
        // es justamente lo que este archivo viene a verificar.
        emit: sink.emit,
        now: () => 1_757_000_000_000,
    });
}

test('CA-4 · un rechazo tipado dispara UNA invalidacion, UNA re-resolucion y UN reintento', async () => {
    const d = driverRotable({ gen: 1 });
    const sink = sinkDeEvidencia();

    // El provider ya considera vigente la generación 2: la key que el pipeline
    // tiene cacheada (gen 1) está revocada. Es el escenario real de la rotación
    // de urgencia — se rotó en la consola del proveedor y el pipeline todavía
    // no se enteró.
    const prov = providerFake({ keyVigente: keyDeGen(2) });

    // Se precalienta la caché con la generación vieja y recién ahí rota el
    // store: así el primer intento arranca con material ya revocado, que es lo
    // que pasa en producción.
    await lanzar(d);
    d.rotar(2);

    const op = createOperation({ operationId: 'op-5802-retry' });
    const res = await correrIntento({ operation: op, driver: d, provider: prov, sink });

    assert.equal(res.ok, true, 'la operacion termina bien DESPUES del retry');
    assert.equal(res.attempts, 2);
    assert.equal(res.retryUsed, true);
    assert.equal(op.invalidations, 1, 'exactamente una invalidacion');
    assert.equal(op.reresolutions, 1, 'exactamente una re-resolucion');
    assert.equal(op.retryConsumed, true);

    // Lo que hace E2E a este assert: el segundo intento salió bien SÓLO porque
    // la invalidación acotada sacó de verdad el material viejo de la caché y la
    // re-resolución trajo de verdad el nuevo. Un `resetVaultCache` que no
    // alcanzara la capa que lee el snapshot dejaría este test en rojo.
    assert.deepEqual(prov.intentos.map((i) => i.aceptada), [false, true],
        'primer intento rechazado con la key vieja, segundo aceptado con la rotada');
    assert.equal(res.snapshot.env[ENV_DEL_PROVIDER], keyDeGen(2));

    const nombres = sink.eventos.map((e) => e.event);
    assert.deepEqual(nombres, [RETRY_EVENTS.INVALIDATED, RETRY_EVENTS.RERESOLVED],
        'la secuencia auditable del camino feliz');
    const invalidacion = sink.eventos[0];
    assert.equal(invalidacion.scope, SCOPE);
    assert.equal(invalidacion.invalidated_entries, 1,
        'la invalidacion reporta cuantas entradas se fueron: verificacion positiva, no un acto de fe');
});

test('CA-4 · UNA operacion raiz atraviesa agente, Commander y fallback con UN SOLO retry', async () => {
    const d = driverRotable({ gen: 1 });
    const sink = sinkDeEvidencia();

    // La credencial está rota de verdad: ninguna generación del store sirve.
    // Es el caso en que el operador rotó mal, o el proveedor revocó las dos.
    const prov = providerFake({ keyVigente: 'CANARIO-key-que-no-esta-en-el-vault' });

    // La MISMA operación viaja por los tres caminos. Ése es el contrato: si el
    // presupuesto viviera en cada eslabón, esta secuencia haría tres
    // invalidaciones y tres re-resoluciones — una estampida contra el vault por
    // cada caída de credencial.
    const op = createOperation({ operationId: 'op-5802-cadena' });
    assert.equal(RETRY_BUDGET, 1, 'el presupuesto es UNO y no es configurable');

    const fallos = [];

    // 1 · Agente. Gasta el retry y falla cerrado por segundo rechazo.
    await assert.rejects(
        () => correrIntento({ operation: op, driver: d, provider: prov, sink, camino: 'primary' }),
        (e) => {
            fallos.push(e);
            assert.ok(e instanceof CredentialRetryError);
            assert.equal(e.code, RETRY_ERROR_CODES.CLOSED);
            assert.equal(e.reason, CLOSE_REASONS.SECOND_REJECTION);
            assert.equal(e.attempt, 2, 'no hay tercer intento');
            return true;
        },
    );
    assert.equal(op.invalidations, 1);
    assert.equal(op.reresolutions, 1);

    // 2 · Commander, misma operación raíz: el presupuesto YA está consumido.
    await assert.rejects(
        () => correrIntento({
            operation: op, driver: d, provider: prov, sink,
            camino: 'commander', destination: 'commander',
        }),
        (e) => {
            fallos.push(e);
            assert.equal(e.reason, CLOSE_REASONS.BUDGET_EXHAUSTED,
                'el Commander NO se gana un retry propio');
            return true;
        },
    );

    // 3 · Fallback, misma operación raíz: idem.
    await assert.rejects(
        () => correrIntento({ operation: op, driver: d, provider: prov, sink, camino: 'fallback-1' }),
        (e) => {
            fallos.push(e);
            assert.equal(e.reason, CLOSE_REASONS.BUDGET_EXHAUSTED,
                'el fallback tampoco reinicia el presupuesto');
            return true;
        },
    );

    // La cuenta que resume todo el contrato: N rechazos en 3 capas ⇒ UNA
    // invalidación y UNA re-resolución.
    assert.equal(op.invalidations, 1, 'exactamente UNA invalidacion para toda la cadena');
    assert.equal(op.reresolutions, 1, 'exactamente UNA re-resolucion para toda la cadena');
    assert.equal(sink.eventos.filter((e) => e.event === RETRY_EVENTS.INVALIDATED).length, 1);
    assert.equal(sink.eventos.filter((e) => e.event === RETRY_EVENTS.RERESOLVED).length, 1);

    const cierres = sink.eventos.filter((e) => e.event === RETRY_EVENTS.RETRY_CLOSED);
    assert.equal(cierres.length, 3, 'los tres caminos cierran, y cada cierre queda auditado');
    assert.deepEqual(cierres.map((e) => e.reason), [
        CLOSE_REASONS.SECOND_REJECTION,
        CLOSE_REASONS.BUDGET_EXHAUSTED,
        CLOSE_REASONS.BUDGET_EXHAUSTED,
    ]);

    // Fail-closed de verdad: ningún camino devolvió algo que aparente éxito.
    assert.equal(fallos.length, 3);
    for (const e of fallos) {
        assert.ok(e instanceof CredentialRetryError, 'error TIPADO, ruteable por code');
        assert.ok(Object.values(CLOSE_REASONS).includes(e.reason), 'motivo de la tabla cerrada');
    }
});

test('CA-4 · timeout, 5xx y cuota NO invalidan ni consumen el presupuesto', async () => {
    const d = driverRotable({ gen: 1 });

    // Errores que NO son un rechazo de credencial. Que cualquiera de ellos
    // gastara el retry dejaría a la operación sin defensa contra el rechazo
    // real que viniera después — y encima con una invalidación gratis contra el
    // vault por cada timeout de red.
    const noAuth = [
        { errorClass: 'timeout', authenticationRejection: null },
        { errorClass: 'server_error', authenticationRejection: null },
        { errorClass: 'quota', authenticationRejection: null },
        // Texto libre: no alcanza para invalidar. Si alcanzara, cualquier
        // mensaje del provider que diga "auth" sería un disparador remoto de
        // invalidación de credenciales.
        { errorClass: 'unknown', mensaje: 'authentication failed, unauthorized, 401' },
    ];

    for (const veredicto of noAuth) {
        const op = createOperation({ operationId: 'op-5802-no-auth' });
        const sink = sinkDeEvidencia();
        const res = await runWithCredentialRetry({
            operation: op,
            destination: DESTINO,
            provider: PROVIDER,
            path: 'primary',
            execute: async () => veredicto,
            createSnapshot: () => lanzar(d),
            emit: sink.emit,
        });
        assert.equal(res.attempts, 1, `"${veredicto.errorClass}" no dispara un reintento`);
        assert.equal(res.retryUsed, false);
        assert.equal(op.retryConsumed, false, 'el presupuesto queda INTACTO');
        assert.equal(op.invalidations, 0, 'no se invalido nada');
        assert.equal(sink.eventos.length, 0, 'no se emitio un solo evento de credencial');
    }
});

test('CA-4 · un fallo de la re-resolucion cierra la operacion en vez de reintentar con lo viejo', async () => {
    const d = driverRotable({ gen: 1 });
    const sink = sinkDeEvidencia();
    const prov = providerFake({ keyVigente: keyDeGen(9) });

    await lanzar(d);

    // El vault deja de contestar JUSTO cuando hay que re-resolver. Reintentar
    // con el snapshot viejo sería reintentar con la credencial que el provider
    // acaba de rechazar: un rechazo garantizado disfrazado de reintento.
    let primeraResolucion = true;
    const op = createOperation({ operationId: 'op-5802-reres-falla' });

    await assert.rejects(
        () => runWithCredentialRetry({
            operation: op,
            destination: DESTINO,
            provider: PROVIDER,
            path: 'primary',
            execute: (ctx) => prov.ejecutar(ctx),
            createSnapshot: async () => {
                if (primeraResolucion) { primeraResolucion = false; return lanzar(d); }
                const err = new Error('AccessDenied: el principal no puede leer el ambito');
                err.code = 'AccessDenied';
                throw err;
            },
            emit: sink.emit,
        }),
        (e) => {
            assert.equal(e.code, RETRY_ERROR_CODES.RERESOLUTION_FAILED);
            assert.equal(e.reason, CLOSE_REASONS.RERESOLUTION_FAILED);
            return true;
        },
    );

    assert.equal(prov.intentos.length, 1, 'NO hubo segundo intento con el snapshot viejo');
    const cierre = sink.eventos.at(-1);
    assert.equal(cierre.event, RETRY_EVENTS.RETRY_CLOSED);
    assert.equal(cierre.reason, CLOSE_REASONS.RERESOLUTION_FAILED);
});

// =============================================================================
// CA-5 · La evidencia sólo contiene scope lógico, launch, versión opaca, estado
//        y timestamps
// =============================================================================

test('CA-5 · la evidencia de una rotacion completa no filtra el canario por ningun canal', async () => {
    const d = driverRotable({ gen: 1 });
    const sink = sinkDeEvidencia();
    const prov = providerFake({ keyVigente: keyDeGen(2) });

    await lanzar(d);
    d.rotar(2);

    const op = createOperation({ operationId: 'op-5802-evidencia' });
    const res = await correrIntento({ operation: op, driver: d, provider: prov, sink });

    // El harness captura por los canales por los que un secreto se filtra de
    // verdad: la señal local, la forma de auditoría del snapshot y el veredicto
    // del provider.
    sink.capturarStdout(`[pipeline] launch ok attempts=${res.attempts} retry=${res.retryUsed}`);
    sink.capturarStderr(JSON.stringify(redactSnapshot(res.snapshot)));
    sink.registrar({
        launch_id: 'launch-evidencia',
        scope: SCOPE,
        opaque_version: 'v-rotada',
        status: 'ok',
        snapshot_keys: res.snapshot.keys.length,
        ts: new Date(0).toISOString(),
    });

    const texto = sink.serializarTodo();

    // Los DOS canarios: el revocado y el vigente. El revocado importa tanto como
    // el otro — una key vieja filtrada sigue siendo material que estuvo en uso.
    assertSinCanario(texto, keyDeGen(1), 'evidencia de la rotacion (generacion revocada)');
    assertSinCanario(texto, keyDeGen(2), 'evidencia de la rotacion (generacion vigente)');
    // Y el material de OTRO scope que el destino nunca pidió tampoco puede
    // aparecer: el snapshot es por destino, y la evidencia hereda ese recorte.
    assertSinCanario(texto, materialGen(1).telegram.bot_token, 'evidencia (scope ajeno)');
    assertSinCanario(texto, materialGen(2).telegram.bot_token, 'evidencia (scope ajeno)');
});

test('CA-5 · ningun campo fuera de la allowlist entra a la evidencia', async () => {
    const d = driverRotable({ gen: 1 });
    const sink = sinkDeEvidencia();
    const prov = providerFake({ keyVigente: keyDeGen(2) });

    await lanzar(d);
    d.rotar(2);
    const op = createOperation({ operationId: 'op-5802-allowlist' });
    await correrIntento({ operation: op, driver: d, provider: prov, sink });

    assert.ok(sink.eventos.length > 0, 'hubo eventos que auditar');
    for (const ev of sink.eventos) {
        // El coordinador emite EXACTAMENTE la allowlist, congelada.
        assert.deepEqual(Object.keys(ev).sort(), [...EVENT_FIELDS].sort(),
            'el evento del coordinador trae exactamente EVENT_FIELDS');
        assert.ok(Object.isFrozen(ev), 'el evento es inmutable');
    }
    for (const reg of sink.registros) {
        for (const campo of Object.keys(reg)) {
            assert.ok(ALLOWLIST_EVIDENCIA.includes(campo),
                `el campo "${campo}" no esta declarado en la allowlist de evidencia`);
        }
    }

    // La allowlist se DERIVA de EVENT_FIELDS: si el coordinador agrega un campo
    // nuevo, entra solo. Una copia literal habría dejado ese campo sin mirar.
    for (const campo of EVENT_FIELDS) {
        assert.ok(ALLOWLIST_EVIDENCIA.includes(campo),
            `la allowlist de evidencia perdio sincronia con EVENT_FIELDS en "${campo}"`);
    }
});

test('CA-5 · la evidencia no persiste hashes ni valores derivados del material', async () => {
    const d = driverRotable({ gen: 1 });
    const sink = sinkDeEvidencia();
    const prov = providerFake({ keyVigente: keyDeGen(2) });

    await lanzar(d);
    d.rotar(2);
    const op = createOperation({ operationId: 'op-5802-derivados' });
    const res = await correrIntento({ operation: op, driver: d, provider: prov, sink });

    // Un hash estable del secreto es un oráculo: permite confirmar si una key
    // candidata es la que estuvo en uso, y correlacionar la misma credencial
    // entre dos entornos. Por eso no se persiste — ni siquiera truncado.
    const crypto = require('node:crypto');
    const texto = sink.serializarTodo();
    for (const gen of [1, 2]) {
        const valor = keyDeGen(gen);
        for (const algo of ['md5', 'sha1', 'sha256']) {
            const hash = crypto.createHash(algo).update(valor).digest('hex');
            assert.ok(!texto.includes(hash), `la evidencia lleva un ${algo} del material (gen ${gen})`);
            assert.ok(!texto.includes(hash.slice(0, 12)),
                `la evidencia lleva un ${algo} TRUNCADO del material (gen ${gen})`);
        }
        assert.ok(!texto.includes(Buffer.from(valor).toString('base64')),
            `la evidencia lleva el material en base64 (gen ${gen})`);
    }

    // Del snapshot sólo puede viajar la CARDINALIDAD: un número no dice nada
    // del material, y es lo que el evento de re-resolución declara.
    const reresuelto = sink.eventos.find((e) => e.event === RETRY_EVENTS.RERESOLVED);
    assert.ok(reresuelto, 'hubo re-resolucion que auditar');
    assert.equal(reresuelto.snapshot_keys, res.snapshot.keys.length);
    assert.equal(typeof reresuelto.snapshot_keys, 'number');
});

// =============================================================================
// CA-6 · El runbook es repetible: el procedimiento sin reinicio está escrito y
//        se verifica automáticamente
// =============================================================================

const RUNBOOK = path.join(__dirname, '..', '..', 'docs', 'runbooks', 'credential-rotation.md');

function leerRunbook() {
    assert.ok(fs.existsSync(RUNBOOK), `falta el runbook en ${RUNBOOK}`);
    return fs.readFileSync(RUNBOOK, 'utf8');
}

test('CA-6 · el runbook documenta el procedimiento SIN reinicio como camino disponible', () => {
    const texto = leerRunbook();

    // El contrato que el runbook tiene que nombrar para ser accionable.
    for (const termino of ['resetVaultCache', 'sin reinicio']) {
        assert.ok(texto.includes(termino),
            `el runbook no menciona "${termino}": el procedimiento sin reinicio no esta documentado`);
    }

    // El peor momento de la experiencia operativa: rotar porque la key se
    // comprometió. Que la salida documentada sea matar el parque entero a mano
    // es lo que este issue viene a eliminar: el corte ordenado es `restart.js`,
    // no un `taskkill` a lo ancho que deja locks huérfanos.
    assert.ok(!/taskkill \/F \/IM node\.exe/.test(texto),
        'el runbook sigue ofreciendo matar el parque entero como salida de invalidacion inmediata');
});

// ---------------------------------------------------------------------------
// El runbook no puede desincronizarse de los gates en silencio.
//
// El camino sin reinicio depende de tres gates de rollout fail-closed. Mientras
// estén cerrados, ninguna de las piezas que lo habilitan corre: el Pulpo vivo
// conserva la credencial de su boot y se la copia a cada agente que spawnea, y
// el ÚNICO mecanismo de invalidación es reiniciar.
//
// Un runbook que afirma "no hace falta reiniciar" con los gates cerrados no es
// un error de redacción: es un vector. Ante una key robada el operador no
// reinicia, nada invalida nada, y la credencial comprometida se sigue
// repartiendo. Por eso el documento se ata acá al valor REAL del config: si
// alguien abre los gates —o los cierra— sin tocar el runbook, esto se pone en
// rojo.
// ---------------------------------------------------------------------------

const { checkGates } = require('../check-credential-rotation-gates');

test('CA-6 · el runbook está sincronizado con el estado real de los gates de rollout', () => {
    const texto = leerRunbook();
    const { gates, allOpen } = checkGates();

    // Sea cual sea el estado, el runbook tiene que nombrar los tres gates para
    // que el operador pueda verificarlos antes de elegir camino.
    for (const { key } of gates) {
        const clave = key.split('.').pop();
        assert.ok(texto.includes(clave),
            `el runbook no menciona el gate "${key}": el operador no tiene como saber que camino le toca`);
    }

    // Y tiene que ofrecer el verificador, no pedirle que confíe en la memoria.
    assert.ok(texto.includes('check-credential-rotation-gates'),
        'el runbook no ofrece el verificador de gates como paso de precondicion');

    if (allOpen) {
        // Gates abiertos: el camino sin reinicio es el vigente y el runbook no
        // debe seguir mandando a reiniciar como cierre normal de la rotación.
        assert.ok(!/^\s*\d+\.\s.*restart\.js/m.test(texto),
            'los gates estan ABIERTOS pero el runbook todavia exige reiniciar como paso de rotacion');
        return;
    }

    // Gates cerrados (estado vigente): el reinicio es el único mecanismo de
    // invalidación que existe, así que el runbook DEBE conservarlo como paso
    // numerado y ejecutable. Si desaparece, el operador se queda sin salida real
    // ante un compromiso de credencial.
    const pasosConRestart = texto
        .split('\n')
        .filter((l) => /^\s*\d+\.\s/.test(l) && /restart\.js/.test(l));
    assert.ok(pasosConRestart.length > 0,
        'los gates estan CERRADOS y el runbook no conserva `node .pipeline/restart.js` como paso numerado: '
        + 'sin el, no queda ningun procedimiento que invalide una credencial comprometida');

    // Y no puede afirmar lo contrario sin condicionarlo. Estas frases sólo son
    // ciertas con los gates abiertos; sueltas, le dicen al operador que no haga
    // lo único que hoy funciona.
    for (const afirmacion of [
        /\*\*No hace falta reiniciar nada\*\*/,
        /Rotar ya no requiere reiniciar el pipeline/,
    ]) {
        assert.ok(!afirmacion.test(texto),
            `los gates estan CERRADOS y el runbook afirma sin condicion: ${afirmacion}`);
    }
});

test('CA-6 · el runbook nombra las señales y los motivos de cierre por los que el operador rutea', () => {
    const texto = leerRunbook();

    // Diagnóstico: sin los nombres de evento, el operador no tiene qué buscar
    // en el log para saber si la rotación surtió efecto.
    for (const evento of Object.values(RETRY_EVENTS)) {
        assert.ok(texto.includes(evento),
            `el runbook no documenta la señal "${evento}"`);
    }
    // Rollback / escalada: cada cierre se remedia distinto, así que el runbook
    // tiene que nombrarlos para que no colapsen en "falló la credencial".
    for (const motivo of Object.values(CLOSE_REASONS)) {
        assert.ok(texto.includes(motivo),
            `el runbook no documenta el motivo de cierre "${motivo}"`);
    }
});

test('CA-6 · el runbook no publica material: sus ejemplos usan metadata opaca', () => {
    const texto = leerRunbook();

    // Un runbook que en su ejemplo de diagnóstico imprime el valor es un
    // runbook que enseña a filtrar. Los campos que SÍ puede mostrar son los
    // mismos que la evidencia: ámbito lógico, identidad del lanzamiento,
    // versión opaca, estado y timestamps.
    for (const prohibido of [
        /echo\s+\$ANTHROPIC_API_KEY/,
        /printenv\s+ANTHROPIC_API_KEY/,
        /console\.log\([^)]*snapshot\.env/,
    ]) {
        assert.ok(!prohibido.test(texto),
            `el runbook incluye un comando que imprime material: ${prohibido}`);
    }

    for (const campo of ['scope', 'opaque_version', 'operation_id']) {
        assert.ok(texto.includes(campo),
            `el runbook no nombra el campo de metadata opaca "${campo}"`);
    }
});
