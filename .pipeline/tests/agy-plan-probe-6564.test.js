// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const probe = require('../lib/multi-provider/agy-plan-probe');
const cron = require('../lib/multi-provider/health-cron');
const alerts = require('../lib/multi-provider/health-alerts');
const view = require('../views/dashboard/providers');
const causes = require('../lib/provider-pause-cause');
const secrets = require('../lib/multi-provider/secrets-rw');
const NOW = Date.parse('2026-09-16T22:00:00Z');
function payload() {
    return { status: 'SUCCESS', num_turns: 0, usage: { total_tokens: 0 },
        conversation_id: 'secret@example.org', response: 'token=secret',
        command: { data: { groups: probe.GROUPS.map(g => ({ name: g.name,
            buckets: g.ids.map((id, i) => ({ id, window: i ? '5h' : 'weekly', remaining_fraction: 0.9935,
                reset_time: '2026-09-23T16:14:00Z', description: 'secret@example.org' })) })) } } };
}
function check() { return { ...probe.parseUsage(JSON.stringify(payload())), checked_at: new Date(NOW).toISOString() }; }
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-6564-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function fakeSpawn(output, options = {}) {
    const fn = (cmd, args, opts) => {
        fn.calls.push({ cmd, args, opts });
        if (options.throws) throw Error('secret@example.org');
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { fn.killed = true; };
        setImmediate(() => {
            child.stderr.emit('data', 'secret@example.org');
            if (options.hang) return;
            child.stdout.emit('data', output);
            child.emit('close', options.rc || 0);
        });
        return child;
    };
    fn.calls = [];
    return fn;
}
function options(t, spawnImpl) {
    const stateDir = temp(t), exe = path.join(stateDir, 'agy.exe');
    fs.writeFileSync(exe, 'fake');
    return { stateDir, env: { ANTIGRAVITY_BIN: exe }, platform: 'win32', spawnImpl, nowMs: NOW };
}

test('acepta ambos grupos y persiste sólo campos permitidos', async t => {
    const spawnImpl = fakeSpawn(JSON.stringify(payload()));
    const opts = options(t, spawnImpl);
    const result = await probe.probeAgyPlan(opts);
    assert.equal(result.reason_code, 'plan_quota_ok');
    assert.deepEqual(spawnImpl.calls[0].args, ['-p', '/usage', '--output-format', 'json']);
    assert.equal(spawnImpl.calls[0].opts.shell, false);
    const cache = fs.readFileSync(path.join(opts.stateDir, 'agy-plan-probe.json'), 'utf8');
    assert.doesNotMatch(cache, /@|token|conversation_id|description|response/);
    await probe.probeAgyPlan({ ...opts, nowMs: NOW + 899999 });
    assert.equal(spawnImpl.calls.length, 1);
    await probe.probeAgyPlan({ ...opts, nowMs: NOW + 900000 });
    assert.equal(spawnImpl.calls.length, 2);
});

for (const [name, mutate] of [
    ['estado fallido', p => { p.status = 'ERROR'; }],
    ['grupo ausente', p => { p.command.data.groups.pop(); }],
    ['semanal ausente', p => { p.command.data.groups[0].buckets.shift(); }],
    ['fracción textual', p => { p.command.data.groups[0].buckets[0].remaining_fraction = '1'; }],
    ['fracción fuera de rango', p => { p.command.data.groups[0].buckets[0].remaining_fraction = 2; }],
    ['ventana renombrada', p => { p.command.data.groups[0].buckets[0].window = 'month'; }],
    ['grupo duplicado', p => { p.command.data.groups.push(p.command.data.groups[0]); }],
    ['turno real', p => { p.num_turns = 1; }],
    ['consumo real', p => { p.usage.total_tokens = 1; }],
    ['uso ausente', p => { delete p.usage; }],
]) test(`falla cerrado ante ${name}`, () => {
    const p = payload(); mutate(p);
    assert.equal(probe.parseUsage(JSON.stringify(p)).reason_code, 'plan_tier_unknown');
});

test('JSON inválido, null y caché corrupta no interrumpen el probe', async t => {
    for (const value of ['{', 'null', '[]', '']) assert.equal(probe.parseUsage(value).reason_code, 'plan_tier_unknown');
    const opts = options(t, fakeSpawn('{'));
    fs.writeFileSync(path.join(opts.stateDir, 'agy-plan-probe.json'), '{');
    assert.equal((await probe.probeAgyPlan(opts)).reason_code, 'plan_tier_unknown');
});

test('turno real queda bloqueado durante todo el TTL incluso con nueva instancia', async t => {
    const p = payload(); p.num_turns = 1;
    const opts = options(t, fakeSpawn(JSON.stringify(p)));
    await probe.probeAgyPlan(opts);
    const second = fakeSpawn(JSON.stringify(payload()));
    assert.equal((await probe.probeAgyPlan({ ...opts, spawnImpl: second, nowMs: NOW + 300000 })).reason_code, 'plan_tier_unknown');
    assert.equal(second.calls.length, 0);
    await probe.probeAgyPlan({ ...opts, spawnImpl: second, nowMs: NOW + 900000 });
    assert.equal(second.calls.length, 1);
});

test('error ordinario usa TTL negativo de cuatro minutos', async t => {
    const spawnImpl = fakeSpawn('{}'), opts = options(t, spawnImpl);
    await probe.probeAgyPlan(opts);
    await probe.probeAgyPlan({ ...opts, nowMs: NOW + 239999 });
    assert.equal(spawnImpl.calls.length, 1);
    await probe.probeAgyPlan({ ...opts, nowMs: NOW + 240000 });
    assert.equal(spawnImpl.calls.length, 2);
});

for (const failure of [{ hang: true }, { throws: true }, { rc: 1 }, { overflow: true }]) {
    test(`spawn falla sin colgar ni filtrar datos: ${JSON.stringify(failure)}`, async t => {
        const spawnImpl = fakeSpawn(failure.overflow ? 'a'.repeat(70000) : '{}', failure);
        const result = await probe.probeAgyPlan({ ...options(t, spawnImpl), timeoutMs: 15 });
        assert.equal(result.reason_code, 'plan_tier_unknown');
        if (failure.hang || failure.overflow) assert.equal(spawnImpl.killed, true);
    });
}

test('cron mantiene salud, cuenta ticks, reinicia racha y omite probe sin sesión', async t => {
    const stateDir = temp(t);
    const spec = secrets.MANAGED_KEYS.find(s => s.provider === 'antigravity');
    let called = 0;
    const opts = { providers: [spec], stateDir, now: NOW,
        catalogProbe: async () => ({ ok: true, reason: 'cli_catalog_ok', models: ['gemini'], checked_at: new Date(NOW).toISOString() }),
        planProbe: async () => { called++; return { reason_code: 'plan_tier_unknown', checked_at: new Date(NOW).toISOString() }; },
        quotaAssessImpl: () => null };
    const first = await cron.pingAllProviders(opts);
    assert.equal(first[0].state, 'green');
    assert.equal(first[0].plan_check.consecutive_count, 1);
    const second = await cron.pingAllProviders({ ...opts, prevSnapshot: { providers: first } });
    assert.equal(second[0].plan_check.consecutive_count, 2);
    const good = await cron.pingAllProviders({ ...opts, prevSnapshot: { providers: second }, planProbe: async () => check() });
    assert.equal(good[0].plan_check.consecutive_count, 0);
    const absent = await cron.pingAllProviders({ ...opts, prevSnapshot: { providers: second },
        catalogProbe: async () => ({ ok: false, reason: 'cli_license_unavailable' }) });
    assert.equal(absent[0].plan_check.reason_code, 'cli_license_unavailable');
    assert.equal(absent[0].plan_check.consecutive_count, 0);
    assert.equal(called, 2);
});

test('alerta al segundo tick con dedupe durable de 24h separado de salud', t => {
    const dedupFile = path.join(temp(t), 'dedup.json');
    const row = { provider: 'antigravity', state: 'green', reason_code: 'cli_catalog_ok',
        plan_check: { reason_code: 'plan_tier_unknown', consecutive_count: 1 } };
    const texts = [];
    const run = now => cron.emitAlerts({ snapshot: { providers: [row] }, dedupFile, now,
        telegramSender: p => { texts.push(cron.formatAlertText(p)); return true; } });
    assert.equal(run(NOW).length, 0);
    row.plan_check.consecutive_count = 2;
    assert.equal(run(NOW + 300000).length, 1);
    assert.match(texts[0], /⚠️ \*Plan sin verificar\*.*sigue 🟢 SANO/);
    assert.doesNotMatch(texts[0], /@|token|conversation_id/);
    alerts.record({ provider: row.provider, state: 'red', sent: true, now: NOW + 310000, dedupFile });
    assert.equal(run(NOW + 600000).length, 0);
    assert.equal(run(NOW + 300000 + 86400000).length, 1);
    row.plan_check.reason_code = 'plan_quota_ok';
    assert.equal(run(NOW + 2 * 86400000).length, 0);
});

test('sin sesión emite sólo la alerta existente y un envío fallido se reintenta', t => {
    const dedupFile = path.join(temp(t), 'dedup.json');
    const p = { provider: 'antigravity', state: 'red', reason_code: 'cli_license_unavailable',
        plan_check: { reason_code: 'plan_tier_unknown', consecutive_count: 2 } };
    const out = cron.emitAlerts({ snapshot: { providers: [p] }, dedupFile, now: NOW, telegramSender: () => true });
    assert.deepEqual(out.map(x => x.kind), ['red']);
    alerts.recordPlanEvent({ provider: p.provider, sent: false, now: NOW, dedupFile });
    assert.equal(alerts.decidePlanEvent({ provider: p.provider, providerState: 'green', planCheck: p.plan_check, now: NOW, dedupFile }).shouldEmit, true);
});

test('SSR diferencia tres estados y rechaza mediciones viejas, futuras o incompletas', () => {
    const p = { key: 'antigravity', healthReason: 'cli_catalog_ok', planCheck: check() };
    const good = view.renderPlanBadge(p, NOW);
    assert.match(good, /PLAN CON CUOTA · 99% SEMANAL/);
    assert.match(good, /bucket gemini-weekly.*bucket 3p-weekly \(Claude y GPT\)/s);
    assert.match(good, /23\/09 16:14 UTC/);
    assert.doesNotMatch(good, /@|token|conversation_id|🟩|🟧|🟦|🟨/);
    for (const now of [NOW - 1, NOW + 1800001]) assert.match(view.renderPlanBadge(p, now), /PLAN · SIN VERIFICAR/);
    assert.match(view.renderPlanBadge({ ...p, planCheck: null }, NOW), /PLAN · SIN VERIFICAR/);
    assert.match(view.renderPlanBadge({ ...p, healthReason: 'cli_license_unavailable' }, NOW), /PLAN · NO VERIFICABLE/);
    const invalid = check(); invalid.groups.pop();
    assert.match(view.renderPlanBadge({ ...p, planCheck: invalid }, NOW), /PLAN · SIN VERIFICAR/);
});

test('los códigos del plan cumplen el invariante de las tres tablas', () => {
    for (const code of ['plan_quota_ok', 'plan_tier_unknown']) {
        assert.equal(alerts.sanitizeReasonCode(code), code);
        assert.ok(view.REASON_LABEL[code]);
        assert.ok(causes.REASON_TABLE[code]);
    }
    assert.ok(causes.ACTION_SHORT.plan_tier_unknown);
    assert.match(causes.ACTION_FULL.plan_tier_unknown('Gemini'), /cuota del plan/);
});
