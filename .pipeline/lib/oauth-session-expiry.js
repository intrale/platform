'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJsonSafe, writeJsonAtomic } = require('./atomic-json');

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const UNAVAILABLE_ALERT_TICKS = 3;
const NEXT_CYCLE_MS = 8 * 60 * 60 * 1000;

function readExpiryFields() {
    try {
        const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
        const oauth = parsed && parsed.claudeAiOauth;
        const expiresAt = oauth && oauth.expiresAt;
        const refreshTokenExpiresAt = oauth && oauth.refreshTokenExpiresAt;
        if (!Number.isFinite(expiresAt)) return null;
        return {
            expiresAt,
            refreshTokenExpiresAt: Number.isFinite(refreshTokenExpiresAt) ? refreshTokenExpiresAt : null,
        };
    } catch (_) {
        // Intencionalmente vacío: el error de parseo puede contener credenciales.
        return null;
    }
}

function getOAuthSessionExpiry(now = Date.now()) {
    const fields = readExpiryFields();
    if (!fields) return { expiresAt: null, minutesLeft: null, available: false };
    return {
        expiresAt: new Date(fields.expiresAt),
        minutesLeft: Math.floor((fields.expiresAt - now) / 60000),
        available: true,
    };
}

function emptyState() {
    return {
        expires_at_epoch: null,
        refresh_expires_at_epoch: null,
        t30_sent: false,
        t10_sent: false,
        unavailable_streak: 0,
        unavailable_since_epoch: null,
        health_alert_open: false,
        expiry_alert_open: false,
        renewal_unhealthy: false,
    };
}

function normalizeState(raw) {
    const base = emptyState();
    if (!raw || typeof raw !== 'object') return base;
    for (const key of Object.keys(base)) {
        if (typeof base[key] === 'boolean') base[key] = raw[key] === true;
        else if (Number.isFinite(raw[key])) base[key] = raw[key];
    }
    return base;
}

function save(statePath, state) {
    if (!writeJsonAtomic(statePath, state, { indent: 2 })) {
        throw new Error('oauth_expiry_state_write_failed');
    }
}

function evaluate({ now = Date.now(), statePath }) {
    const existed = fs.existsSync(statePath);
    const prev = normalizeState(readJsonSafe(statePath, null));
    const fields = readExpiryFields();

    if (!fields) {
        const next = { ...prev };
        next.unavailable_streak += 1;
        if (next.unavailable_since_epoch === null) next.unavailable_since_epoch = now;
        save(statePath, next);
        const healthAlert = next.unavailable_streak >= UNAVAILABLE_ALERT_TICKS && !next.health_alert_open;
        return {
            shouldEmit: healthAlert,
            alert: healthAlert ? 'health_unavailable' : null,
            healthAlert,
            ageMinutes: Math.max(0, Math.floor((now - next.unavailable_since_epoch) / 60000)),
            minutesLeft: null,
            reason: healthAlert ? 'health_unavailable' : 'unavailable',
        };
    }

    const epoch = fields.expiresAt;
    const minutesLeft = Math.floor((epoch - now) / 60000);
    const renewed = prev.expires_at_epoch !== null && epoch > prev.expires_at_epoch;
    const renewedBeforeExpiry = renewed && prev.expires_at_epoch > now;
    const crossedWithoutRenewal = prev.expires_at_epoch !== null
        && prev.expires_at_epoch <= now && epoch <= prev.expires_at_epoch;
    const next = { ...prev };
    next.expires_at_epoch = epoch;
    next.refresh_expires_at_epoch = fields.refreshTokenExpiresAt;
    next.unavailable_streak = 0;
    next.unavailable_since_epoch = null;
    if (crossedWithoutRenewal) next.renewal_unhealthy = true;
    if (renewed) {
        next.t30_sent = false;
        next.t10_sent = false;
    }
    if (renewedBeforeExpiry) {
        next.renewal_unhealthy = false;
    }

    if (prev.health_alert_open) {
        save(statePath, next);
        return { shouldEmit: true, alert: 'health_recovered', minutesLeft, reason: 'health_recovered' };
    }
    if (!existed || prev.expires_at_epoch === null) {
        save(statePath, next);
        return { shouldEmit: false, minutesLeft, reason: 'first_reading' };
    }
    if (renewed && prev.expiry_alert_open) {
        save(statePath, next);
        return { shouldEmit: true, alert: 'renewed', minutesLeft, reason: 'session_renewed' };
    }
    if (minutesLeft <= 0) {
        save(statePath, next);
        return { shouldEmit: false, minutesLeft, reason: 'already_expired' };
    }

    const refreshCannotCoverNextCycle = fields.refreshTokenExpiresAt !== null
        && fields.refreshTokenExpiresAt < epoch + NEXT_CYCLE_MS;
    const emissionCondition = refreshCannotCoverNextCycle || next.renewal_unhealthy;
    if (!emissionCondition) {
        save(statePath, next);
        return { shouldEmit: false, minutesLeft, reason: 'automatic_renewal_expected' };
    }

    let threshold = null;
    if (minutesLeft <= 10 && !next.t10_sent) threshold = 't10';
    else if (minutesLeft <= 30 && !next.t30_sent) threshold = 't30';
    if (!threshold) {
        save(statePath, next);
        return { shouldEmit: false, minutesLeft, reason: 'threshold_not_crossed_or_sent' };
    }
    save(statePath, next);
    return { shouldEmit: true, alert: 'expiry', threshold, minutesLeft, reason: refreshCannotCoverNextCycle ? 'refresh_insufficient' : 'renewal_unhealthy' };
}

function recordEmitted({ statePath, alert, threshold }) {
    const state = normalizeState(readJsonSafe(statePath, null));
    if (alert === 'expiry') {
        if (threshold === 't10') {
            state.t10_sent = true;
            state.t30_sent = true;
        } else if (threshold === 't30') state.t30_sent = true;
        else return false;
        state.expiry_alert_open = true;
    } else if (alert === 'health_unavailable') state.health_alert_open = true;
    else if (alert === 'health_recovered') state.health_alert_open = false;
    else if (alert === 'renewed') state.expiry_alert_open = false;
    else return false;
    return writeJsonAtomic(statePath, state, { indent: 2 });
}

module.exports = {
    getOAuthSessionExpiry,
    evaluate,
    recordEmitted,
    CREDENTIALS_PATH,
    UNAVAILABLE_ALERT_TICKS,
    NEXT_CYCLE_MS,
};
