// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #6564: cuota observada, nunca inferencia del tier contratado.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveAgyBinary, DEFAULT_TTL_MS, DEFAULT_NEGATIVE_TTL_MS, DEFAULT_TIMEOUT_MS } = require('./agy-catalog-probe');
const GROUPS = Object.freeze([
    { name: 'Gemini Models', ids: ['gemini-weekly', 'gemini-5h'] },
    { name: 'Claude and GPT models', ids: ['3p-weekly', '3p-5h'] },
]);
const UNKNOWN = 'plan_tier_unknown';
const OK = 'plan_quota_ok';
const LICENSE = 'cli_license_unavailable';

function sanitizeGroups(groups) {
    if (!Array.isArray(groups)) return null;
    const result = [];
    for (const spec of GROUPS) {
        const matches = groups.filter(g => g && g.name === spec.name);
        if (matches.length !== 1 || !Array.isArray(matches[0].buckets)) return null;
        const buckets = [];
        for (const [i, id] of spec.ids.entries()) {
            const found = matches[0].buckets.filter(b => b && b.id === id);
            if (found.length === 0 && i === 1) continue;
            if (found.length !== 1) return null;
            const b = found[0];
            const window = i === 0 ? 'weekly' : '5h';
            if (b.window !== window || !Number.isFinite(b.remaining_fraction)
                || b.remaining_fraction < 0 || b.remaining_fraction > 1) return null;
            const reset = typeof b.reset_time === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(b.reset_time)
                && Number.isFinite(Date.parse(b.reset_time)) ? new Date(b.reset_time).toISOString() : null;
            buckets.push({ id, window, remaining_fraction: b.remaining_fraction, reset_time: reset });
        }
        result.push({ name: spec.name, buckets });
    }
    return result;
}

function parseUsage(stdout) {
    try {
        const p = JSON.parse(stdout);
        const consumed = p.num_turns > 0 || (p.usage && p.usage.total_tokens > 0);
        const groups = p.status === 'SUCCESS' && p.num_turns === 0 && p.usage && p.usage.total_tokens === 0
            ? sanitizeGroups(p.command && p.command.data && p.command.data.groups) : null;
        return { reason_code: groups ? OK : UNKNOWN, groups: groups || [], consumed };
    } catch { return { reason_code: UNKNOWN, groups: [], consumed: false }; }
}

// Lista cerrada también al leer caché/snapshot: ningún texto del CLI llega al panel.
function sanitizePlanCheck(value, now = Date.now()) {
    const p = value || {};
    const time = typeof p.checked_at === 'string' ? Date.parse(p.checked_at) : NaN;
    const checked_at = Number.isFinite(time) ? new Date(time).toISOString() : null;
    const fresh = Number.isFinite(time) && now >= time && now - time <= 2 * DEFAULT_TTL_MS;
    const groups = p.reason_code === OK && fresh ? sanitizeGroups(p.groups) : null;
    const reason_code = p.reason_code === LICENSE ? LICENSE : groups ? OK : UNKNOWN;
    return { reason_code, checked_at, groups: groups || [] };
}

function runUsage({ cmd, env, spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    return new Promise(resolve => {
        let child, timer, done = false, stdout = '', bytes = 0;
        const finish = result => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(result);
        };
        try {
            child = spawnImpl(cmd, ['-p', '/usage', '--output-format', 'json'], {
                shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
            });
            timer = setTimeout(() => {
                finish(null);
                try { child.kill(); } catch { /* cierre defensivo */ }
            }, timeoutMs);
            child.stdout.on('data', chunk => {
                bytes += Buffer.byteLength(chunk);
                if (bytes > 64 * 1024) {
                    finish(null);
                    try { child.kill(); } catch { /* cierre defensivo */ }
                } else if (!done) stdout += String(chunk);
            });
            child.stderr.on('data', () => {});
            child.on('error', () => finish(null));
            child.on('close', code => finish(code === 0 ? stdout : null));
        } catch { finish(null); }
    });
}

async function probeAgyPlan(opts = {}) {
    const now = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const fsImpl = opts.fsImpl || fs;
    const env = opts.env || process.env;
    // #7112 — sin `opts.stateDir` el dir sale del envoltorio (SEC-13): sin ambiente
    // declarado ni dir de pruebas avisa por stderr y LANZA (CA-3), nunca `__dirname`.
    const file = path.join(opts.stateDir
        || require('../write-target').writePath(process.env, { canal: 'estado', destino: 'state/agy-plan-probe.json' }, 'state'), 'agy-plan-probe.json');
    const unknown = { reason_code: UNKNOWN, checked_at: new Date(now).toISOString(), groups: [] };
    const ttl = DEFAULT_TTL_MS;
    try {
        const cached = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
        const age = now - Date.parse(cached.checked_at);
        const effectiveTtl = cached.reason_code === OK || cached.generation_discarded === true ? ttl : DEFAULT_NEGATIVE_TTL_MS;
        if (cached.version === 1 && age >= 0 && age < effectiveTtl) return sanitizePlanCheck(cached, now);
    } catch { /* caché ausente o ilegible: medir */ }
    let parsed = { reason_code: UNKNOWN, groups: [], consumed: false };
    try {
        const bin = resolveAgyBinary({ env, fsImpl, platform: opts.platform });
        if (bin.available) parsed = parseUsage(await runUsage({ cmd: bin.cmd, env, spawnImpl: opts.spawnImpl, timeoutMs: opts.timeoutMs }));
    } catch { /* nunca interrumpir el cron */ }
    const result = { ...unknown, reason_code: parsed.reason_code, groups: parsed.groups };
    // El flag cerrado evita reintentar un turno real dentro de los 15 minutos.
    const entry = { version: 1, ...result, generation_discarded: parsed.consumed };
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    try {
        fsImpl.mkdirSync(path.dirname(file), { recursive: true });
        fsImpl.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
        fsImpl.renameSync(tmp, file);
    } catch {
        try { fsImpl.unlinkSync(tmp); } catch { /* best effort */ }
    }
    return result;
}

module.exports = { probeAgyPlan, parseUsage, sanitizeGroups, sanitizePlanCheck, runUsage, GROUPS };
