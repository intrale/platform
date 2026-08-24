#!/usr/bin/env node
'use strict';

const path = require('node:path');
const metrics = require('../lib/metrics/effective-model');

function show(value) { return value == null ? 'n/d — no observable' : String(value); }

function main(deps = {}) {
    if (deps.logDir) deps.records = metrics.recordsFromLogs(deps.logDir, deps);
    const rows = metrics.auditDeclaredVsEffective(deps);
    console.log('Auditoría de modelo efectivo');
    console.log('declarado: configuración del actor | resuelto: launcher | efectivo: observado en el log');
    console.table(rows.map((r) => ({
        actor: r.skill, proveedor: r.provider, declarado: show(r.model_declared),
        resuelto: show(r.model_resolved), efectivo: show(r.model_effective_top),
        corridas: r.runs, divergentes: r.runs_diverged,
        coincidencia: r.match_pct == null ? 'n/d — no observable' : `${r.match_pct}%`,
    })));
    const divergent = rows.filter((r) => r.runs_diverged > 0).length;
    const silent = rows.filter((r) => r.match_pct == null).length;
    console.log(`${divergent} actores divergentes de ${rows.length} evaluados, ${silent} no observables`);
    return rows;
}

if (require.main === module) {
    const logsAt = process.argv.indexOf('--logs');
    main(logsAt >= 0
        ? { logDir: path.resolve(process.argv[logsAt + 1] || path.join(__dirname, '..', 'logs')) }
        : { file: process.argv[2] ? path.resolve(process.argv[2]) : undefined });
}
module.exports = { main, show };
