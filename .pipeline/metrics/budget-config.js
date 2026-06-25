// V3 Metrics — Presupuesto mensual configurable (#3962 EP8-H9, CA-4)
//
// Persiste el presupuesto mensual (USD) que el operador edita desde la pantalla
// Costos del Dashboard V3. Hasta ahora el presupuesto vivía SOLO en la env var
// `METRICS_QUOTA_MONTHLY_USD` (default 100) y no era editable desde la UI; este
// módulo agrega persistencia en `.pipeline/metrics/budget-config.json`.
//
// Diseño (calca `rest-mode-state.js:73-79`):
//   - Escritura ATÓMICA tmp + rename → nunca deja un JSON a medias.
//   - `readBudget()` tolerante a ENOENT/corrupción → cae al default.
//   - `writeBudget(value, { actor })` con actor FIJO server-side
//     (`operador-local`), NUNCA leído del body del request (REQ-SEC-3).
//
// La VALIDACIÓN del valor (numérico finito, >0, cota, sin notación científica)
// vive en el endpoint mutante (`dashboard-routes.handleBudgetMutation`), que es
// la frontera de confianza. `writeBudget` re-chequea por defensa en profundidad
// y tira si el valor no es un número finito positivo.

'use strict';

const fs = require('fs');
const path = require('path');

let REPO_ROOT;
try {
    ({ REPO_ROOT } = require('../lib/traceability'));
} catch (_) {
    REPO_ROOT = process.env.PIPELINE_REPO_ROOT || path.resolve(__dirname, '..', '..');
}

// Default alineado con `projections.DEFAULT_MONTHLY_TOKEN_USD` (env
// METRICS_QUOTA_MONTHLY_USD, default 100). Si no hay archivo persistido, el
// presupuesto efectivo es este valor.
const DEFAULT_MONTHLY_USD = Number(process.env.METRICS_QUOTA_MONTHLY_USD || 100);

// Cota máxima razonable (REQ-SEC A03). Un presupuesto mensual de tokens por
// encima de esto es casi seguro un error de tipeo o un payload malicioso; el
// endpoint lo rechaza con 400 antes de llegar acá.
const BUDGET_MAX = 1000000;

// Actor FIJO grabado server-side (REQ-SEC-3). Nunca proviene del body.
const FIXED_ACTOR = 'operador-local';

function budgetPath(opts) {
    const o = opts || {};
    if (o.path) return o.path;
    const dir = o.metricsDir || path.join(REPO_ROOT, '.pipeline', 'metrics');
    return path.join(dir, 'budget-config.json');
}

function defaultBudget() {
    return {
        monthly_usd: DEFAULT_MONTHLY_USD,
        actor: null,
        updated_at: null,
        source: 'default',
    };
}

// Lectura tolerante: ENOENT, JSON corrupto o valor inválido → default.
function readBudget(opts) {
    const file = budgetPath(opts);
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return defaultBudget();
    }
    if (!raw || typeof raw !== 'object') return defaultBudget();
    const n = Number(raw.monthly_usd);
    if (!Number.isFinite(n) || n <= 0 || n > BUDGET_MAX) {
        // Archivo presente pero con valor corrupto/fuera de rango → default
        // seguro en lugar de propagar basura a las proyecciones.
        return defaultBudget();
    }
    return {
        monthly_usd: n,
        actor: typeof raw.actor === 'string' ? raw.actor : null,
        updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
        source: 'persisted',
    };
}

// Escritura atómica tmp + rename (patrón rest-mode-state.js:76). El actor es
// FIJO server-side; el `opts.actor` solo permite overridear en tests.
function writeBudget(value, opts) {
    const o = opts || {};
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > BUDGET_MAX) {
        throw new Error('invalid_budget_value');
    }
    const file = budgetPath(o);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
        monthly_usd: n,
        actor: o.actor || FIXED_ACTOR,
        updated_at: o.now || new Date().toISOString(),
    };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file); // atómico
    return Object.assign({ source: 'persisted' }, payload);
}

module.exports = {
    readBudget,
    writeBudget,
    budgetPath,
    DEFAULT_MONTHLY_USD,
    BUDGET_MAX,
    FIXED_ACTOR,
};
