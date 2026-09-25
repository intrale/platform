// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// Diagnóstico opcional del heartbeat; no cambia el estado ni los gates.
const fs = require('node:fs');
const path = require('node:path');
const liveness = require('./process-liveness');
const MAX_AGE_MS = 120000;
let startedAt;

function snapshot(pipelineDir) {
    if (startedAt === undefined) startedAt = liveness.getProcessStartTime(process.pid);
    return {
        version: 1,
        pipelineDir: path.resolve(pipelineDir),
        startedAt,
        strict: process.env.PARTIAL_PAUSE_STRICT_AUTH === '1',
    };
}

function read(pipelineDir, deps = {}) {
    const source = path.join(pipelineDir, 'last-tick.json');
    const fail = (reason) => ({ ok: false, strict: false, source, reason });
    try {
        const tick = JSON.parse(fs.readFileSync(source, 'utf8'));
        const auth = tick.runtimeAuth;
        const age = (deps.now || Date.now)() - Date.parse(tick.timestamp);
        const normalize = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
        if (!auth || auth.version !== 1 || typeof auth.strict !== 'boolean'
            || typeof auth.pipelineDir !== 'string' || !auth.startedAt
            || normalize(auth.pipelineDir) !== normalize(pipelineDir)
            || !Number.isInteger(tick.pid) || tick.pid <= 0
            || !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return fail('heartbeat_no_acreditado');
        const processInfo = (deps.processForPid || require('../pid-discovery').processForPid)(tick.pid);
        const script = normalize(path.join(pipelineDir, 'pulpo.js'));
        const command = processInfo && String(processInfo.commandLine || '').replace(/\\/g, '/').toLowerCase();
        // El PID debe seguir siendo el mismo proceso y ejecutar el Pulpo de este checkout.
        const args = command && command.match(/"[^"]*"|\S+/g);
        if (!processInfo || processInfo.pid !== tick.pid || !args
            || !args.some((arg) => arg.replace(/^"|"$/g, '') === script)
            || (deps.identityMatches || liveness.processIdentityMatches)(tick.pid, { startedAt: auth.startedAt }) !== true) {
            return fail('identidad_servicio_no_acreditada');
        }
        return { ok: true, strict: auth.strict, source, pid: tick.pid, observedAt: tick.timestamp, ageMs: age };
    } catch { return fail('heartbeat_ausente_o_ilegible'); }
}

module.exports = { snapshot, read, MAX_AGE_MS };
