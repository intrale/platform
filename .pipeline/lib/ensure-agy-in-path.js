'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function pathEnvKey(env) {
    return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function prependPath(env, dir) {
    const key = pathEnvKey(env);
    const parts = (env[key] || '').split(path.delimiter).filter(Boolean);
    if (!parts.some((part) => path.resolve(part) === path.resolve(dir))) {
        env[key] = [dir, ...parts].join(path.delimiter);
    }
}

function agyWorks(env, spawnImpl = spawnSync) {
    const command = env.AGY_BIN || 'agy';
    try {
        const probe = spawnImpl(command, ['--version'], {
            env, shell: false, windowsHide: true, encoding: 'utf8',
            timeout: 10_000,
        });
        return probe.status === 0;
    } catch {
        return false;
    }
}

function ensureAgyInEnv(env, options = {}) {
    if (!env) return { available: false, reason: 'missing_env' };
    const fsImpl = options.fsImpl || fs;
    const spawnImpl = options.spawnImpl || spawnSync;
    const platform = options.platform || process.platform;

    if (agyWorks(env, spawnImpl)) {
        return { available: true, bin: env.AGY_BIN || 'agy' };
    }

    const candidates = [];
    if (env.AGY_BIN) candidates.push(env.AGY_BIN);
    if (platform === 'win32' && env.LOCALAPPDATA) {
        candidates.push(path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'));
    }

    for (const candidate of candidates) {
        try {
            if (!fsImpl.existsSync(candidate)) continue;
        } catch {
            continue;
        }
        env.AGY_BIN = candidate;
        prependPath(env, path.dirname(candidate));
        if (agyWorks(env, spawnImpl)) {
            return { available: true, bin: candidate };
        }
    }
    return { available: false, reason: 'agy_not_found_or_not_executable' };
}

function ensureAgyInProcessPath(options) {
    return ensureAgyInEnv(process.env, options);
}

module.exports = {
    agyWorks,
    ensureAgyInEnv,
    ensureAgyInProcessPath,
    pathEnvKey,
};
