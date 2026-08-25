// =============================================================================
// toctou-claim-slot.test.js — Tests de concurrencia para el fix #3939
// (épica EP-5 #3937): claim-by-rename + reserva atómica de slot + sweep de
// claims huérfanos.
//
// Las dos primeras suites usan PROCESOS HIJO REALES (child_process.fork) para
// generar concurrencia genuina cross-process: `lib/file-lock` discrimina holders
// por pid+startTime, así que worker_threads (que comparten process.pid) NO
// reproducirían la carrera. Cada hijo arranca a un instante común (barrier por
// timestamp) y compite sobre el mismo filesystem.
//
// Invariantes verificados (CA-6):
//   - claim-by-rename: EXACTAMENTE-UNA-VEZ sobre el mismo work file.
//   - reserva de slot: a lo sumo `maxConcurrencia` archivos en `trabajando/`.
//   - sweep de huérfanos: PID muerto restaura; PID vivo reciente no se toca.
// =============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// -----------------------------------------------------------------------------
// MODO WORKER — cuando el archivo se forkea con SLOT_WORKER_ROLE, ejecuta la
// acción de carrera y sale. NO registra tests en ese modo.
// -----------------------------------------------------------------------------
if (process.env.SLOT_WORKER_ROLE) {
  runWorker();
} else {
  defineTests();
}

function busyWaitUntil(epochMs) {
  while (Date.now() < epochMs) { /* spin para alinear el arranque */ }
}

function runWorker() {
  const role = process.env.SLOT_WORKER_ROLE;
  // Pre-cargar el módulo ANTES del handshake para que el require pesado no
  // desalinee el arranque de la carrera (causa de flakiness por barrier).
  const slotClaim = require('../lib/slot-claim');

  // Barrier por IPC: avisamos "ready" y esperamos un `{ start }` del parent,
  // que sólo lo emite cuando TODOS los hijos están listos. Así la contención es
  // máxima y determinística, sin depender de tiempos de fork/require.
  function runAt(startAt, fn) {
    busyWaitUntil(startAt);
    let out;
    try { out = fn(); } catch (e) { out = { error: e.code || e.message }; }
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  process.on('message', (msg) => {
    if (!msg || typeof msg.start !== 'number') return;
    if (role === 'claim') {
      const target = process.env.SLOT_TARGET;
      runAt(msg.start, () => {
        try {
          return slotClaim.claimByRename(target, process.pid);
        } catch (e) {
          return { claimed: false, reason: `THROW:${e.code || e.message}` };
        }
      });
    } else if (role === 'slot') {
      const lockFile = process.env.SLOT_LOCK_FILE;
      const skill = process.env.SLOT_SKILL;
      const max = parseInt(process.env.SLOT_MAX, 10);
      const trabajando = process.env.SLOT_TRABAJANDO;
      const myPendiente = process.env.SLOT_PENDIENTE_FILE;
      runAt(msg.start, () => {
        const launched = slotClaim.reserveSlot(lockFile, {
          max,
          countFn: () => fs.readdirSync(trabajando).filter((f) => f.endsWith(`.${skill}`)).length,
          timeoutMs: 8000,
          onAcquired: () => {
            // Emular el move durable a trabajando/ (atómico).
            fs.renameSync(myPendiente, path.join(trabajando, path.basename(myPendiente)));
            // Pequeña ventana ocupada para forzar contención real del lock.
            busyWaitUntil(Date.now() + 15);
          },
        });
        return { launched, pid: process.pid };
      });
    } else {
      process.exit(0);
    }
  });

  // Señal de readiness al parent.
  if (process.send) process.send({ ready: true });
}

// -----------------------------------------------------------------------------
// MODO TEST
// -----------------------------------------------------------------------------
function defineTests() {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const cp = require('child_process');

  const slotClaim = require('../lib/slot-claim');
  const fileLock = require('../lib/file-lock');

  function mkTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  // Lanza N hijos, espera a que TODOS señalen `ready`, luego les difunde un
  // `start` común (now + delta) para que la carrera arranque alineada. Devuelve
  // la lista de resultados parseados en el mismo orden de `envs`.
  function raceWorkers(envs, startDeltaMs = 200) {
    const children = [];
    const outs = envs.map(() => '');
    const readyFlags = envs.map(() => false);
    const exitPromises = [];

    let resolveAllReady;
    const allReady = new Promise((r) => { resolveAllReady = r; });

    envs.forEach((env, i) => {
      const child = cp.fork(__filename, [], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.push(child);
      child.stdout.on('data', (d) => { outs[i] += d.toString(); });
      child.on('message', (msg) => {
        if (msg && msg.ready) {
          readyFlags[i] = true;
          if (readyFlags.every(Boolean)) resolveAllReady();
        }
      });
      exitPromises.push(new Promise((res) => {
        child.on('exit', () => {
          let parsed = null;
          try { parsed = JSON.parse(outs[i].trim()); } catch { parsed = { _raw: outs[i] }; }
          res(parsed);
        });
      }));
    });

    return allReady.then(() => {
      const startAt = Date.now() + startDeltaMs;
      for (const c of children) c.send({ start: startAt });
      return Promise.all(exitPromises);
    });
  }

  // ===========================================================================
  // Suite 1 — claim-by-rename: exactamente-una-vez
  // ===========================================================================
  test('claim-by-rename: exactamente-una-vez bajo N reclamos concurrentes', async () => {
    const dir = mkTmpDir('toctou-claim-');
    const target = path.join(dir, '3939.pipeline-dev');
    fs.writeFileSync(target, 'issue: 3939\n');

    const N = 8;
    const results = await raceWorkers(
      Array.from({ length: N }, () => ({
        SLOT_WORKER_ROLE: 'claim',
        SLOT_TARGET: target,
      })),
    );

    const winners = results.filter((r) => r && r.claimed === true);
    const losers = results.filter((r) => r && r.claimed === false);

    // -----------------------------------------------------------------------
    // #6145 (3ra vuelta) — Qué se verifica y por qué en este orden.
    //
    // El invariante de SEGURIDAD es "a lo sumo un dueño": dos ganadores
    // significan doble reencolado, que es exactamente el TOCTOU que #3939
    // cerró. Ese se exige SIEMPRE, sin excepción ni condición de carga.
    //
    // El invariante de LIVENESS ("alguien ganó") es condicional desde que
    // `claimByRename` deshace el rename cuando la propiedad no queda probada:
    // bajo saturación de CPU (esta suite corre junto a ~830 archivos de test y
    // un fork-storm de 8 hijos) puede pasar que NADIE logre garantizar la
    // sección crítica. En producción eso es el comportamiento correcto — nadie
    // reclama, el work file sigue visible y el próximo tick reintenta — y por
    // lo tanto no puede reportarse como test en rojo. Lo que SÍ se exige en ese
    // caso es que el cero-ganadores esté EXPLICADO por una falla de la capa de
    // lock y que el filesystem quede consistente; si los 8 dijeran
    // `ENOENT`/`EEXIST` sin ganador, el archivo se habría evaporado y eso sí es
    // un bug.
    // -----------------------------------------------------------------------
    assert.ok(winners.length <= 1, `a lo sumo un proceso puede ganar el rename (ganaron ${winners.length})`);
    assert.equal(
      winners.length + losers.length, N,
      `los ${N} contendientes deben devolver un veredicto parseable: ${JSON.stringify(results)}`,
    );

    // Razones legítimas de NO reclamar. Además de perder el rename
    // (`ENOENT`/`EEXIST`), un contendiente puede no llegar a garantizar la
    // sección crítica bajo saturación de CPU: `ELOCK_TIMEOUT` (no consiguió el
    // lock dentro del presupuesto) o `ELOCK_STOLEN` (la propiedad no quedó
    // probada al salir). En ambos casos `claimByRename` NO reclama y devuelve
    // el motivo — nunca propaga la excepción al caller (#6145).
    const RAZONES_CARRERA = ['ENOENT', 'EEXIST'];
    const RAZONES_LOCK = ['ELOCK_TIMEOUT', 'ELOCK_STOLEN'];
    const RAZONES_OK = [...RAZONES_CARRERA, ...RAZONES_LOCK];
    for (const l of losers) {
      assert.ok(!String(l.reason).startsWith('THROW:'), `claimByRename no debe propagar excepciones: ${l.reason}`);
      assert.ok(RAZONES_OK.includes(l.reason), `perdedor con razón inesperada: ${l.reason}`);
    }

    const claimed = fs.readdirSync(dir).filter((f) => slotClaim.CLAIM_RE.test(f));
    if (winners.length === 1) {
      // Caso normal: el canónico ya NO está (lo tiene el ganador como
      // *.claimed-<pid>) y hay exactamente un claim.
      assert.ok(!fs.existsSync(target), 'el work file canónico fue reclamado');
      assert.equal(claimed.length, 1, 'debe existir exactamente un archivo .claimed-<pid>');
    } else {
      // Caso saturación: nadie pudo probar la exclusión mutua.
      const razones = losers.map((l) => l.reason);
      assert.ok(
        razones.some((r) => RAZONES_LOCK.includes(r)),
        `sin ganador, el resultado debe explicarse por la capa de lock, no por un archivo evaporado: ${JSON.stringify(razones)}`,
      );
      // Fail-closed: el work file vuelve a estar disponible para el próximo tick
      // y no queda ningún claim huérfano.
      assert.ok(fs.existsSync(target), 'sin dueño, el work file debe seguir visible al scan');
      assert.equal(claimed.length, 0, 'no debe quedar un *.claimed-<pid> sin dueño');
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Suite 2 — reserva de slot: <= maxConcurrencia
  // ===========================================================================
  test('reserva de slot: a lo sumo maxConcurrencia archivos terminan en trabajando/', async () => {
    const root = mkTmpDir('toctou-slot-');
    const trabajando = path.join(root, 'trabajando');
    const pendiente = path.join(root, 'pendiente');
    fs.mkdirSync(trabajando, { recursive: true });
    fs.mkdirSync(pendiente, { recursive: true });

    const skill = 'pipeline-dev';
    const K = 2;            // maxConcurrencia del skill
    const N = 6;            // intentos de spawn concurrentes
    const lockFile = path.join(root, `.slots.${skill}`);

    // Un work file por candidato.
    const candidates = [];
    for (let i = 0; i < N; i++) {
      const p = path.join(pendiente, `${1000 + i}.${skill}`);
      fs.writeFileSync(p, `issue: ${1000 + i}\n`);
      candidates.push(p);
    }

    const results = await raceWorkers(
      candidates.map((p) => ({
        SLOT_WORKER_ROLE: 'slot',
        SLOT_LOCK_FILE: lockFile,
        SLOT_SKILL: skill,
        SLOT_MAX: String(K),
        SLOT_TRABAJANDO: trabajando,
        SLOT_PENDIENTE_FILE: p,
      })),
    );

    const launchedCount = results.filter((r) => r && r.launched === true).length;
    const enTrabajando = fs.readdirSync(trabajando).filter((f) => f.endsWith(`.${skill}`)).length;

    assert.ok(enTrabajando <= K, `no debe superar maxConcurrencia=${K} (hubo ${enTrabajando})`);
    assert.equal(enTrabajando, K, `con N=${N} > K=${K} deben llenarse exactamente ${K} slots`);
    assert.equal(launchedCount, enTrabajando, 'cada launched=true corresponde a un archivo movido');
    // No quedan locks colgados (CA-3: liberación garantizada).
    assert.ok(!fs.existsSync(`${lockFile}.lock`), 'el lock de slot debe liberarse siempre');

    fs.rmSync(root, { recursive: true, force: true });
  });

  // ===========================================================================
  // Suite 3 — sweep de huérfanos: PID muerto restaura, PID vivo reciente no
  // ===========================================================================
  test('sweep de huérfanos: PID muerto restaura el archivo; PID vivo reciente no se toca', () => {
    const dir = mkTmpDir('toctou-sweep-');
    const pendiente = path.join(dir, 'pendiente');
    fs.mkdirSync(pendiente, { recursive: true });

    // PID con altísima probabilidad de NO existir.
    const deadPid = 2147483600;
    assert.equal(fileLock._internal.isPidAlive(deadPid), false, 'el pid de prueba debe estar muerto');

    // (a) claim huérfano de PID muerto → debe restaurarse.
    const orphanDead = path.join(pendiente, `4001.guru.claimed-${deadPid}`);
    fs.writeFileSync(orphanDead, 'issue: 4001\n');

    // (b) claim de PID VIVO (este proceso) y RECIENTE → NO debe tocarse.
    const orphanAliveRecent = path.join(pendiente, `4002.po.claimed-${process.pid}`);
    fs.writeFileSync(orphanAliveRecent, 'issue: 4002\n');

    // (c) claim de PID VIVO pero ANTIGUO (> STALE_AGE_MS) → debe restaurarse
    //     (heurística PID-reciclado: superó el umbral de stale).
    const orphanAliveStale = path.join(pendiente, `4003.tester.claimed-${process.pid}`);
    fs.writeFileSync(orphanAliveStale, 'issue: 4003\n');
    const old = Date.now() - (fileLock._internal.STALE_AGE_MS + 5000);
    fs.utimesSync(orphanAliveStale, new Date(old), new Date(old));

    const res = slotClaim.sweepOrphanClaims([pendiente], { fl: fileLock });

    // (a) restaurado al nombre canónico.
    assert.ok(fs.existsSync(path.join(pendiente, '4001.guru')), 'el huérfano de PID muerto debe restaurarse');
    assert.ok(!fs.existsSync(orphanDead), 'el claim de PID muerto ya no existe');

    // (b) intacto.
    assert.ok(fs.existsSync(orphanAliveRecent), 'el claim de PID vivo reciente NO debe tocarse');
    assert.ok(!fs.existsSync(path.join(pendiente, '4002.po')), 'no debe restaurarse un claim vivo reciente');

    // (c) restaurado por antigüedad.
    assert.ok(fs.existsSync(path.join(pendiente, '4003.tester')), 'el huérfano vivo pero antiguo debe restaurarse');

    assert.equal(res.restored, 2, 'deben restaurarse exactamente 2 (muerto + viejo)');
    assert.equal(res.skipped, 1, 'debe saltearse exactamente 1 (vivo reciente)');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Suite 4 — sweep: claim huérfano con canónico ya presente → descarta
  // ===========================================================================
  test('sweep de huérfanos: descarta el claim si el canónico ya existe', () => {
    const dir = mkTmpDir('toctou-sweep2-');
    const pendiente = path.join(dir, 'pendiente');
    fs.mkdirSync(pendiente, { recursive: true });

    const deadPid = 2147483601;
    const canonical = path.join(pendiente, '5001.guru');
    const orphan = path.join(pendiente, `5001.guru.claimed-${deadPid}`);
    fs.writeFileSync(canonical, 'issue: 5001\n');
    fs.writeFileSync(orphan, 'issue: 5001\n');

    const res = slotClaim.sweepOrphanClaims([pendiente], { fl: fileLock });

    assert.ok(fs.existsSync(canonical), 'el canónico se preserva');
    assert.ok(!fs.existsSync(orphan), 'el huérfano redundante se descarta');
    assert.equal(res.discarded, 1, 'debe descartar exactamente 1');
    assert.equal(res.restored, 0, 'no debe restaurar ninguno');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Suite 5 — #6145: claimByRename NUNCA propaga fallas de la capa de lock
  // ===========================================================================
  //
  // Rebote del tester: un perdedor de la carrera salió con
  // `THROW:ELOCK_STOLEN`. Además de corregir la causa raíz en `file-lock`
  // (una lectura transitoria fallida no es prueba de robo), `claimByRename`
  // debe degradar cualquier falla del lock a `claimed: false` — el caller
  // (`pulpo.js` reencolando candidatos) trata la excepción como error fatal del
  // tick y abortaría el reencolado de todos los candidatos restantes.

  for (const code of ['ELOCK_TIMEOUT', 'ELOCK_STOLEN']) {
    test(`claimByRename devuelve claimed:false ante ${code} en vez de propagar`, () => {
      const dir = mkTmpDir('toctou-lockfail-');
      const target = path.join(dir, '6145.pipeline-dev');
      fs.writeFileSync(target, 'issue: 6145\n');

      const flFake = {
        withLockSync: () => {
          const e = new Error(`falla simulada de la capa de lock (${code})`);
          e.code = code;
          throw e;
        },
      };

      const r = slotClaim.claimByRename(target, process.pid, { fl: flFake });
      assert.equal(r.claimed, false);
      assert.equal(r.reason, code);
      assert.ok(fs.existsSync(target), 'el work file sigue visible al scan');

      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  test('claimByRename: si le roban el lock DESPUES del rename, deshace el claim', () => {
    const dir = mkTmpDir('toctou-lockundo-');
    const target = path.join(dir, '6146.pipeline-dev');
    fs.writeFileSync(target, 'issue: 6146\n');

    // El fake ejecuta la sección crítica (el rename ocurre) y recién después
    // falla la verificación de propiedad, como haría `withLockSync` real.
    const flFake = {
      withLockSync: (filePath, fn) => {
        fn();
        const e = new Error('propiedad no probada al salir');
        e.code = 'ELOCK_STOLEN';
        throw e;
      },
    };

    const r = slotClaim.claimByRename(target, process.pid, { fl: flFake });
    assert.equal(r.claimed, false, 'sin exclusión probada NO se reclama');
    assert.equal(r.reason, 'ELOCK_STOLEN');
    assert.ok(fs.existsSync(target), 'el nombre canónico debe restaurarse');
    assert.equal(
      fs.readdirSync(dir).filter((f) => slotClaim.CLAIM_RE.test(f)).length,
      0,
      'no debe quedar un *.claimed-<pid> sin dueño',
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('claimByRename: un error ajeno a la capa de lock SI se propaga', () => {
    const dir = mkTmpDir('toctou-lockother-');
    const target = path.join(dir, '6147.pipeline-dev');
    fs.writeFileSync(target, 'issue: 6147\n');

    const flFake = {
      withLockSync: () => {
        const e = new Error('disco lleno');
        e.code = 'ENOSPC';
        throw e;
      },
    };

    assert.throws(() => slotClaim.claimByRename(target, process.pid, { fl: flFake }), /disco lleno/);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Suite 6 — #6145: saturación real de la capa de lock (cero ganadores)
  // ===========================================================================
  //
  // La rama "nadie reclamó" de la Suite 1 sólo aparece bajo saturación de CPU,
  // que es justamente lo que no se puede provocar de forma determinística en un
  // test. Acá se la fuerza por el otro lado: un tercero VIVO (este mismo proceso
  // de test) retiene el lock durante toda la carrera, así los contendientes
  // agotan su presupuesto y salen por `ELOCK_TIMEOUT`.
  //
  // Lo que se fija es la semántica de producción del caso: ante la duda NADIE
  // reclama, el work file queda visible para el próximo tick y no aparece ningún
  // `*.claimed-<pid>` huérfano. Sin esto, el pulpo podría operar sobre un claim
  // que la exclusión mutua no respalda.

  test('claim-by-rename: con el lock retenido por un tercero vivo, NADIE reclama y el work file sobrevive', async () => {
    const dir = mkTmpDir('toctou-saturado-');
    const target = path.join(dir, '6145.pipeline-dev');
    fs.writeFileSync(target, 'issue: 6145\n');

    // Este proceso (vivo) retiene el lock: los hijos no pueden declararlo stale
    // ni robarlo, sólo agotar el timeout.
    const held = fileLock.acquireLockSync(target, { timeoutMs: 2000 });
    assert.equal(held.acquired, true, 'el test debe poder tomar el lock antes de la carrera');

    let results;
    try {
      const N = 4;
      results = await raceWorkers(
        Array.from({ length: N }, () => ({
          SLOT_WORKER_ROLE: 'claim',
          SLOT_TARGET: target,
        })),
      );
      assert.equal(results.length, N, 'todos los contendientes deben responder');
    } finally {
      fileLock.releaseLock(target);
    }

    for (const r of results) {
      assert.equal(r.claimed, false, `nadie puede reclamar con el lock tomado: ${JSON.stringify(r)}`);
      assert.ok(
        !String(r.reason).startsWith('THROW:'),
        `claimByRename no debe propagar excepciones al caller: ${r.reason}`,
      );
      assert.equal(r.reason, 'ELOCK_TIMEOUT', `razón esperada ELOCK_TIMEOUT, llegó ${r.reason}`);
    }

    assert.ok(fs.existsSync(target), 'el work file debe seguir visible al scan del próximo tick');
    assert.equal(
      fs.readdirSync(dir).filter((f) => slotClaim.CLAIM_RE.test(f)).length,
      0,
      'no debe quedar ningún *.claimed-<pid> sin dueño',
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });
}
