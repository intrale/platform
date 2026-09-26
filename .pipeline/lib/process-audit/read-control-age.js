// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// =============================================================================
// process-audit / read-control-age — "este control está apagado hace X días"
// (#6809 H2, SEC-6809-2)
// =============================================================================
//
// `config.yaml` no guarda cuándo se apagó un flag. La fuente es el historial de
// git: se busca la línea EXACTA `  enabled: false…` de la sección y se pregunta
// cuándo entró por última vez con `git log -S<línea>` (pickaxe: el commit más
// reciente que cambió la cantidad de apariciones de esa línea = cuándo se
// escribió el `false` vigente).
//
// Reglas (SEC-6809-2):
//   - Sólo se auditan las claves de la allowlist CERRADA `CONTROLES_AUDITADOS`,
//     validadas con `/^[a-z0-9_.]+$/`. Nunca se toma una clave de lo que se lea
//     en `config.yaml`.
//   - `execFileSync('git', argv)` SIN shell, con `timeout` de 10 s, `maxBuffer`
//     de 1 MB y un presupuesto total por corrida: si se agota, los controles
//     restantes quedan `sin_evidencia_suficiente` y la corrida sigue.
//   - Si la línea aparece más de una vez en el archivo (ambigua) o git falla,
//     ese control queda `sin_evidencia_suficiente`. Nunca se inventa una fecha.
//   - Sólo lectura: `git log` no modifica el repo.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const DAY_MS = 86400000;
const KEY_RE = /^[a-z0-9_.]+$/;
const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 1024 * 1024;
const PRESUPUESTO_MS = 30000;

/** Allowlist cerrada de controles auditables (`<seccion>.enabled`). */
const CONTROLES_AUDITADOS = Object.freeze([
    'architect.enabled',
    'model_value_audit.enabled',
    'handoff.enabled',
    'pacing.enabled',
    'wave_coherence_gate.enabled',
    'pr_mergeability_watcher.enabled',
    'admission_gate.enabled',
    'deliverable_gate.enabled',
    'reduced_mode.enabled',
    'wave_auto_transition.enabled',
    'human_block_reminder.enabled',
    'human_block_auto_recheck.enabled',
    'ghostbusters_cron.enabled',
    'disk_budget.enabled',
    'wave_watchdog.enabled',
    'historico.enabled',
]);

/** Línea exacta `  enabled: false…` dentro de la sección top-level, o null. */
function lineaApagada(texto, seccion) {
    const lineas = String(texto).split(/\r?\n/);
    const headerRe = new RegExp('^' + seccion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(#.*)?$');
    let dentro = false;
    for (const l of lineas) {
        if (!dentro) {
            if (headerRe.test(l)) dentro = true;
            continue;
        }
        if (/^\S/.test(l)) return null; // terminó la sección
        if (/^ {2}enabled:\s*false\b/.test(l)) return l.replace(/\s+$/, '');
    }
    return null;
}

function contar(texto, linea) {
    return String(texto).split(/\r?\n/).filter((l) => l.replace(/\s+$/, '') === linea).length;
}

/**
 * @param {object} p
 * @param {string} p.pipelineDir
 * @param {object} p.cfgRoot            config resuelta (valor vigente de cada flag)
 * @param {number} p.now
 * @param {object} [p.fsImpl]
 * @param {Function} [p.execFileSync]   inyectable (tests)
 * @param {string[]} [p.controles]      subconjunto de la allowlist (tests)
 * @returns {Array<{control:string, estado:string, dias?:number, desde?:string}>}
 */
function readControlAges({ pipelineDir, cfgRoot, now = Date.now(), fsImpl = fs, execFileSync, controles } = {}) {
    const exec = execFileSync || childProcess.execFileSync;
    const lista = (Array.isArray(controles) ? controles : CONTROLES_AUDITADOS)
        .filter((c) => CONTROLES_AUDITADOS.includes(c) && KEY_RE.test(c));
    const out = [];
    const configFile = path.join(pipelineDir, 'config.yaml');
    const repoRoot = path.resolve(pipelineDir, '..');
    const rel = path.relative(repoRoot, configFile).split(path.sep).join('/');
    let texto = null;
    try { texto = String(fsImpl.readFileSync(configFile, 'utf8')); } catch { texto = null; }
    const inicio = Date.now();

    for (const control of lista) {
        const seccion = control.slice(0, control.lastIndexOf('.'));
        const cfg = cfgRoot && typeof cfgRoot === 'object' ? cfgRoot[seccion] : undefined;
        if (!cfg || typeof cfg !== 'object' || cfg.enabled !== false) {
            out.push({ control, estado: 'encendido_o_ausente' });
            continue;
        }
        if (texto === null) { out.push({ control, estado: 'sin_evidencia_suficiente', motivo: 'config_ilegible' }); continue; }
        const linea = lineaApagada(texto, seccion);
        if (!linea || contar(texto, linea) !== 1) {
            out.push({ control, estado: 'sin_evidencia_suficiente', motivo: 'linea_ambigua' });
            continue;
        }
        if (Date.now() - inicio > PRESUPUESTO_MS) {
            out.push({ control, estado: 'sin_evidencia_suficiente', motivo: 'presupuesto_agotado' });
            continue;
        }
        let salida;
        try {
            salida = exec('git', ['log', '-1', '--format=%ct', `-S${linea}`, '--', rel], {
                cwd: repoRoot,
                encoding: 'utf8',
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: GIT_MAX_BUFFER,
                windowsHide: true,
                shell: false,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
        } catch {
            out.push({ control, estado: 'sin_evidencia_suficiente', motivo: 'git_fallo' });
            continue;
        }
        const seg = Number(String(salida || '').trim());
        if (!Number.isInteger(seg) || seg <= 0 || seg * 1000 > now) {
            out.push({ control, estado: 'sin_evidencia_suficiente', motivo: 'sin_commit' });
            continue;
        }
        out.push({
            control,
            estado: 'apagado',
            dias: Math.floor((now - seg * 1000) / DAY_MS),
            desde: new Date(seg * 1000).toISOString().slice(0, 10),
        });
    }
    return out;
}

module.exports = { CONTROLES_AUDITADOS, KEY_RE, GIT_TIMEOUT_MS, GIT_MAX_BUFFER, lineaApagada, readControlAges };
