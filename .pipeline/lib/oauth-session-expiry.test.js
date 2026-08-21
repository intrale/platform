'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const oauth = require('./oauth-session-expiry');

const originalRead = fs.readFileSync;

function fixture(t, value) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-expiry-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const statePath = path.join(dir, 'state.json');
    fs.readFileSync = function fakeRead(file, encoding) {
        if (path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)) {
            if (value instanceof Error) throw value;
            return typeof value === 'string' ? value : JSON.stringify(value);
        }
        return originalRead.call(fs, file, encoding);
    };
    t.after(() => { fs.readFileSync = originalRead; });
    return statePath;
}

function credentials(expiresAt, refreshTokenExpiresAt = expiresAt + oauth.NEXT_CYCLE_MS * 2) {
    return { claudeAiOauth: { expiresAt, refreshTokenExpiresAt } };
}

test('calcula una sesión vigente leyendo sólo vencimientos derivados', (t) => {
    const now = Date.UTC(2026, 7, 20, 12);
    fixture(t, credentials(now + 65 * 60000));
    assert.deepEqual(oauth.getOAuthSessionExpiry(now), {
        expiresAt: new Date(now + 65 * 60000), minutesLeft: 65, available: true,
    });
});

test('degrada sin excepción ante archivo ausente o JSON corrupto', async (t) => {
    fixture(t, new Error('missing'));
    assert.deepEqual(oauth.getOAuthSessionExpiry(), { expiresAt: null, minutesLeft: null, available: false });
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? '{dato sintetico invalido'
        : originalRead.call(fs, file, encoding);
    assert.equal(oauth.getOAuthSessionExpiry().available, false);
});

test('la primera lectura persiste y no emite', (t) => {
    const now = 1_800_000_000_000;
    const statePath = fixture(t, credentials(now + 25 * 60000, now + 20 * 60000));
    const d = oauth.evaluate({ now, statePath });
    assert.equal(d.reason, 'first_reading');
    assert.equal(d.shouldEmit, false);
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).expires_at_epoch, now + 25 * 60000);
});

test('emite T-30 una sola vez cuando el refresh no alcanza', (t) => {
    const now = 1_800_000_000_000;
    const value = credentials(now + 25 * 60000, now + 20 * 60000);
    const statePath = fixture(t, value);
    oauth.evaluate({ now: now - 60000, statePath });
    const first = oauth.evaluate({ now, statePath });
    assert.equal(first.threshold, 't30');
    assert.equal(first.reason, 'refresh_insufficient');
    assert.equal(oauth.recordEmitted({ statePath, alert: first.alert, threshold: first.threshold }), true);
    assert.equal(oauth.evaluate({ now: now + 60000, statePath }).shouldEmit, false);
});

test('un salto directo a T-10 marca también T-30', (t) => {
    const now = 1_800_000_000_000;
    const statePath = fixture(t, credentials(now + 8 * 60000, now));
    oauth.evaluate({ now: now - 60000, statePath });
    const d = oauth.evaluate({ now, statePath });
    assert.equal(d.threshold, 't10');
    oauth.recordEmitted({ statePath, alert: d.alert, threshold: d.threshold });
    const state = JSON.parse(originalRead(statePath, 'utf8'));
    assert.equal(state.t30_sent, true);
    assert.equal(state.t10_sent, true);
});

test('una sesión vencida no emite avisos anticipados', (t) => {
    const now = 1_800_000_000_000;
    const statePath = fixture(t, credentials(now - 60000, now - 60000));
    oauth.evaluate({ now: now - 120000, statePath });
    assert.equal(oauth.evaluate({ now, statePath }).reason, 'already_expired');
});

test('la renovación resetea umbrales y cierra un aviso abierto', (t) => {
    const now = 1_800_000_000_000;
    let epoch = now + 5 * 60000;
    const statePath = fixture(t, credentials(epoch, now));
    oauth.evaluate({ now: now - 60000, statePath });
    const warning = oauth.evaluate({ now, statePath });
    oauth.recordEmitted({ statePath, alert: warning.alert, threshold: warning.threshold });
    epoch = now + 8 * 60 * 60000;
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? JSON.stringify(credentials(epoch)) : originalRead.call(fs, file, encoding);
    const renewed = oauth.evaluate({ now: now + 60000, statePath });
    assert.equal(renewed.alert, 'renewed');
    const state = JSON.parse(originalRead(statePath, 'utf8'));
    assert.equal(state.t10_sent, false);
    assert.equal(state.renewal_unhealthy, false);
});

test('tres lecturas fallidas abren un único episodio de salud y la recuperación lo cierra', (t) => {
    const now = 1_800_000_000_000;
    const statePath = fixture(t, new Error('missing'));
    assert.equal(oauth.evaluate({ now, statePath }).shouldEmit, false);
    assert.equal(oauth.evaluate({ now: now + 5 * 60000, statePath }).shouldEmit, false);
    const alert = oauth.evaluate({ now: now + 10 * 60000, statePath });
    assert.equal(alert.alert, 'health_unavailable');
    oauth.recordEmitted({ statePath, alert: alert.alert });
    assert.equal(oauth.evaluate({ now: now + 15 * 60000, statePath }).shouldEmit, false);
    fs.readFileSync = (file, encoding) => path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)
        ? JSON.stringify(credentials(now + 9 * 60 * 60000)) : originalRead.call(fs, file, encoding);
    const recovered = oauth.evaluate({ now: now + 20 * 60000, statePath });
    assert.equal(recovered.alert, 'health_recovered');
});

test('en régimen sano cruza umbrales en silencio', (t) => {
    const now = 1_800_000_000_000;
    const epoch = now + 25 * 60000;
    const statePath = fixture(t, credentials(epoch, epoch + oauth.NEXT_CYCLE_MS));
    oauth.evaluate({ now: now - 60000, statePath });
    assert.equal(oauth.evaluate({ now, statePath }).reason, 'automatic_renewal_expected');
});
