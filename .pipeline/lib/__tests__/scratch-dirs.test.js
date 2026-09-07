'use strict';

// =============================================================================
// Tests de `lib/scratch-dirs.js` (#6190)
//
// El modulo nacio porque tres guards estructurales traian su propia lista
// hardcodeada de directorios a saltear y las tres estaban desincronizadas: un
// scratchpad de agente (`.pipeline/tmp-review-<issue>/`, que contiene copias
// enteras del repo) ponia en rojo guards de issues ajenos. Estos tests fijan
// el contrato del predicado Y que los tres barridos lo consumen de verdad.
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    NON_PRODUCTION_DIRS,
    isScratchDirName,
    isNonProductionDirName,
} = require('../scratch-dirs');

const PIPELINE_DIR = path.join(__dirname, '..', '..');

// -----------------------------------------------------------------------------
// Contrato del predicado
// -----------------------------------------------------------------------------

test('reconoce el scratchpad compartido `_tmp`', () => {
    assert.equal(isScratchDirName('_tmp'), true);
});

test('reconoce las formas `tmp*` que usan los agentes', () => {
    // Nombres reales observados en el arbol al momento de escribir el modulo.
    for (const name of [
        'tmp5173',
        'tmp-5351',
        'tmp-review-5245',
        'tmp-review-5217',
        'tmp-po-5641',
        'tmp-ux-5242',
        'tmp-ruleset',
    ]) {
        assert.equal(isScratchDirName(name), true, `${name} deberia ser scratchpad`);
    }
});

test('NO marca como scratchpad a los directorios de produccion', () => {
    for (const name of ['lib', 'tests', 'views', 'hooks', 'tools', 'bin', 'skills-deterministicos']) {
        assert.equal(isScratchDirName(name), false, `${name} NO deberia ser scratchpad`);
    }
});

test('tolera entradas que no son nombres validos sin lanzar', () => {
    for (const value of [undefined, null, '', 0, 42, {}, [], false]) {
        assert.equal(isScratchDirName(value), false);
        assert.equal(isNonProductionDirName(value), false);
    }
});

test('`isNonProductionDirName` suma dependencias y superficie de test al scratchpad', () => {
    for (const name of NON_PRODUCTION_DIRS) {
        assert.equal(isNonProductionDirName(name), true, `${name} no es produccion`);
    }
    assert.equal(isNonProductionDirName('_tmp'), true);
    assert.equal(isNonProductionDirName('tmp-review-5245'), true);
    assert.equal(isNonProductionDirName('lib'), false);
});

test('la tabla de directorios no-produccion esta congelada', () => {
    assert.equal(Object.isFrozen(NON_PRODUCTION_DIRS), true);
    assert.throws(() => { NON_PRODUCTION_DIRS.push('otro'); });
});

// -----------------------------------------------------------------------------
// Anti-vacuidad: la premisa del modulo tiene que seguir siendo cierta
// -----------------------------------------------------------------------------

test('dentro de `.pipeline/` no hay ningun directorio de produccion que empiece con `tmp`', () => {
    // Si algun dia se agrega uno de verdad (p. ej. `tmplates/`), este test se
    // pone en rojo y avisa que el prefijo dejo de alcanzar como convencion —
    // antes de que el predicado lo excluya en silencio de los tres guards.
    const sospechosos = fs.readdirSync(PIPELINE_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && isScratchDirName(e.name))
        .map((e) => e.name)
        // Todo lo que hay hoy es scratchpad: `_tmp` o `tmp<issue>`/`tmp-<algo>`.
        .filter((name) => name !== '_tmp' && !/^tmp[-_]?[0-9]/.test(name) && !/^tmp-[a-z]+-?[0-9]*$/i.test(name));

    assert.deepEqual(sospechosos, [], 'aparecio un directorio `tmp*` que no sigue la convencion de scratchpad');
});

// -----------------------------------------------------------------------------
// Los tres barridos consumen el predicado (no volvieron a su lista local)
// -----------------------------------------------------------------------------

const CONSUMIDORES = Object.freeze([
    ['lib/secrets-manifest.js', 'isScratchDirName'],
    ['lib/__tests__/config-resolver-guard.test.js', 'isNonProductionDirName'],
    ['tests/dropfile-productores-6226.test.js', 'isScratchDirName'],
]);

for (const [rel, fn] of CONSUMIDORES) {
    test(`${rel} excluye scratchpads via lib/scratch-dirs`, () => {
        const source = fs.readFileSync(path.join(PIPELINE_DIR, rel), 'utf8');
        assert.match(source, /require\((?:'|")[^'"]*scratch-dirs[^'"]*(?:'|")\)|'scratch-dirs\.js'/,
            `${rel} deberia requerir lib/scratch-dirs`);
        assert.ok(source.includes(fn), `${rel} deberia usar ${fn}()`);
    });
}

// -----------------------------------------------------------------------------
// `operational-state-lint.js` lleva una copia INLINE del predicado (es
// self-contained a proposito: se copia solo a un tmpdir en sus tests del CLI y
// corre en el pre-commit). Este test es lo que impide que las dos copias se
// desincronicen en silencio — que es exactamente el bug que #6190 vino a
// cerrar, sólo que un nivel mas arriba.
// -----------------------------------------------------------------------------

test('la copia inline del predicado en operational-state-lint no se desincroniza', () => {
    const lint = require('../operational-state-lint');
    const inline = lint._internal && lint._internal.isScratchDirName;

    assert.equal(typeof inline, 'function',
        'operational-state-lint deberia exportar su copia inline para poder compararla');

    const NOMBRES = [
        '_tmp', 'tmp', 'tmp5173', 'tmp-5351', 'tmp-review-5245', 'tmp-po-5641',
        'tmp-ux-5242', 'tmp-ruleset', 'lib', 'tests', 'views', 'node_modules',
        '__tests__', 'temp', 'atmp', '', 'Tmp',
    ];

    for (const name of NOMBRES) {
        assert.equal(inline(name), isScratchDirName(name),
            `las dos copias difieren para "${name}"`);
    }

    for (const value of [undefined, null, 0, 42, {}, [], false]) {
        assert.equal(inline(value), isScratchDirName(value),
            `las dos copias difieren para ${String(value)}`);
    }
});
