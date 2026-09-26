// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

/**
 * #7636 · CA-5 / CA-7 — ESTACIONAMIENTO de un lanzamiento rechazado por
 * `CHILD_ENV_VIOLATION` y DETECCIÓN DE REVERSA del aislamiento.
 *
 * Por qué existe: una violación del entorno mínimo es un fallo de
 * CONFIGURACIÓN (el rol pide algo que su fase no permite, o no tiene
 * declaración). Reintentar no lo arregla. Antes de este módulo el `catch` de
 * `lanzarAgenteClaude` hacía `throw`, el workfile quedaba en `trabajando/` sin
 * proceso, `brazoHuerfanos` lo contaba como muerte prematura y se quemaban los
 * 3 reintentos (Hueco 1 de guru). Ahora:
 *
 *   1. El workfile pasa a `bloqueado-humano/` de su fase con
 *      `motivo_tipo: child-env-violation`, SIN `rev++` y sin tocar contadores
 *      del circuit breaker. Al salir de `trabajando/`, `brazoHuerfanos` no lo ve.
 *   2. Se escribe el `.reason.json` junto al marker (mismo formato que el resto
 *      de los bloqueos humanos) y se encola `needs-human`: el destrabe es el de
 *      siempre (sacar el label o `/unblock`), después de corregir la config.
 *   3. Se avisa al operador UNA vez por `(rol, causa)`: el marker de episodio se
 *      reclama con `wx` (EEXIST ⇒ ya notificado). Se limpia cuando ese rol
 *      vuelve a lanzar con el entorno OK (`clearViolationNotices`).
 *
 * Todo lo que sale (log, reason, Telegram) lleva SÓLO nombres de variables
 * (RS-3). Nunca se lee el env: la única fuente es `violation.details`.
 *
 * Módulo sin estado global: las dependencias de IO se inyectan (tests).
 */

const fs = require('fs');
const path = require('path');

const {
    formatChildEnvBlockedLine,
    causaKey,
    nombresBloqueados,
    isChildEnvViolation,
} = require('./child-env-error');

const MOTIVO_TIPO = 'child-env-violation';
const NOTICE_DIR_NAME = 'child-env-violations';
const OPERADOR_MAX_NOMBRES = 3;
const SEGMENTO = /^[a-z0-9-]{1,40}$/;

/** Frase humana por familia de variable (audio / Telegram, sin deletrear nombres). */
function familiasDe(nombres) {
    const fam = new Set();
    for (const n of nombres) {
        const u = n.toUpperCase();
        if (u.startsWith('AWS_')) fam.add('de AWS');
        else if (u === 'JAVA_HOME' || u.startsWith('ANDROID_') || u.startsWith('GRADLE_')) fam.add('de Android');
        else if (u === 'GH_TOKEN' || u === 'GITHUB_TOKEN') fam.add('de GitHub');
        else if (u.endsWith('_API_KEY')) fam.add('de proveedores de IA');
        else if (u.startsWith('TELEGRAM_')) fam.add('de Telegram');
    }
    return [...fam];
}

/**
 * Texto del aviso al operador (UX: qué pasó → qué quedó frenado → cómo destrabar).
 * Hasta 3 nombres y "y N más"; la lista completa queda en la línea grepeable.
 */
function formatOperatorNotice({ skill, fase, issue, violation } = {}) {
    const rol = SEGMENTO.test(String(skill)) ? skill : '(rol inválido)';
    const faseTxt = SEGMENTO.test(String(fase)) ? fase : '(fase inválida)';
    const nro = /^\d{1,7}$/.test(String(issue)) ? `#${issue}` : '';
    const nombres = nombresBloqueados(violation);
    const visibles = nombres.slice(0, OPERADOR_MAX_NOMBRES);
    let lista = visibles.join(', ');
    if (nombres.length > OPERADOR_MAX_NOMBRES) lista += ` y ${nombres.length - OPERADOR_MAX_NOMBRES} más`;
    const causa = causaKey(violation);
    const familias = familiasDe(nombres);
    const que = causa.split('+').includes('unknown-skill')
        ? 'el rol no tiene declaración de entorno'
        : (familias.length
            ? `su configuración de entorno pide credenciales ${familias.join(' y ')} que su fase no permite`
            : 'su configuración de entorno no cumple el entorno mínimo de su fase');
    return [
        `🔒 Frené el lanzamiento de ${rol} en ${faseTxt}${nro ? ` (${nro})` : ''}: ${que}`
            + `${lista ? ` (${lista})` : ''}.`,
        'El trabajo quedó en espera y no gastó reintentos.',
        'Para destrabarlo: corregí la config del rol (requires_credentials en agent-models.json '
            + 'o DEFAULT_REQUIRES_BY_SKILL) y sacá el marker de bloqueado-humano/ (quitar needs-human o /unblock).',
        `Causa técnica: ${causa}. Detalle en docs/pipeline/entorno-agentes-hijos.md#encendido-y-reversa.`,
    ].join('\n');
}

function noticeDirFor(pipelineDir) {
    return path.join(pipelineDir, 'state', NOTICE_DIR_NAME);
}

function noticePathFor(pipelineDir, skill, violation) {
    const rol = SEGMENTO.test(String(skill)) ? skill : 'invalido';
    return path.join(noticeDirFor(pipelineDir), `${rol}__${causaKey(violation)}.notified`);
}

/**
 * Reclama el derecho a notificar `(rol, causa)`. `true` una sola vez por
 * episodio. Fail-open ante errores distintos de EEXIST (mismo criterio que
 * `claimEscaladoNotice` del Pulpo: mejor repetir que callar).
 */
function claimViolationNotice({ pipelineDir, skill, violation, fsImpl = fs } = {}) {
    const p = noticePathFor(pipelineDir, skill, violation);
    try {
        fsImpl.mkdirSync(path.dirname(p), { recursive: true });
        fsImpl.writeFileSync(p, new Date().toISOString(), { flag: 'wx' });
        return true;
    } catch (e) {
        if (e && e.code === 'EEXIST') return false;
        return true;
    }
}

/**
 * Cierra el episodio de un rol: cuando el rol vuelve a lanzar con el entorno
 * OK, la próxima violación vuelve a avisar. Best-effort, nunca tira.
 */
function clearViolationNotices({ pipelineDir, skill, fsImpl = fs } = {}) {
    if (!SEGMENTO.test(String(skill))) return 0;
    const dir = noticeDirFor(pipelineDir);
    let borrados = 0;
    try {
        if (!fsImpl.existsSync(dir)) return 0;
        for (const f of fsImpl.readdirSync(dir)) {
            if (!f.startsWith(`${skill}__`)) continue;
            try { fsImpl.unlinkSync(path.join(dir, f)); borrados++; } catch { /* best-effort */ }
        }
    } catch { /* best-effort */ }
    return borrados;
}

/**
 * Estaciona el workfile de un lanzamiento rechazado por CHILD_ENV_VIOLATION.
 *
 * @param {object} o
 * @param {Error} o.violation            error con code CHILD_ENV_VIOLATION
 * @param {string} o.trabajandoPath      workfile en `trabajando/`
 * @param {string} o.faseDir             directorio de la fase (padre de trabajando/)
 * @param {string} o.pipelineDir         raíz `.pipeline/` (markers de episodio)
 * @param {string|number} o.issue
 * @param {string} o.skill
 * @param {string} o.fase
 * @param {string} o.pipeline
 * @param {string} o.intento             `primary:<provider>` | `fallback:<provider>`
 * @param {object} o.deps  { readYaml, writeYaml, moveFile, log, notify, enqueueNeedsHuman, fsImpl }
 * @returns {{ parked:boolean, notified:boolean, line:string, blockedPath:string|null }}
 */
function parkChildEnvViolation(o = {}) {
    const {
        violation, trabajandoPath, faseDir, pipelineDir,
        issue, skill, fase, pipeline, intento, deps = {},
    } = o;
    if (!isChildEnvViolation(violation)) {
        throw new TypeError('[child-env-parking] parkChildEnvViolation sólo acepta CHILD_ENV_VIOLATION.');
    }
    const fsImpl = deps.fsImpl || fs;
    const log = deps.log || (() => {});
    const line = formatChildEnvBlockedLine({ skill, fase, intento, violation });
    log(line);

    const causa = causaKey(violation);
    const nombres = nombresBloqueados(violation);
    const blockedDir = path.join(faseDir, 'bloqueado-humano');
    let blockedPath = null;
    let parked = false;

    // 1. Anotar el workfile. Sin `rev++`, sin `rebote`, sin contadores: esto no
    //    es un rechazo del agente (no llegó a correr) ni un fallo de infra.
    try {
        const data = (deps.readYaml && deps.readYaml(trabajandoPath)) || {};
        const updated = {
            ...data,
            motivo_tipo: MOTIVO_TIPO,
            bloqueado_por_humano: true,
            bloqueo_humano_motivo: `entorno del hijo bloqueado (causa=${causa})`,
            child_env_violation: {
                intento: typeof intento === 'string' ? intento : null,
                causa,
                nombres,
                bloqueado_at: new Date().toISOString(),
            },
        };
        if (deps.writeYaml) deps.writeYaml(trabajandoPath, updated);
    } catch (e) {
        log(`⚠️ #${issue}: no se pudo anotar el workfile antes de estacionar: ${String(e && e.message).slice(0, 120)}`);
    }

    // 2. `.reason.json` junto al marker (lo leen el dashboard, /bloqueados y el destrabe).
    try {
        fsImpl.mkdirSync(blockedDir, { recursive: true });
        const reasonFile = path.join(blockedDir, path.basename(trabajandoPath)) + '.reason.json';
        fsImpl.writeFileSync(reasonFile, JSON.stringify({
            issue: parseInt(issue, 10),
            skill,
            phase: fase,
            pipeline,
            motivo_tipo: MOTIVO_TIPO,
            reason: `Lanzamiento de ${skill} en ${fase} bloqueado por el entorno mínimo (causa=${causa}`
                + `${nombres.length ? `; nombres=${nombres.slice(0, 8).join(',')}` : ''}). No gastó reintentos.`,
            question: 'Corregí la declaración de entorno del rol (requires_credentials o DEFAULT_REQUIRES_BY_SKILL) '
                + 'y destrabá el issue (quitar needs-human o /unblock).',
            blocked_at: new Date().toISOString(),
        }, null, 2));
    } catch (e) {
        log(`⚠️ #${issue}: no se pudo escribir el reason del bloqueo de entorno: ${String(e && e.message).slice(0, 120)}`);
    }

    // 3. Mover a bloqueado-humano/ (sale de trabajando/: brazoHuerfanos no lo ve).
    try {
        blockedPath = deps.moveFile(trabajandoPath, blockedDir);
        parked = true;
    } catch (e) {
        log(`⚠️ #${issue}: no se pudo mover a bloqueado-humano tras la violación de entorno: ${String(e && e.message).slice(0, 120)}`);
    }

    // 4. needs-human (idempotente, best-effort): sin label el intake reinyecta el issue.
    try { if (deps.enqueueNeedsHuman) deps.enqueueNeedsHuman(parseInt(issue, 10)); } catch { /* best-effort */ }

    // 5. Aviso único por (rol, causa).
    let notified = false;
    if (claimViolationNotice({ pipelineDir, skill, violation, fsImpl })) {
        try {
            if (deps.notify) deps.notify(formatOperatorNotice({ skill, fase, issue, violation }));
            notified = true;
        } catch { /* best-effort */ }
    } else {
        log(`🔁 #${issue}: violación de entorno de ${skill} (causa=${causa}) ya notificada en este episodio — sin re-notificar`);
    }

    log(`🚧 #${issue} estacionado en ${pipeline}/${fase}/bloqueado-humano/ (motivo_tipo=${MOTIVO_TIPO}). Sin rev++, sin reintentos.`);
    return { parked, notified, line, blockedPath };
}

// -----------------------------------------------------------------------------
// CA-7 / RS-6 — detección de la reversa `true → false`.
//
// El flag se relee en caliente en cada lanzamiento. El tracker guarda el valor
// del ciclo anterior en memoria del proceso: el arranque (`null → *`) y
// `false → false` no emiten nada; `true → false` devuelve `true` UNA vez.
// -----------------------------------------------------------------------------
function createIsolationTransitionTracker() {
    let last = null;
    return {
        /** @returns {boolean} true sólo en la transición true→false. */
        observe(enabled) {
            const actual = !!enabled;
            const reversa = last === true && actual === false;
            last = actual;
            return reversa;
        },
        get last() { return last; },
    };
}

const REVERSA_LOG_LINE = '[entorno-hijo] aislamiento APAGADO (reversa)';
const REVERSA_OPERADOR_TXT = 'Apagaron el aislamiento de entorno de los agentes (env_isolation_enabled: false). '
    + 'Desde el próximo lanzamiento vuelven a heredar el entorno completo, salvo el token de Telegram. '
    + 'Si no fue intencional, volvé a poner true en .pipeline/config.yaml.';

module.exports = {
    MOTIVO_TIPO,
    NOTICE_DIR_NAME,
    REVERSA_LOG_LINE,
    REVERSA_OPERADOR_TXT,
    parkChildEnvViolation,
    claimViolationNotice,
    clearViolationNotices,
    formatOperatorNotice,
    noticePathFor,
    createIsolationTransitionTracker,
};
