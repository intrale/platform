'use strict';

// =============================================================================
// with-env.test.js — suite propia del helper de aislamiento de entorno (#6258).
//
// Cubre CA-6258-2 .. CA-6258-13. Vive en `lib/__tests__/` (no dentro de
// `lib/test-helpers/`) para que el directorio del helper quede con un unico
// archivo, siguiendo el precedente de las demas suites de `lib/__tests__/`.
//
// Criterio de cobertura (no hay umbral numerico, es Node puro): CADA RAMA de
// `with-env.js` ejercitada por al menos un test.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HELPER_PATH = path.join(__dirname, '..', 'test-helpers', 'with-env.js');
const {
    withEnv,
    snapshotEnv,
    restoreEnv,
    SECURITY_CONTROL_VARS,
    isSecurityControlVar,
} = require('../test-helpers/with-env');

// Nombre de trabajo que no existe en ningun entorno real del pipeline.
const V = 'WITH_ENV_TEST_VAR_6258';
// CA-6258-10: centinela improbable. NO es '1' ni '0' (esos aparecen como
// literales en el copy de la guia, asi que no probarian nada).
const CENTINELA = 'zx9-centinela-no-debe-filtrarse-7f3a';

// -----------------------------------------------------------------------------
// CA-6258-2 / CA-6258-3 — contrato exportado y desambiguacion
// -----------------------------------------------------------------------------

test('CA-6258-2 · exporta exactamente el contrato acordado', () => {
    const mod = require('../test-helpers/with-env');
    assert.deepStrictEqual(
        Object.keys(mod).sort(),
        ['SECURITY_CONTROL_VARS', 'isSecurityControlVar', 'restoreEnv', 'snapshotEnv', 'withEnv'],
    );
    assert.strictEqual(typeof withEnv, 'function');
    assert.strictEqual(typeof snapshotEnv, 'function');
    assert.strictEqual(typeof restoreEnv, 'function');
    assert.strictEqual(typeof isSecurityControlVar, 'function');
});

test('CA-6258-2 · SECURITY_CONTROL_VARS es un array de RegExp (contrato cross-issue con #6260)', () => {
    // H-5 / R-7: si el shape cambia a strings/Set/objeto, el guardrail de #6260
    // deja de matchear y falla ABIERTO en silencio. Este aserto es el que rompe.
    assert.ok(Array.isArray(SECURITY_CONTROL_VARS), 'debe ser un Array');
    assert.ok(SECURITY_CONTROL_VARS.length > 0, 'no puede estar vacio');
    assert.ok(SECURITY_CONTROL_VARS.every((r) => r instanceof RegExp), 'cada entrada debe ser RegExp');
    // Sin flag `g`: `.test()` con /g es stateful y daria resultados alternados.
    assert.ok(SECURITY_CONTROL_VARS.every((r) => !r.global), 'ninguna RegExp puede tener flag g');
});

test('CA-6258-3 · la cabecera desambigua contra las otras dos rutas homonimas (R-4)', () => {
    const src = fs.readFileSync(HELPER_PATH, 'utf8');
    const cabecera = src.slice(0, src.indexOf('const SECURITY_CONTROL_VARS'));
    assert.match(cabecera, /QUE ES/);
    assert.match(cabecera, /QUE NO ES/);
    assert.match(cabecera, /_test-helpers\//);              // lib/_test-helpers/ (con guion bajo)
    assert.match(cabecera, /__tests__\/_test-helpers\.js/); // el tercero, a un caracter de distancia
});

// -----------------------------------------------------------------------------
// CA-6258-4 — restauracion sincronica
// -----------------------------------------------------------------------------

test('CA-6258-4 · variable AUSENTE previamente queda borrada, no como el string "undefined"', () => {
    delete process.env[V];
    assert.strictEqual(V in process.env, false);
    withEnv({ [V]: 'valor-durante' }, () => {
        assert.strictEqual(process.env[V], 'valor-durante');
    });
    assert.strictEqual(V in process.env, false, 'debe quedar BORRADA, no seteada');
    assert.strictEqual(process.env[V], undefined);
});

test('CA-6258-4 · variable CON valor previo se repone al valor exacto', () => {
    process.env[V] = 'valor-previo';
    try {
        withEnv({ [V]: 'valor-durante' }, () => {
            assert.strictEqual(process.env[V], 'valor-durante');
        });
        assert.strictEqual(process.env[V], 'valor-previo');
    } finally {
        delete process.env[V];
    }
});

test('CA-6258-4 · fn sincronica que lanza: entorno restaurado y excepcion propagada SIN envolver', () => {
    delete process.env[V];
    const boom = new Error('explosion original');
    let capturada = null;
    try {
        withEnv({ [V]: 'x' }, () => { throw boom; });
    } catch (e) {
        capturada = e;
    }
    // Identidad, no equivalencia: nada de envolver en otro Error.
    assert.strictEqual(capturada, boom, 'debe propagarse la MISMA instancia');
    assert.strictEqual(capturada.message, 'explosion original');
    assert.strictEqual(V in process.env, false, 'entorno restaurado pese a la excepcion');
});

test('CA-6258-4 · withEnv devuelve el valor de retorno de fn (camino sincronico)', () => {
    delete process.env[V];
    const r = withEnv({ [V]: 'x' }, () => 42);
    assert.strictEqual(r, 42);
    assert.strictEqual(V in process.env, false);
});

// -----------------------------------------------------------------------------
// CA-6258-5 — restauracion asincronica (DESPUES del settle)
// -----------------------------------------------------------------------------

test('CA-6258-5 · fn async que RESUELVE: la variable sigue seteada durante el await', async () => {
    delete process.env[V];
    let vistoDentro = null;
    const p = withEnv({ [V]: 'vive-durante-el-await' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        vistoDentro = process.env[V];
        return 'ok';
    });
    // Aserto desde AFUERA mientras la promesa esta pendiente: aun no se restauro.
    assert.strictEqual(process.env[V], 'vive-durante-el-await', 'no debe restaurar antes del settle');
    const r = await p;
    assert.strictEqual(r, 'ok');
    assert.strictEqual(vistoDentro, 'vive-durante-el-await', 'seguia seteada dentro del await');
    assert.strictEqual(V in process.env, false, 'restaurada DESPUES del settle');
});

test('CA-6258-5 · fn async que RECHAZA: restaura despues del settle y propaga sin envolver', async () => {
    process.env[V] = 'previo-async';
    const boom = new Error('rechazo original');
    let vistoDentro = null;
    try {
        const p = withEnv({ [V]: 'durante' }, async () => {
            await new Promise((r) => setTimeout(r, 5));
            vistoDentro = process.env[V];
            throw boom;
        });
        assert.strictEqual(process.env[V], 'durante', 'no debe restaurar antes del settle');
        await p;
        assert.fail('debio rechazar');
    } catch (e) {
        assert.strictEqual(e, boom, 'debe propagarse la MISMA instancia');
    } finally {
        const quedo = process.env[V];
        delete process.env[V];
        assert.strictEqual(vistoDentro, 'durante');
        assert.strictEqual(quedo, 'previo-async', 'repuesto al valor previo tras el rechazo');
    }
});

// -----------------------------------------------------------------------------
// CA-6258-6 / SEC-1 — el snapshot no arrastra secrets
// -----------------------------------------------------------------------------

test('CA-6258-6 · snapshotEnv(["PIPELINE_DIR_OVERRIDE"]) con secrets presentes devuelve UNA sola clave', () => {
    // Los secrets se inyectan con el propio helper (no son variables de control),
    // asi que quedan restaurados aunque el aserto falle.
    withEnv({
        ANTHROPIC_API_KEY: 'sk-ant-FALSO-solo-para-el-test',
        TELEGRAM_BOT_TOKEN: '000000:FALSO-solo-para-el-test',
    }, () => {
        assert.ok(process.env.ANTHROPIC_API_KEY, 'precondicion: el secret esta presente');
        assert.ok(process.env.TELEGRAM_BOT_TOKEN, 'precondicion: el secret esta presente');

        const snap = snapshotEnv(['PIPELINE_DIR_OVERRIDE']);
        assert.strictEqual(Object.keys(snap).length, 1);
        assert.deepStrictEqual(Object.keys(snap), ['PIPELINE_DIR_OVERRIDE']);
        assert.strictEqual('ANTHROPIC_API_KEY' in snap, false);
        assert.strictEqual('TELEGRAM_BOT_TOKEN' in snap, false);
        // Ningun VALOR de secret quedo dentro del snapshot.
        const serializado = JSON.stringify(snap);
        assert.doesNotMatch(serializado, /sk-ant-/);
        assert.doesNotMatch(serializado, /FALSO-solo-para-el-test/);
    });
});

test('CA-6258-6 · el fuente del helper no clona process.env por ningun camino', () => {
    const src = fs.readFileSync(HELPER_PATH, 'utf8');
    // Se assertea sobre un booleano (no sobre `src`) para que el diff de un fallo
    // sea legible en vez de volcar el fuente entero al log del agente.
    const prohibidos = [
        ['spread del entorno completo', /\.\.\.process\.env/],
        ['Object.assign del entorno', /Object\.assign\(\s*\{\s*\}\s*,\s*process\.env/],
        // CA-6258-10: prohibido serializar `vars` en cualquier path de error.
        ['serializacion de valores (JSON.stringify)', /JSON\.stringify/],
    ];
    for (const [etiqueta, re] of prohibidos) {
        assert.strictEqual(re.test(src), false, `with-env.js no puede contener ${etiqueta}`);
    }
});

test('CA-6258-6 · restoreEnv repone valores y borra los que estaban ausentes', () => {
    const OTRA = `${V}_B`;
    delete process.env[V];
    process.env[OTRA] = 'tenia-valor';
    try {
        const snap = snapshotEnv([V, OTRA]);
        process.env[V] = 'ensuciada';
        process.env[OTRA] = 'ensuciada';
        restoreEnv(snap);
        assert.strictEqual(V in process.env, false, 'la ausente vuelve a estar ausente');
        assert.strictEqual(process.env[OTRA], 'tenia-valor');
    } finally {
        delete process.env[V];
        delete process.env[OTRA];
    }
});

// -----------------------------------------------------------------------------
// CA-6258-7 — fail-closed: ningun camino degrada a clonar el entorno
// -----------------------------------------------------------------------------

test('CA-6258-7 · snapshotEnv() sin argumento tira TypeError', () => {
    assert.throws(() => snapshotEnv(), TypeError);
});

test('CA-6258-7 · snapshotEnv("X") (string suelto, no array) tira TypeError', () => {
    assert.throws(() => snapshotEnv('X'), TypeError);
});

test('CA-6258-7 · snapshotEnv([]) tira TypeError (UX-1: nada de aislamiento aparente)', () => {
    assert.throws(() => snapshotEnv([]), TypeError);
});

test('CA-6258-7 · snapshotEnv(["X", ""]) tira TypeError (nombre vacio)', () => {
    assert.throws(() => snapshotEnv(['X', '']), TypeError);
    assert.throws(() => snapshotEnv(['X', 123]), TypeError);
});

test('CA-6258-7 · withEnv({}, fn) tira y NO ejecuta fn (D-6258-4)', () => {
    let corrio = false;
    assert.throws(() => withEnv({}, () => { corrio = true; }), TypeError);
    assert.strictEqual(corrio, false, 'un no-op silencioso que aparenta aislar es el peor modo de fallo');
});

test('CA-6258-7 · withEnv rechaza vars no-objeto y fn no-funcion', () => {
    assert.throws(() => withEnv(null, () => {}), TypeError);
    assert.throws(() => withEnv('X=1', () => {}), TypeError);
    assert.throws(() => withEnv([['X', '1']], () => {}), TypeError);
    assert.throws(() => withEnv({ [V]: '1' }, 'no soy funcion'), TypeError);
    assert.throws(() => restoreEnv(null), TypeError);
});

// -----------------------------------------------------------------------------
// CA-6258-8 / CA-6258-9 — SEC-7, regla asimetrica
// -----------------------------------------------------------------------------

test('CA-6258-8 · SEC-7 direccion PROHIBIDA: habilitar una variable de control tira y no muta nada', () => {
    const CTRL = 'PULPO_SKIP_DATA_RESIDENCY_VALIDATE';
    delete process.env[CTRL];
    let corrio = false;
    assert.throws(
        () => withEnv({ [CTRL]: '1' }, async () => { corrio = true; }),
        (err) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /PULPO_SKIP_DATA_RESIDENCY_VALIDATE/, 'nombra la variable');
            return true;
        },
    );
    assert.strictEqual(corrio, false, 'fn no debe correr');
    // La validacion es PREVIA a mutar: el entorno quedo intacto.
    assert.strictEqual(CTRL in process.env, false);
});

test('CA-6258-8 · SEC-7 tampoco deja mutar las OTRAS variables del mismo lote', () => {
    const CTRL = 'PULPO_NO_AUTOSTART';
    delete process.env[CTRL];
    delete process.env[V];
    assert.throws(() => withEnv({ [V]: 'inocente', [CTRL]: 'si' }, () => {}), /PULPO_NO_AUTOSTART/);
    assert.strictEqual(V in process.env, false, 'ninguna variable del lote se toco');
    assert.strictEqual(CTRL in process.env, false);
});

// #6260 CA-40.1 / seccion 11(c) — AUTORIZADO A CAMBIAR, con el invariante
// intacto. El test defiende que *la direccion permitida no tira*; lo que cambia
// es la variable con la que se lo ejercita. `PIPELINE_GATE0_ENABLED` resuelve
// por la familia `*GATE*_ENABLED`, que es `apagar`: bajo el vocabulario del
// consumidor real, ausencia y `'0'` pasaron a ser su direccion INSEGURA. Se
// migra a una variable `encender` (`PULPO_SKIP_ALGO`), donde `undefined`,
// `null`, `'0'`, `''` y `0` siguen siendo la direccion permitida — las CINCO
// aserciones migran intactas — y se agrega la contracara `apagar`.
test('CA-6258-9 / CA-40.1 · SEC-7 direccion PERMITIDA: undefined, null y "0" no tiran', () => {
    const CTRL = 'PULPO_SKIP_ALGO';                 // familia PULPO_SKIP_* => `encender`
    const prev = process.env[CTRL];
    try {
        process.env[CTRL] = '1';
        assert.doesNotThrow(() => withEnv({ [CTRL]: undefined }, () => {
            assert.strictEqual(CTRL in process.env, false, 'forzar ausencia es fail-closed');
        }));
        assert.doesNotThrow(() => withEnv({ [CTRL]: null }, () => {
            assert.strictEqual(CTRL in process.env, false);
        }));
        assert.doesNotThrow(() => withEnv({ [CTRL]: '0' }, () => {
            assert.strictEqual(process.env[CTRL], '0');
        }));
        // Y ademas el valor previo quedo repuesto tras las tres.
        assert.strictEqual(process.env[CTRL], '1');
        // El string vacio y el numero 0 tambien son deshabilitantes (se evalua el EFECTO).
        assert.doesNotThrow(() => withEnv({ [CTRL]: '' }, () => {}));
        assert.doesNotThrow(() => withEnv({ [CTRL]: 0 }, () => {}));
    } finally {
        if (prev === undefined) delete process.env[CTRL];
        else process.env[CTRL] = prev;
    }
    // La CONTRACARA: para una variable `apagar`, `'0'` es la direccion insegura
    // y tira. Sin este aserto el test solo probaria la mitad del invariante.
    assert.throws(
        () => withEnv({ PIPELINE_GATE0_ENABLED: '0' }, () => {}),
        /PIPELINE_GATE0_ENABLED/,
    );
});

test('CA-6258-9 · PIPELINE_DIR_OVERRIDE NO es variable de control (si lo fuera, waves-* no podria usar el helper)', () => {
    assert.strictEqual(isSecurityControlVar('PIPELINE_DIR_OVERRIDE'), false);
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    try {
        assert.doesNotThrow(() => withEnv({ PIPELINE_DIR_OVERRIDE: 'C:/tmp/lo-que-sea' }, () => {
            assert.strictEqual(process.env.PIPELINE_DIR_OVERRIDE, 'C:/tmp/lo-que-sea');
        }));
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
    }
});

// -----------------------------------------------------------------------------
// CA-6258-10 — cero fuga de valores en mensajes de error
// -----------------------------------------------------------------------------

test('CA-6258-10 · el error de SEC-7 nombra la variable pero NUNCA el centinela', () => {
    const CTRL = 'PULPO_SKIP_DATA_RESIDENCY_VALIDATE';
    delete process.env[CTRL];
    let msg = null;
    try {
        withEnv({ [CTRL]: CENTINELA }, () => {});
    } catch (e) {
        msg = e.message;
    }
    assert.ok(msg, 'debio tirar');
    assert.match(msg, /PULPO_SKIP_DATA_RESIDENCY_VALIDATE/);
    assert.doesNotMatch(msg, new RegExp(CENTINELA), 'el VALOR no puede aparecer en el mensaje');
    assert.strictEqual(CTRL in process.env, false);
});

test('CA-6258-10 · tampoco filtra el centinela por los paths de error GENERICOS', () => {
    const casos = [
        () => withEnv({ [V]: CENTINELA }, 'no soy funcion'),
        () => withEnv([[V, CENTINELA]], () => {}),
        () => snapshotEnv([V, '']),
        () => snapshotEnv({ [V]: CENTINELA }),
    ];
    for (const caso of casos) {
        let msg = null;
        try { caso(); } catch (e) { msg = e.message; }
        assert.ok(msg, 'cada caso debe tirar');
        assert.doesNotMatch(msg, new RegExp(CENTINELA), `path generico filtro el valor: ${msg}`);
    }
    assert.strictEqual(V in process.env, false);
});

// -----------------------------------------------------------------------------
// CA-6258-11 — SEC-6: control por patron, no por enumeracion
// -----------------------------------------------------------------------------

test('CA-6258-11 · un PULPO_SKIP_* que NO existe hoy en el repo ya nace cubierto', () => {
    assert.strictEqual(isSecurityControlVar('PULPO_SKIP_FOO_BAR'), true);
    assert.strictEqual(isSecurityControlVar('pulpo_skip_foo_bar'), true);
    assert.strictEqual(isSecurityControlVar('PULPO_NO_INVENTADA_2199'), true);
    assert.strictEqual(isSecurityControlVar('PIPELINE_INVENTADO_GATE_ENABLED'), true);
});

test('CA-6258-11 · el casing de Windows no permite evadir SEC-7', () => {
    assert.throws(
        () => withEnv({ pulpo_skip_data_residency_validate: '1' }, () => {}),
        /pulpo_skip_data_residency_validate/,
    );
});

test('CA-6258-11 · los 7 nombres de control reales del inventario matchean', () => {
    const inventario = [
        'PULPO_SKIP_DATA_RESIDENCY_VALIDATE',
        'PULPO_SKIP_SECRETS_HALT',
        'PULPO_NO_AUTOSTART',
        'PIPELINE_GATE0_ENABLED',
        'QUOTA_SNAPSHOT_GATE_ENABLED',
        'PIPELINE_VISUAL_GATE_ENABLED',
        'PIPELINE_WAVE_COHERENCE_GATE_ENABLED',
    ];
    for (const n of inventario) {
        assert.strictEqual(isSecurityControlVar(n), true, `${n} deberia ser variable de control`);
    }
});

test('CA-6258-11 · nombres corrientes NO quedan atrapados por el patron', () => {
    for (const n of ['PIPELINE_DIR_OVERRIDE', 'PATH', 'NODE_PATH', 'PIPELINE_STATE_DIR', 'GATEWAY_URL', '']) {
        assert.strictEqual(isSecurityControlVar(n), false, `${n} no deberia ser variable de control`);
    }
    assert.strictEqual(isSecurityControlVar('pipeline_dir_override'), false);
    assert.strictEqual(isSecurityControlVar(undefined), false);
    assert.strictEqual(isSecurityControlVar(123), false);
});

// -----------------------------------------------------------------------------
// CA-6258-12 — `null` borra la variable (UX-3 / D-6258-5)
// -----------------------------------------------------------------------------

test('CA-6258-12 · withEnv({ X: null }) BORRA X durante fn; el string "null" nunca llega al entorno', () => {
    process.env[V] = 'tenia-valor';
    try {
        withEnv({ [V]: null }, () => {
            assert.strictEqual(V in process.env, false, 'null debe BORRAR, no escribir "null"');
            assert.notStrictEqual(process.env[V], 'null');
        });
        assert.strictEqual(process.env[V], 'tenia-valor', 'repuesta al salir');
    } finally {
        delete process.env[V];
    }
});

test('CA-6258-12 · undefined se comporta igual que null', () => {
    process.env[V] = 'tenia-valor';
    try {
        withEnv({ [V]: undefined }, () => {
            assert.strictEqual(V in process.env, false);
        });
        assert.strictEqual(process.env[V], 'tenia-valor');
    } finally {
        delete process.env[V];
    }
});

test('CA-6258-12 · valores no-string se coercionan con String(), sin colarse "null"/"undefined"', () => {
    delete process.env[V];
    withEnv({ [V]: 7 }, () => assert.strictEqual(process.env[V], '7'));
    withEnv({ [V]: 0 }, () => assert.strictEqual(process.env[V], '0'));
    withEnv({ [V]: false }, () => assert.strictEqual(process.env[V], 'false'));
    assert.strictEqual(V in process.env, false);
});

// -----------------------------------------------------------------------------
// CA-6258-13 — el copy accionable no depende de una tilde (UX-2 / D-6258-6)
// -----------------------------------------------------------------------------

// #6260 seccion 10 — AUTORIZACION EXPLICITA para adaptar los asserts literales
// de este test al copy nuevo. Los asserts viejos congelaban un texto FIJO que
// bajo el vocabulario del consumidor real es falso para 9 de las 16 entradas
// del registro: ofrecia como salida exactamente lo que el guardrail bloquea.
// El test ejercitaba `PULPO_SKIP_ALGO` — familia `encender`, el UNICO caso
// donde ese copy seguia siendo correcto — y por eso quedaba verde blindando el
// defecto para las otras 9. Los invariantes de UX (d) se preservan enteros.
test('CA-6258-13 / CA-39.2 · el mensaje de SEC-7 es ASCII puro, afirmativo y enumera la salida correcta', () => {
    let msg = null;
    try {
        withEnv({ PULPO_SKIP_ALGO: 'on' }, () => {});
    } catch (e) {
        msg = e.message;
    }
    assert.ok(msg);
    // ASCII puro: el sentido no puede depender de un acento que se pierda en consola.
    assert.match(msg, /^[\x20-\x7E]+$/, 'debe ser ASCII imprimible puro');
    // Afirmativo e inequivoco: nada del ambiguo "si esta permitido".
    assert.doesNotMatch(msg, /si esta permitido/);
    assert.match(msg, /\(1\) pasar el env como parametro/);
    assert.match(msg, /\(2\) el opt-in nominal de withEnv/);
    // Direccion `encender`: la ausencia y "0" SIGUEN siendo salidas validas.
    assert.match(msg, /forzar la ausencia de la variable con undefined o null/);
    assert.match(msg, /desactivarla con "0"/);
    assert.match(msg, /lo bloqueado es el sentido que la habilita/);
    assert.match(msg, /PULPO_SKIP_ALGO/);
});

// CA-39.2 (contracara) — el mismo test para una familia `apagar`, que es el
// caso que el copy viejo instruia MAL.
test('CA-6258-13 / CA-39.1 · para una variable `apagar` el mensaje NO ofrece "0" ni la ausencia', () => {
    let msg = null;
    try {
        withEnv({ PIPELINE_GATE0_ENABLED: '0' }, () => {});
    } catch (e) {
        msg = e.message;
    }
    assert.ok(msg);
    assert.match(msg, /^[\x20-\x7E]+$/, 'debe ser ASCII imprimible puro');
    assert.doesNotMatch(msg, /si esta permitido/);
    assert.match(msg, /PIPELINE_GATE0_ENABLED/);
    assert.match(msg, /la unica salida por valor es "1"/);
    assert.match(msg, /lo bloqueado es el sentido que la apaga/);
    // Lo que NO puede decir: ofrecer justo lo que bloquea.
    assert.doesNotMatch(msg, /forzar la ausencia/);
    assert.doesNotMatch(msg, /desactivarla con "0"/);
    assert.doesNotMatch(msg, /Lo unico bloqueado es el sentido que la habilita/);
});

// -----------------------------------------------------------------------------
// #6260 — CA-32 .. CA-35, CA-37, CA-38, CA-39, CA-40.5
// -----------------------------------------------------------------------------

test('CA-32 · el contrato exportado se DERIVA del registro y conserva su shape', () => {
    // El helper ya no mantiene lista propia: la resolucion sale de
    // `test-env-lint.protected.json`. Lo que se preserva es el SHAPE.
    const registro = require('../test-env-lint').getRegistry();
    assert.ok(Array.isArray(SECURITY_CONTROL_VARS), 'sigue siendo un Array');
    assert.ok(SECURITY_CONTROL_VARS.every((r) => r instanceof RegExp), 'sigue siendo de RegExp');
    assert.ok(Object.isFrozen(SECURITY_CONTROL_VARS), 'sigue congelado');
    assert.strictEqual(SECURITY_CONTROL_VARS.length, registro.size,
        'una RegExp por entrada del registro (13 `nombre` + 3 `patron`)');
    assert.strictEqual(SECURITY_CONTROL_VARS.length, 16);
    // Y el helper NO reimplementa la lista: no queda ningun literal de patron
    // de control escrito a mano en el archivo (R-A12).
    const src = fs.readFileSync(HELPER_PATH, 'utf8');
    assert.doesNotMatch(src, /\/\^PULPO_SKIP_/, 'el patron no puede volver a estar hardcodeado aca');
    assert.doesNotMatch(src, /\/\^PULPO_NO_/, 'el patron no puede volver a estar hardcodeado aca');
});

test('CA-33 · regresion del hallazgo §3: las direcciones inseguras reales tiran', () => {
    const casos = [
        ['PIPELINE_CFG_FIRMA_OPERADOR__ENABLED', 'false'],
        ['QUOTA_RECONCILE_DISABLED', '1'],
        ['ADMISSION_SWEEP_ENABLED', '0'],
        ['QUOTA_SNAPSHOT_ENABLED', '0'],
    ];
    for (const [name, valor] of casos) {
        assert.throws(
            () => withEnv({ [name]: valor }, () => {}),
            new RegExp(name),
            `${name} en su sentido inseguro debia tirar`,
        );
        assert.strictEqual(name in process.env, false, 'la validacion es PREVIA a mutar');
    }
});

test('CA-34 · PULPO_NO_AUTOSTART="1" NO tira: es el sentido SEGURO (precedencia nominal)', () => {
    // Es la regresion que desbloquea las 49 lineas del patron P1 de #6259. Sin
    // precedencia nominal, la familia `PULPO_NO_*` (`encender`) haria tirar
    // justo la posicion mas inerte.
    const prev = process.env.PULPO_NO_AUTOSTART;
    try {
        assert.doesNotThrow(() => withEnv({ PULPO_NO_AUTOSTART: '1' }, () => {
            assert.strictEqual(process.env.PULPO_NO_AUTOSTART, '1');
        }));
    } finally {
        if (prev === undefined) delete process.env.PULPO_NO_AUTOSTART;
        else process.env.PULPO_NO_AUTOSTART = prev;
    }
    // Y su contracara sigue tirando (CA-6258-8 intacto).
    assert.throws(() => withEnv({ PULPO_NO_AUTOSTART: 'si' }, () => {}), /PULPO_NO_AUTOSTART/);
});

test('CA-35 · el opt-in exige motivo no vacio y variable reconocida', () => {
    const OK = { permitirApagarControl: ['PIPELINE_GATE0_ENABLED'], motivo: 'rama fail-closed' };
    assert.doesNotThrow(() => withEnv({ PIPELINE_GATE0_ENABLED: '0' }, () => {}, OK));
    // motivo ausente
    assert.throws(
        () => withEnv({ PIPELINE_GATE0_ENABLED: '0' }, () => {}, { permitirApagarControl: ['PIPELINE_GATE0_ENABLED'] }),
        /motivo/,
    );
    // motivo vacio / solo espacios
    assert.throws(
        () => withEnv({ PIPELINE_GATE0_ENABLED: '0' }, () => {}, { permitirApagarControl: ['PIPELINE_GATE0_ENABLED'], motivo: '   ' }),
        /motivo/,
    );
    // variable fuera del registro: el opt-in NO es un comodin
    assert.throws(
        () => withEnv({ PATH: 'x' }, () => {}, { permitirApagarControl: ['PATH'], motivo: 'porque si' }),
        /no es una variable de control/,
    );
});

test('CA-37 · vocabulario de valores alineado al consumidor real, no a truthiness', () => {
    // `String(env[X] || '0').trim() === '1'` en produccion: todo lo que no sea
    // exactamente '1' APAGA el gate — "true" incluido.
    for (const valor of ['false', 'off', '2', 'true', '0', 'FALSE']) {
        assert.throws(
            () => withEnv({ PIPELINE_GATE0_ENABLED: valor }, () => {}),
            /PIPELINE_GATE0_ENABLED/,
            `PIPELINE_GATE0_ENABLED con un valor que apaga el gate debia tirar`,
        );
    }
    // '1' es la UNICA posicion que deja el gate encendido.
    const prev = process.env.PIPELINE_GATE0_ENABLED;
    try {
        assert.doesNotThrow(() => withEnv({ PIPELINE_GATE0_ENABLED: '1' }, () => {}));
        assert.doesNotThrow(() => withEnv({ PIPELINE_GATE0_ENABLED: ' 1 ' }, () => {}));
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_GATE0_ENABLED;
        else process.env.PIPELINE_GATE0_ENABLED = prev;
    }
    // Y la familia cubre los otros dos gates reales SIN enumerarlos.
    for (const g of ['PIPELINE_VISUAL_GATE_ENABLED', 'PIPELINE_WAVE_COHERENCE_GATE_ENABLED']) {
        assert.strictEqual(isSecurityControlVar(g), true);
        assert.throws(() => withEnv({ [g]: 'false' }, () => {}), new RegExp(g));
    }
});

test('CA-38 · la derivacion nominal es case-insensitive y escapa el nombre', () => {
    // Fixture canonica: entrada `nombre` que NINGUNA familia cubre.
    assert.strictEqual(isSecurityControlVar('PIPELINE_CFG_FIRMA_OPERADOR__ENABLED'), true);
    assert.strictEqual(isSecurityControlVar('pipeline_cfg_firma_operador__enabled'), true);
    assert.throws(
        () => withEnv({ pipeline_cfg_firma_operador__enabled: '0' }, () => {}),
        /pipeline_cfg_firma_operador__enabled/,
    );
    // El contrato COMPLETO (16 entradas), no solo las 3 de familia.
    assert.ok(
        SECURITY_CONTROL_VARS.every((re) => re.flags.includes('i')),
        'las 16 entradas derivadas deben ser case-insensitive: process.env en Windows tambien lo es',
    );
    // Las 8 nominales que ninguna familia cubre, en minuscula.
    const solasNominales = [
        'pulpo_allow_force_provider_override', 'pipeline_cfg_firma_operador__enabled',
        'quota_reconcile_disabled', 'pipeline_codex_healthcheck_enabled',
        'admission_sweep_enabled', 'anthropic_1m_workaround_enabled',
        'quota_snapshot_enabled', 'pulpo_liveness_kill_seconds',
    ];
    for (const n of solasNominales) {
        assert.strictEqual(isSecurityControlVar(n), true, `${n} deberia resolver en minuscula`);
    }
    // El escape del nombre no ensancha la cobertura hacia variables corrientes.
    assert.strictEqual(isSecurityControlVar('pipeline_dir_override'), false);
});

test('CA-39.3 · direccion `cualquiera`: el mensaje no ofrece NINGUNA salida por valor', () => {
    let msg = null;
    try {
        withEnv({ PULPO_LIVENESS_KILL_SECONDS: '99999' }, () => {});
    } catch (e) {
        msg = e.message;
    }
    assert.ok(msg);
    assert.match(msg, /PULPO_LIVENESS_KILL_SECONDS/);
    assert.match(msg, /no hay salida por valor porque toda escritura es insegura/);
    assert.doesNotMatch(msg, /desactivarla con "0"/);
    assert.doesNotMatch(msg, /la unica salida por valor es "1"/);
    // Las dos salidas validas siempre siguen ofreciendose.
    assert.match(msg, /\(1\) pasar el env como parametro/);
    assert.match(msg, /permitirApagarControl/);
});

test('CA-39.4 · un throw que agrupa direcciones distintas enumera la salida POR VARIABLE', () => {
    let msg = null;
    try {
        withEnv({ PULPO_SKIP_ALGO: 'on', PIPELINE_GATE0_ENABLED: '0' }, () => {});
    } catch (e) {
        msg = e.message;
    }
    assert.ok(msg);
    // Cada variable con su propia salida, ninguna sugerencia falsa para la otra.
    assert.match(msg, /PULPO_SKIP_ALGO: forzar la ausencia de la variable con undefined o null/);
    assert.match(msg, /PIPELINE_GATE0_ENABLED: la unica salida por valor es "1"/);
});

test('CA-39.5 · invariantes de #6258 preservados en las cuatro direcciones', () => {
    const casos = [
        { PULPO_SKIP_ALGO: CENTINELA },
        { PIPELINE_GATE0_ENABLED: CENTINELA },
        { PULPO_LIVENESS_KILL_SECONDS: CENTINELA },
        { PULPO_SKIP_ALGO: CENTINELA, PIPELINE_GATE0_ENABLED: CENTINELA },
    ];
    for (const vars of casos) {
        let msg = null;
        try { withEnv(vars, () => {}); } catch (e) { msg = e.message; }
        assert.ok(msg, 'cada caso debe tirar');
        assert.match(msg, /^[\x20-\x7E]+$/, 'ASCII imprimible puro');
        assert.doesNotMatch(msg, /si esta permitido/, 'nada de la forma ambigua');
        assert.doesNotMatch(msg, new RegExp(CENTINELA), 'el mensaje NUNCA nombra el valor');
        for (const n of Object.keys(vars)) assert.match(msg, new RegExp(n), 'el mensaje nombra la variable');
    }
});

test('CA-40.5 · el opt-in valida contra isSecurityControlVar, NO contra la tabla nominal', () => {
    // `PIPELINE_GATE0_ENABLED` NO figura en la tabla nominal del registro:
    // resuelve por la familia `*GATE*_ENABLED`. Sin esto, la lectura literal de
    // "opt-in nominal" volveria CA-40.2 inalcanzable.
    assert.doesNotThrow(() => withEnv({ PIPELINE_GATE0_ENABLED: undefined }, () => {}, {
        permitirApagarControl: ['PIPELINE_GATE0_ENABLED'],
        motivo: 'resuelve por familia, no por nombre',
    }));
    assert.throws(
        () => withEnv({ PATH: 'x' }, () => {}, { permitirApagarControl: ['PATH'], motivo: 'no' }),
        /no es una variable de control/,
    );
    assert.throws(
        () => withEnv({ PIPELINE_GATE0_ENABLED: undefined }, () => {}, {
            permitirApagarControl: ['PIPELINE_GATE0_ENABLED'], motivo: '',
        }),
        /motivo/,
    );
    // La FORMA del opt-in es nominal: un patron no se acepta como nombre.
    assert.throws(
        () => withEnv({ PULPO_SKIP_X: '1' }, () => {}, {
            permitirApagarControl: ['^PULPO_SKIP_[A-Z0-9_]+$'], motivo: 'intento de comodin',
        }),
        /no es una variable de control/,
    );
});
