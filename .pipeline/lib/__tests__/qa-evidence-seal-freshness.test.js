'use strict';

// =============================================================================
// #6496 — Caducidad del veredicto sellado de QA.
//
// Cubre los criterios de aceptación del issue con los NOMBRES DE TEST que el
// issue nomina. Los tres guardianes (CA-11, CA-12, CA-5) son bloqueantes: si
// alguno falta o está en rojo, el issue no se acepta en `aprobacion`.
//
// Todo corre contra repos git REALES en `os.tmpdir()` (nunca mocks de git): el
// módulo deriva el HEAD con `execFileSync('git', ['-C', cwd, 'rev-parse',
// 'HEAD'])` y un mock del binario no probaría el fail-closed de SEC-A.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const seal = require('../qa-evidence-seal');

const HEAD_FALSO = 'a'.repeat(40);

// #6496 (rebote security) — Los fixtures NO pueden usar numeros de issue reales
// del repo. Un brazo del Pulpo que se escape del sandbox escribe contra el issue
// que diga el fixture; con `6496` eso significaba spamear un issue publico vivo.
// `999496` esta fuera del rango existente y sigue siendo valido para
// `normalizeIssueNumber` (regex /^[1-9][0-9]{0,6}$/).
const ISSUE_FIXTURE = 999496;

function tmpDir(prefijo) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefijo));
}

/** Repo git real con un commit. Devuelve `{dir, head}`. */
function crearRepo() {
  const dir = tmpDir('seal-repo-');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8', windowsHide: true });
  git('config', 'user.email', 'pipeline@intrale.test');
  git('config', 'user.name', 'pipeline');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uno');
  git('add', '.');
  git('commit', '-q', '-m', 'commit inicial');
  return { dir, head: git('rev-parse', 'HEAD').trim(), git };
}

/** Estructura mínima de un `.pipeline/` de estado. */
function crearEstado() {
  const dir = tmpDir('seal-state-');
  for (const sub of ['procesado', 'pendiente', 'trabajando', 'listo', 'archivado']) {
    fs.mkdirSync(path.join(dir, 'desarrollo', 'verificacion', sub), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'servicios', 'github', 'pendiente'), { recursive: true });
  return dir;
}

function escribirVeredicto(estado, issue, data) {
  const file = path.join(estado, 'desarrollo', 'verificacion', 'procesado', `${issue}.qa`);
  fs.writeFileSync(file, yaml.dump(data, { lineWidth: -1 }));
  return file;
}

function leerVeredicto(estado, issue, subdir = 'procesado') {
  return yaml.load(fs.readFileSync(
    path.join(estado, 'desarrollo', 'verificacion', subdir, `${issue}.qa`), 'utf8'));
}

function ordenesGithub(estado) {
  const dir = path.join(estado, 'servicios', 'github', 'pendiente');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function ordenesRequeue(estado) {
  const dir = path.join(estado, ...seal.REQUEUE_QUEUE_DIR);
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

/** Fuerza el contador a `n` sin pasar por `requeueVerification`. */
function sembrarContador(estado, issue, n) {
  fs.writeFileSync(seal.sealRetriesPath(estado, issue),
    JSON.stringify({ intentos: n, ultimo_motivo: 'head-desincronizado', ts: '2026-08-26T00:00:00Z' }));
}

// ---------------------------------------------------------------------------
// Grupo A — Qué es un veredicto caduco
// ---------------------------------------------------------------------------

test('un aprobado en modo structural queda con sello.head y artefactos vacios', () => {
  const repo = crearRepo();
  // CA-1 — el carril con bypass de evidencia (42 de 76 aprobados reales) no
  // tiene artefactos que hashear, pero SÍ tiene un commit contra el que se
  // aprobó. Eso es todo lo que la caducidad necesita.
  const data = {
    issue: ISSUE_FIXTURE, resultado: 'aprobado', modo: 'structural',
    evidencia: 'no aplica: QA_MODE=structural sin UI visible',
  };
  const res = seal.sealHeadOnly({ data, cwd: repo.dir, motivo: 'sin-evidencia', modo: 'qa-mode-structural' });

  assert.strictEqual(res.sealed, true);
  assert.strictEqual(data.sello.head, repo.head);
  assert.deepStrictEqual(data.sello.artefactos, []);
  assert.strictEqual(data.sello.version, 1);
  assert.strictEqual(data.sello.derivado_por, 'qa-evidence-seal');
  assert.deepStrictEqual(data.sello.sin_artefactos, { motivo: 'sin-evidencia', modo: 'qa-mode-structural' });
  // Y el veredicto NO se toca: el sello head-only no degrada nada.
  assert.strictEqual(data.resultado, 'aprobado');
});

test('sin HEAD derivable el sello head-only no se escribe (fail-closed de CA-1)', () => {
  const noRepo = tmpDir('seal-norepo-');
  const data = { resultado: 'aprobado', modo: 'api' };
  const res = seal.sealHeadOnly({ data, cwd: noRepo, motivo: 'sin-evidencia', modo: 'qa-mode-api' });
  assert.strictEqual(res.sealed, false);
  assert.strictEqual(res.reason, 'head-invalido');
  assert.strictEqual(data.sello, undefined);
});

test('el sello head-only no toca un veredicto que no esta aprobado', () => {
  const repo = crearRepo();
  const data = { resultado: 'rechazado' };
  const res = seal.sealHeadOnly({ data, cwd: repo.dir, motivo: 'sin-evidencia', modo: 'qa-skipped' });
  assert.strictEqual(res.sealed, false);
  assert.strictEqual(res.reason, 'no-aplica');
  assert.strictEqual(data.sello, undefined);
});

test('un veredicto sellado sobre otro HEAD caduca y re-encola', () => {
  const repo = crearRepo();
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });

  const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: ISSUE_FIXTURE, cwd: repo.dir });
  assert.strictEqual(chequeo.caduco, true);
  assert.strictEqual(chequeo.motivo, 'head-desincronizado');
  assert.strictEqual(chequeo.head_sellado, HEAD_FALSO);
  assert.strictEqual(chequeo.head_actual, repo.head);

  const repar = seal.requeueVerification({
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: chequeo.motivo,
    headSellado: chequeo.head_sellado, headActual: chequeo.head_actual,
  });
  assert.strictEqual(repar.ok, true);
  assert.strictEqual(repar.escalado, false);
  assert.strictEqual(repar.intentos, 1);

  const ordenes = ordenesRequeue(estado);
  assert.strictEqual(ordenes.length, 1, 'se encola exactamente una orden de re-encolado');
  assert.strictEqual(ordenes[0].tipo, seal.REQUEUE_TYPE);
  assert.strictEqual(ordenes[0].issue, ISSUE_FIXTURE);
  assert.strictEqual(ordenes[0].head_sellado, HEAD_FALSO);
  assert.strictEqual(ordenes[0].head_actual, repo.head);
});

test('un veredicto sellado sobre el HEAD actual NO caduca', () => {
  const repo = crearRepo();
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, { resultado: 'aprobado', sello: { version: 1, head: repo.head, artefactos: [] } });
  const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: ISSUE_FIXTURE, cwd: repo.dir });
  assert.strictEqual(chequeo.caduco, false);
  assert.strictEqual(chequeo.motivo, null);
  assert.strictEqual(chequeo.head_actual, repo.head);
});

test('HEAD no resoluble caduca fail-closed', () => {
  // CA-2 — `checkVerdictFreshness` deriva el HEAD ella misma; si no lo puede
  // resolver ⇒ caduco, NUNCA "no caduco". Este es el fail-open que SEC-A
  // señalaba en el snippet original (que además leía un `snap.head` inexistente).
  const noRepo = tmpDir('seal-norepo-');
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });
  const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: ISSUE_FIXTURE, cwd: noRepo });
  assert.strictEqual(chequeo.caduco, true);
  assert.strictEqual(chequeo.motivo, 'head-no-resoluble');
});

test('un veredicto caduco no aplica needs-human ni blocked:routing-manual', () => {
  const repo = crearRepo();
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });

  seal.requeueVerification({
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
    headSellado: HEAD_FALSO, headActual: repo.head,
  });

  const ordenes = ordenesGithub(estado);
  const labels = ordenes.map(o => o.label);
  assert.ok(!labels.includes('needs-human'), 'el primer caduco NO escala a humano');
  assert.ok(!labels.includes('blocked:routing-manual'), 'la caducidad nunca aplica blocked:routing-manual');
  // rev-4 (D2) — las únicas mutaciones son las DOS mitades de la degradación del
  // gate: subir `qa:pending` y bajar `qa:skipped`, que es la misma autoridad de
  // merge que `qa:passed` y que el reconciliador no conoce.
  assert.deepStrictEqual(
    ordenes.map(o => `${o.action} ${o.label}`),
    ['label qa:pending', 'remove-label qa:skipped'],
    'la única mutación de label es la degradación del gate, en sus dos mitades',
  );
});

test('aprobado sin sello despues del corte caduca fail-closed', () => {
  // CA-3 — con CA-1 puesto, "sin sello" ya no significa "modo sin evidencia".
  const repo = crearRepo();
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, { resultado: 'aprobado', evidencia: 'prosa sin artefactos' });
  const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: ISSUE_FIXTURE, cwd: repo.dir });
  assert.strictEqual(chequeo.caduco, true);
  assert.strictEqual(chequeo.motivo, 'sin-sello');
});

test('sin veredicto archivado el chequeo caduca, no se cae a fresco', () => {
  const repo = crearRepo();
  const estado = crearEstado();
  const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: ISSUE_FIXTURE, cwd: repo.dir });
  assert.strictEqual(chequeo.caduco, true);
  assert.strictEqual(chequeo.motivo, 'sin-veredicto');
});

test('un veredicto archivado en historico se lee igual que uno en procesado', () => {
  // El propio pipeline muda `procesado/` a `historico/` (`lib/historico.js`).
  // Ignorar ese destino convertiría un archivado rutinario en caducidad falsa.
  const repo = crearRepo();
  const estado = crearEstado();
  const dest = path.join(estado, 'historico', 'desarrollo', 'verificacion');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, '999496.qa'),
    yaml.dump({ resultado: 'aprobado', sello: { version: 1, head: repo.head, artefactos: [] } }));
  const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: ISSUE_FIXTURE, cwd: repo.dir });
  assert.strictEqual(chequeo.caduco, false);
});

test('un veredicto ilegible caduca en vez de saltearse', () => {
  const repo = crearRepo();
  const estado = crearEstado();
  fs.writeFileSync(path.join(estado, 'desarrollo', 'verificacion', 'procesado', '999496.qa'), '{[: yaml roto');
  const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: ISSUE_FIXTURE, cwd: repo.dir });
  assert.strictEqual(chequeo.caduco, true);
  assert.strictEqual(chequeo.motivo, 'veredicto-ilegible');
});

test('un issue invalido caduca antes de construir ningun path (SEC-B)', () => {
  const repo = crearRepo();
  const estado = crearEstado();
  for (const malo of ['../../etc/passwd', '0', '', '12345678', 'abc', null, undefined, '999496; rm -rf /']) {
    const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: malo, cwd: repo.dir });
    assert.strictEqual(chequeo.caduco, true, `issue ${JSON.stringify(malo)} debe caducar`);
    assert.strictEqual(chequeo.motivo, 'issue-invalido');
  }
  assert.strictEqual(seal.normalizeIssueNumber('999496'), ISSUE_FIXTURE);
  assert.strictEqual(seal.normalizeIssueNumber(ISSUE_FIXTURE), ISSUE_FIXTURE);
});

// --- GUARDIÁN CA-5 ---------------------------------------------------------

test('el modo declarado por el agente no exime de caducidad', () => {
  // GUARDIÁN. `modo` lo escribe el agente QA en su YAML. Si la exención se
  // pudiera derivar de ahí, escribir `modo: structural` sería EL bypass del
  // gate. La única fuente válida de exención es la marca que escribe el
  // pipeline (`sello_exencion`), y el enforcement real lo resuelve el Pulpo
  // contra los labels de GitHub (`resolveQaEvidenceEnforcement`).
  const repo = crearRepo();
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, {
    resultado: 'aprobado',
    modo: 'structural',
    labels: ['qa:skipped'],
    qa_mode: 'structural',
    sello_exencion: 'me eximo solo',
  });
  const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: ISSUE_FIXTURE, cwd: repo.dir });
  assert.strictEqual(chequeo.caduco, true);
  assert.strictEqual(chequeo.motivo, 'sin-sello');

  // Y una marca de exención con forma de objeto pero mal firmada tampoco exime.
  escribirVeredicto(estado, ISSUE_FIXTURE, {
    resultado: 'aprobado', modo: 'structural',
    sello_exencion: { motivo: 'migracion-pre-sellado', derivado_por: 'qa' },
  });
  assert.strictEqual(
    seal.checkVerdictFreshness({ pipelineDir: estado, issue: ISSUE_FIXTURE, cwd: repo.dir }).motivo,
    'sin-sello');
});

test('stripDeclaredSeal borra la exencion que declare el agente', () => {
  // Complemento del guardián anterior: la marca no sólo se ignora al leer, se
  // BORRA del dropfile antes de que viaje a `listo/` y `procesado/`.
  const data = {
    resultado: 'aprobado',
    sello: { head: HEAD_FALSO },
    sello_exencion: { motivo: 'migracion-pre-sellado', derivado_por: 'pipeline' },
  };
  const declarado = seal.stripDeclaredSeal(data);
  assert.strictEqual(data.sello, undefined);
  assert.strictEqual(data.sello_exencion, undefined);
  assert.deepStrictEqual(declarado.exencion, { motivo: 'migracion-pre-sellado', derivado_por: 'pipeline' });
});

// --- CA-4: migración one-shot ----------------------------------------------

test('la migracion es idempotente', () => {
  const estado = crearEstado();
  escribirVeredicto(estado, 6258, { resultado: 'aprobado', evidencia: 'prosa' });
  escribirVeredicto(estado, 6362, { resultado: 'aprobado', evidencia: 'prosa' });
  escribirVeredicto(estado, 6259, { resultado: 'rechazado' });

  const uno = seal.migratePreSealBacklog({ pipelineDir: estado, ahora: '2026-08-26T00:00:00Z' });
  assert.deepStrictEqual(uno.exentos.sort(), [6258, 6362]);
  assert.strictEqual(uno.anunciar, true, 'la primera corrida anuncia');

  const antes = leerVeredicto(estado, 6258);
  const dos = seal.migratePreSealBacklog({ pipelineDir: estado, ahora: '2026-08-27T00:00:00Z' });
  assert.deepStrictEqual(dos.exentos, [], 'la segunda corrida no vuelve a eximir a nadie');
  assert.deepStrictEqual(dos.yaExentos.sort(), [6258, 6362]);
  assert.strictEqual(dos.anunciar, false, 'el anuncio es único');
  assert.deepStrictEqual(leerVeredicto(estado, 6258), antes, 'el dropfile no cambia en la segunda pasada');

  // El rechazado no recibe exención: la migración es sólo sobre aprobados.
  assert.strictEqual(leerVeredicto(estado, 6259).sello_exencion, undefined);

  // Y la lista exacta queda auditada.
  const audit = fs.readFileSync(path.join(estado, 'logs', seal.MIGRACION_AUDIT_FILE), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(audit.map(e => e.issue).sort(), [6258, 6362]);
});

test('un aprobado sin sello posterior al corte NO recibe exencion en un boot posterior', () => {
  // GUARDIÁN de CA-3 vs CA-4 (rev-1 de #6496).
  //
  // `migrarBacklogPreSellado` corre en CADA arranque del Pulpo. Si el barrido
  // materializara exenciones en cada corrida, un veredicto `aprobado` sin
  // `sello` que llegue a `procesado/` DESPUÉS del corte quedaría exento de
  // caducidad para siempre y contra cualquier HEAD: el bypass exacto que CA-3
  // prohíbe, y que anula el único fail-closed del carril con bypass de
  // evidencia (`sealHeadOnly` → `head-invalido` ⇒ dropfile sin sello).
  //
  // Nótese que el test de CA-3 (`aprobado sin sello despues del corte caduca
  // fail-closed`) NO cubre esto: pasa porque la migración no corre en ese
  // estado aislado. El defecto sólo aparece con la migración en el medio.
  const repo = crearRepo();
  const estado = crearEstado();
  escribirVeredicto(estado, 6258, { resultado: 'aprobado', evidencia: 'prosa' });

  // BOOT 1 — la ventana de migración se abre una única vez y cierra el corte.
  const boot1 = seal.migratePreSealBacklog({ pipelineDir: estado, ahora: '2026-08-26T00:00:00Z' });
  assert.deepStrictEqual(boot1.exentos, [6258], 'el backlog pre-sellado sí se exime (CA-4)');
  assert.strictEqual(boot1.ventana, 'abierta');

  // Llega un veredicto NUEVO, posterior al corte, aprobado y sin sello.
  escribirVeredicto(estado, 7777, { resultado: 'aprobado', evidencia: 'prosa' });
  const antes = seal.checkVerdictFreshness({ pipelineDir: estado, issue: 7777, cwd: repo.dir });
  assert.strictEqual(antes.caduco, true, 'antes del boot el gate ya lo declara caduco');
  assert.strictEqual(antes.motivo, 'sin-sello');

  // BOOT 2 — el Pulpo arranca de nuevo y vuelve a correr la migración.
  const boot2 = seal.migratePreSealBacklog({ pipelineDir: estado, ahora: '2026-08-27T00:00:00Z' });
  assert.deepStrictEqual(boot2.exentos, [], 'la ventana cerrada no exime a NADIE');
  assert.strictEqual(boot2.ventana, 'cerrada');
  assert.strictEqual(boot2.fueraDeVentana, 1, 'el aprobado post-corte queda contado, no exento');
  assert.strictEqual(boot2.anunciar, false, 'el anuncio sigue siendo único');

  assert.strictEqual(leerVeredicto(estado, 7777).sello_exencion, undefined,
    'un aprobado posterior al corte NUNCA puede recibir sello_exencion');

  const despues = seal.checkVerdictFreshness({ pipelineDir: estado, issue: 7777, cwd: repo.dir });
  assert.strictEqual(despues.caduco, true, 'CA-3 sigue en pie después de un boot posterior');
  assert.strictEqual(despues.motivo, 'sin-sello');

  // Y el exento legítimo del corte no se rompió: CA-4 sigue valiendo.
  assert.strictEqual(
    seal.checkVerdictFreshness({ pipelineDir: estado, issue: 6258, cwd: repo.dir }).caduco, false,
    'el backlog pre-sellado sigue exento');

  // La auditoría no crece con exenciones fantasma.
  const audit = fs.readFileSync(path.join(estado, 'logs', seal.MIGRACION_AUDIT_FILE), 'utf8')
    .trim().split(/\r?\n/).map(JSON.parse);
  assert.deepStrictEqual(audit.map(e => e.issue), [6258]);
});

test('un dropfile ya sellado no recibe exencion', () => {
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, {
    resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] },
  });
  const res = seal.migratePreSealBacklog({ pipelineDir: estado, ahora: '2026-08-26T00:00:00Z' });
  assert.deepStrictEqual(res.exentos, []);
  assert.strictEqual(leerVeredicto(estado, ISSUE_FIXTURE).sello_exencion, undefined,
    'un veredicto que YA tiene contra qué chequearse no se exime');
});

test('el gate sobre el backlog migrado produce cero re-encolados', () => {
  const repo = crearRepo();
  const estado = crearEstado();
  const issues = [5220, 5244, 5459, 5986, 6145, 6208, 6239, 6362, 6432, 6611];
  for (const n of issues) escribirVeredicto(estado, n, { resultado: 'aprobado', evidencia: 'prosa' });

  seal.migratePreSealBacklog({ pipelineDir: estado, ahora: '2026-08-26T00:00:00Z' });

  for (const n of issues) {
    const chequeo = seal.checkVerdictFreshness({ pipelineDir: estado, issue: n, cwd: repo.dir });
    assert.strictEqual(chequeo.caduco, false, `#${n} exento no debe caducar`);
  }
  assert.deepStrictEqual(ordenesRequeue(estado), [], 'cero órdenes de re-encolado');
  assert.deepStrictEqual(ordenesGithub(estado), [], 'cero mutaciones de label');
});

// ---------------------------------------------------------------------------
// Grupo B — El bucle queda acotado
// ---------------------------------------------------------------------------

test('el contador de caducidad no toca el budget de routing', () => {
  // CA-6 — `blocked:routing-manual` sólo lo dispara el agotamiento de
  // `MAX_ROUTING_BOUNCES` (`pulpo.js:4985`), que se cuenta leyendo
  // `rebote_tipo === 'routing'` + `rebote_routing_numero` en los dropfiles de
  // `definicion`. La caducidad no escribe ninguno de los dos.
  const repo = crearRepo();
  const estado = crearEstado();
  seal.requeueVerification({
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
    headSellado: HEAD_FALSO, headActual: repo.head,
  });

  const contador = JSON.parse(fs.readFileSync(seal.sealRetriesPath(estado, ISSUE_FIXTURE), 'utf8'));
  assert.deepStrictEqual(Object.keys(contador).sort(), ['intentos', 'ts', 'ultimo_motivo']);
  assert.strictEqual(contador.intentos, 1);

  const orden = ordenesRequeue(estado)[0];
  assert.strictEqual(orden.rebote_tipo, undefined);
  assert.strictEqual(orden.rebote_routing_numero, undefined);
  assert.strictEqual(orden.routing_bounces, undefined);
  // Y ningún dropfile de `definicion` se tocó.
  assert.ok(!fs.existsSync(path.join(estado, 'definicion')));
});

test('dos caducidades consecutivas dejan intentos = 2', () => {
  // CA-7 — el contador cuenta RE-ENCOLADOS POR CADUCIDAD, no fallos de
  // re-sellado. Si contara fallos, el camino que esta historia habilita (una
  // caducidad EXITOSA que re-encola) nunca lo subiría y la escalada nunca
  // dispararía (SEC-E).
  const repo = crearRepo();
  const estado = crearEstado();
  const args = {
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
    headSellado: HEAD_FALSO, headActual: repo.head,
  };
  const uno = seal.requeueVerification(args);
  const dos = seal.requeueVerification(args);
  assert.strictEqual(uno.intentos, 1);
  assert.strictEqual(uno.escalado, false);
  assert.strictEqual(dos.intentos, 2);
  assert.strictEqual(dos.escalado, false);
  assert.strictEqual(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }).intentos, 2);
});

test('un re-encolado exitoso no resetea el contador', () => {
  // CA-8 — la regla de reset es ÚNICA y no incluye "el re-encolado salió bien".
  const repo = crearRepo();
  const estado = crearEstado();
  const args = {
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
    headSellado: HEAD_FALSO, headActual: repo.head,
  };
  seal.requeueVerification(args);
  assert.strictEqual(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }).intentos, 1);

  // Una aprobación NUEVA de QA por sí sola tampoco lo resetea.
  escribirVeredicto(estado, ISSUE_FIXTURE, { resultado: 'aprobado', sello: { version: 1, head: repo.head, artefactos: [] } });
  assert.strictEqual(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }).intentos, 1);

  seal.requeueVerification(args);
  assert.strictEqual(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }).intentos, 2);
});

test('el contador se borra recien cuando se integra un veredicto fresco', () => {
  const estado = crearEstado();
  sembrarContador(estado, ISSUE_FIXTURE, 1);
  assert.strictEqual(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }).intentos, 1);
  seal.clearSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE });
  assert.strictEqual(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }).intentos, 0);
  // Idempotente: borrarlo dos veces no rompe.
  assert.strictEqual(seal.clearSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }), true);
});

test('escala a humano recien en la tercera caducidad', () => {
  // CA-9 — el contador se lee ANTES de re-encolar. `intentos >= 2` ⇒ no
  // re-encola: escala con la ficha de decisión. Máximo 2 re-encolados
  // automáticos. Fail-closed ACOTADO, no permanente.
  const repo = crearRepo();
  const estado = crearEstado();
  const args = {
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
    headSellado: HEAD_FALSO, headActual: repo.head,
  };
  assert.strictEqual(seal.requeueVerification(args).escalado, false);
  assert.strictEqual(seal.requeueVerification(args).escalado, false);

  const tercera = seal.requeueVerification(args);
  assert.strictEqual(tercera.escalado, true);
  assert.strictEqual(tercera.intentos, 2, 'la escalada no incrementa el contador');
  assert.strictEqual(ordenesRequeue(estado).length, 2, 'sólo hubo 2 re-encolados automáticos');

  const labels = ordenesGithub(estado).map(o => o.label).filter(Boolean);
  assert.strictEqual(labels.filter(l => l === 'needs-human').length, 1);

  const ficha = ordenesGithub(estado).find(o => o.action === 'comment');
  assert.ok(ficha, 'la escalada deja una ficha de decisión');
  assert.ok(ficha.body.includes(HEAD_FALSO), 'la ficha dice qué HEAD se selló');
  assert.ok(ficha.body.includes(repo.head), 'la ficha dice cuál es el HEAD actual');
  assert.ok(/2 \/ 2/.test(ficha.body), 'la ficha dice cuántas vueltas hubo');
  assert.ok(!/[A-Za-z]:[\\/]/.test(ficha.body) && !/(^|\s)\/[a-z]/.test(ficha.body),
    'SEC-I: la ficha no publica rutas absolutas');
});

test('el contador corrupto se lee como agotado, no como cero', () => {
  // CA-10 — un contador que se resetea corrompiéndolo no acota nada.
  const repo = crearRepo();
  for (const basura of ['{no json', '[]', 'null', '{"intentos":-1}', '{"intentos":"2"}', '{"intentos":1.5}', '{}']) {
    const estado = crearEstado();
    fs.writeFileSync(seal.sealRetriesPath(estado, ISSUE_FIXTURE), basura);
    const leido = seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE });
    assert.strictEqual(leido.intentos, seal.MAX_SEAL_REQUEUES, `basura ${basura} debe leerse como agotado`);
    assert.strictEqual(leido.corrupto, true);
    // Y por lo tanto la reparación escala en vez de re-encolar.
    const repar = seal.requeueVerification({
      pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
      headSellado: HEAD_FALSO, headActual: repo.head,
    });
    assert.strictEqual(repar.escalado, true, `basura ${basura} debe escalar`);
  }
});

// ---------------------------------------------------------------------------
// Grupo C — Caducar invalida de verdad
// ---------------------------------------------------------------------------

// --- GUARDIÁN CA-12 --------------------------------------------------------

test('un veredicto caduco no deja qa:passed vivo en el issue', () => {
  // GUARDIÁN (SEC-C). El label del issue es la autoridad que leen el pre-check
  // de `/delivery` y la propagación al PR. Invalidar el dropfile y dejar
  // `qa:passed` vivo invalida la mitad: durante toda la ventana de
  // re-verificación el issue seguiría declarando "QA aprobado" sobre un HEAD
  // que nadie verificó.
  const repo = crearRepo();
  const estado = crearEstado();
  const repar = seal.requeueVerification({
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
    headSellado: HEAD_FALSO, headActual: repo.head,
  });
  assert.strictEqual(repar.escalado, false);

  const gate = ordenesGithub(estado).filter(o => o.action === 'label' && o.label === 'qa:pending');
  assert.strictEqual(gate.length, 1, 'el gate se degrada a qa:pending EN EL MISMO ACTO del re-encolado');
  assert.strictEqual(gate[0].issue, ISSUE_FIXTURE);
  assert.strictEqual(gate[0].target, undefined, 'la degradación es sobre el ISSUE, no sobre el PR');
  // `qa:pending` es gate label ⇒ el worker de servicio-github hace
  // remove-then-add con `gate-label-reconciler`, así que `qa:passed` no
  // sobrevive a la orden.
  // Se recorre la MISMA cadena que corre el worker de `servicio-github`
  // (`applyGateLabelAction`), no una aproximación: la orden entra sin
  // `gate_reconciler`, el worker la reconcilia contra los labels frescos y
  // emite remove-then-add.
  const reconciler = require('../gate-label-reconciler');
  assert.ok(reconciler.isGateLabel(gate[0].label), 'qa:pending es gate label ⇒ pasa por el reconciliador');
  assert.strictEqual(gate[0].gate_reconciler, undefined,
    'la orden NO viene pre-reconciliada: la resuelve el worker con labels frescos');
  const reconciliation = reconciler.reconcileGateLabels({
    currentLabels: ['qa:passed'],
    verdict: reconciler.verdictForGateLabel(gate[0].label),
  });
  const acciones = reconciler.buildLabelActions({ issue: ISSUE_FIXTURE, reconciliation, target: 'issue' });
  assert.deepStrictEqual(
    acciones.map(a => `${a.action}:${a.label}`),
    ['remove-label:qa:passed', 'label:qa:pending'],
    'la reconciliación remove-then-add saca el qa:passed vivo antes de poner qa:pending');
  // Nadie encoló `qa:passed` en esta reparación.
  assert.ok(!ordenesGithub(estado).some(o => o.label === 'qa:passed'));

  // Y mientras el re-encolado está ABIERTO, el gate no viaja al PR.
  assert.strictEqual(seal.hasOpenRequeue({ pipelineDir: estado, issue: ISSUE_FIXTURE }), true);
  const delivery = require('../../delivery.js');
  const prop = delivery.buildPrGatePropagation({
    issue: ISSUE_FIXTURE, prNumber: 99, branch: 'agent/999496-pipeline-dev',
    issueLabels: [{ name: 'qa:passed' }],
    prHead: { number: 99, headRepositoryOwner: { login: 'intrale' }, headRefName: 'agent/999496-pipeline-dev' },
    repo: 'intrale/platform',
    pipelineDir: estado,
  });
  assert.strictEqual(prop.ok, false);
  assert.strictEqual(prop.reason, 're_encolado_de_verificacion_abierto');
});

test('hasOpenRequeue es fail-closed y se cierra cuando el pulpo drena la orden', () => {
  const estado = crearEstado();
  // Sin cola todavía: no hay re-encolado abierto.
  assert.strictEqual(seal.hasOpenRequeue({ pipelineDir: estado, issue: ISSUE_FIXTURE }), false);
  // Issue inválido ⇒ fail-closed.
  assert.strictEqual(seal.hasOpenRequeue({ pipelineDir: estado, issue: '../x' }), true);

  seal.requeueVerification({ pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado' });
  assert.strictEqual(seal.hasOpenRequeue({ pipelineDir: estado, issue: ISSUE_FIXTURE }), true);
  // Otro issue no queda bloqueado por el re-encolado ajeno.
  assert.strictEqual(seal.hasOpenRequeue({ pipelineDir: estado, issue: 6497 }), false);

  // El Pulpo drena ⇒ la orden sale de `pendiente/` y el bloqueo se levanta.
  const pend = path.join(estado, ...seal.REQUEUE_QUEUE_DIR);
  const done = path.join(estado, ...seal.REQUEUE_DONE_DIR);
  fs.mkdirSync(done, { recursive: true });
  for (const f of fs.readdirSync(pend)) fs.renameSync(path.join(pend, f), path.join(done, f));
  assert.strictEqual(seal.hasOpenRequeue({ pipelineDir: estado, issue: ISSUE_FIXTURE }), false);
});

// --- GUARDIÁN CA-11 --------------------------------------------------------

test('un veredicto caduco NO sale de la reparacion en estado aprobado', () => {
  // GUARDIÁN (SEC-3, el riesgo #1 de #6475). Si re-sellar recalculara el hash
  // CONSERVANDO el `aprobado`, provocar un desfasaje sería EL bypass del gate
  // de QA. Se verifica la reparación COMPLETA: `requeueVerification` (delivery)
  // + el drenado del Pulpo.
  const repo = crearRepo();
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, {
    resultado: 'aprobado',
    sello: { version: 1, head: HEAD_FALSO, artefactos: [] },
    evidencia_sha256: `sha256:${'b'.repeat(64)}`,
  });

  seal.requeueVerification({
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
    headSellado: HEAD_FALSO, headActual: repo.head,
  });

  // 1) `requeueVerification` NO re-firma: no recalcula ningún hash ni escribe
  //    un sello nuevo. Lo único que produce son órdenes.
  const orden = ordenesRequeue(estado)[0];
  assert.strictEqual(orden.sello, undefined);
  assert.strictEqual(orden.resultado, undefined);
  assert.strictEqual(orden.head_actual, repo.head,
    'la orden REPORTA el HEAD actual, pero no lo convierte en sello');

  // 2) El drenado del Pulpo reemplaza el dropfile por un work-file de rebote
  //    SIN `resultado` y SIN `sello`.
  const pulpo = requirePulpo(estado);
  // El notificador se INYECTA: sin el stub, el drenador publicaría un comentario
  // REAL en un issue publico de GitHub en cada corrida de la suite (#6496 rev-1).
  const comentarios = [];
  pulpo.drenarRequeueVerificacion(
    { pipelines: { desarrollo: { skills_por_fase: { verificacion: ['qa'] } } } },
    { comentar: (issue, body) => comentarios.push({ issue, body }) },
  );
  assert.strictEqual(comentarios.length, 1, 'el drenador avisa por el canal INYECTADO, no por el real');
  assert.strictEqual(Number(comentarios[0].issue), ISSUE_FIXTURE);

  const enPendiente = path.join(estado, 'desarrollo', 'verificacion', 'pendiente', '999496.qa');
  assert.ok(fs.existsSync(enPendiente), 'la verificación quedó re-encolada');
  const reencolado = yaml.load(fs.readFileSync(enPendiente, 'utf8'));
  assert.strictEqual(reencolado.resultado, undefined, 'NADA sale de la reparación en estado aprobado');
  assert.strictEqual(reencolado.sello, undefined, 'la reparación no re-firma');
  assert.strictEqual(reencolado.evidencia_sha256, undefined);
  assert.strictEqual(reencolado.rebote, true);
  assert.ok(String(reencolado.motivo_rechazo).includes(HEAD_FALSO));

  // 3) Y no quedó ningún `aprobado` vivo en NINGÚN estado de la fase.
  for (const sub of ['procesado', 'pendiente', 'trabajando', 'listo']) {
    const dir = path.join(estado, 'desarrollo', 'verificacion', sub);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.qa')) continue;
      const d = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8')) || {};
      assert.notStrictEqual(d.resultado, 'aprobado', `${sub}/${f} no puede quedar aprobado`);
    }
  }
});

test('requeueVerification no escribe en procesado/ desde delivery', () => {
  // CA-13 / SEC-G — el Pulpo es el único dueño del lifecycle del work-file.
  const repo = crearRepo();
  const estado = crearEstado();
  const file = escribirVeredicto(estado, ISSUE_FIXTURE, {
    resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] },
  });
  const antes = fs.readFileSync(file, 'utf8');
  const listadoAntes = fs.readdirSync(path.join(estado, 'desarrollo', 'verificacion', 'procesado')).sort();

  seal.requeueVerification({
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
    headSellado: HEAD_FALSO, headActual: repo.head,
  });

  assert.strictEqual(fs.readFileSync(file, 'utf8'), antes, 'el dropfile de procesado/ no se toca');
  assert.deepStrictEqual(
    fs.readdirSync(path.join(estado, 'desarrollo', 'verificacion', 'procesado')).sort(), listadoAntes,
    'no se mueve ni se renombra nada en procesado/');
  assert.deepStrictEqual(fs.readdirSync(path.join(estado, 'desarrollo', 'verificacion', 'pendiente')), [],
    'delivery tampoco encola la fase por su cuenta: eso lo hace el Pulpo al drenar');
});

// ---------------------------------------------------------------------------
// Grupo D — La frontera con delivery
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DELIVERY_JS = path.join(REPO_ROOT, '.pipeline', 'delivery.js');

/**
 * Repo git con remoto bare y un commit local por delante de `origin/main`, que
 * es lo que `gitCtx.snapshot` exige para llegar al gate.
 */
function crearRepoConRemoto() {
  const repo = crearRepo();
  const remoto = tmpDir('seal-remote-');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remoto], { windowsHide: true });
  repo.git('remote', 'add', 'origin', remoto);
  repo.git('push', '-q', 'origin', 'main');
  repo.git('checkout', '-q', '-b', 'agent/999496-pipeline-dev');
  fs.writeFileSync(path.join(repo.dir, 'b.txt'), 'dos');
  repo.git('add', '.');
  repo.git('commit', '-q', '-m', 'feat: cambio por delante de main');
  repo.head = repo.git('rev-parse', 'HEAD').trim();
  repo.remoto = remoto;
  return repo;
}

// El repo destino de `gh` es DELIBERADAMENTE inexistente. `delivery.js` invoca
// `gh` de verdad (no hay inyección para el binario), así que un test que
// apuntara a `intrale/platform` podría crear un PR real desde una rama
// `agent/6496-*` que sí existe en el remoto. Con un repo inexistente cada
// llamada a `gh` falla de forma inocua y el flujo cae a sus fallbacks, que es
// justamente el camino que este test quiere ejercitar (git, no GitHub).
const REPO_INEXISTENTE = 'intrale/no-existe-test-999496';

function correrDelivery(repo, estado, extraArgs = []) {
  return spawnSync(process.execPath, [
    DELIVERY_JS, '--issue', '999496', '--description', 'gate de caducidad',
    '--repo', REPO_INEXISTENTE, ...extraArgs,
  ], {
    cwd: repo.dir, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, PIPELINE_STATE_DIR: estado, DEBUG: '' },
  });
}

function refsDelRemoto(repo) {
  return execFileSync('git', ['-C', repo.remoto, 'for-each-ref', '--format=%(refname) %(objectname)'],
    { encoding: 'utf8', windowsHide: true }).trim();
}

test('el camino caduco emite el contrato veredicto_caduco en stdout', () => {
  // CA-14 / SEC-D — quien ejecuta delivery.js es un agente LLM: `exit 0` a
  // secas es indistinguible de "entrega exitosa" y produce el falso positivo de
  // R3 en `delivery-status.js` (#5220/#5244).
  const repo = crearRepoConRemoto();
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });

  const res = correrDelivery(repo, estado);
  assert.strictEqual(res.status, 0, `delivery debe salir con 0 (stderr: ${res.stderr})`);

  const ultima = res.stdout.trim().split('\n').pop();
  const contrato = JSON.parse(ultima);
  assert.strictEqual(contrato.estado, 'veredicto_caduco');
  assert.strictEqual(contrato.issue, ISSUE_FIXTURE);
  assert.strictEqual(contrato.motivo, 'head-desincronizado');
  assert.strictEqual(contrato.escalado, false);
  assert.ok(/caduco/i.test(res.stderr), 'stderr trae un mensaje inequívoco para el humano');
});

test('delivery no pushea cuando el veredicto esta caduco', () => {
  // CA-15 — el chequeo corre ANTES del push, nunca después.
  const repo = crearRepoConRemoto();
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, { resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] } });

  const antes = refsDelRemoto(repo);
  const res = correrDelivery(repo, estado);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(refsDelRemoto(repo), antes, 'el remoto no se movió');
  assert.ok(!/refs\/heads\/agent\/999496/.test(refsDelRemoto(repo)), 'la rama del agente no llegó al remoto');

  // Y dejó la reparación encolada, no un bloqueo permanente.
  assert.strictEqual(ordenesRequeue(estado).length, 1);
  assert.deepStrictEqual(
    ordenesGithub(estado).map(o => `${o.action} ${o.label}`),
    ['label qa:pending', 'remove-label qa:skipped'],
  );
});

test('se pushea el sha verificado, no la rama simbolica', () => {
  // CA-15 / SEC-F — hoy se verifica un SHA y se pushea un NOMBRE que pudo haber
  // avanzado entre el chequeo y el push (TOCTOU). El GATE 2 recomputa el HEAD
  // por esta misma razón (#4575).
  const fuente = fs.readFileSync(DELIVERY_JS, 'utf8');
  assert.ok(
    fuente.includes("['-C', cwd, 'push', 'origin', `${shaVerificado}:refs/heads/${snap.branch}`]"),
    'el push del camino verificado usa el SHA explícito');

  const repo = crearRepoConRemoto();
  const estado = crearEstado();
  // Veredicto FRESCO: sellado contra el HEAD real.
  escribirVeredicto(estado, ISSUE_FIXTURE, { resultado: 'aprobado', sello: { version: 1, head: repo.head, artefactos: [] } });
  const shaVerificado = repo.head;

  sembrarContador(estado, ISSUE_FIXTURE, 1); // había una caducidad previa en el historial

  const res = correrDelivery(repo, estado);
  // `gh pr create` falla contra el repo inexistente y delivery sale 1 DESPUÉS
  // del push; lo que se verifica acá es exactamente el push.
  assert.ok(/GATE 3 OK/.test(res.stdout), `el gate de caducidad dejó pasar el veredicto fresco: ${res.stderr}`);
  assert.deepStrictEqual(ordenesRequeue(estado), [],
    'un veredicto fresco no puede producir un re-encolado por caducidad');

  const refs = refsDelRemoto(repo);
  const rama = refs.split('\n').find(l => l.includes('refs/heads/agent/999496'));
  assert.ok(rama, `la rama tiene que haber llegado al remoto. refs:\n${refs}\nstderr:\n${res.stderr}`);
  assert.strictEqual(rama.split(' ')[1], shaVerificado, 'al remoto llegó exactamente el SHA verificado');
  // Y el push fue por SHA explícito, no por nombre de rama.
  assert.ok(res.stderr.includes(`${shaVerificado} -> agent/999496-pipeline-dev`),
    `git reportó el push por SHA explícito. stderr:\n${res.stderr}`);

  // CA-8 (rebote security rev-3 — F6) — el push NO borra el contador.
  //
  // Antes esta línea afirmaba lo contrario, y era justamente el defecto: este CLI
  // pushea y crea el PR, pero NUNCA mergea, así que resetear acá reseteaba en el
  // 100% de las corridas. Con eso el tope de 2 re-encolados automáticos (CA-9) se
  // reiniciaba indefinidamente corriendo `/delivery` y la escalada a
  // `needs-human` no llegaba nunca. "Integrar" es el merge, no el push: el único
  // punto de reset vive donde se confirma `mergeSha`, en el skill determinístico.
  assert.strictEqual(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_FIXTURE }).intentos, 1,
    'el contador sobrevive a un push sin merge: si no, el tope de CA-9 se reinicia para siempre');
});

test('un --issue invalido frena la entrega antes de tocar el remoto (SEC-B)', () => {
  const repo = crearRepoConRemoto();
  const estado = crearEstado();
  const antes = refsDelRemoto(repo);
  const res = spawnSync(process.execPath, [
    DELIVERY_JS, '--issue', '../../etc/passwd', '--description', 'x', '--repo', REPO_INEXISTENTE,
  ], {
    cwd: repo.dir, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, PIPELINE_STATE_DIR: estado },
  });
  assert.strictEqual(res.status, 1);
  assert.ok(/--issue inválido/.test(res.stderr));
  assert.strictEqual(refsDelRemoto(repo), antes);
});

// --- GUARDIÁN SEC · la suite NO escribe en GitHub --------------------------
//
// #6496 rev-1 (security / OWASP A05+A08). `requirePulpo()` aísla el FILESYSTEM
// vía `PIPELINE_DIR_OVERRIDE`, pero NO aislaba el canal de GitHub: el drenador
// llamaba a `ghCommentOnIssue`, que hace `execSync` contra el `gh.exe` real con
// la credencial del operador. Cada `npm run test:pipeline` publicaba un
// comentario en un issue público (27 de ruido acumulados). Estos dos tests son
// el guardián de la regresión y se verifican INTERCEPTANDO `child_process`
// antes de cargar `pulpo.js`, que es la única forma de probar que no sale nada.

test('ghCommentOnIssue corta en seco en entorno de prueba (defensa en profundidad)', () => {
  const estado = crearEstado();
  const pulpo = requirePulpo(estado);

  // `requirePulpo` deja seteados PULPO_NO_AUTOSTART=1 y PIPELINE_DIR_OVERRIDE,
  // así que el guard debe reportar bloqueo y `ghCommentOnIssue` no debe escribir.
  assert.ok(pulpo.ghWritesBloqueadas(), 'con el entorno de prueba las escrituras están bloqueadas');
  assert.doesNotThrow(() => pulpo.ghCommentOnIssue(ISSUE_FIXTURE, 'este texto NO puede llegar a GitHub'));
});

test('drenar la cola de caducidad no ejecuta NINGUNA escritura contra gh', () => {
  // Prueba end-to-end en un proceso hijo: se parchea `child_process.execSync`
  // ANTES del require de `pulpo.js` (que lo destructura en su línea 10) y se
  // cuenta cuántas invocaciones a `gh` se intentaron. Debe ser CERO.
  const repo = crearRepo();
  const estado = crearEstado();
  escribirVeredicto(estado, ISSUE_FIXTURE, {
    resultado: 'aprobado',
    sello: { version: 1, head: HEAD_FALSO, artefactos: [] },
  });
  seal.requeueVerification({
    pipelineDir: estado, issue: ISSUE_FIXTURE, motivo: 'head-desincronizado',
    headSellado: HEAD_FALSO, headActual: repo.head,
  });

  const helpers = require('./_test-helpers');
  helpers.seedPipelineConfig(estado);
  helpers.seedRealProductManifest(estado);

  const script = String.raw`
    const cp = require('child_process');
    const llamadas = [];
    const esGh = (linea) => /(^|[\/"'\s])gh(\.exe)?("|'|\s|$)/i.test(linea);
    for (const fn of ['execSync', 'execFileSync', 'spawnSync']) {
      const orig = cp[fn];
      cp[fn] = function (cmd, ...rest) {
        const linea = Array.isArray(rest[0]) ? [cmd, ...rest[0]].join(' ') : String(cmd);
        if (esGh(linea)) { llamadas.push(linea); return ''; }
        return orig.call(cp, cmd, ...rest);
      };
    }
    const pulpo = require(${JSON.stringify(path.resolve(__dirname, '..', '..', 'pulpo.js'))});
    pulpo.drenarRequeueVerificacion({ pipelines: { desarrollo: { skills_por_fase: { verificacion: ['qa'] } } } });
    process.stdout.write('[[GH_CALLS=' + llamadas.length + ']]' + llamadas.join(' | '));
  `;

  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    cwd: repo.dir,
    env: { ...process.env, PIPELINE_DIR_OVERRIDE: estado, PULPO_NO_AUTOSTART: '1' },
  });

  assert.strictEqual(res.status, 0, `el hijo falló: ${res.stderr}`);
  const m = /\[\[GH_CALLS=(\d+)\]\]/.exec(res.stdout || '');
  assert.ok(m, `no se pudo leer el contador de llamadas. stdout: ${res.stdout}`);
  assert.strictEqual(m[1], '0',
    `la suite intentó ${m[1]} escritura(s) contra gh — el guard de #6496 no está cortando`);
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/**
 * Carga `pulpo.js` apuntado al `.pipeline/` de prueba. `PULPO_NO_AUTOSTART=1`
 * evita que el require arranque el mainLoop (mismo patrón que
 * `gate3-config-failclosed.test.js`).
 */
let pulpoCache = null;
function requirePulpo(estado) {
  if (pulpoCache) return pulpoCache;
  const helpers = require('./_test-helpers');
  helpers.seedPipelineConfig(estado);
  helpers.seedRealProductManifest(estado);
  process.env.PIPELINE_DIR_OVERRIDE = estado;
  process.env.PULPO_NO_AUTOSTART = '1';
  pulpoCache = require('../../pulpo.js');
  return pulpoCache;
}
