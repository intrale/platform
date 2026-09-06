'use strict';

// =============================================================================
// Guard estructural del arbol VERSIONADO (#5126 · CA-0 / CA-B2).
//
// CA-0 del issue dice, textual: "El account-id nunca se commitea". CA-B2 lo
// vuelve verificable: "Verificado en el diff del PR que el account-id no se
// commitea". Al cerrar el paraguas ese criterio estaba INCUMPLIDO en `main`:
// cuatro scratchpads de agentes habian quedado versionados en la raiz
// (`.tmp-architect/`, `.tmp5337/`, `.tmp5516/`, `.tmp-issue-2505.txt`) — 40
// archivos, 17.5 MB de dumps de la API de issues — y `.tmp5516/p3.json`
// publicaba el account-id AWS real dos veces, dentro de ARNs completos
// (`arn:aws:iam::<account>:user/claude-code` y `.../intrale-kernel-runtime`),
// en un repositorio PUBLICO.
//
// Por que no lo atrapo ningun guard previo:
//   - `lib/scratch-dirs.js` (#6190) reconoce `tmp*` para que los barridos
//     EXCLUYAN scratchpads; es un predicado de exclusion, no una prohibicion
//     de commitear, y ademas mira nombres sin punto inicial (`tmp5516`), no
//     `.tmp5516`.
//   - `lib/secret-leak-scan.js` (#5220) clasifica pares clave/valor de
//     credenciales (tokens, API keys). Un account-id dentro de un ARN no es
//     ninguna de esas formas.
//
// Este test cierra las dos puertas sobre `git ls-files`, que es la unica
// fuente de verdad de "esto esta commiteado".
// =============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/** Corre git en el repo. Devuelve null si git no esta disponible. */
function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch (err) {
        // `git grep` sale 1 cuando NO hay match: eso es exito para nosotros.
        if (err && err.status === 1 && typeof err.stdout === 'string') return err.stdout;
        return null;
    }
}

// Account-ids sinteticos declarados. Los cuatro primeros son los ejemplos de
// la documentacion publica de AWS; los dos ultimos son fixtures inventados que
// ya viven en tests del repo (digitos descendentes / repetidos: no son de
// nadie). La lista es EXPLICITA a proposito — si aparece un valor de 12
// digitos que no esta aca, el test se pone en rojo y obliga a declararlo o a
// sacarlo. Ese fail-closed es el punto: un account-id real nunca se cuela por
// no estar previsto.
const PLACEHOLDER_ACCOUNTS = new Set([
    '123456789012',   // AWS docs
    '111122223333',   // AWS docs
    '444455556666',   // AWS docs
    '000000000000',   // relleno
    '210987654321',   // fixture: kernel-cutover-probe.test.js
    '999999999999',   // fixture: vault-access-audit.test.js
]);

test('CA-B2: ningun scratchpad de agente quedo versionado en la raiz del repo', () => {
    const listado = git(['ls-files']);
    if (listado === null) { console.log('git no disponible — test omitido'); return; }

    const versionados = listado.split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        // Scratch de agentes en la raiz: `.tmp<issue>/`, `.tmp-<rol>/`,
        // `.tmp-issue-<n>.txt`. Es exactamente lo que ignora `/.tmp*/` +
        // `/.tmp-*.txt` en `.gitignore`.
        .filter((p) => /^\.tmp/.test(p));

    assert.deepEqual(versionados, [],
        `hay scratch de agente versionado en la raiz (nunca es entregable):\n  ${versionados.slice(0, 10).join('\n  ')}`);
});

test('CA-0: no hay ningun account-id AWS real commiteado en un ARN', () => {
    // `git grep` sobre el arbol versionado: no mira el working tree sucio ni
    // los ignorados, que es justo el recorte que pide el criterio.
    const salida = git(['grep', '-h', '-I', '-o', '-E',
        'arn:aws:[a-z0-9-]*:[a-z0-9-]*:[0-9]{12}:', 'HEAD']);
    if (salida === null) { console.log('git no disponible — test omitido'); return; }

    const reales = [...new Set(
        salida.split('\n')
            .map((l) => (l.match(/:([0-9]{12}):/) || [])[1])
            .filter(Boolean)
            .filter((acct) => !PLACEHOLDER_ACCOUNTS.has(acct)),
    )];

    // No se imprime el valor: el mensaje de un test en rojo tambien es texto
    // que termina en un log publico.
    assert.equal(reales.length, 0,
        `hay ${reales.length} account-id AWS que no son placeholders de la doc de AWS ` +
        'dentro de ARNs versionados. CA-0: "el account-id nunca se commitea".');
});

test('el `.gitignore` mantiene las reglas que impiden la reincidencia', () => {
    const fs = require('node:fs');
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');

    for (const regla of ['/.tmp*/', '/.tmp-*.txt']) {
        assert.ok(
            ignore.split('\n').some((l) => l.trim() === regla),
            `falta la regla "${regla}" en .gitignore: sin ella un \`git add -A\` vuelve a colar el scratch`,
        );
    }
});
