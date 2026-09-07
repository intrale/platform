// =============================================================================
// project-context-traversal.test.js — SEC-2 / SEC-3 (#5110 · E2).
//
// El `projectId` se concatena a un path (`.pipeline/projects/<id>/`) y se usa
// como CLAVE de contenedores indexados por proyecto. Son dos superficies de
// ataque distintas sobre el mismo dato:
//
//   SEC-2 · path traversal — un id con `..`, separadores o una raíz absoluta
//           haría que el estado de un proyecto se escriba fuera de su namespace
//           (o encima del de otro).
//   SEC-3 · prototype pollution — `__proto__` / `constructor` / `prototype`
//           como id envenenan el objeto que indexa namespaces.
//
// La defensa es en capas: `isSafeId()` (regex + chequeo de separadores) primero
// y el assert de contención bajo `projects/` después. El segundo existe para
// que, si el regex se relajara alguna vez, el escape siga cortado ANTES de
// tocar el filesystem.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/project-context-traversal.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE = '../project-context';

function fresh() {
    delete require.cache[require.resolve(MODULE)];
    const mod = require(MODULE);
    mod._resetForTests();
    return mod;
}

function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projctx-trav-'));
    fs.mkdirSync(path.join(dir, 'descriptors'), { recursive: true });
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    process.env.PIPELINE_OPSTATE_NAMESPACED = '1';
    return dir;
}

function cleanup(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    delete process.env.PIPELINE_OPSTATE_NAMESPACED;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

// ─── SEC-2 · path traversal ─────────────────────────────────────────────────

const TRAVERSAL_IDS = [
    ['..', 'padre directo'],
    ['../otro', 'traversal POSIX'],
    ['..\\otro', 'traversal Windows'],
    ['../../.pipeline', 'traversal multi-nivel'],
    ['a/../../b', 'traversal embebido'],
    ['/etc/passwd', 'absoluto POSIX'],
    ['C:\\Windows\\System32', 'absoluto Windows'],
    ['\\\\servidor\\share', 'UNC Windows'],
    ['sub/dir', 'separador POSIX'],
    ['sub\\dir', 'separador Windows'],
    ['%2e%2e', 'traversal URL-encoded'],
    ['%2e%2e%2fotro', 'traversal URL-encoded con separador'],
    ['proj\u0000.json', 'byte NUL'],
    ['\u0000', 'sólo NUL'],
    ['.', 'directorio actual'],
    ['', 'string vacío'],
    ['   ', 'sólo espacios'],
    ['proj\nid', 'newline embebido'],
    ['~', 'expansión de home'],
    ['~/otro', 'home + subpath'],
];

for (const [id, label] of TRAVERSAL_IDS) {
    test(`SEC-2 · rechaza ${label}: ${JSON.stringify(id)}`, () => {
        const dir = sandbox();
        try {
            const pc = fresh();
            assert.throws(
                () => pc.stateDirFor(id),
                (err) => {
                    // Cualquiera de las dos capas es aceptable — lo que NO es
                    // aceptable es que devuelva un path.
                    assert.ok(
                        ['EOPSTATE_INVALID_PROJECT_ID', 'EOPSTATE_RESERVED_PROJECT_ID', 'EOPSTATE_PATH_ESCAPE'].includes(err.code),
                        `código inesperado: ${err.code}`,
                    );
                    return true;
                },
                `stateDirFor(${JSON.stringify(id)}) debería rechazar`,
            );
        } finally { cleanup(dir); }
    });
}

test('SEC-2 · tipos no-string se rechazan sin tocar el FS', () => {
    const dir = sandbox();
    try {
        const pc = fresh();
        for (const bad of [null, undefined, 42, {}, [], true, Symbol('x'), () => {}]) {
            assert.throws(() => pc.stateDirFor(bad), `stateDirFor(${String(bad)}) debería rechazar`);
        }
    } finally { cleanup(dir); }
});

test('SEC-2 · todo id aceptado resuelve DENTRO de projects/', () => {
    const dir = sandbox();
    try {
        const pc = fresh();
        const root = path.resolve(path.join(dir, 'projects'));
        for (const id of ['alpha', 'mi-producto', 'proj123', 'a-b-c']) {
            const resolved = pc.stateDirFor(id);
            assert.ok(
                resolved.startsWith(root + path.sep),
                `${id} resolvió fuera de projects/: ${resolved}`,
            );
            assert.notEqual(resolved, root, 'nunca puede colapsar a la raíz misma');
        }
    } finally { cleanup(dir); }
});

test('SEC-2 · el namespace de un proyecto nunca contiene al de otro', () => {
    const dir = sandbox();
    try {
        const pc = fresh();
        const a = pc.stateDirFor('alpha');
        const b = pc.stateDirFor('beta');
        assert.notEqual(a, b);
        assert.ok(!a.startsWith(b + path.sep), 'alpha no puede colgar de beta');
        assert.ok(!b.startsWith(a + path.sep), 'beta no puede colgar de alpha');
    } finally { cleanup(dir); }
});

// ─── SEC-3 · prototype pollution ────────────────────────────────────────────

// `RESERVED_PROJECT_IDS` los cubre por construcción (`PROTOTYPE_POLLUTION_IDS`
// en project-descriptor.js). El test verifica el efecto, no la implementación:
// si algún día la lista se arma de otra forma, esto tiene que seguir rojo o
// verde por la razón correcta.
const POLLUTION_IDS = ['__proto__', 'constructor', 'prototype', 'toString', 'namespaces'];

for (const id of POLLUTION_IDS) {
    test(`SEC-3 · rechaza el id de contaminación de prototipo "${id}"`, () => {
        const dir = sandbox();
        try {
            const pc = fresh();
            assert.throws(() => pc.assertOperationalNamespace(id));
            assert.throws(() => pc.stateDirFor(id));
        } finally { cleanup(dir); }
    });
}

test('SEC-3 · rechazar los ids no altera Object.prototype', () => {
    const dir = sandbox();
    try {
        const pc = fresh();
        for (const id of POLLUTION_IDS) {
            try { pc.stateDirFor(id); } catch { /* esperado */ }
        }
        assert.equal({}.polluted, undefined);
        assert.equal(Object.prototype.polluted, undefined);
        // Y un objeto nuevo sigue teniendo el prototipo intacto.
        assert.equal(Object.getPrototypeOf({}), Object.prototype);
    } finally { cleanup(dir); }
});

// ─── Bindings: misma superficie, mismo criterio ─────────────────────────────

test('SEC-2 · readSpawnBinding no escapa del directorio de bindings', () => {
    const dir = sandbox();
    try {
        const pc = fresh();
        // Un archivo real fuera del directorio de bindings, con shape válida.
        const fuera = path.join(dir, 'robado.json');
        fs.writeFileSync(fuera, JSON.stringify({ projectId: 'victima' }));
        for (const nonce of ['../robado', '..\\robado', '/etc/passwd', '../../robado', 'x\u0000']) {
            assert.equal(pc.readSpawnBinding(nonce), null, `nonce ${JSON.stringify(nonce)} no debe resolver`);
        }
    } finally { cleanup(dir); }
});
