#!/usr/bin/env node
// =============================================================================
// service-liveness-run.js — Barrido de liveness de servicios declarados (#6441)
//
// Lo invoca `watchdog.ps1` en cada ciclo (Task Scheduler, ~2 min). Compara el
// registro canónico de componentes contra los procesos node vivos, asienta los
// flancos en `process-transitions.jsonl` y avisa al operador de los caídos.
//
// Por qué existe
// -------------
// Hasta #6441 el único que computaba el flanco vivo↔muerto era el dashboard
// (`dashboard.js` → `recordSnapshot`). Si el dashboard no snapshoteaba, o el
// componente no entraba en su lista, el flanco no se computaba nunca: sin flanco
// no hay alerta, y `svc-reconciler` estuvo seis días muerto en silencio. La
// detección se muda acá, que corre siempre y lee del registro canónico.
//
// Salida stdout (una línea, la lee PowerShell):
//   ACTION:ok                       — todos los supervisados vivos
//   ACTION:down:svc-a,svc-b         — supervisados caídos (informativo)
//
// El relanzamiento NO se ordena desde acá: lo hace el loop de servicios caídos
// del propio `watchdog.ps1`, que ya tiene el double-check anti-TOCTOU justo
// antes de spawnear. Emitir además una orden de relanzamiento produciría dos
// spawns del mismo servicio en el mismo ciclo. La línea `ACTION:down:` es para
// que el .ps1 la deje registrada, no para que actúe sobre ella.
//
// Fail-soft: cualquier error interno => `ACTION:ok` + log. Un bug del barrido no
// puede tumbar el watchdog. Lo que NO es fail-soft es el aviso: si el estado de
// dedup no se puede leer o escribir, se alerta IGUAL (mejor un aviso repetido
// que una caída muda — ver `emitirAlerta`).
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const PIPELINE_DIR = process.env.SLV_PIPELINE_DIR || __dirname;
const LOG_DIR = process.env.SLV_LOG_DIR || path.join(PIPELINE_DIR, 'logs');
const STATE_FILE = process.env.SLV_STATE_FILE || path.join(LOG_DIR, 'service-liveness-state.json');
const RUN_LOG = path.join(LOG_DIR, 'service-liveness.log');

// `lib/` se resuelve contra el directorio de ESTE archivo, no contra
// PIPELINE_DIR: el override de env sólo mueve dónde se leen/escriben datos, no
// de dónde se carga el código.
const stale = require('./lib/stale-services');
const transitions = require('./lib/process-transitions');
const { sweep, DEFAULT_REMINDER_MS, DEFAULT_QUIET_MS } = require('./lib/service-liveness-sweep');

// OJO: el de la RAÍZ, no `lib/pid-discovery`. Éste expone `scanNodeProcesses` /
// `findPidByScriptIn` / `processForPid`, que identifican al proceso por su
// COMMAND LINE. `lib/pid-discovery` sólo expone `pidAlive`, que responde "ese
// número de PID existe" — y un PID reciclado por otro proceso da vivo un
// servicio muerto (le pasó a `svc-emulador.pid`). Acá no se leen pid files.
const pidDiscovery = require('./pid-discovery');

function log(msg) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(RUN_LOG, '[' + new Date().toISOString() + '] ' + msg + '\n');
    } catch { /* fail-soft: si no podemos loguear, seguimos */ }
}

// ---------------------------------------------------------------------------
// Estado de dedup.
//
// No se reusa `lib/watchdog-supervisor.saveStateAtomic`: su `normalizeState`
// conoce un esquema concreto (`relaunches`/`lastRelaunchTs`/`lastEscalationTs`)
// y descarta cualquier otra clave — guardar `{down:{...}}` con esa función lo
// borraría entero, en silencio. Se reusa el PATRÓN (tmp + rename), no el código.
// ---------------------------------------------------------------------------
function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
        // Distinguir "no existe todavía" (primer arranque, normal) de "no se
        // pudo leer" (permisos, JSON corrupto). El segundo caso se loguea: si
        // el dedup no persiste, el operador tiene que poder explicarse por qué
        // recibe el mismo aviso cada dos minutos.
        if (!e || e.code !== 'ENOENT') {
            log('WARN no se pudo leer el estado de dedup (' + ((e && e.message) || 'error') +
                ') — se alerta igual, con riesgo de repetir el aviso');
        }
        return { down: {} };
    }
}

function saveState(state) {
    const tmp = STATE_FILE + '.tmp';
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
        fs.renameSync(tmp, STATE_FILE);
        return true;
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
        log('WARN no se pudo persistir el estado de dedup: ' + ((e && e.message) || 'error'));
        return false;
    }
}

// ---------------------------------------------------------------------------
// Config: umbrales bajo `watchdog:` en config.yaml. `lib/config-schema.js`
// declara `watchdog: OBJ()` (objeto permisivo), así que agregar claves no
// requiere tocar el schema ni puede disparar el fail-closed de "config nuevo vs
// schema viejo en memoria".
//
// Require LAZY (mismo motivo que `watchdog-supervisor-run.js`): config-resolver
// arrastra `js-yaml` y `ajv`, y este runner puede correr en un worktree sin
// `node_modules`. Un require en el tope mataría el proceso en el import y el
// fallo sería MUDO. La degradación a defaults se loguea SIEMPRE.
// ---------------------------------------------------------------------------
function loadUmbrales() {
    const defaults = { reminderMs: DEFAULT_REMINDER_MS, quietThresholdMs: DEFAULT_QUIET_MS };
    let cfg;
    try {
        // eslint-disable-next-line global-require
        const configResolver = require('./lib/config-resolver');
        const resolved = configResolver.resolve({ pipelineDir: PIPELINE_DIR });
        cfg = resolved && resolved.watchdog;
    } catch (e) {
        log('config.yaml no legible (' + ((e && e.message) || 'error').slice(0, 120) +
            ') — se usan los umbrales por default (recordatorio 6 h, mudo 24 h)');
        return defaults;
    }
    if (!cfg || typeof cfg !== 'object') {
        log('sin bloque `watchdog:` en config.yaml — umbrales por default');
        return defaults;
    }
    const horas = (v, def) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n * 3600 * 1000 : def;
    };
    return {
        reminderMs: horas(cfg.service_liveness_reminder_hours, defaults.reminderMs),
        quietThresholdMs: horas(cfg.service_liveness_quiet_hours, defaults.quietThresholdMs),
    };
}

// ---------------------------------------------------------------------------
// Recolección de hechos.
// ---------------------------------------------------------------------------

/**
 * ¿Está vivo el componente? Identidad por command line, nunca por pid file.
 *
 * Doble chequeo a propósito: `findPidByScriptIn` encuentra la fila del scan cuya
 * command line menciona el script, y `processForPid` confirma que ese PID sigue
 * siendo un proceso node del scan. Contrato de `processForPid`: `null` significa
 * EXCLUSIVAMENTE "el PID no aparece entre los procesos node".
 */
function observar(vivos) {
    const observed = {};
    for (const comp of stale.COMPONENT_REGISTRY) {
        let alive = false;
        try {
            const found = pidDiscovery.findPidByScriptIn(vivos, comp.script);
            alive = !!(found && pidDiscovery.processForPid(found.pid));
        } catch { alive = false; }
        observed[comp.name] = { alive };
    }
    return observed;
}

// Edad del log por componente (para "vivo pero mudo"). Un log ausente no es
// señal de nada: `logs/outbox-drain.log` directamente no existe.
function edadesDeLog(now) {
    const ages = {};
    for (const comp of stale.COMPONENT_REGISTRY) {
        try {
            const st = fs.statSync(path.join(LOG_DIR, comp.name + '.log'));
            ages[comp.name] = now - st.mtimeMs;
        } catch { /* sin log: no se evalúa */ }
    }
    return ages;
}

// ---------------------------------------------------------------------------
// Emisión.
// ---------------------------------------------------------------------------
function emitirAlerta(level, alerta) {
    try {
        // eslint-disable-next-line global-require
        const { notifyTelegram } = require('./lib/notify-telegram');
        notifyTelegram({
            level,
            component: 'service-liveness',
            message: alerta.message,
            action: alerta.action,
            context: alerta.context,
        });
    } catch (e) {
        // El canal de Telegram NO es el único camino: la transición ya quedó
        // asentada en el store y se ve en /ops. Si el caído es `svc-telegram` o
        // `listener`, el aviso queda encolado hasta que vuelvan — por eso el
        // store es la fuente de verdad y esto es best-effort.
        log('WARN no se pudo encolar el aviso de ' + alerta.service + ': ' + ((e && e.message) || 'error'));
    }
}

function main() {
    const now = Date.now();
    const umbrales = loadUmbrales();

    // UN solo scan del SO por corrida, reusado para todos los componentes.
    const vivos = pidDiscovery.scanNodeProcesses();
    const observed = observar(vivos);

    // El store se asienta SIEMPRE, para todos los componentes (supervisados o
    // no) y antes de cualquier decisión de aviso: es la evidencia que sobrevive
    // aunque el canal de notificación esté caído.
    let flancos = [];
    try {
        flancos = transitions.recordSweep(observed, { pipelineDir: PIPELINE_DIR, now });
    } catch (e) {
        log('WARN no se pudo asentar el barrido en el store: ' + ((e && e.message) || 'error'));
    }
    for (const f of flancos) {
        log('transición ' + f.service + ': ' + f.from + ' -> ' + f.to + ' (' + f.reason + ')');
    }

    const state = loadState();
    const d = sweep({
        registry: stale.COMPONENT_REGISTRY,
        observed,
        dedupState: state,
        now,
        reminderMs: umbrales.reminderMs,
        quietThresholdMs: umbrales.quietThresholdMs,
        logAges: edadesDeLog(now),
    });

    // Persistir ANTES de notificar. Si el proceso muere entre medio, el peor
    // caso es un aviso perdido; al revés, el peor caso es re-alertar cada dos
    // minutos, que es el loop que el CA prohíbe.
    saveState(d.nextDedupState);

    for (const q of d.quiet) {
        // CA-4: sólo registro, sin escalar (ver el comentario del sweep).
        log('vivo pero mudo: ' + q.service + ' — su log no crece ' + q.texto);
    }

    for (const a of d.alerts) {
        log((a.kind === 'reminder' ? 'RECORDATORIO' : 'CAÍDO') + ' ' + a.service + ': ' + a.message);
        emitirAlerta('error', {
            service: a.service,
            // El texto se arma con datos del registro (enum cerrado de 9
            // nombres) y con literales de este repo. No se interpola nada que
            // venga de un log ni de la línea de comandos de un proceso.
            message: a.message,
            action: a.action,
            context: { impacto: a.impacto },
        });
    }

    for (const r of d.recovered) {
        log('RECUPERADO ' + r.service + ': ' + r.message);
        emitirAlerta('info', {
            service: r.service,
            message: r.message,
            action: 'No hace falta hacer nada: el servicio volvió solo.',
            context: {},
        });
    }

    const caidos = d.relaunch;
    process.stdout.write(caidos.length ? 'ACTION:down:' + caidos.join(',') + '\n' : 'ACTION:ok\n');
}

try {
    main();
} catch (err) {
    log('ERROR inesperado en el barrido: ' + ((err && err.message) || 'error'));
    // Fail-soft hacia el .ps1: un bug del barrido no puede tumbar el watchdog.
    process.stdout.write('ACTION:ok\n');
}
