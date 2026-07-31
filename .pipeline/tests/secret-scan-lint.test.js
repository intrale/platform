'use strict';

// #5244 rev-2 — CA-UX-7: cero falsos positivos sobre código benigno.
// El rechazo de `ux` midió 13/60 commits de `main` bloqueados, 6 de ellos SÓLO
// por ruido. Este suite fija las líneas reales que bloqueaban como regresión.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sanitizerModule = require('../sanitizer.js');
const {
  CONFIG_ONLY, IGNORE_MARKER, LINT_ALWAYS, createLintSanitizer, isConfigPath,
  looksLikeSecret, selectPatterns, shannonEntropy, stripIgnoredLines,
} = require('../lib/secret-scan-lint');
const { findingFor, run } = require('../lib/precommit-secret-scan');

const EMPTY_ALLOWLIST = path.join(__dirname, '..', 'secret-scan-allowlist.json');
const lint = createLintSanitizer(sanitizerModule);

// Los literales con forma de secreto se arman en runtime: escritos enteros,
// este archivo dispararía su propio gate (misma política que el test de contenido).
const GITHUB_TOKEN = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMN'].join('');
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'ABCDEFG'].join('');
const OPAQUE = ['Zk9pQ2xWb3JmN3RhU2Rm', 'Z0hqS2xQb1d4Q3pWYk5t', 'QXNkRmdIakts'].join('');
const KEY_NAME = ['api', 'Key'].join('');

function bloquea(text, filePath) {
  const finding = findingFor({ path: filePath, startLine: 1, text }, lint);
  return finding !== null;
}

// ── Las 6 líneas benignas que bloqueaban `main` (rechazo rev-1) ──────────────

const BENIGNAS = [
  ['.pipeline/lib/operational-state.js', 'const token = String(errors[0]).trim().split(/\\s+/)[0];'],
  ['users/src/main/kotlin/ar/com/intrale/kernel/OperatorIdentity.kt', 'val token = this["Authorization"] ?: this["authorization"]'],
  ['.pipeline/views/dashboard/estado-productos.js', 'var token=tj&&tj.csrf_token;'],
  ['.pipeline/lib/product-seed.js', 'const token = resolved.scopes && resolved.scopes[PROJECT_SCOPE];'],
  ['docs/pipeline/kernel-release-workflow-security-signoff.md', 'El job `publish` corre con `contents: write` + `packages: write` + `id-token: write`.'],
  ['.pipeline/lib/product-control-drain.js', '// URL limpia — NUNCA la remote con `x-access-token:<TOKEN>@` (A05/A07).'],
];

for (const [filePath, linea] of BENIGNAS) {
  test(`CA-UX-7: no bloquea código benigno en ${path.basename(filePath)}`, () => {
    assert.equal(bloquea(linea, filePath), false, `bloqueó: ${linea}`);
  });
}

test('CA-UX-7: el modo redacción sigue tapando esas mismas líneas', () => {
  // El fix calibra el LINT, no debilita la REDACCIÓN de mensajes/estado.
  const redactado = sanitizerModule.sanitize(BENIGNAS[0][1]);
  assert.match(redactado, /\[REDACTED:CONF_VALUE\]/);
});

// ── CA-8: el gate sigue cazando el caso real ────────────────────────────────

test('CA-8: un secreto con forma real bloquea en un path no anticipado', () => {
  assert.equal(bloquea(`{"token":"${GITHUB_TOKEN}"}`, '.claude/hooks/inesperado.json'), true);
  assert.equal(bloquea(`user ${AWS_KEY} en el runtime`, 'docs/notas.md'), true);
});

test('los genéricos por nombre de clave siguen activos en archivos de config', () => {
  const linea = `${KEY_NAME}: unvalorcualquiera`;
  assert.equal(bloquea(linea, 'config/app.yml'), true, 'yml es config: el genérico aplica');
  assert.equal(bloquea(linea, '.env.production'), true, '.env es config: el genérico aplica');
  assert.equal(bloquea(linea, 'src/Main.kt'), false, 'código fuente: el genérico NO aplica');
});

test('HARDCODED_SECRET caza un literal opaco en código fuente', () => {
  assert.equal(
    bloquea(`val ${KEY_NAME} = "${OPAQUE}"`, 'src/Main.kt'), true,
    'un literal entrecomillado con forma de secreto tiene que bloquear igual',
  );
  assert.equal(
    bloquea(`const ${KEY_NAME} = process.env.API_KEY;`, 'src/main.js'), false,
    'leer de env no es un secreto hardcodeado',
  );
  assert.equal(
    bloquea(`const ${KEY_NAME} = "your-api-key-here-placeholder";`, 'src/main.js'), false,
    'un placeholder evidente no bloquea',
  );
});

test('AUTH_HEADER_LITERAL exige el esquema y un valor opaco', () => {
  assert.equal(bloquea(`Authorization: Bearer ${OPAQUE}`, 'docs/api.md'), true);
  assert.equal(
    bloquea('Authorization: Bearer ${accessToken}', 'src/client.js'), false,
    'una interpolación no es un secreto',
  );
  assert.equal(
    bloquea('val header = this["Authorization"]', 'src/Auth.kt'), false,
    'leer el nombre del header no es un secreto',
  );
});

// ── Escape por línea ────────────────────────────────────────────────────────

test(`"${IGNORE_MARKER}" excluye sólo esa línea`, () => {
  const conMarca = `const fixture = "${GITHUB_TOKEN}"; // ${IGNORE_MARKER}`;
  assert.equal(bloquea(conMarca, 'test/fixtures.js'), false);
  assert.equal(
    bloquea(`${conMarca}\nconst otro = "${GITHUB_TOKEN}";`, 'test/fixtures.js'), true,
    'la marca no puede apagar el escaneo del resto del hunk',
  );
});

test('stripIgnoredLines preserva la cantidad de líneas', () => {
  const resultado = stripIgnoredLines(`uno\ndos ${IGNORE_MARKER}\ntres`);
  assert.equal(resultado.ignored, 1);
  assert.equal(resultado.text.split('\n').length, 3);
  assert.equal(resultado.text, 'uno\n\ntres');
});

test('el escape no puede partir un secreto multilínea para colarlo', () => {
  // Los delimitadores PEM también se arman en runtime: escritos enteros en una
  // sola línea, el patrón multilínea matchea y este archivo bloquea su commit.
  const abrir = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const cerrar = ['-----END ', 'PRIVATE KEY-----'].join('');
  const pem = [abrir, 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=', cerrar].join('\n');
  assert.equal(bloquea(pem, 'src/keys.txt'), true);
  // Marcar el medio no reconstruye un PEM válido: BEGIN y END siguen y el
  // patrón multilínea sigue matcheando.
  const conMarca = pem.split('\n').map((l, i) => (i === 1 ? `${l} ${IGNORE_MARKER}` : l)).join('\n');
  assert.equal(bloquea(conMarca, 'src/keys.txt'), true);
});

// ── Contrato del clasificador ───────────────────────────────────────────────

test('todo patrón de sanitizer.js está clasificado explícitamente', () => {
  const sinClasificar = sanitizerModule.__forTestsOnly__.PATTERNS
    .map(({ name }) => name)
    .filter((name) => !LINT_ALWAYS.has(name) && !CONFIG_ONLY.has(name));
  assert.deepEqual(
    sinClasificar, [],
    'un patrón nuevo en sanitizer.js debe declararse en LINT_ALWAYS o CONFIG_ONLY',
  );
});

test('selectPatterns filtra los genéricos fuera de los archivos de config', () => {
  const enCodigo = selectPatterns(sanitizerModule.__forTestsOnly__.PATTERNS, 'a.js').map((p) => p.name);
  const enConfig = selectPatterns(sanitizerModule.__forTestsOnly__.PATTERNS, 'a.json').map((p) => p.name);
  assert.equal(enCodigo.includes('CONF_STRUCTURED'), false);
  assert.equal(enConfig.includes('CONF_STRUCTURED'), true);
  assert.equal(enCodigo.includes('AWS_ACCESS_KEY'), true, 'los específicos corren en todos lados');
});

test('isConfigPath reconoce config y descarta código y docs', () => {
  for (const p of ['a.json', 'b.yml', 'c.yaml', '.env', '.env.local', 'd.conf', 'e.properties', 'f.toml', 'dir/.npmrc']) {
    assert.equal(isConfigPath(p), true, `${p} debería ser config`);
  }
  for (const p of ['a.js', 'b.kt', 'c.md', 'd.ts', 'e.sh', 'Makefile', 'f.png']) {
    assert.equal(isConfigPath(p), false, `${p} no debería ser config`);
  }
});

test('looksLikeSecret rechaza identificadores y acepta valores opacos', () => {
  assert.equal(looksLikeSecret(OPAQUE), true);
  assert.equal(looksLikeSecret('corto123'), false, 'muy corto');
  assert.equal(looksLikeSecret('esto-es-un-slug-largo-de-verdad'), false, 'slug sin dígitos');
  assert.equal(looksLikeSecret('aaaaaaaaaaaaaaaaaaaaaaaa1'), false, 'entropía nula');
  assert.ok(shannonEntropy('aaaa') < shannonEntropy('a1B2c3D4'));
});

// ── Fail-closed preservado ──────────────────────────────────────────────────

test('el sanitizer de lint es fail-closed ante un patrón que explota', () => {
  const roto = createLintSanitizer({
    __forTestsOnly__: {
      normalizeForMatching: (t) => t,
      PATTERNS: [{ name: 'AWS_ACCESS_KEY', re: /x/g, replace: () => { throw new Error('boom'); } }],
    },
  });
  assert.match(roto('x', 'a.js'), /^\[SANITIZER_ERROR:/);
  assert.equal(
    findingFor({ path: 'a.js', startLine: 1, text: 'x' }, roto).error, 'SANITIZER_ERROR',
    'el marcador de error del sanitizer bloquea',
  );
});

test('createLintSanitizer rechaza un sanitizer sin PATTERNS en vez de fallar abierto', () => {
  assert.throws(() => createLintSanitizer({}), /no expone PATTERNS/);
});

test('run end-to-end usa el modo lint y no bloquea por ruido benigno', () => {
  const options = { allowlist: EMPTY_ALLOWLIST, format: 'text' };
  const limpio = run(options, {
    collectAddedHunks: () => BENIGNAS.map(([p, text], i) => ({ path: p, startLine: i + 1, text })),
  });
  assert.equal(limpio.exitCode, 0, limpio.output);
  assert.equal(limpio.output, '', 'happy path sin bytes en salida (CA-UX-4)');

  const bloqueado = run(options, {
    collectAddedHunks: () => [{ path: '.claude/hooks/x.json', startLine: 3, text: `{"token":"${GITHUB_TOKEN}"}` }],
  });
  assert.equal(bloqueado.exitCode, 1);
  assert.match(bloqueado.output, new RegExp(IGNORE_MARKER), 'el mensaje ofrece el escape por línea');
  assert.doesNotMatch(bloqueado.output, new RegExp(GITHUB_TOKEN), 'el valor crudo no se imprime');
});
