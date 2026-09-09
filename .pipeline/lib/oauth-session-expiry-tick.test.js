'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const oauth = require('./oauth-session-expiry');
const { runOAuthExpiryTick } = require('./oauth-session-expiry-tick');

test('reintenta si Telegram falla y consume el umbral una sola vez al aceptar el aviso', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-expiry-tick-'));
    const statePath = path.join(dir, 'state.json');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const now = Date.parse('2026-09-07T12:00:00Z');
    const expiresAt = now + 25 * 60 * 1000;
    const refreshExpiresAt = now + 5 * 60 * 1000;
    const originalRead = fs.readFileSync;
    fs.readFileSync = function fakeRead(file, encoding) {
        if (path.resolve(String(file)) === path.resolve(oauth.CREDENTIALS_PATH)) {
            return JSON.stringify({ claudeAiOauth: { expiresAt, refreshTokenExpiresAt: refreshExpiresAt } });
        }
        return originalRead.call(fs, file, encoding);
    };
    t.after(() => { fs.readFileSync = originalRead; });
    const disabledModule = { getDisabledEntry: () => null };
    oauth.evaluate({ statePath, now, disabledModule });
    const evaluate = ({ statePath: marker }) => oauth.evaluate({
        statePath: marker,
        now: now + 1000,
        disabledModule,
    });
    let accepted = false;
    let notifyCalls = 0;
    const notify = () => {
        notifyCalls += 1;
        return accepted ? { ok: true } : { ok: false, reason: 'fake_queue_error' };
    };
    const args = { evaluate, notify, render: (notice) => notice,
        recordEmitted: (record) => oauth.recordEmitted(record), statePath };

    assert.equal(runOAuthExpiryTick(args).emitted, false);
    assert.equal(JSON.parse(originalRead(statePath, 'utf8')).t30_sent, false,
        'el umbral debe seguir disponible');
    accepted = true;
    assert.equal(runOAuthExpiryTick(args).emitted, true);
    assert.equal(evaluate({ statePath }).shouldEmit, false, 'el umbral debe quedar consumido');
    assert.equal(runOAuthExpiryTick(args).emitted, false);
    assert.equal(notifyCalls, 2, 'Telegram recibe un reintento, pero no un duplicado');
});
