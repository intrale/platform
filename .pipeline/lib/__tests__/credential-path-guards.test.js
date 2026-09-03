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
        '.claude/hooks/telegram-sanitizer.js',
        'app/composeApp/build.gradle.kts',
    ];

    for (const p of legitimos) {
        assert.strictEqual(
            inventario.clasificarPath(p), null,
            `"${p}" fue clasificado como sensible — el inventario está de más`,
        );
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// CA-3 (regresión) · `.claude/hooks/telegram-config.json`
//
// Este path estuvo fuera del inventario y, peor, la suite lo fijaba como
// "legítimo" afirmando `clasificarPath(p) === null`. Es portador de credenciales
// (`bot_token`/`chat_id`/`openai_api_key`), está TRACKEADO, NO está ignorado, y
// es el único path del repo donde el re-commit de una credencial ya ocurrió (11
// commits del historial con un bot_token de formato real; #5226 registró además
// valores reales de Google OAuth en su working copy). Con `isSensitive()`
// devolviendo null, restaurar el token y hacer `git add` pasaba por las DOS
// capas sin bloqueo.
//
// Como el archivo debe seguir versionado hasta el destrackeo de #5226, la
// entrada usa `requiereIgnore: false` + `escaneaContenido: true` (mismo patrón
// que `servicios-state`): la contención es el sanitizer, no el ignore.
// ─────────────────────────────────────────────────────────────────────────────
test('el config de Telegram de los hooks está en el inventario y se cubre por contenido', () => {
    const rel = '.claude/hooks/telegram-config.json';

    const clase = inventario.clasificarPath(rel);
    assert.ok(clase, `"${rel}" no está en el inventario — el scanner nunca lo mira (ver #5226)`);
    assert.strictEqual(clase.id, 'claude-hooks-telegram-config');
    assert.strictEqual(clase.clase, 'credencial');
    assert.strictEqual(
        clase.escaneaContenido, true,
        'sin escaneo de contenido no queda ninguna capa cubriendo el path',
    );
    assert.strictEqual(
        clase.requiereIgnore, false,
        'el archivo está trackeado a propósito: exigir ignore taparía un archivo versionado',
    );

    // La capa que efectivamente lo cubre: el scanner de pre-commit.
    assert.strictEqual(
        scanner.isSensitive(rel), 'claude-hooks-telegram-config',
        'el scanner de pre-commit no reconoce el path',
    );

    // El matcher es exacto: no se lleva puesto el resto de `.claude/hooks/`.
    assert.strictEqual(inventario.clasificarPath('.claude/hooks/telegram-sanitizer.js'), null);
    assert.strictEqual(inventario.clasificarPath('.claude/hooks/activity-logger.js'), null);
});

test('el scanner corre el sanitizer sobre el config de Telegram de los hooks staged', () => {
    // Canario con la FORMA de un bot token (para que el sanitizer lo cace) pero
    // transparentemente falso: no aporta un valor ni un patrón útil a nadie.
    const CANARIO = '000000:CANARIO-5463-NO-ES-UN-TOKEN-REAL-XXX';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-5463-hooks-'));

    try {
        assert.strictEqual(git(['init', '-q'], { cwd: tmp }).rc, 0, 'no se pudo iniciar el repo temporal');
        git(['config', 'user.email', 'test@intrale'], { cwd: tmp });
        git(['config', 'user.name', 'test'], { cwd: tmp });
        git(['config', 'commit.gpgsign', 'false'], { cwd: tmp });
        git(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'init'], { cwd: tmp });

        fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
        fs.writeFileSync(
            path.join(tmp, '.claude', 'hooks', 'telegram-config.json'),
            JSON.stringify({ bot_token: CANARIO, chat_id: '12345' }, null, 2),
        );
        // Sin `-f`: el path NO está ignorado (ese es justamente el agujero), así
        // que un `git add` común lo stagea. Es el escenario real del defecto.
        git(['add', '.claude/hooks/telegram-config.json'], { cwd: tmp });

        const r = spawnSync('node', [path.join(REPO_ROOT, '.pipeline', 'lib', 'precommit-secret-scan.js')], {
            cwd: tmp,
            encoding: 'utf8',
        });

        assert.strictEqual(
            r.status, 1,
            'el scanner dejó pasar una credencial restaurada en .claude/hooks/telegram-config.json',
        );

        const salida = (r.stdout || '') + (r.stderr || '');
        assert.ok(salida.includes('.claude/hooks/telegram-config.json'), 'el bloqueo no nombra el path ofensor');
        assert.ok(salida.includes('claude-hooks-telegram-config'), 'el bloqueo no atribuye la entrada del inventario');
        // Prueba de que pasó por el sanitizer (nivel 2) y no por el bloqueo seco
        // de path staged (nivel 1, que no aplica porque requiereIgnore es false).
        assert.ok(
            salida.includes('[REDACTED:TELEGRAM_BOT_TOKEN]'),
            'el sanitizer no corrió sobre el archivo: no hay placeholder de redacción',
        );
        // CA-5: el bloqueo nombra el path y el patrón, nunca el valor.
        assert.ok(!salida.includes(CANARIO), 'el bloqueo volcó el contenido del archivo sensible');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
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

// Regresión: `sanitize()` normaliza CRLF→LF. El scanner comparaba el contenido
// crudo contra el sanitizado, así que un archivo del inventario con finales de
// línea de Windows — el caso por default en este repo — se reportaba como
// "secreto detectado" sin un solo patrón redactado. Un bloqueo falso sobre un
// archivo limpio empuja al operador a `--no-verify`, que apaga las dos capas.
test('el scanner no bloquea un archivo del inventario limpio con finales de línea CRLF', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-5463-crlf-'));

    try {
        git(['init', '-q'], { cwd: tmp });
        git(['config', 'user.email', 'test@intrale'], { cwd: tmp });
        git(['config', 'user.name', 'test'], { cwd: tmp });
        git(['config', 'core.autocrlf', 'false'], { cwd: tmp });
        git(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'init'], { cwd: tmp });

        fs.mkdirSync(path.join(tmp, '.claude', 'hooks'), { recursive: true });
        // Config legítima, sin credenciales, escrita con CRLF.
        const limpio = JSON.stringify(
            { bot_token: '', chat_id: '', permission_timeout_min: 30 }, null, 2,
        ).replace(/\n/g, '\r\n');
        fs.writeFileSync(path.join(tmp, '.claude', 'hooks', 'telegram-config.json'), limpio);
        git(['add', '.claude/hooks/telegram-config.json'], { cwd: tmp });

        const r = spawnSync('node', [path.join(REPO_ROOT, '.pipeline', 'lib', 'precommit-secret-scan.js')], {
            cwd: tmp,
            encoding: 'utf8',
        });

        assert.strictEqual(
            r.status, 0,
            'el scanner bloqueó un archivo limpio sólo por venir en CRLF: ' +
            ((r.stdout || '') + (r.stderr || '')),
        );
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

test('pipeline-runtime-state clasifica todos sus descendientes sin excepciones', () => {
    for (const rel of [
        '.pipeline/state/probe.json',
        '.pipeline/state/sub dir/archivo con espacios',
        '.pipeline/state/$(touch NO-EJECUTAR)',
        '.pipeline/state/linea\nnueva.json',
    ]) {
        const result = inventario.clasificarPath(rel);
        assert.ok(result, `no clasificó ${JSON.stringify(rel)}`);
        assert.strictEqual(result.id, 'pipeline-runtime-state');
        assert.strictEqual(result.clase, 'estado');
        assert.strictEqual(result.requiereIgnore, true);
    }
    assert.strictEqual(inventario.clasificarPath('.pipeline/state'), null);
    assert.strictEqual(inventario.clasificarPath('.pipeline/stateful/probe.json'), null);
});

test('parser NUL cubre A/C/M/R y conserva ambos lados de copy y rename', () => {
    const hostile = '.pipeline/state/a b\n"$()`;x.json';
    const parsed = scanner.__forTestsOnly__.parseNameStatusZ(Buffer.from(
        ['A', hostile, 'C100', 'origen', '.pipeline/state/copia', 'M', '.pipeline/state/mod',
            'R090', '.pipeline/state/viejo', 'destino', ''].join('\0'),
    ));
    assert.deepStrictEqual(parsed.map((entry) => entry.status), ['A', 'C100', 'M', 'R090']);
    assert.deepStrictEqual(parsed[0].paths, [hostile]);
    assert.deepStrictEqual(parsed[1].paths, ['origen', '.pipeline/state/copia']);
    assert.deepStrictEqual(parsed[3].paths, ['.pipeline/state/viejo', 'destino']);
});

test('el guard de rango bloquea ambos lados de renames y deduplica paths', () => {
    const output = Buffer.from([
        'R100', '.pipeline/state/origen.json', 'destino.json',
        'C100', 'origen.json', '.pipeline/state/copia.json',
        'M', '.pipeline/state/copia.json', '',
    ].join('\0'));
    const findings = scanner.collectFindings({ mode: 'range', base: 'base', head: 'head', git: () => output });
    assert.deepStrictEqual(findings.map((finding) => finding.path), [
        '.pipeline/state/origen.json', '.pipeline/state/copia.json',
    ]);
});

test('un fallo de Git bloquea y se distingue de una infracción', () => {
    const failGit = () => { throw new scanner.GitOperationError('enumerar paths del diff', 128, 'fixture'); };
    assert.throws(() => scanner.collectFindings({ mode: 'staged', git: failGit }), /enumerar paths del diff/);
    const originalWrite = process.stderr.write;
    let diagnostic = '';
    process.stderr.write = (chunk) => { diagnostic += chunk; return true; };
    try {
        assert.strictEqual(scanner.main(['--staged'], { git: failGit }), 2);
    } finally {
        process.stderr.write = originalWrite;
    }
    assert.match(diagnostic, /fallo técnico de Git/);
    assert.match(diagnostic, /enumerar paths del diff/);
});

test('workflow de PR nace enforce, con permisos mínimos y sin bypass', () => {
    const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'runtime-state-guard.yml'), 'utf8');
    assert.match(workflow, /^\s*pull_request:\s*$/m);
    assert.match(workflow, /^\s*contents:\s*read\s*$/m);
    assert.match(workflow, /fetch-depth:\s*0/);
    assert.match(workflow, /--range/);
    for (const forbidden of ['pull_request_target', 'continue-on-error', '|| true', 'report-only', 'secrets.']) {
        assert.ok(!workflow.includes(forbidden), `workflow contiene bypass/provisión prohibida: ${forbidden}`);
    }
});

test('commit real con path runtime forzado falla mediante hook y el caso limpio pasa', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-6111-hook-'));
    try {
        git(['init', '-q'], { cwd: tmp });
        git(['config', 'user.email', 'test@intrale'], { cwd: tmp });
        git(['config', 'user.name', 'test'], { cwd: tmp });
        git(['config', 'commit.gpgsign', 'false'], { cwd: tmp });
        git(['commit', '-q', '--allow-empty', '--no-verify', '-m', 'init'], { cwd: tmp });
        const scannerPath = path.join(REPO_ROOT, '.pipeline', 'lib', 'precommit-secret-scan.js').replace(/\\/g, '/');
        fs.writeFileSync(path.join(tmp, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nnode "${scannerPath}" --staged\n`);
        fs.chmodSync(path.join(tmp, '.git', 'hooks', 'pre-commit'), 0o755);
        fs.mkdirSync(path.join(tmp, '.pipeline', 'state'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.pipeline', 'state', 'probe.json'), '{"canary":"NO-IMPRIMIR"}');
        git(['add', '-f', '--', '.pipeline/state/probe.json'], { cwd: tmp });
        const blocked = git(['commit', '-m', 'runtime'], { cwd: tmp });
        assert.notStrictEqual(blocked.rc, 0);
        assert.match(blocked.stderr, /pipeline-runtime-state/);
        assert.match(blocked.stderr, /clase=estado/);
        assert.match(blocked.stderr, /Remediación/);
        assert.ok(!blocked.stderr.includes('NO-IMPRIMIR'));
        git(['reset', '-q'], { cwd: tmp });
        fs.writeFileSync(path.join(tmp, 'funcional.txt'), 'ok');
        git(['add', 'funcional.txt'], { cwd: tmp });
        const clean = git(['commit', '-q', '-m', 'clean'], { cwd: tmp });
        assert.strictEqual(clean.rc, 0, clean.stderr);
        assert.strictEqual(clean.stdout.trim(), '');
        assert.strictEqual(clean.stderr.trim(), '');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

test('hook invoca el scanner exactamente una vez antes del primer early-exit', () => {
    const hook = fs.readFileSync(path.join(REPO_ROOT, '.husky', 'pre-commit'), 'utf8');
    const invocations = hook.match(/^\s*node \.pipeline\/lib\/precommit-secret-scan\.js\b/gm) || [];
    assert.strictEqual(invocations.length, 1);
    assert.ok(hook.indexOf('precommit-secret-scan.js --staged') < hook.indexOf('if [ "$RUN_VALIDATE" = "0" ]'));
});

test('rango Git real bloquea A/C/M/R y deja pasar un diff funcional limpio', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-6111-range-'));
    const scannerPath = path.join(REPO_ROOT, '.pipeline', 'lib', 'precommit-secret-scan.js');
    try {
        git(['init', '-q'], { cwd: tmp });
        git(['config', 'user.email', 'test@intrale'], { cwd: tmp });
        git(['config', 'user.name', 'test'], { cwd: tmp });
        git(['config', 'commit.gpgsign', 'false'], { cwd: tmp });
        fs.mkdirSync(path.join(tmp, '.pipeline', 'state'), { recursive: true });
        fs.writeFileSync(path.join(tmp, '.pipeline', 'state', 'modified.json'), 'base');
        fs.writeFileSync(path.join(tmp, '.pipeline', 'state', 'renamed.json'), 'rename');
        fs.writeFileSync(path.join(tmp, 'copy-source.txt'), 'copy fixture with enough unique content');
        fs.writeFileSync(path.join(tmp, 'clean.txt'), 'base');
        git(['add', '-A'], { cwd: tmp });
        git(['commit', '-q', '-m', 'base'], { cwd: tmp });
        const base = git(['rev-parse', 'HEAD'], { cwd: tmp }).stdout.trim();

        fs.writeFileSync(path.join(tmp, '.pipeline', 'state', 'added.json'), 'added');
        fs.writeFileSync(path.join(tmp, '.pipeline', 'state', 'modified.json'), 'changed');
        fs.copyFileSync(path.join(tmp, 'copy-source.txt'), path.join(tmp, '.pipeline', 'state', 'copied.txt'));
        fs.renameSync(path.join(tmp, '.pipeline', 'state', 'renamed.json'), path.join(tmp, 'renamed-out.json'));
        git(['add', '-A'], { cwd: tmp });
        git(['commit', '-q', '-m', 'matrix'], { cwd: tmp });
        const head = git(['rev-parse', 'HEAD'], { cwd: tmp }).stdout.trim();
        const blocked = spawnSync('node', [scannerPath, '--range', base, head], { cwd: tmp, encoding: 'utf8' });
        assert.strictEqual(blocked.status, 1, blocked.stderr);
        for (const rel of ['added.json', 'modified.json', 'copied.txt', 'renamed.json']) {
            assert.ok(blocked.stderr.includes(rel), `el rango no reportó ${rel}: ${blocked.stderr}`);
        }

        fs.writeFileSync(path.join(tmp, 'clean.txt'), 'functional change');
        git(['add', 'clean.txt'], { cwd: tmp });
        git(['commit', '-q', '-m', 'clean'], { cwd: tmp });
        const cleanHead = git(['rev-parse', 'HEAD'], { cwd: tmp }).stdout.trim();
        const clean = spawnSync('node', [scannerPath, '--range', head, cleanHead], { cwd: tmp, encoding: 'utf8' });
        assert.strictEqual(clean.status, 0, clean.stderr);
        assert.strictEqual((clean.stdout || '') + (clean.stderr || ''), '');
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});
