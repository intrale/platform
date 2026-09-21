#!/usr/bin/env node
// =============================================================================
// model-value-report.js — Auditoría de calidad-precio del modelo por agente
// (#7519, parte 3 de #6793)
// =============================================================================
//
// CLI READ-ONLY sobre el pipeline, espejo 1:1 de
// `scripts/provider-contribution-report.js`. Responde la pregunta del operador
// "¿qué agente corre con un modelo más caro (o más flojo) de lo que su calidad
// justifica?" con un veredicto cerrado por skill y su evidencia numérica.
//
// LO QUE ESTE SCRIPT **NO** HACE (CA-20, CA-30):
//   - No modifica `config.yaml` ni `agent-models.json`.
//   - No escribe en `state/` ni en `metrics/`.
//   - No cambia el modelo de nadie: MARCA, no ejecuta.
//
// La ÚNICA escritura posible es OPT-IN (`--registrar`) y va a un audit
// append-only con hash-chain (`.pipeline/audit/model-value-audit.jsonl`) vía
// `lib/model-value-audit/audit.registrar` → `lib/audit-log.appendChained`.
//
// -----------------------------------------------------------------------------
// USO
// -----------------------------------------------------------------------------
//
//   node .pipeline/scripts/model-value-report.js [opts]
//
//   --dias=N              Ventana en días (default 30, MÍNIMO 30 — CA-19).
//   --hasta=YYYY-MM-DD    Fin de la ventana (default: ahora).
//   --compacto            Tabla de 4 columnas (terminales angostas).
//   --json                Emitir SOLO el JSON canónico (sin texto para humanos).
//   --registrar           Registrar la corrida en el audit append-only.
//   --pipeline-dir=PATH   Override de `.pipeline/` (tests).
//
// Exit codes (CA-19b, SEC-R5/R6):
//   0 — reporte emitido (y registrado, si se pidió).
//   1 — argumentos, config o lectura inválidos.
//   2 — `--registrar` falló (difiere a propósito del espejo, que traga el
//       error: #7528). Con `--json`, en TODO camino de error stdout queda vacío.
//
// Toda salida va por `deps.stdout` / `deps.stderr` (nunca por la consola global).
//
// =============================================================================
'use strict';

const path = require('node:path');

const { runAudit } = require('../lib/model-value-audit');
const audit = require('../lib/model-value-audit/audit');
const report = require('../lib/model-value-audit/report');

const { AUDIT_FILE } = audit;
const DEFAULT_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 30;
const TAG = '[model-value-report]';

// -----------------------------------------------------------------------------
// parseArgs
// -----------------------------------------------------------------------------

function parseArgs(argv) {
    const out = {
        dias: DEFAULT_WINDOW_DAYS,
        hasta: null,
        compacto: false,
        json: false,
        registrar: false,
        pipelineDir: path.resolve(__dirname, '..'),
        errors: [],
    };
    const numero = (k, v, { min, max, entero }) => {
        const n = Number(v);
        if (v === null || v === '' || !Number.isFinite(n)) {
            out.errors.push(`${k}: valor invalido ${JSON.stringify(v)} (esperado numero`
                + ` entre ${min} y ${max === undefined ? '∞' : max})`);
            return null;
        }
        if (n < min) {
            // C1: el espejo NO valida el mínimo; acá es un CA (CA-19).
            out.errors.push(`${k}: mínimo ${min} (recibido ${entero ? Math.floor(n) : n})`);
            return null;
        }
        if (max !== undefined && n > max) {
            out.errors.push(`${k}: máximo ${max} (recibido ${n})`);
            return null;
        }
        return entero ? Math.floor(n) : n;
    };
    for (const raw of argv || []) {
        const s = String(raw);
        const [k, v] = s.includes('=') ? [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)] : [s, null];
        switch (k) {
            case '--dias': {
                const n = numero(k, v, { min: MIN_WINDOW_DAYS, entero: true });
                if (n !== null) out.dias = n;
                break;
            }
            case '--hasta': {
                const ok = /^\d{4}-\d{2}-\d{2}$/.test(v || '') && Number.isFinite(Date.parse(`${v}T00:00:00Z`))
                    && new Date(Date.parse(`${v}T00:00:00Z`)).toISOString().slice(0, 10) === v;
                if (!ok) out.errors.push(`--hasta: formato invalido ${JSON.stringify(v)} (esperado YYYY-MM-DD)`);
                else out.hasta = v;
                break;
            }
            case '--compacto': out.compacto = true; break;
            case '--json': out.json = true; break;
            case '--registrar': out.registrar = true; break;
            case '--pipeline-dir':
                if (v) out.pipelineDir = v;
                else out.errors.push('--pipeline-dir: valor requerido');
                break;
            default:
                out.errors.push(`opcion desconocida: ${k}`);
                break;
        }
    }
    return out;
}

/**
 * El comando EXACTO que regenera este reporte, copiable tal cual (incluye
 * `--hasta`: sin él, el "reproducible" daría otra ventana al día siguiente).
 */
function reproducibleCommand(args) {
    const parts = ['node .pipeline/scripts/model-value-report.js', `--dias=${args.dias}`];
    if (args.hasta) parts.push(`--hasta=${args.hasta}`);
    if (args.compacto) parts.push('--compacto');
    return parts.join(' ');
}

// -----------------------------------------------------------------------------
// main
// -----------------------------------------------------------------------------

/**
 * @param {string[]} [argv]
 * @param {object} [deps]  `{ stdout, stderr, fsImpl, auditLog, pricing, configResolver,
 *                          effectiveModel, now, providerAlias, args, readSources,
 *                          sanitize, pricingFreshness, qualitySignal, reboundSince }`
 * @returns {0|1|2}
 */
function main(argv, deps = {}) {
    const stdout = deps.stdout || process.stdout;
    const stderr = deps.stderr || process.stderr;
    const args = { ...parseArgs(argv || process.argv.slice(2)), ...(deps.args || {}) };
    if (args.errors && args.errors.length) {
        for (const e of args.errors) stderr.write(`${TAG} ${e}\n`);
        return 1;
    }
    // Reloj: `deps.now` (función) o `args.now` (epoch fijo, patrón del espejo).
    const now = typeof deps.now === 'function'
        ? deps.now
        : (Number.isFinite(args.now) ? () => args.now : Date.now);
    const pipelineDir = path.resolve(args.pipelineDir);

    let rep;
    try {
        rep = runAudit({ pipelineDir, dias: args.dias, hasta: args.hasta, deps: { ...deps, now } });
    } catch (err) {
        // Contrato de config-resolver para CLIs: mensaje redactado + exit 1.
        // No se degrada a defaults ni se emite un reporte a medias.
        stderr.write(`${TAG} ${err && err.message ? err.message : String(err)}\n`);
        return 1;
    }

    if (args.registrar) {
        try {
            audit.registrar({ pipelineDir, report: rep, fsImpl: deps.fsImpl, auditLog: deps.auditLog, now });
        } catch (err) {
            // Fail-closed (SEC-R5): nunca exit 0 con la decisión sin registrar.
            stderr.write(`${TAG} audit: ${err && err.message ? err.message : String(err)}\n`);
            return 2;
        }
    }

    if (args.json) {
        stdout.write(`${JSON.stringify(rep, null, 2)}\n`);
    } else {
        stdout.write(`${report.renderHuman(rep, { compacto: args.compacto, comando: reproducibleCommand(args) })}\n`);
    }
    return 0;
}

module.exports = {
    parseArgs,
    main,
    reproducibleCommand,
    AUDIT_FILE,
    DEFAULT_WINDOW_DAYS,
    MIN_WINDOW_DAYS,
};

if (require.main === module) {
    process.exitCode = main();
}
