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

test('CA-6258-9 · SEC-7 direccion PERMITIDA: undefined, null y "0" no tiran', () => {
    const CTRL = 'PIPELINE_GATE0_ENABLED';
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
    assert.strictEqual(isSecurityControlVar('PULPO_NO_INVENTADA_2199'), true);
    assert.strictEqual(isSecurityControlVar('PIPELINE_INVENTADO_GATE_ENABLED'), true);
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

test('CA-6258-13 · el mensaje de SEC-7 es ASCII puro, afirmativo y enumera las tres salidas', () => {
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
    assert.match(msg, /Hay tres alternativas permitidas/);
    assert.match(msg, /\(1\) pasar el env como parametro/);
    assert.match(msg, /\(2\) forzar la ausencia de la variable con undefined o null/);
    assert.match(msg, /\(3\) desactivarla con "0"/);
    assert.match(msg, /Lo unico bloqueado es el sentido que la habilita/);
    assert.match(msg, /PULPO_SKIP_ALGO/);
});
