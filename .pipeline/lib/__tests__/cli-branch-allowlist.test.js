// =============================================================================
// Tests de la allowlist deny-by-default para copiar `.claude/` a un worktree
// nuevo (#5220, CA-2.c).
//
// ⚠️ Estos tests validan la DEFENSA EN PROFUNDIDAD, no CA-2. Está verificado
// que el `cpSync` de `scripts/cli-branch.js` no se ejecuta (G1) y que el
// productor real vive fuera del repo (#5264). CA-2 se acredita por evidencia
// empírica sobre un worktree real, nunca por inspección de código (CA-2.b).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isAllowed, claudeCopyFilter, ALLOWLIST, DENY } = require('../claude-copy-allowlist');

test('la copia de .claude excluye telegram-config.json', () => {
  // CA-2.c — es el archivo que originó #5220.
  assert.strictEqual(isAllowed('hooks/telegram-config.json'), false);
  // …pero el resto de hooks/ sí se copia: sin hooks el worktree no funciona.
  assert.strictEqual(isAllowed('hooks/pretooluse.js'), true);
  assert.strictEqual(isAllowed('hooks/messaging-config.json.example'), true);
});

test('el deny del secreto es por forma y no por ruta exacta', () => {
  // El deny original era el path literal `hooks/telegram-config.json`, pero
  // `hooks/` está allowlisteado EN BLOQUE: cualquier variante del nombre se
  // copiaba al destino. Hoy no existe ninguno de estos archivos; la allowlist
  // tiene que resistir que aparezcan.
  for (const variante of [
    'hooks/telegram-config.json',
    'hooks/telegram-config.json.bak',
    'hooks/telegram-config.json.orig',
    'hooks/telegram-config.local.json',
    'hooks/tests/telegram-config.json',
    'hooks/backup/telegram-config.json.2026-07-30',
    'telegram-config.json',
  ]) {
    assert.strictEqual(isAllowed(variante), false, `debería bloquear: ${variante}`);
  }
  // Y no se pasa de rosca: un hook cuyo nombre sólo MENCIONA telegram sí se copia.
  assert.strictEqual(isAllowed('hooks/telegram-notify.js'), true);
  assert.strictEqual(isAllowed('hooks/telegram-config-loader.js'), false,
    'un loader que arranca con `telegram-config` cae del lado conservador');
});

test('la copia de .claude no recursa en worktrees ni sessions', () => {
  // Corte de recursión: sin esto se copian copias de copias.
  for (const denegado of [
    'worktrees', 'worktrees/otro/.claude/hooks/telegram-config.json',
    'sessions', 'sessions/abc.json',
    'sessions-archive/x.json', 'tmp/scratch.txt',
  ]) {
    assert.strictEqual(isAllowed(denegado), false, `debería bloquear: ${denegado}`);
  }
});

test('la allowlist es deny-by-default: lo no enumerado no se copia', () => {
  for (const noEnumerado of ['algo-nuevo.json', 'secretos/creds.json', 'x/y/z.txt']) {
    assert.strictEqual(isAllowed(noEnumerado), false, `debería bloquear: ${noEnumerado}`);
  }
  for (const permitido of ['settings.json', 'skills/qa/SKILL.md', 'icons/a.svg', 'dashboard-server.js']) {
    assert.strictEqual(isAllowed(permitido), true, `debería copiar: ${permitido}`);
  }
});

test('la copia de .claude excluye estado de runtime (jsonl, pid, lock, heartbeat)', () => {
  for (const runtime of [
    'activity-log.jsonl', 'hooks/agent.pid', 'hooks/telegram-commander.lock',
    'hooks/x.heartbeat', 'hooks/x.heartbeat.stale', 'settings.local.json',
  ]) {
    assert.strictEqual(isAllowed(runtime), false, `debería bloquear: ${runtime}`);
  }
});

test('el deny gana sobre el allow', () => {
  // `hooks` está en la allowlist y `hooks/telegram-config.json` en el deny.
  assert.ok(ALLOWLIST.includes('hooks'));
  assert.ok(DENY.includes('hooks/telegram-config.json'));
  assert.strictEqual(isAllowed('hooks/telegram-config.json'), false);
});

test('claudeCopyFilter aplicado con fs.cpSync no deja el secreto en el destino', () => {
  // Verificación de comportamiento real, no de la lista: se copia de verdad.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '5220-cp-'));
  const src = path.join(tmp, 'origen', '.claude');
  const dst = path.join(tmp, 'destino', '.claude');
  fs.mkdirSync(path.join(src, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(src, 'worktrees', 'viejo'), { recursive: true });
  fs.mkdirSync(path.join(src, 'skills'), { recursive: true });

  fs.writeFileSync(path.join(src, 'settings.json'), '{}');
  fs.writeFileSync(path.join(src, 'hooks', 'telegram-config.json'), '{"bot_token":"secreto"}');
  fs.writeFileSync(path.join(src, 'hooks', 'util.js'), '// hook');
  fs.writeFileSync(path.join(src, 'skills', 'x.md'), '# skill');
  fs.writeFileSync(path.join(src, 'activity-log.jsonl'), '{}\n');
  fs.writeFileSync(path.join(src, 'worktrees', 'viejo', 'basura.json'), '{}');

  fs.cpSync(src, dst, { recursive: true, filter: claudeCopyFilter(src) });

  assert.strictEqual(fs.existsSync(path.join(dst, 'hooks', 'telegram-config.json')), false,
    'el secreto no llegó a tocar el disco del destino');
  assert.strictEqual(fs.existsSync(path.join(dst, 'worktrees')), false);
  assert.strictEqual(fs.existsSync(path.join(dst, 'activity-log.jsonl')), false);
  assert.strictEqual(fs.existsSync(path.join(dst, 'settings.json')), true, 'lo permitido sí se copia');
  assert.strictEqual(fs.existsSync(path.join(dst, 'hooks', 'util.js')), true);
  assert.strictEqual(fs.existsSync(path.join(dst, 'skills', 'x.md')), true);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scripts/cli-branch.js usa el filtro en su cpSync', () => {
  // Guarda anti-regresión: si alguien vuelve al `cpSync` sin filtro, falla.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'cli-branch.js'), 'utf8');
  assert.ok(src.includes('claude-copy-allowlist'), 'debe requerir la allowlist');
  assert.match(src, /cpSync\([^)]*filter:\s*claudeCopyFilter/s,
    'el cpSync de .claude debe ir filtrado');
});

test('scripts/dev-functions.sh preserva trackeados y filtra antes de copiar', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'dev-functions.sh'), 'utf8');
  assert.ok(!sh.includes('rm -rf "$current_dir/.claude"'),
    'no debe borrar el árbol trackeado que materializó git worktree');
  assert.ok(sh.includes('_allow=('), 'debe copiar por allowlist explícita');
  // El deny se espeja por FORMA, no por ruta exacta: `hooks/` se copia en
  // bloque, así que un `.bak` o un `hooks/tests/telegram-config.json` se colaba.
  assert.match(sh, /telegram-config\*\|\*\/telegram-config\*[^]*continue/,
    'debe excluir toda variante del archivo con secretos antes del cp');
  assert.ok(!/case "\$_rel" in[^]*?hooks\/telegram-config\.json\|/.test(sh),
    'el deny literal por ruta exacta quedó reemplazado por el glob de forma');
  assert.ok(!sh.includes('rm -f "$current_dir/.claude/hooks/telegram-config.json"'),
    'no debe post-borrar el secreto después de copiarlo');
  assert.ok(!/cp -r "\$_INTRALE_MAIN\/\.claude" "\$current_dir\/\.claude"/.test(sh),
    'ya no debe existir el cp -r completo sin filtro');
});
