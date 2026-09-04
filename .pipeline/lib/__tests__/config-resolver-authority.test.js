// =============================================================================
// config-resolver-authority.test.js — #5174 · CA-4 (Entrega C de #5111)
// =============================================================================
//
// La fila invertida de la matriz: para las claves de AUTORIDAD el kernel gana
// SIEMPRE, y ese "gana" no se implementa como precedencia de merge sino como
// **fail-closed**. La diferencia importa: si fuera precedencia, un manifiesto de
// producto hostil podría declarar `firma_operador.enabled: false` y el resolver
// lo descartaría en silencio; desde el log, "lo ignoré" es indistinguible de "el
// ataque no ocurrió". Por eso la presencia sola —del lado producto o en una env
// var— rompe el arranque nombrando la clave y el lado correcto.
//
// Cobertura: CADA prefijo de la lista congelada de #5173, por los DOS caminos.
// Se itera sobre `AUTHORITY_PREFIXES` en vez de enumerar a mano para que una
// clave nueva quede cubierta automáticamente el día que se agregue.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolver = require('../config-resolver');
const { AUTHORITY_PREFIXES, checkSide, archivoDeLado } = require('../config-schema');
const { seedProductManifest } = require('./_test-helpers');

const KERNEL_BASE = [
    'circuit_breaker:',
    '  infra_escalate_threshold: 3',
    '  auto_resume_ok_threshold: 2',
    'pipelines:',
    '  desarrollo:',
    '    fases: [dev]',
    '',
].join('\n');

const PRODUCTO_BASE = {
    pipelines: { desarrollo: { skills_por_fase: { dev: ['pipeline-dev'] } } },
};

/**
 * Valor de fixture para un prefijo de autoridad. El VALOR no importa (el
 * rechazo es por presencia, no por contenido), sólo que la forma sea la que el
 * prefijo espera: `a.b` es una clave anidada, `a` una sección.
 * @param {string} prefijo
 * @returns {object}
 */
function fixtureDe(prefijo) {
    const segs = prefijo.split('.');
    const raiz = {};
    let cur = raiz;
    for (let i = 0; i < segs.length - 1; i++) { cur[segs[i]] = {}; cur = cur[segs[i]]; }
    // Hoja: un mapa para las secciones, un escalar para las claves puntuales.
    cur[segs[segs.length - 1]] = segs.length === 1 ? { enabled: false } : false;
    return raiz;
}

const ENV_LIMPIO = ['PIPELINE_DIR_OVERRIDE', 'PIPELINE_STATE_DIR', 'PIPELINE_REPO_ROOT'];
let guardado = {};

function sembrar(nombre, producto) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cfgauth-${nombre}-`));
    fs.writeFileSync(path.join(dir, 'config.yaml'), KERNEL_BASE, 'utf8');
    seedProductManifest(dir, producto);
    return dir;
}

test.beforeEach(() => {
    guardado = {};
    for (const k of ENV_LIMPIO) { guardado[k] = process.env[k]; delete process.env[k]; }
    resolver.clearCache();
    resolver._resetTraceState();
    resolver.setTraceSink(() => {});
});

test.afterEach(() => {
    for (const k of ENV_LIMPIO) {
        if (guardado[k] === undefined) delete process.env[k];
        else process.env[k] = guardado[k];
    }
    resolver.clearCache();
});

test.after(() => { resolver.setTraceSink(null); });

// -----------------------------------------------------------------------------
// 1 · Camino ARCHIVO — autoridad declarada del lado producto
// -----------------------------------------------------------------------------

test('CA-4 · CADA clave de autoridad puesta del lado producto falla el arranque', () => {
    assert.ok(AUTHORITY_PREFIXES.length >= 14, 'la lista congelada no puede venir vacía');

    for (const prefijo of AUTHORITY_PREFIXES) {
        const dir = sembrar('archivo', { ...PRODUCTO_BASE, ...fixtureDe(prefijo) });
        resolver.clearCache();
        assert.throws(
            () => resolver.resolve({ pipelineDir: dir }),
            (e) => {
                assert.ok(resolver.isConfigViolation(e),
                    `'${prefijo}': esperaba violación tipada, salió ${e && e.name}`);
                const msg = String(e.message);
                // Las 2 piezas que el CA exige: QUÉ clave y CUÁL es su lado.
                assert.match(msg, new RegExp(prefijo.split('.')[0]),
                    `'${prefijo}': el mensaje debe nombrar la clave`);
                assert.match(msg, /autoridad/,
                    `'${prefijo}': el mensaje debe nombrar el lado correcto`);
                return true;
            },
            `'${prefijo}' del lado producto tiene que romper el arranque`,
        );
    }
});

test('CA-4 · el rechazo apunta al archivo del lado que corresponde, no a "algún archivo"', () => {
    const dir = sembrar('nombra-archivo', { ...PRODUCTO_BASE, ...fixtureDe('firma_operador') });
    assert.throws(() => resolver.resolve({ pipelineDir: dir }), (e) => {
        assert.equal(e.archivo, path.join(dir, 'pipeline.config.json'),
            'el error nombra el archivo QUE FALLÓ (el manifiesto), no el kernel');
        // Y el texto le dice al operador dónde SÍ va.
        assert.equal(archivoDeLado('autoridad'), '.pipeline/config.yaml');
        return true;
    });
});

test('CA-4 · el rechazo NO vuelca el valor crudo que venía en el manifiesto', () => {
    // SEC-2: el manifiesto es mergeable por PR y puede traer un chat id o un
    // token en el valor. El error viaja a Telegram y al log.
    const SECRETO = 'CHAT-ID-SECRETO-9988776655';
    const dir = sembrar('sin-valor', {
        ...PRODUCTO_BASE,
        commander_products: { products: { x: { operator_chat_id: SECRETO } } },
    });
    assert.throws(() => resolver.resolve({ pipelineDir: dir }), (e) => {
        assert.doesNotMatch(String(e.message), new RegExp(SECRETO),
            'el mensaje no puede contener el valor crudo');
        assert.match(String(e.message), /commander_products/, 'pero sí la clave');
        return true;
    });
});

// -----------------------------------------------------------------------------
// 2 · Camino ENV VAR — autoridad intentada por el canal genérico prohibido
// -----------------------------------------------------------------------------

test('CA-4 · CADA clave de autoridad intentada por env var falla el arranque', () => {
    const dir = sembrar('env', PRODUCTO_BASE);
    for (const prefijo of AUTHORITY_PREFIXES) {
        // `PIPELINE_CFG_<CLAVE>` con `__` como separador de nivel es el canal
        // genérico que #5174 prohíbe entero (`ENV_CONFIG_PATTERN`).
        const envVar = 'PIPELINE_CFG_' + prefijo.split('.').join('__').toUpperCase();
        process.env[envVar] = 'false';
        try {
            resolver.clearCache();
            assert.throws(
                () => resolver.resolve({ pipelineDir: dir }),
                (e) => {
                    assert.ok(resolver.isConfigViolation(e), `'${envVar}': violación tipada`);
                    const msg = String(e.message);
                    assert.match(msg, new RegExp(prefijo.split('.')[0]),
                        `'${envVar}': debe nombrar la clave que intenta tocar`);
                    assert.match(msg, /autoridad/, `'${envVar}': debe nombrar el lado`);
                    return true;
                },
                `'${envVar}' tiene que romper el arranque`,
            );
        } finally {
            delete process.env[envVar];
        }
    }
});

test('CA-4 · la env var prohibida se nombra a SÍ MISMA en el error (si no, es inauditable)', () => {
    const dir = sembrar('env-nombre', PRODUCTO_BASE);
    process.env.PIPELINE_CFG_FIRMA_OPERADOR__ENABLED = 'false';
    try {
        assert.throws(() => resolver.resolve({ pipelineDir: dir }), (e) => {
            assert.match(String(e.message), /PIPELINE_CFG_FIRMA_OPERADOR__ENABLED/,
                'sin el nombre de la variable el operador no sabe qué desetear');
            return true;
        });
    } finally {
        delete process.env.PIPELINE_CFG_FIRMA_OPERADOR__ENABLED;
    }
});

test('CA-10 · el canal genérico está prohibido ENTERO, no sólo para autoridad', () => {
    // Una clave de PRODUCTO por el canal genérico también rompe: si se admitiera
    // "sólo para calibración", el canal existiría y la superficie volvería.
    const dir = sembrar('env-producto', PRODUCTO_BASE);
    process.env.PIPELINE_CFG_DEV_ROUTING_PRIORITY = 'x';
    try {
        assert.throws(() => resolver.resolve({ pipelineDir: dir }), (e) => {
            assert.ok(resolver.isConfigViolation(e));
            assert.match(String(e.message), /dev_routing_priority/);
            return true;
        });
    } finally {
        delete process.env.PIPELINE_CFG_DEV_ROUTING_PRIORITY;
    }
});

// -----------------------------------------------------------------------------
// 3 · La otra dirección — la autoridad SÍ vive en el kernel
// -----------------------------------------------------------------------------

test('CA-4 · el test no es vacuo: la MISMA clave del lado kernel resuelve normal', () => {
    // Sin esto, un `checkSide` que rechazara todo pasaría los tests de arriba.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgauth-kernel-'));
    fs.writeFileSync(path.join(dir, 'config.yaml'),
        KERNEL_BASE + 'firma_operador:\n  enabled: false\n  kill_switch: false\n  modo: dry-run\n', 'utf8');
    seedProductManifest(dir, PRODUCTO_BASE);

    const cfg = resolver.resolve({ pipelineDir: dir });
    assert.equal(cfg.firma_operador.enabled, false);
    assert.equal(cfg.circuit_breaker.infra_escalate_threshold, 3);
});

test('CA-8 · la lista congelada es la MISMA fuente que usa el chequeo de lado', () => {
    // Si el resolver validara contra una copia propia, la lista podría divergir
    // y una clave nueva de autoridad quedaría sin proteger en silencio.
    for (const prefijo of AUTHORITY_PREFIXES) {
        const { valid, errors } = checkSide(fixtureDe(prefijo), 'producto');
        assert.equal(valid, false, `'${prefijo}' debe ser rechazada del lado producto`);
        assert.ok(errors.some((e) => e.lado === 'autoridad'),
            `'${prefijo}' debe reportarse con lado 'autoridad'`);
    }
});
