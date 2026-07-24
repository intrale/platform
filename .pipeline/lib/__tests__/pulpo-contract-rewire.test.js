// #3418 — Smoke contract test que valida que `pulpo.js` mantiene las
// regresiones críticas detectadas por [review] y [po] en el rebote del
// 2026-05-20. La PO pidió explícitamente este test (acción 5 del
// motivo_rechazo del ciclo anterior):
//
//   "Agregar smoke contract test que valide que pulpo.js:
//     - require('./lib/sherlock-verifier') está presente
//     - dispatcher.dispatch(...) recibe los campos voice/audio cuando vienen
//     - brazoBarrido tiene el branch dependency_block antes del drain"
//
// El test es deliberadamente grep-based contra el source de pulpo.js (no
// imports el módulo entero, que arrancaría el pipeline). Solo verifica que
// los markers críticos están presentes — si un futuro refactor cambia
// nombres pero mantiene la funcionalidad, el test falla y obliga al dev
// a actualizar este contrato explícitamente.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PULPO_PATH = path.resolve(__dirname, '..', '..', 'pulpo.js');
const SOURCE = fs.readFileSync(PULPO_PATH, 'utf8');

test('contract pulpo.js — require sherlock-verifier (#3343) presente', () => {
  // R1 del motivo de rechazo PO 2026-05-20: el commit cb5499b0 eliminó
  // el `require('./lib/sherlock-verifier')`, dejando el módulo vivo pero
  // desconectado. Esto desactivó la verificación adversarial pre-Telegram.
  assert.ok(
    /require\(['"]\.\/lib\/sherlock-verifier['"]\)/.test(SOURCE),
    'pulpo.js debe requerir ./lib/sherlock-verifier — sino el commander envía respuestas sin verificación adversarial'
  );
  // crypto se importa para el turnId de correlación Sherlock — también
  // se removió en cb5499b0 cuando se eliminó la sección Sherlock.
  assert.ok(
    /require\(['"]node:crypto['"]\)/.test(SOURCE),
    'pulpo.js debe importar node:crypto para generar turnId de correlación Sherlock'
  );
});

test('contract pulpo.js — sección Sherlock verifier wired en _brazoCommanderInner', () => {
  // Más allá del require, la sección que efectivamente invoca
  // `sherlockVerifier.verify(...)` antes de `sendTelegram` también fue
  // eliminada en cb5499b0. Verificamos que vuelve a estar.
  assert.ok(
    /sherlockVerifier\.verify\(/.test(SOURCE),
    'pulpo.js debe invocar sherlockVerifier.verify() para refutar la respuesta del commander pre-Telegram'
  );
  assert.ok(
    /sherlockVerifier\.applyDisclaimer\(/.test(SOURCE) || /applyDisclaimer\(/.test(SOURCE),
    'pulpo.js debe aplicar disclaimers F-5/F-6/F-7 cuando Sherlock detecta inconsistencias o aborta'
  );
});

test('contract pulpo.js — handler dependency_block (#3373/#3411) presente en brazoBarrido', () => {
  // R2 del motivo de rechazo PO 2026-05-20: el commit cb5499b0 eliminó
  // el branch que detecta rechazos con `rebote_categoria: dependency_block`
  // antes de drenar archivos a `procesado/`. Sin este branch, rechazos
  // dep_block vuelven a archivar .po/.ux con `cancelado_por: fast-fail-rebote`
  // y el brazoDesbloqueo nunca los recupera de procesado/.
  assert.ok(
    /hayDepBlockEnRechazos/.test(SOURCE),
    'brazoBarrido debe inspeccionar rechazos por dependency_block antes del drain — sino se reabre el bug #3361 (issue trabado ~10h)'
  );
  assert.ok(
    /dependency_block/.test(SOURCE),
    'pulpo.js debe referenciar la categoría "dependency_block" para clasificar rebotes'
  );
});

test('contract pulpo.js — releaseRes.swept log en brazoDesbloqueoImpl (#3373)', () => {
  // Parte de R2: el sweep defensivo que recupera archivos legacy de
  // `procesado/` cuando el desbloqueo se ejecuta también se eliminó.
  // Sin él, los archivos cancelados por fast-fail-rebote pre-#3373 no
  // se rescatan al cerrar la dependencia.
  assert.ok(
    /releaseRes\.swept/.test(SOURCE),
    'brazoDesbloqueoImpl debe loguear releaseRes.swept para forensics de recuperación de archivos legacy'
  );
});

test('contract pulpo.js — dispatcher.dispatch(...) recibe campos voice/audio (#3441/#3415)', () => {
  // R3 del motivo de rechazo PO 2026-05-20: el commit cb5499b0 eliminó
  // los campos voice_path/voice_file_size/voice_duration/_esAudio/_audio
  // del argumento de `dispatcher.dispatch(...)`. Sin esos campos, el
  // handler de `/rechazar` recibe `voice_path: undefined` y no puede
  // transcribir audio con whisper-local. Las defensas SEC-1.1..SEC-1.9
  // del #3441 (replay protection, límites 10MB/120s) no aplican porque
  // sus inputs ya no llegan.
  //
  // Buscamos las 4 keys en el bloque de dispatcher.dispatch (no en
  // cualquier parte del archivo) usando regex que cubre el shape:
  //   dispatcher.dispatch({ ... voice_path: m.voice_path, ... })
  const dispatchBlock = SOURCE.match(/dispatcher\.dispatch\(\{[\s\S]*?\}\)/);
  assert.ok(dispatchBlock, 'dispatcher.dispatch({...}) debe existir en pulpo.js');
  const block = dispatchBlock[0];
  assert.ok(/voice_path:\s*m\.voice_path/.test(block), 'dispatcher.dispatch debe propagar voice_path para /rechazar por audio');
  assert.ok(/voice_file_size:\s*m\.voice_file_size/.test(block), 'dispatcher.dispatch debe propagar voice_file_size (límite 10MB SEC-1.6)');
  assert.ok(/_esAudio:\s*m\._esAudio/.test(block), 'dispatcher.dispatch debe propagar _esAudio (flag de audio detectado)');
  assert.ok(/_audio:\s*m\._audio/.test(block), 'dispatcher.dispatch debe propagar _audio (metadata audio struct)');
});

test('contract pulpo.js — aportes del #3418 vivos (watchdog Skill + patterns continuativos)', () => {
  // Anti-regresión: los aportes propios del #3418 NO deben ser eliminados
  // por un futuro merge que toque pulpo.js. El test falla si alguien
  // remueve el watchdog Skill o la lógica de inferSkillResult.
  assert.ok(/SKILL_WATCHDOG_MS/.test(SOURCE), '#3418 watchdog: constante SKILL_WATCHDOG_MS debe estar definida');
  assert.ok(/pendingSkillCalls/.test(SOURCE), '#3418 watchdog: Map pendingSkillCalls debe trackear tool_use IDs');
  assert.ok(/SKILL_TIMEOUT:/.test(SOURCE), '#3418 watchdog: marker SKILL_TIMEOUT debe estar propagado en finish()');
  assert.ok(/inferSkillResult/.test(SOURCE), '#3418: inferSkillResult del lib debe usarse para mapear a enum cerrado');
  assert.ok(/readPrevIssueCreationContext/.test(SOURCE), '#3418 SEC-B: helper readPrevIssueCreationContext debe existir');
});
