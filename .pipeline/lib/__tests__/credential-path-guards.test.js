// =============================================================================
// credential-path-guards.test.js — Issue #5463 (split de #5451)
//
// Verifica las guardas contra re-commit de paths sensibles. El inventario es
// `.pipeline/lib/sensitive-paths.js`; acá se comprueba que las DOS capas de
// contención lo respeten de verdad, contra git, no contra una lista paralela:
//
//   CA-1 · `git check-ignore -v --no-index <path>` devuelve rc=0 e identifica la
//          regla aplicable, para cada path sensible del inventario.
//   CA-2 · `git ls-files` confirma que ninguno de esos paths está trackeado
//          (`.gitignore` NO desindexa lo que ya entró al índice).
//   CA-3 · `.gitignore` y el scanner de `.husky/pre-commit` cubren el MISMO
//          inventario.
//   CA-4 · `.env.example` sigue permitido.
//   CA-5 · La evidencia no incluye contenido de archivos sensibles ni dumps de
//          entorno: el bloqueo del scanner nombra el path y la razón, nunca lo
//          que hay adentro.
//
// Nota sobre `check-ignore -v`: con `-v` git devuelve rc=0 también cuando la
// regla que matchea es una NEGACIÓN (`!.env.example` sale con rc=0). Por eso
// cada aserción de "está ignorado" chequea además que el patrón devuelto no
// empiece con `!` — leer sólo el exit code da un verde falso.
// =============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const inventario = require('../sensitive-paths');
const scanner = require('../precommit-secret-scan');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GITIGNORE = path.join(REPO_ROOT, '.gitignore');

const CON_IGNORE = inventario.SENSITIVE_PATHS.filter((e) => e.requiereIgnore);

function git(args, opts = {}) {
    const r = spawnSync('git', args, {
        cwd: opts.cwd || REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
    });
    return { rc: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Corre `git check-ignore -v --no-index` sobre un path y parsea la salida
 * `<source>:<line>:<pattern>\t<pathname>`.
 */
function checkIgnore(rel) {
    const r = git(['check-ignore', '-v', '--no-index', '--', rel]);
    const linea = r.stdout.split('\n').find(Boolean) || '';
    const [origen, ...resto] = linea.split('\t');
    const partes = origen.split(':');
    const patron = partes.slice(2).join(':');
    return {
        rc: r.rc,
        salida: linea,
        fuente: partes[0] || '',
        numeroLinea: partes[1] || '',
        patron,
        negada: patron.startsWith('!'),
        pathname: (resto[0] || '').trim(),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// CA-1 — cada path sensible está ignorado y la regla es identificable.
// ─────────────────────────────────────────────────────────────────────────────
test('cada path sensible del inventario da rc=0 en check-ignore y expone la regla aplicable', () => {
    assert.ok(CON_IGNORE.length >= 10, 'el inventario quedó sospechosamente corto');

    for (const entrada of CON_IGNORE) {
        assert.ok(entrada.muestras.length > 0, `${entrada.id}: sin muestras para verificar`);

        for (const muestra of entrada.muestras) {
            const res = checkIgnore(muestra);
            assert.strictEqual(
                res.rc, 0,
                `${entrada.id}: "${muestra}" NO está ignorado (rc=${res.rc}). Falta la regla en .gitignore.`,
            );
            assert.ok(
                res.patron.length > 0,
                `${entrada.id}: check-ignore no identificó regla para "${muestra}"`,
            );
            assert.ok(
                !res.negada,
                `${entrada.id}: "${muestra}" matchea una regla de NEGACIÓN (${res.patron}) — queda versionable`,
            );
            assert.ok(
                res.fuente.endsWith('.gitignore'),
                `${entrada.id}: la regla de "${muestra}" viene de "${res.fuente}", no de un .gitignore versionado`,
            );
        }
    }
});

test('cada regla declarada en el inventario existe como línea exacta en .gitignore', () => {
    const lineas = fs.readFileSync(GITIGNORE, 'utf8')
        .split('\n')
        .map((l) => l.replace(/\r$/, '').trim());

    for (const entrada of CON_IGNORE) {
        for (const regla of entrada.reglas) {
            assert.ok(
                lineas.includes(regla),
                `${entrada.id}: la regla "${regla}" no está en .gitignore`,
            );
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// CA-2 — ninguno de esos paths está trackeado.
// ─────────────────────────────────────────────────────────────────────────────
test('ningún path sensible del inventario está trackeado por git', () => {
    for (const entrada of CON_IGNORE) {
        for (const spec of entrada.pathspecs) {
            const r = git(['ls-files', '--', spec]);
            assert.strictEqual(r.rc, 0, `${entrada.id}: git ls-files falló para "${spec}": ${r.stderr}`);
            const trackeados = r.stdout.split('\n').filter(Boolean);
            assert.deepStrictEqual(
                trackeados, [],
                `${entrada.id}: hay paths sensibles en el índice (${spec}). ` +
                'Sacarlos con `git rm --cached` — .gitignore no desindexa lo ya trackeado.',
            );
        }
    }
});

test('el barrido completo del índice no contiene ningún path del inventario que requiera ignore', () => {
    const r = git(['ls-files']);
    assert.strictEqual(r.rc, 0, `git ls-files falló: ${r.stderr}`);

    const ofensores = r.stdout.split('\n').filter(Boolean).filter((p) => {
        const c = inventario.clasificarPath(p);
        return c && c.requiereIgnore;
    });

    assert.deepStrictEqual(
        ofensores, [],
        `paths sensibles trackeados: ${ofensores.join(', ')}`,
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// CA-3 — .gitignore y el scanner de pre-commit cubren el mismo inventario.
// ─────────────────────────────────────────────────────────────────────────────
test('el scanner de pre-commit reconoce todas las muestras del inventario', () => {
    for (const entrada of inventario.SENSITIVE_PATHS) {
        for (const muestra of entrada.muestras) {
            assert.strictEqual(
                scanner.isSensitive(muestra), entrada.id,
                `el scanner de pre-commit no reconoce "${muestra}" (esperado ${entrada.id})`,
            );
        }
    }
});

test('el scanner deriva su inventario del módulo compartido, sin lista paralela', () => {
    const idsScanner = scanner.SENSITIVE_PATTERNS.map((p) => p.name).sort();
    const idsInventario = inventario.SENSITIVE_PATHS
        .filter((e) => e.escaneaContenido)
        .map((e) => e.id)
        .sort();

    assert.deepStrictEqual(
        idsScanner, idsInventario,
        'el inventario del pre-commit divergió del módulo compartido',
    );
});

test('el inventario no clasifica archivos legítimos del repo como sensibles', () => {
    const legitimos = [
        'README.md',
        '.env.example',
        'docs/pipeline/inventario-credenciales.md',
        '.pipeline/lib/sensitive-paths.js',
        '.pipeline/agent-models.json',
        '.claude/hooks/telegram-config.json',
        'app/composeApp/build.gradle.kts',
    ];

    for (const p of legitimos) {
        assert.strictEqual(
            inventario.clasificarPath(p), null,
            `"${p}" fue clasificado como sensible — el inventario está de más`,
        );
    }
});

test('cada entrada del inventario está bien formada y con id único', () => {
    const ids = new Set();
    for (const e of inventario.SENSITIVE_PATHS) {
        assert.ok(e.id && !ids.has(e.id), `id duplicado o ausente: ${e.id}`);
        ids.add(e.id);
        assert.ok(['credencial', 'cripto', 'estado'].includes(e.clase), `${e.id}: clase inválida`);
        assert.ok(typeof e.motivo === 'string' && e.motivo.length > 20, `${e.id}: motivo insuficiente`);
        assert.strictEqual(typeof e.test, 'function', `${e.id}: sin matcher`);
        if (e.requiereIgnore) {
            assert.ok(e.reglas.length > 0, `${e.id}: requiereIgnore sin reglas declaradas`);
            assert.ok(e.pathspecs.length > 0, `${e.id}: requiereIgnore sin pathspecs para ls-files`);
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// CA-4 — la excepción .env.example sigue viva.
// ─────────────────────────────────────────────────────────────────────────────
test('.env.example sigue permitido pese a la regla .env.*', () => {
    // Sin `-v`: rc=1 significa "no ignorado". Con `-v` daría rc=0 mostrando la
    // regla de negación, que es justamente el verde falso que evitamos.
    const r = git(['check-ignore', '--no-index', '--', '.env.example']);
    assert.strictEqual(r.rc, 1, '.env.example quedó ignorado — se perdió la excepción');

    const detalle = checkIgnore('.env.example');
    assert.ok(detalle.negada, `la regla que aplica a .env.example debería ser negada, es "${detalle.patron}"`);

    // Y el hermano genérico sigue ignorado.
    const otro = checkIgnore('.env.produccion');
    assert.strictEqual(otro.rc, 0, '.env.produccion debería estar ignorado');
    assert.ok(!otro.negada, '.env.produccion matchea una negación');
});

test('las excepciones declaradas se reconocen y no se clasifican como sensibles', () => {
    for (const exc of inventario.EXCEPCIONES) {
        assert.ok(inventario.esExcepcion(exc.path), `no se reconoce la excepción ${exc.path}`);
        assert.strictEqual(inventario.clasificarPath(exc.path), null, `${exc.path} clasificado como sensible`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// CA-5 — el bloqueo del scanner no filtra contenido sensible.
// ─────────────────────────────────────────────────────────────────────────────
test('el scanner bloquea un path sensible staged sin volcar su contenido', () => {
    // Canario deliberadamente NO realista: no imita el formato de ninguna
    // credencial, así el fixture no aporta un patrón útil a nadie.
    const CANARIO = 'CANARIO-5463-CONTENIDO-QUE-NO-DEBE-APARECER';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-5463-'));

    try {
        assert.strictEqual(git(['init', '-q'], { cwd: tmp }).rc, 0, 'no se pudo iniciar el repo temporal');
        git(['config', 'user.email', 'test@intrale'], { cwd: tmp });
        git(['config', 'user.name', 'test'], { cwd: tmp });
        git(['config', 'commit.gpgsign', 'false'], { cwd: tmp });
        git(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'init'], { cwd: tmp });

        fs.mkdirSync(path.join(tmp, '.pipeline'), { recursive: true });
        fs.writeFileSync(
            path.join(tmp, '.pipeline', 'credentials.json'),
            JSON.stringify({ nota: CANARIO }, null, 2),
        );
        // `-f` simula exactamente el caso peligroso: alguien forzando al índice
        // un path que .gitignore cubre.
        git(['add', '-f', '.pipeline/credentials.json'], { cwd: tmp });

        const r = spawnSync('node', [path.join(REPO_ROOT, '.pipeline', 'lib', 'precommit-secret-scan.js')], {
            cwd: tmp,
            encoding: 'utf8',
        });

        assert.strictEqual(r.status, 1, 'el scanner no bloqueó un path sensible staged');
        const salida = (r.stdout || '') + (r.stderr || '');
        assert.ok(salida.includes('.pipeline/credentials.json'), 'el bloqueo no nombra el path ofensor');
        assert.ok(!salida.includes(CANARIO), 'el bloqueo volcó contenido del archivo sensible');
        assert.ok(salida.includes('sensitive-paths.js'), 'el bloqueo no orienta al inventario');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

test('el scanner deja pasar un commit sin paths sensibles', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-5463-ok-'));

    try {
        git(['init', '-q'], { cwd: tmp });
        git(['config', 'user.email', 'test@intrale'], { cwd: tmp });
        git(['config', 'user.name', 'test'], { cwd: tmp });
        git(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'init'], { cwd: tmp });

        fs.writeFileSync(path.join(tmp, '.env.example'), 'API_BASE_URL=\nLOG_LEVEL=info\n');
        git(['add', '.env.example'], { cwd: tmp });

        const r = spawnSync('node', [path.join(REPO_ROOT, '.pipeline', 'lib', 'precommit-secret-scan.js')], {
            cwd: tmp,
            encoding: 'utf8',
        });

        assert.strictEqual(r.status, 0, `el scanner bloqueó un commit legítimo: ${r.stderr}`);
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});
