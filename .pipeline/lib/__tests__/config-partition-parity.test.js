// =============================================================================
// config-partition-parity.test.js — #5174 · CA-2 (Entrega C de #5111)
// =============================================================================
//
// El CA central de la entrega: **los valores efectivos resueltos son idénticos a
// los previos a la partición**. Sin esto, mover 9 secciones y un split de
// `config.yaml` a `pipeline.config.json` es indistinguible de perderlas — y el
// modo de fallo no es ruidoso: los cuatro consumidores de la tabla de ruteo
// caen a defaults locales permisivos (`|| {}`, `|| []`), así que una clave
// perdida degrada el ruteo EN SILENCIO en vez de romper el arranque.
//
// La comparación va sobre `resolveForDiff()` (la vía de comparación del
// resolver), no sobre un lector suelto: si cada test parseara los archivos por
// su cuenta, verificaría su propio merge y no el del pipeline.
//
// ## Por qué el golden es REDACTADO
//
// El dump de la configuración resuelta volcaría chat ids de operadores,
// endpoints y paths de la máquina. `snapshotForDiff()` emite `path: tipo` y
// nunca el valor: alcanza para demostrar paridad clave por clave, y no alcanza
// para filtrar nada. El golden se puede leer entero en un PR.
//
// ## Qué caza y qué no
//
// Caza: clave perdida, clave aparecida, clave que cambió de tipo, sección que se
// mudó de lado y no llegó al merge. NO caza un cambio de VALOR — que es lo
// correcto, porque los valores se recalibran a propósito y el golden no debe
// convertirse en un candado sobre la operación diaria.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const resolver = require('../config-resolver');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const KERNEL_FILE = path.join(REPO_ROOT, '.pipeline', 'config.yaml');
const PRODUCT_FILE = path.join(REPO_ROOT, 'pipeline.config.json');
const GOLDEN_FILE = path.join(__dirname, 'fixtures', 'config-snapshot-pre-particion.json');

function resueltaActual() {
    return resolver.resolveMergedForDiff({
        kernelText: fs.readFileSync(KERNEL_FILE, 'utf8'),
        productText: fs.readFileSync(PRODUCT_FILE, 'utf8'),
    });
}

const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));

// -----------------------------------------------------------------------------
// 1 · Paridad clave por clave contra el estado pre-partición
// -----------------------------------------------------------------------------

test('CA-2 · el golden pre-partición no está vacío (si no, el test sería vacuo)', () => {
    assert.ok(Array.isArray(golden.snapshot), 'el golden debe traer un array de claves');
    assert.ok(golden.snapshot.length >= 400,
        `el golden trae ${golden.snapshot.length} claves; se esperaban ~429. `
        + 'Un golden truncado haría pasar cualquier partición.');
    assert.equal(golden.snapshot.length, golden._claves, 'el contador del golden quedó desfasado');
});

test('CA-2 · la configuración resuelta post-partición es idéntica clave por clave a la previa', () => {
    const { config, valid, errors } = resueltaActual();
    assert.ok(config, 'la configuración efectiva debe resolverse');
    assert.equal(valid, true, 'la configuración efectiva debe validar: ' + JSON.stringify(errors));

    const ahora = resolver.snapshotForDiff(config);
    const antes = golden.snapshot;

    const setAntes = new Set(antes);
    const setAhora = new Set(ahora);
    const perdidas = antes.filter((k) => !setAhora.has(k));
    const aparecidas = ahora.filter((k) => !setAntes.has(k));

    // Se reportan por separado porque significan cosas distintas: "perdida" es
    // una clave que el pipeline ya no ve (degradación silenciosa), "aparecida"
    // suele ser una sección nueva legítima que hay que regenerar en el golden.
    assert.deepEqual(perdidas, [],
        'claves PERDIDAS en la partición — los consumidores caerían a su default permisivo:\n  '
        + perdidas.join('\n  '));
    assert.deepEqual(aparecidas, [],
        'claves APARECIDAS respecto del golden. Si el cambio es legítimo, regenerá con:\n'
        + '  node .pipeline/lib/__tests__/fixtures/regen-config-snapshot.js\n  '
        + aparecidas.join('\n  '));

    // Y el orden también: el snapshot es determinístico, así que un deepEqual
    // completo cierra el caso (dos multisets iguales con distinto orden serían
    // un cambio de forma del propio snapshot).
    assert.deepEqual(ahora, antes, 'el snapshot resuelto difiere del golden pre-partición');
});

// -----------------------------------------------------------------------------
// 2 · La salida del diff es REDACTADA
// -----------------------------------------------------------------------------

test('CA-2 · el snapshot no vuelca NINGÚN valor crudo de la configuración', () => {
    const { config } = resueltaActual();
    const snap = resolver.snapshotForDiff(config).join('\n');

    // Cada línea termina en `: <tipo>` con el tipo de un vocabulario CERRADO: lo
    // que se emite de la hoja es su tipo, nunca su contenido. (El prefijo es el
    // path y puede traer `:` adentro: las claves de ruteo son labels de GitHub,
    // como `dev_skill_mapping.app:business`.)
    for (const linea of resolver.snapshotForDiff(config)) {
        assert.match(linea, /: (string|number|boolean|null|object\(\d+\)|array\[\d+\])$/,
            `línea con forma inesperada (¿se filtró un valor?): ${linea}`);
    }

    // Y el control positivo: valores REALES y sensibles del config no aparecen.
    const chatId = config.telegram && config.telegram.leo_operator_chat_id;
    if (chatId !== undefined && chatId !== null) {
        assert.doesNotMatch(snap, new RegExp(String(chatId)),
            'el chat id del operador NO puede aparecer en el dump de paridad');
    }
    const raiz = config.workspace && config.workspace.root;
    if (typeof raiz === 'string' && raiz.length > 3) {
        assert.ok(!snap.includes(raiz), 'el path de la máquina NO puede aparecer en el dump');
    }
});

// -----------------------------------------------------------------------------
// 3 · La paridad se demuestra sobre `resolveForDiff()`, no sobre un lector suelto
// -----------------------------------------------------------------------------

test('CA-2 · `resolveForDiff` en modo monolito y en modo partido dan el MISMO documento', () => {
    // Se arma un monolito sintético uniendo los dos lados y se lo compara con el
    // merge del resolver. Es la propiedad que hace demostrable la paridad: el
    // merge es una UNIÓN de lados disjuntos, así que rearmar el archivo único
    // tiene que devolver exactamente lo mismo.
    const yaml = require('js-yaml');
    const kernel = yaml.load(fs.readFileSync(KERNEL_FILE, 'utf8'));
    const producto = JSON.parse(fs.readFileSync(PRODUCT_FILE, 'utf8'))[resolver.PRODUCT_CONFIG_KEY];

    const monolito = resolver.resolveForDiff(yaml.dump(mergeProfundo(kernel, producto)));
    assert.ok(monolito.config, 'el monolito sintético debe parsear');

    assert.deepEqual(
        resolver.snapshotForDiff(resueltaActual().config),
        resolver.snapshotForDiff(monolito.config),
        'partido y monolito tienen que resolver al mismo documento',
    );
});

test('CA-2 · los dos lados son DISJUNTOS: ninguna clave existe en ambos archivos', () => {
    // Es la precondición que hace que el merge sea una unión y no una
    // precedencia. Si dejara de valer, "idéntico clave por clave" pasaría a
    // depender del orden del merge y el golden ya no probaría lo mismo.
    const yaml = require('js-yaml');
    const kernel = yaml.load(fs.readFileSync(KERNEL_FILE, 'utf8'));
    const producto = JSON.parse(fs.readFileSync(PRODUCT_FILE, 'utf8'))[resolver.PRODUCT_CONFIG_KEY];

    const hojasKernel = new Set(resolver.snapshotForDiff(kernel).map((l) => l.split(':')[0]));
    const colisiones = resolver.snapshotForDiff(producto)
        .map((l) => l.split(':')[0])
        // Las secciones CONTENEDORAS sí se repiten (`pipelines`, `pipelines.desarrollo`):
        // el split declarado vive más abajo. Lo que no puede repetirse es una HOJA.
        .filter((k) => hojasKernel.has(k))
        .filter((k) => {
            const enKernel = leerPath(kernel, k);
            const enProducto = leerPath(producto, k);
            return !(esMapa(enKernel) && esMapa(enProducto));
        });

    assert.deepEqual(colisiones, [],
        'estas claves existen en los DOS archivos: el merge dejaría de ser una unión');
});

// -----------------------------------------------------------------------------
// 4 · Las listas DUPLICADAS siguen coherentes con el lado producto
// -----------------------------------------------------------------------------

test('CA-6 · `routing-classifier` sigue coherente con `dev_skill_mapping` (que ahora vive en producto)', () => {
    // `routing-classifier.js` hardcodea los skills/áreas a propósito (corre sobre
    // TEXTO de issues, en caminos donde todavía no hay config resuelta) y su
    // comentario dice que "la coherencia la verifica un test". Este es ese test:
    // sin él, mover `dev_skill_mapping` al manifiesto deja las dos listas
    // divergiendo en silencio y el clasificador descarta ruteos válidos como
    // falsos positivos.
    const { KNOWN_DEV_SKILLS, KNOWN_AREAS } = require('../routing-classifier');
    const { config } = resueltaActual();
    const mapping = config.dev_skill_mapping;

    assert.ok(mapping && Object.keys(mapping).length > 0,
        'dev_skill_mapping debe llegar desde el lado producto');

    const skillsDelConfig = new Set(Object.values(mapping));
    const areasDelConfig = new Set(
        Object.keys(mapping)
            .filter((k) => k.startsWith('area:'))
            .map((k) => k.slice('area:'.length)),
    );

    const skillsSinDeclarar = [...skillsDelConfig].filter((s) => !KNOWN_DEV_SKILLS.has(s));
    assert.deepEqual(skillsSinDeclarar, [],
        'skills que el config rutea pero `KNOWN_DEV_SKILLS` no conoce: el clasificador '
        + 'los descartaría como falso positivo');

    const areasSinDeclarar = [...areasDelConfig].filter((a) => !KNOWN_AREAS.has(a));
    assert.deepEqual(areasSinDeclarar, [],
        'áreas ruteadas en el config que `KNOWN_AREAS` no declara');
});

// -----------------------------------------------------------------------------
// Helpers locales
// -----------------------------------------------------------------------------

function esMapa(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function leerPath(obj, dotted) {
    let cur = obj;
    for (const seg of dotted.split('.')) {
        if (!esMapa(cur)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/** Unión profunda de dos subárboles disjuntos (rearma el monolito pre-partición). */
function mergeProfundo(a, b) {
    const out = { ...a };
    for (const k of Object.keys(b || {})) {
        out[k] = esMapa(a[k]) && esMapa(b[k]) ? mergeProfundo(a[k], b[k]) : b[k];
    }
    return out;
}
