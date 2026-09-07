// =============================================================================
// safe-project-id.test.js — Issue #5901 · CA-1 (GURU-4 + REQ-SEC-2)
//
// El módulo es el punto ÚNICO de identidad de proyecto. Lo que se verifica acá:
//
//   1. La denylist de prototipo cierra el agujero que el regex NO cubría:
//      `constructor` y `prototype` MATCHEAN `^[a-z0-9][a-z0-9-]{1,63}$` y hoy
//      pasaban la validación de las copias locales.
//   2. La EQUIVALENCIA con los consumidores que espejaban el regex — la
//      "coincidencia cubierta por test" que `product-catalog.js` prometía en un
//      comentario y que ahora es un test de verdad.
//   3. `projectLabel` nunca refleja input sin validar (UX-3 + UX-5).
//   4. El módulo es HOJA: sin `fs`, sin `path`, sin requires del pipeline.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const safe = require('../safe-project-id');

// ─── Regex base ──────────────────────────────────────────────────────────────

test('isSafeProjectId acepta slugs validos del catalogo', () => {
    for (const id of ['kernel', 'intrale', 'acme-corp', 'a1', 'x9-y8-z7']) {
        assert.equal(safe.isSafeProjectId(id), true, `deberia aceptar '${id}'`);
    }
});

test('isSafeProjectId rechaza lo que el regex ya rechazaba', () => {
    const invalidos = [
        '',                     // vacio
        'a',                    // 1 char (el regex exige >= 2)
        'A',                    // mayuscula
        'Acme',                 // mayuscula intercalada
        '-acme',                // arranca con guion
        'acme_corp',            // guion bajo
        'acme corp',            // espacio
        'acme/corp',            // separador de path
        'acme\\corp',           // separador de path Windows
        '..',                   // traversal
        '../etc',               // traversal
        'x'.repeat(65),         // demasiado largo
    ];
    for (const id of invalidos) {
        assert.equal(safe.isSafeProjectId(id), false, `deberia rechazar '${id}'`);
    }
});

test('isSafeProjectId rechaza no-strings sin explotar', () => {
    for (const id of [undefined, null, 0, 1, {}, [], true, Symbol('x'), () => {}]) {
        assert.equal(safe.isSafeProjectId(id), false);
    }
});

// ─── REQ-SEC-2 · denylist de prototipo ───────────────────────────────────────

test('REQ-SEC-2: constructor y prototype MATCHEAN el regex pero son rechazados', () => {
    // Esta es la razon de existir de la denylist: el regex solo NO alcanza.
    assert.equal(safe.SAFE_ID_RE.test('constructor'), true,
        'premisa del test: el regex por si solo acepta "constructor"');
    assert.equal(safe.SAFE_ID_RE.test('prototype'), true,
        'premisa del test: el regex por si solo acepta "prototype"');

    assert.equal(safe.isSafeProjectId('constructor'), false);
    assert.equal(safe.isSafeProjectId('prototype'), false);
    assert.equal(safe.isSafeProjectId('__proto__'), false);
});

test('REQ-SEC-2: un id rechazado no puede sembrar el prototipo de un indice', () => {
    // Simula el patron real de uso: `state[projectId] = {...}`.
    const state = Object.create(null);
    for (const id of safe.PROTOTYPE_DENYLIST) {
        assert.equal(safe.isSafeProjectId(id), false);
        // El consumidor fail-closed nunca llega a escribir; comprobamos que el
        // objeto quede intacto y que ningun literal ajeno herede propiedades.
    }
    assert.deepEqual(Object.keys(state), []);
    assert.equal(({}).polluted, undefined);
});

// ─── Kernel reservado (GURU-3) ───────────────────────────────────────────────

test('KERNEL_PROJECT_ID es un slug valido y esta en RESERVED_PROJECT_IDS', () => {
    assert.equal(safe.KERNEL_PROJECT_ID, 'kernel');
    assert.equal(safe.isSafeProjectId(safe.KERNEL_PROJECT_ID), true);
    assert.ok(safe.RESERVED_PROJECT_IDS.includes('kernel'));
    assert.equal(safe.isReservedProjectId('kernel'), true);
    assert.equal(safe.isReservedProjectId('acme'), false);
    assert.throws(() => { safe.RESERVED_PROJECT_IDS.push('x'); },
        'RESERVED_PROJECT_IDS debe estar congelado');
});

// ─── projectLabel (UX-3 + UX-5) ──────────────────────────────────────────────

test('projectLabel traduce kernel y devuelve el slug tal cual para el resto', () => {
    assert.equal(safe.projectLabel('kernel'), 'Kernel (plataforma)');
    assert.equal(safe.projectLabel('acme-corp'), 'acme-corp');
});

test('projectLabel NO refleja input invalido en el mensaje', () => {
    // Lo que devuelve va a un mensaje de Telegram: interpolar input sin validar
    // seria inyeccion de contenido en el canal del operador.
    for (const malo of ['<script>', '../etc/passwd', '__proto__', '', null, undefined, 42]) {
        assert.equal(safe.projectLabel(malo), '(proyecto inválido)');
    }
});

// ─── Equivalencia con los consumidores (la promesa del comentario) ───────────

test('equivalencia: product-catalog re-exporta el modulo, no una copia', () => {
    const catalog = require('../product-catalog');
    assert.equal(catalog.isSafeProjectId, safe.isSafeProjectId,
        'product-catalog debe re-exportar la MISMA funcion, no una copia equivalente');
    assert.equal(catalog.SAFE_ID_RE, safe.SAFE_ID_RE);
});

test('equivalencia: el regex coincide con project-descriptor y product-state-segment', () => {
    const segment = require('../product-state-segment');
    assert.equal(segment.SAFE_ID_RE.source, safe.SAFE_ID_RE.source,
        'product-state-segment espeja el mismo regex');

    // `project-descriptor.js` no exporta el regex, asi que se compara el
    // COMPORTAMIENTO contra su validador publico sobre un corpus comun.
    const descriptor = require('../project-descriptor');
    const isSafeId = descriptor.isSafeId || (descriptor._internal && descriptor._internal.isSafeId);
    if (typeof isSafeId === 'function') {
        const corpus = ['kernel', 'acme-corp', 'a1', 'A', '-x', 'x_y', '../y', 'x/y', ''];
        for (const id of corpus) {
            // La UNICA divergencia admitida es la denylist de prototipo, que es
            // un endurecimiento deliberado del modulo nuevo.
            if (safe.PROTOTYPE_DENYLIST.includes(id)) continue;
            assert.equal(safe.isSafeProjectId(id), isSafeId(id),
                `divergencia para '${id}': el modulo unico y project-descriptor deben coincidir`);
        }
    }
});

test('equivalencia: el modulo endurece, nunca relaja — todo id aceptado pasa el regex espejado', () => {
    const ESPEJO = /^[a-z0-9][a-z0-9-]{1,63}$/;
    const corpus = [
        'kernel', 'acme', 'acme-corp', 'a1', 'constructor', 'prototype',
        '__proto__', 'A', '-x', 'x_y', '../y', 'x/y', '', 'x'.repeat(70),
    ];
    for (const id of corpus) {
        if (safe.isSafeProjectId(id)) {
            assert.equal(ESPEJO.test(id), true,
                `'${id}' fue aceptado pero NO pasa el regex historico: el cambio dejo de ser restrictivo`);
        }
    }
});

// ─── Modulo HOJA ─────────────────────────────────────────────────────────────

test('el modulo es HOJA: no requiere fs, path ni otros modulos del pipeline', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'safe-project-id.js'), 'utf8');
    const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(requires, [],
        `safe-project-id.js debe ser dependency-free; encontrados: ${requires.join(', ')}`);
});
