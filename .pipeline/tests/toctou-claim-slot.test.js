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

    assert.equal(winners.length, 1, `exactamente un proceso debe ganar el rename (ganaron ${winners.length})`);
    assert.equal(losers.length, N - 1, 'el resto debe perder');
    for (const l of losers) {
      assert.ok(['ENOENT', 'EEXIST'].includes(l.reason), `perdedor con razón inesperada: ${l.reason}`);
    }

    // El archivo canónico ya NO está (lo tiene el ganador como *.claimed-<pid>).
    assert.ok(!fs.existsSync(target), 'el work file canónico fue reclamado');
    const claimed = fs.readdirSync(dir).filter((f) => slotClaim.CLAIM_RE.test(f));
    assert.equal(claimed.length, 1, 'debe existir exactamente un archivo .claimed-<pid>');

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
}
