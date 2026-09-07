'use strict';

// =============================================================================
// service-liveness-sweep.js — Decisión PURA del barrido de servicios (#6441).
// -----------------------------------------------------------------------------
// Entra: qué componentes están declarados, cuáles se vieron vivos, el estado de
// deduplicación previo y el reloj. Sale: a quién avisar, a quién relanzar, quién
// está "vivo pero mudo" y cuál es el nuevo estado de dedup.
//
// Sin I/O a propósito: todo lo que decide vive acá y se cubre con `node --test`.
// El runner (`service-liveness-run.js`) sólo recolecta hechos y ejecuta.
//
// Dos decisiones de diseño que conviene no revertir sin pensarlas:
//
// 1) La alerta se dispara por ESTADO ("está muerto y es supervisado"), no por
//    FLANCO ("se murió recién"). Un emisor que sólo alerta en el flanco pierde
//    la caída para siempre si justo esa corrida falla — y perder la caída es
//    exactamente el incidente que este issue viene a cerrar. El flanco se sigue
//    registrando en el store, que es donde importa que sea un flanco.
//    La deduplicación es la que evita que "por estado" se convierta en un loop.
//
// 2) Un componente NO supervisado igual genera línea en el store, pero no alerta
//    ni se relanza. `outbox-drain` se auto-mata con el Pulpo vivo y `svc-emulador`
//    sólo corre en la ventana QA: alertarlos sería el falso positivo diario que
//    entrena al operador a ignorar los avisos.
// =============================================================================

// Recordatorio por default mientras el servicio siga caído. El primer aviso es
// inmediato; después se recuerda cada 6 h. No degrada a silencio permanente: un
// servicio caído hace tres días tiene que seguir doliendo.
const DEFAULT_REMINDER_MS = 6 * 3600 * 1000;

// "Vivo pero mudo": proceso presente, log sin crecer. Umbral largo a propósito
// (24 h) — svc-emulador logueó 211 bytes en 7 días sin estar roto.
const DEFAULT_QUIET_MS = 24 * 3600 * 1000;

// Qué deja de funcionar cuando cada servicio no está. Es lo que lee el operador
// a las 3 AM: el nombre del proceso no le dice nada, la consecuencia sí.
const IMPACTO = {
    'pulpo': 'no se lanza ningún agente nuevo: el pipeline deja de avanzar',
    'listener': 'los comandos que mandás por Telegram no llegan al pipeline',
    'svc-telegram': 'los avisos del pipeline quedan encolados y no se envían',
    'svc-github': 'las operaciones contra GitHub (issues, labels, PRs) quedan encoladas',
    'svc-drive': 'la evidencia de QA no se sube a Drive',
    'svc-emulador': 'la cola del emulador Android no se atiende',
    'svc-reconciler': 'el tablero deja de sincronizarse con GitHub: se decide sobre datos viejos',
    'outbox-drain': 'la outbox no se drena por fuera del Pulpo',
    'dashboard': 'el panel del operador no responde',
};

function impactoDe(service) {
    return IMPACTO[service] || 'un componente del pipeline deja de prestar su servicio';
}

// Texto de duración en castellano llano. Sin librerías: es una línea de aviso.
function textoDuracion(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'hace un rato';
    const min = Math.floor(ms / 60000);
    if (min < 2) return 'recién';
    if (min < 60) return 'hace ' + min + ' minutos';
    const h = Math.floor(min / 60);
    if (h < 24) return h === 1 ? 'hace 1 hora' : 'hace ' + h + ' horas';
    const d = Math.floor(h / 24);
    return d === 1 ? 'hace 1 día' : 'hace ' + d + ' días';
}

function normalizeDedup(state) {
    const out = { down: {} };
    if (!state || typeof state !== 'object' || !state.down || typeof state.down !== 'object') return out;
    for (const [k, v] of Object.entries(state.down)) {
        if (!v || typeof v !== 'object') continue;
        const firstSeenTs = Number(v.firstSeenTs);
        const lastAlertTs = Number(v.lastAlertTs);
        if (!Number.isFinite(firstSeenTs) || firstSeenTs <= 0) continue;
        out.down[k] = {
            firstSeenTs,
            lastAlertTs: Number.isFinite(lastAlertTs) && lastAlertTs > 0 ? lastAlertTs : 0,
            alerted: !!v.alerted,
        };
    }
    return out;
}

function positivo(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Decide qué hacer con el resultado de un barrido.
 *
 * @param {object} args
 * @param {Array<{name,script,supervisado}>} args.registry — registro canónico.
 * @param {Object<string,{alive:boolean}|boolean>} args.observed — lo que se vio.
 * @param {object} args.dedupState — estado persistido del barrido anterior.
 * @param {number} args.now — reloj (ms).
 * @param {number} [args.reminderMs] — cada cuánto recordar un caído.
 * @param {number} [args.quietThresholdMs] — umbral de "vivo pero mudo".
 * @param {Object<string,number>} [args.logAges] — edad del log por servicio (ms).
 * @returns {{alerts:Array, recovered:Array, relaunch:Array<string>, quiet:Array, nextDedupState:object}}
 */
function sweep(args) {
    const a = args || {};
    const registry = Array.isArray(a.registry) ? a.registry : [];
    const observed = (a.observed && typeof a.observed === 'object') ? a.observed : {};
    const now = Number.isFinite(a.now) ? a.now : Date.now();
    const reminderMs = positivo(a.reminderMs, DEFAULT_REMINDER_MS);
    const quietMs = positivo(a.quietThresholdMs, DEFAULT_QUIET_MS);
    const logAges = (a.logAges && typeof a.logAges === 'object') ? a.logAges : {};

    const prevDedup = normalizeDedup(a.dedupState);
    const nextDown = {};
    const alerts = [];
    const recovered = [];
    const relaunch = [];
    const quiet = [];

    for (const comp of registry) {
        if (!comp || typeof comp.name !== 'string') continue;
        const name = comp.name;
        const raw = observed[name];
        // Un componente declarado que NO aparece en lo observado se trata como
        // muerto: "no lo vi" es exactamente el caso que quedó seis días mudo.
        // Fail hacia la visibilidad, no hacia el silencio.
        const alive = !!(raw && typeof raw === 'object' ? raw.alive : raw);
        const prev = prevDedup.down[name];

        if (alive) {
            if (prev && prev.alerted) {
                recovered.push({
                    service: name,
                    downMs: now - prev.firstSeenTs,
                    message: name + ' volvió a estar vivo (estuvo caído ' +
                        textoDuracion(now - prev.firstSeenTs) + ')',
                });
            }
            // La entrada NO se copia a nextDown: una caída futura vuelve a
            // avisar de inmediato en vez de quedar tapada por el throttle.

            const edad = Number(logAges[name]);
            if (Number.isFinite(edad) && edad >= quietMs) {
                // CA-4 — sólo se REGISTRA. Escalarlo a alerta con los datos que
                // hay hoy generaría falsos positivos (hay servicios que loguean
                // 200 bytes por semana sin estar rotos). Cuando exista una serie
                // real de referencia se decide si esto merece alerta.
                quiet.push({ service: name, ageMs: edad, texto: textoDuracion(edad) });
            }
            continue;
        }

        // --- muerto ---
        if (!comp.supervisado) {
            // Se registra en el store (lo hace el caller), no se alerta ni se
            // relanza: para estos dos, "muerto" no significa "roto".
            continue;
        }

        relaunch.push(name);

        const firstSeenTs = prev ? prev.firstSeenTs : now;
        const debeAvisar = !prev || !prev.alerted || (now - prev.lastAlertTs) >= reminderMs;
        const downMs = now - firstSeenTs;

        if (debeAvisar) {
            const esRecordatorio = !!(prev && prev.alerted);
            alerts.push({
                service: name,
                kind: esRecordatorio ? 'reminder' : 'down',
                downMs,
                impacto: impactoDe(name),
                message: esRecordatorio
                    ? name + ' sigue caído (' + textoDuracion(downMs) + '): ' + impactoDe(name)
                    : name + ' está caído: ' + impactoDe(name),
                action: 'El watchdog intenta relanzarlo. Si el aviso se repite, revisar ' +
                    'logs/' + name + '.log — el servicio no logra arrancar solo.',
            });
            nextDown[name] = { firstSeenTs, lastAlertTs: now, alerted: true };
        } else {
            nextDown[name] = { firstSeenTs, lastAlertTs: prev.lastAlertTs, alerted: true };
        }
    }

    return { alerts, recovered, relaunch, quiet, nextDedupState: { down: nextDown } };
}

module.exports = {
    sweep,
    impactoDe,
    textoDuracion,
    normalizeDedup,
    IMPACTO,
    DEFAULT_REMINDER_MS,
    DEFAULT_QUIET_MS,
};
