// =============================================================================
// Tests del barrido de credenciales replicadas (#5220).
//
// Los valores sintéticos de este archivo NO son credenciales reales: se arman
// con prefijos válidos y relleno determinístico para ejercitar las formas.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scan = require('../secret-leak-scan');

// --- Valores sintéticos (forma válida, valor inventado) ----------------------
const FAKE = {
  botToken: '123456789:AAFakeSyntheticTokenForTestsOnly0123456789',
  openai: 'sk-proj-FakeSyntheticOpenAiKeyForTestsOnly000111222333',
  googleSecret: 'GOCSPX-FakeSyntheticClientSecret01',   // 35 chars, como el real
  googleRefresh: '1//FakeSyntheticRefreshTokenForTestsOnly0123456789',
  aws: 'AKIAFAKESYNTHETIC123',
};

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `5220-${prefix}-`));
}

// -----------------------------------------------------------------------------
// classifyValue — clasificador de dos ejes
// -----------------------------------------------------------------------------

test('classifyValue distingue valor real de placeholder MOVED_TO_HOME_DOT_CLAUDE_SECRETS', () => {
  const real = scan.classifyValue('bot_token', FAKE.botToken);
  assert.strictEqual(real.verdict, 'real');
  assert.strictEqual(real.kind, 'telegram_bot_token');

  for (const ph of ['MOVED_TO_HOME_DOT_CLAUDE_SECRETS', 'REVOKED', 'PLACEHOLDER', 'CHANGE_ME']) {
    assert.strictEqual(scan.classifyValue('bot_token', ph).verdict, 'placeholder',
      `"${ph}" debería clasificar como placeholder`);
  }
});

test('classifyValue no reporta _secrets_note como hallazgo', () => {
  // `guru` midió 198 descartes sobre 226 ocurrencias (88 %) con un matcher
  // sólo-por-nombre: `_secrets_note` es prosa, la mata el eje 2.
  const nota = 'Los secretos ahora viven en ~/.claude/secrets/credentials.json';
  assert.strictEqual(scan.classifyValue('_secrets_note', nota).verdict, 'not-secret');
});

test('classifyValue no reporta google_credentials_path como hallazgo', () => {
  for (const p of [
    'C:\\Users\\Administrator\\.claude\\secrets\\credentials.json',
    '/home/user/.claude/secrets/credentials.json',
    './config/creds.json',
    '~/.claude/secrets/credentials.json',
  ]) {
    assert.strictEqual(scan.classifyValue('google_credentials_path', p).verdict, 'not-secret',
      `"${p}" es un path, no un secreto`);
  }
});

test('classifyValue reconoce bot_token, openai, GOCSPX- y refresh_token de Google', () => {
  const casos = [
    ['bot_token', FAKE.botToken, 'telegram_bot_token'],
    ['openai_api_key', FAKE.openai, 'openai_api_key'],
    ['google_oauth_client_secret', FAKE.googleSecret, 'google_client_secret'],
    ['google_oauth_refresh_token', FAKE.googleRefresh, 'google_refresh_token'],
    ['aws_access_key_id', FAKE.aws, 'aws_access_key'],
  ];
  for (const [key, value, kind] of casos) {
    const r = scan.classifyValue(key, value);
    assert.strictEqual(r.verdict, 'real', `${key} debería ser real`);
    assert.strictEqual(r.kind, kind, `${key} debería clasificar como ${kind}`);
  }
});

test('classifyValue exige los DOS ejes: nombre de clave mas forma de valor', () => {
  // Forma de secreto pero nombre inocuo → no es hallazgo (evita los falsos
  // positivos que midió `guru`).
  assert.strictEqual(scan.classifyValue('descripcion', FAKE.botToken).verdict, 'not-secret');
  // Nombre de secreto pero valor sin forma → tampoco.
  assert.strictEqual(scan.classifyValue('bot_token', 'hola').verdict, 'not-secret');
});

test('classifyValue nunca devuelve el valor ni una subcadena suya', () => {
  // ⛔ CA-3 — BLOQUEANTE. El control es estructural: el resultado no tiene
  // campo `value`, así que es imposible filtrarlo aguas abajo.
  for (const [key, value] of Object.entries({
    bot_token: FAKE.botToken,
    openai_api_key: FAKE.openai,
    google_oauth_client_secret: FAKE.googleSecret,
    google_oauth_refresh_token: FAKE.googleRefresh,
  })) {
    const r = scan.classifyValue(key, value);
    assert.strictEqual(r.verdict, 'real');
    assert.ok(!('value' in r), 'el resultado NO debe tener campo `value`');

    const serializado = JSON.stringify(r);
    // Falla ante CUALQUIER subcadena de 8+ chars del valor, no sólo el completo.
    for (let i = 0; i + 8 <= value.length; i++) {
      const sub = value.slice(i, i + 8);
      assert.ok(!serializado.includes(sub),
        `el resultado filtró la subcadena "${sub.slice(0, 3)}…" del valor de ${key}`);
    }
    // Lo que sí tiene que estar: identificación sin revelación.
    assert.match(r.hash8, /^[0-9a-f]{8}$/);
    assert.strictEqual(r.len, value.length);
  }
});

// -----------------------------------------------------------------------------
// classifyRemediation — tres categorías, nunca dos
// -----------------------------------------------------------------------------

test('classifyRemediation separa purgable, historial y no-verificable', () => {
  const root = 'C:/wt/platform.session-x';
  const mk = (rel, extra = {}) => ({
    root, file: `${root}/${rel}`, rel, key: 'bot_token', kind: 'telegram_bot_token',
    hash8: 'aabbccdd', len: 46, ...extra,
  });

  // fs falso: la raíz es un árbol git (tiene `.git`).
  const fsImpl = { statSync: (p) => {
    if (String(p).replace(/\\/g, '/') === `${root}/.git`) return { isDirectory: () => true };
    throw new Error('ENOENT');
  } };
  // git falso: sólo `.claude/hooks/telegram-config.json` está trackeado.
  const spawnImpl = () => ({ status: 0, stdout: '.claude/hooks/telegram-config.json\0' });

  assert.strictEqual(
    scan.classifyRemediation(mk('.claude/hooks/telegram-config.json'), { spawnImpl, fsImpl }),
    'historial', 'un trackeado se re-materializa en el próximo checkout: no se purga');

  assert.strictEqual(
    scan.classifyRemediation(mk('.claude/.claude/hooks/telegram-config.json'), { spawnImpl, fsImpl }),
    'purgable', 'la copia anidada es untracked: se purga');

  assert.strictEqual(
    scan.classifyRemediation(mk('.claude/roto.json', { category: 'no-verificable' }), { spawnImpl, fsImpl }),
    'no-verificable', 'lo que nació no-verificable lo sigue siendo');

  // git que falla ⇒ fail-closed, NUNCA "purgable" por optimismo.
  const spawnRoto = () => ({ status: 128, stdout: '', error: new Error('git murió') });
  assert.strictEqual(
    scan.classifyRemediation(mk('.claude/hooks/telegram-config.json'), { spawnImpl: spawnRoto, fsImpl }),
    'no-verificable', 'si no se puede consultar git, no se puede afirmar nada');
});

// -----------------------------------------------------------------------------
// purgeFindings — por archivo, jamás por directorio ni por worktree
// -----------------------------------------------------------------------------

test('purgeFindings borra solo untracked y nunca directorios ni worktrees', () => {
  const tmp = mkTmpDir('purge');
  const root = path.join(tmp, 'platform.session-fake');
  const nested = path.join(root, '.claude', '.claude', 'hooks');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });

  const purgable = path.join(nested, 'telegram-config.json');
  const tracked = path.join(root, '.claude', 'hooks', 'telegram-config.json');
  const dirTarget = path.join(root, '.claude', '.claude');
  fs.writeFileSync(purgable, '{"bot_token":"x"}');
  fs.writeFileSync(tracked, '{"bot_token":"x"}');

  const mk = (file, category) => ({
    root: root.replace(/\\/g, '/'), file: file.replace(/\\/g, '/'),
    rel: path.relative(root, file).replace(/\\/g, '/'),
    key: 'bot_token', kind: 'telegram_bot_token', hash8: 'aabbccdd', len: 46, category,
  });

  const { purged, skipped } = scan.purgeFindings(
    [mk(purgable, 'purgable'), mk(tracked, 'historial'), mk(dirTarget, 'purgable')],
    { dryRun: false, mainRepo: path.join(tmp, 'platform') }
  );

  assert.strictEqual(purged.length, 1, 'sólo el untracked se purga');
  assert.strictEqual(fs.existsSync(purgable), false, 'el untracked fue eliminado');
  assert.strictEqual(fs.existsSync(tracked), true, 'el trackeado NO se toca (R4)');
  assert.strictEqual(fs.existsSync(dirTarget), true, 'jamás se borra un directorio (CA-9)');
  assert.ok(skipped.some((s) => s.skipReason.includes('no es un archivo regular')));
  assert.ok(skipped.some((s) => s.skipReason.includes('historial')));

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('purgeFindings en dry-run no toca el disco', () => {
  const tmp = mkTmpDir('dry');
  const root = path.join(tmp, 'platform.session-fake');
  const dir = path.join(root, '.claude', '.claude', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'telegram-config.json');
  fs.writeFileSync(file, '{"bot_token":"x"}');

  const { purged } = scan.purgeFindings([{
    root: root.replace(/\\/g, '/'), file: file.replace(/\\/g, '/'),
    rel: '.claude/.claude/hooks/telegram-config.json',
    key: 'bot_token', kind: 'telegram_bot_token', hash8: 'a1b2c3d4', len: 46, category: 'purgable',
  }], { dryRun: true, mainRepo: path.join(tmp, 'platform') });

  assert.strictEqual(purged.length, 1);
  assert.strictEqual(purged[0].removed, false);
  assert.strictEqual(fs.existsSync(file), true, 'dry-run no borra: la purga es el ÚLTIMO paso (R8/CA-7)');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('purgeFindings rechaza un path fuera del .claude de la raiz barrida', () => {
  const tmp = mkTmpDir('escape');
  const root = path.join(tmp, 'platform.session-fake');
  fs.mkdirSync(root, { recursive: true });
  const afuera = path.join(tmp, 'importante.json');
  fs.writeFileSync(afuera, '{}');

  const { purged, skipped } = scan.purgeFindings([{
    root: root.replace(/\\/g, '/'), file: afuera.replace(/\\/g, '/'),
    rel: '../importante.json', key: 'token', kind: 'telegram_bot_token',
    hash8: 'a1b2c3d4', len: 46, category: 'purgable',
  }], { dryRun: false, mainRepo: path.join(tmp, 'platform') });

  assert.strictEqual(purged.length, 0);
  assert.strictEqual(fs.existsSync(afuera), true, 'no se sale del .claude/ barrido');
  assert.ok(skipped[0].skipReason.includes('fuera del'));

  fs.rmSync(tmp, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// scanLeakedSecrets — fail-closed
// -----------------------------------------------------------------------------

test('scanLeakedSecrets contabiliza no parseables en vez de reportar limpio', () => {
  const tmp = mkTmpDir('scan');
  const root = path.join(tmp, 'platform.session-fake');
  const hooks = path.join(root, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });

  fs.writeFileSync(path.join(hooks, 'ok.json'), JSON.stringify({ bot_token: FAKE.botToken }));
  // JSON roto por marcadores de conflicto de git, como los 419 medidos en disco.
  fs.writeFileSync(path.join(hooks, 'roto.json'), '{\n<<<<<<< HEAD\n"a": 1,\n=======\n"a": 2,\n>>>>>>> x\n}');

  const r = scan.scanLeakedSecrets({ roots: [root] });

  assert.strictEqual(r.filesUnparseable, 1, 'el JSON roto se cuenta como no parseable');
  const noVerif = r.findings.filter((f) => f.category === 'no-verificable');
  assert.strictEqual(noVerif.length, 1, 'y emite un hallazgo propio: nunca se traga en silencio');
  assert.match(noVerif[0].reason, /conflicto de git/);
  assert.ok(r.findings.some((f) => f.kind === 'telegram_bot_token'), 'el JSON sano sí se barre');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scanLeakedSecrets parsea JSONL guardado con extension .json', () => {
  const tmp = mkTmpDir('jsonl');
  const hooks = path.join(tmp, 'wt', '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'metrics.json'),
    `{"a":1}\n{"bot_token":"${FAKE.botToken}"}\n`);

  const r = scan.scanLeakedSecrets({ roots: [path.join(tmp, 'wt')] });
  assert.strictEqual(r.filesUnparseable, 0, 'JSONL válido no es "no verificable"');
  assert.ok(r.findings.some((f) => f.kind === 'telegram_bot_token'), 'y se barre su contenido');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scanLeakedSecrets falla cerrado al alcanzar el limite de profundidad', () => {
  const tmp = mkTmpDir('depth-limit');
  const root = path.join(tmp, 'platform.session-fake');
  let deepDir = path.join(root, '.claude');
  for (let i = 0; i < 7; i++) deepDir = path.join(deepDir, `nivel-${i}`);
  fs.mkdirSync(deepDir, { recursive: true });
  fs.writeFileSync(path.join(deepDir, 'secreto.json'),
    JSON.stringify({ refresh_token: FAKE.refreshToken }));

  const r = scan.scanLeakedSecrets({ roots: [root] });

  assert.strictEqual(r.filesScanned, 0, 'el archivo fuera del límite no se declara inspeccionado');
  assert.strictEqual(r.filesUnparseable, 1, 'la superficie omitida se contabiliza');
  assert.strictEqual(r.errors.length, 1, 'el límite queda visible como error de barrido');
  assert.ok(r.findings.some((f) =>
    f.category === 'no-verificable' &&
    f.kind === 'limite-profundidad' &&
    /profundidad 7 supera el límite 6/.test(f.reason)));
  assert.strictEqual(scan.computeExitCode({
    leakedSecrets: r.findings,
    secretsScanErrors: r.errors,
    secretsUnparseable: r.filesUnparseable,
  }), scan.EXIT_CODES.UNVERIFIABLE);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scanLeakedSecrets falla cerrado ante un JSON mayor a 2 MiB', () => {
  const tmp = mkTmpDir('size-limit');
  const root = path.join(tmp, 'platform.session-fake');
  const hooks = path.join(root, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'secreto-grande.json'), JSON.stringify({
    refresh_token: FAKE.refreshToken,
    padding: 'x'.repeat(2 * 1024 * 1024),
  }));

  const r = scan.scanLeakedSecrets({ roots: [root] });

  assert.strictEqual(r.filesScanned, 0, 'el archivo fuera del límite no se declara inspeccionado');
  assert.strictEqual(r.filesUnparseable, 1, 'el JSON grande se contabiliza');
  assert.strictEqual(r.errors.length, 1, 'el límite queda visible como error de barrido');
  assert.ok(r.findings.some((f) =>
    f.category === 'no-verificable' &&
    f.kind === 'limite-tamano' &&
    /tamaño .* supera el límite 2097152 bytes/.test(f.reason)));
  assert.strictEqual(scan.computeExitCode({
    leakedSecrets: r.findings,
    secretsScanErrors: r.errors,
    secretsUnparseable: r.filesUnparseable,
  }), scan.EXIT_CODES.UNVERIFIABLE);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('el barrido crudo encuentra un secreto dentro de un archivo que no parsea', () => {
  // Sin esta pasada, un secreto en un archivo con conflictos quedaría invisible:
  // el operador leería "no pude verificar" y seguiría de largo.
  const hits = scan.scanRawFallback(
    `{\n<<<<<<< HEAD\n  "bot_token": "${FAKE.botToken}",\n=======\n  "x": 1\n>>>>>>> otra\n}`);
  assert.ok(hits.some((h) => h.kind === 'telegram_bot_token'));
  const s = JSON.stringify(hits);
  assert.ok(!s.includes(FAKE.botToken.slice(10, 25)), 'tampoco acá viaja el valor');
});

test('el barrido no agrega entradas al git status ni deja trackeados en M o D', () => {
  // CA-4 — el dry-run es de sólo lectura por construcción: el único punto que
  // escribe es `purgeFindings`, y en dry-run no llama a `unlinkSync`.
  const tmp = mkTmpDir('gitstatus');
  const root = path.join(tmp, 'platform.session-fake');
  const hooks = path.join(root, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'cfg.json'), JSON.stringify({ bot_token: FAKE.botToken }));

  const antes = fs.readdirSync(hooks).sort();
  const mtimeAntes = fs.statSync(path.join(hooks, 'cfg.json')).mtimeMs;

  const r = scan.scanLeakedSecrets({ roots: [root] });
  scan.purgeFindings(r.findings.map((f) => ({ ...f, category: 'historial' })), { dryRun: true });

  assert.deepStrictEqual(fs.readdirSync(hooks).sort(), antes, 'no se creó ni borró nada');
  assert.strictEqual(fs.statSync(path.join(hooks, 'cfg.json')).mtimeMs, mtimeAntes,
    'no se modificó ningún archivo: cero entradas nuevas en git status');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Rotación, agrupado y exit codes
// -----------------------------------------------------------------------------

test('rotationStatusOf marca PENDIENTE salvo rotacion con revocacion verificada', () => {
  const f = { hash8: 'aabbccdd' };
  assert.strictEqual(scan.rotationStatusOf(f, new Map()).rotated, false);

  const parcial = new Map([['aabbccdd', { rotated_at: '2026-07-30', revoked: false }]]);
  assert.strictEqual(scan.rotationStatusOf(f, parcial).rotated, false);

  const sinVerificar = new Map([['aabbccdd', { rotated_at: '2026-07-30', revoked: true }]]);
  assert.strictEqual(scan.rotationStatusOf(f, sinVerificar).rotated, false);

  const completa = new Map([['aabbccdd',
    { rotated_at: '2026-07-30', revoked: true, verified_at: '2026-07-30' }]]);
  assert.strictEqual(scan.rotationStatusOf(f, completa).rotated, true);
});

test('groupFindings agrupa por credencial distinta sin perder ningun archivo', () => {
  const mk = (root) => ({
    root, file: `${root}/.claude/.claude/hooks/telegram-config.json`, rel: 'x',
    key: 'bot_token', kind: 'telegram_bot_token', hash8: 'aabbccdd', len: 46, category: 'purgable',
  });
  const g = scan.groupFindings([mk('/a'), mk('/b'), mk('/c')]);
  assert.strictEqual(g.length, 1, 'una línea por credencial distinta');
  assert.strictEqual(g[0].count, 3, 'sin perder ninguno: agrupar comprime, truncar pierde');
  assert.strictEqual(g[0].roots.length, 3);
});

test('computeExitCode devuelve el codigo semantico mas alto', () => {
  const E = scan.EXIT_CODES;
  assert.strictEqual(computeFor([]), E.CLEAN);
  assert.strictEqual(computeFor([{ category: 'purgable', removed: false }]), E.PURGABLE_PENDING);
  assert.strictEqual(computeFor([{ category: 'no-verificable' }]), E.UNVERIFIABLE);
  assert.strictEqual(computeFor([{ category: 'historial', rotated: false }]), E.UNROTATED);
  assert.strictEqual(computeFor([{ category: 'historial', rotated: true }]), E.CLEAN);
  // Gana el más alto.
  assert.strictEqual(
    computeFor([{ category: 'purgable', removed: false }, { category: 'historial', rotated: false }]),
    E.UNROTATED);
  // Un error del barrido también es fail-closed.
  assert.strictEqual(
    scan.computeExitCode({ leakedSecrets: [], secretsScanErrors: [{ reason: 'x' }] }),
    E.UNVERIFIABLE);

  function computeFor(leakedSecrets) {
    return scan.computeExitCode({ leakedSecrets, secretsScanErrors: [], secretsUnparseable: 0 });
  }
});

test('quickNestedClaudeCheck detecta la firma de la fuga sin parsear ni consultar git', () => {
  const tmp = mkTmpDir('quick');
  const conAnidado = path.join(tmp, 'platform.session-a');
  const sinAnidado = path.join(tmp, 'platform.agent-b');
  fs.mkdirSync(path.join(conAnidado, '.claude', '.claude'), { recursive: true });
  fs.mkdirSync(path.join(sinAnidado, '.claude'), { recursive: true });

  const q = scan.quickNestedClaudeCheck({ roots: [conAnidado, sinAnidado] });
  assert.strictEqual(q.nestedClaudeCopies, 1);
  assert.ok(q.roots[0].includes('platform.session-a'));

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('enumerateScanRoots enumera por existencia de .claude, no por glob de nombre', () => {
  const tmp = mkTmpDir('enum');
  const main = path.join(tmp, 'platform');
  fs.mkdirSync(path.join(main, '.pipeline', '_tmp', 'ux-2761-rebounce', '.claude'), { recursive: true });
  fs.mkdirSync(path.join(main, '.pipeline', '_tmp', 'sin-claude'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'platform.session-x', '.claude'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'platform.session-y'), { recursive: true });   // sin .claude

  const roots = scan.enumerateScanRoots({ mainRepo: main, workspaces: tmp }).map((p) => path.basename(p));
  assert.ok(roots.includes('platform.session-x'));
  assert.ok(roots.includes('ux-2761-rebounce'), 'un glob `*-worktree` lo dejaría afuera');
  assert.ok(!roots.includes('sin-claude'));
  assert.ok(!roots.includes('platform.session-y'));

  fs.rmSync(tmp, { recursive: true, force: true });
});
