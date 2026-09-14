// =============================================================================
// legacy-config-fuera-del-repo.test.js — #5215 · CA-1
//
// "Ningún componente del pipeline lee credenciales desde un archivo ubicado
// dentro del árbol del repo."
//
// El defecto real: `qa-video-share.js` y `qa-narration.js` resolvían su fallback
// legacy a `<repo>/.claude/hooks/telegram-config.json`. Un `reset --hard` +
// `clean` o un respawn del worktree se lleva ese archivo puesto — así se perdió
// el `refresh_token` de Google Drive y 15 jobs de evidencia de QA fallaron con
// "Google Drive no configurado", sin que nadie relacionara causa y síntoma.
//
// El legacy NO se elimina (sigue siendo la vía de recuperación de secretos que
// nunca se migraron): se re-apunta al store de HOME, fuera del árbol versionado.
//
// SEC: este archivo no lee ningún secreto. Sólo compara PATHS y parsea código
// fuente — nunca imprime ni resuelve un valor de credencial.
//
// NOTA para quien triaje `secrets-census.js`: este test suma +1 al censo de
// "lectores directos" porque menciona el nombre del archivo legacy y usa
// `readFileSync` (sobre CÓDIGO FUENTE, no sobre el config). Es un falso positivo
// conocido del instrumento, que es grep-based por diseño. No es una fuga.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const { LEGACY_CONFIG_PATH } = require('../qa-video-share');
const { LEGACY_PATH } = require('../../../.pipeline/lib/credentials');

/**
 * Verdadero si `target` cae bajo `root`. Se compara con `path.relative`: si el
 * resultado arranca con `..` (o es absoluto, caso de otra unidad en Windows),
 * el target está fuera.
 */
function estaFueraDe(root, target) {
    const rel = path.relative(root, target);
    return rel.startsWith('..') || path.isAbsolute(rel);
}

test('#5215 CA-1 — el legacy por default de qa-video-share vive fuera del árbol del repo', () => {
    assert.equal(typeof LEGACY_CONFIG_PATH, 'string');
    assert.ok(LEGACY_CONFIG_PATH.length > 0);
    assert.ok(
        estaFueraDe(REPO_ROOT, LEGACY_CONFIG_PATH),
        `el fallback legacy cae dentro del repo: ${path.relative(REPO_ROOT, LEGACY_CONFIG_PATH)}`,
    );
});

test('#5215 CA-1 — el default coincide con el LEGACY_PATH canónico del store', () => {
    // No se construye un path a mano en el consumidor: `lib/credentials.js` es
    // el dueño de los dos paths del store (canónico y legacy).
    assert.equal(LEGACY_CONFIG_PATH, LEGACY_PATH);
    assert.ok(estaFueraDe(REPO_ROOT, LEGACY_PATH));
});

test('#5215 CA-1 — el fallback sin el módulo de credenciales resuelve al mismo lugar', () => {
    // El `require` de `lib/credentials.js` puede fallar (el consumidor lo
    // contempla con try/catch). El `||` de respaldo tiene que dar exactamente el
    // mismo path, no uno del repo.
    const respaldo = path.join(os.homedir(), '.claude', 'secrets', 'telegram-config.json');
    assert.equal(respaldo, LEGACY_CONFIG_PATH);
    assert.ok(estaFueraDe(REPO_ROOT, respaldo));
});

// ---- anti-regresión estática ------------------------------------------------
//
// `qa-narration.js` es un CLI sin exports (requerirlo dispara su main), así que
// se audita por forma sobre el fuente, igual que `credential-resolution-pattern`.
// El mismo chequeo se aplica a `qa-video-share.js`: si mañana alguien reintroduce
// el path del repo, el test lo marca aunque el export siga limpio.

const CONSUMIDORES = ['qa/scripts/qa-video-share.js', 'qa/scripts/qa-narration.js'];

/** Saca comentarios para no marcar el patrón cuando aparece documentado en prosa. */
function stripComments(source) {
    return String(source)
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

for (const rel of CONSUMIDORES) {
    test(`#5215 CA-1 — ${rel} no construye el path del legacy desde el árbol del repo`, () => {
        const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
        const lineas = code.split(/\r?\n/);

        const ofensivas = lineas
            .map((linea, i) => ({ linea, nro: i + 1 }))
            .filter(({ linea }) => /telegram-config\.json|\.claude[\/\\]+hooks|["']hooks["']/.test(linea))
            // `__dirname` + subida al root del repo es exactamente el patrón que falló.
            .filter(({ linea }) => /__dirname/.test(linea) || /\.claude[\/\\]+hooks/.test(linea));

        assert.deepEqual(
            ofensivas.map(({ nro, linea }) => `${nro}: ${linea.trim()}`),
            [],
            `${rel} vuelve a resolver el legacy dentro del repo`,
        );
    });

    test(`#5215 CA-1 — ${rel} ancla su legacy en el HOME del operador`, () => {
        const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
        assert.match(
            code,
            /credentialsLib\.LEGACY_PATH|os\.homedir\(\)/,
            `${rel} debe resolver el legacy vía LEGACY_PATH del store o os.homedir()`,
        );
    });
}
