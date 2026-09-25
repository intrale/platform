// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

'use strict';

// #7635 · CA-15 — Los datos de permisos se extrajeron de build-child-env.js a
// child-env-scopes.json SIN cambiar el comportamiento: mismo contenido que en
// `5052c08b3` (snapshot literal abajo), mismos exports y todos congelados.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const lib = require('../build-child-env');

// Snapshot LITERAL de los valores de build-child-env.js en 5052c08b3.
const SNAPSHOT_5052c08b3 = {
    SYSTEM_ALLOWLIST: [
        'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA',
        'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'SystemRoot', 'ComSpec', 'WINDIR',
        'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', 'NODE_PATH', 'NODE_OPTIONS',
    ],
    CREDENTIAL_SCOPES: {
        github: ['GH_TOKEN', 'GITHUB_TOKEN'],
        aws: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_PROFILE'],
        'gradle-android': ['JAVA_HOME', 'GRADLE_USER_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME'],
        'telegram-hooks': ['TELEGRAM_CHAT_ID'],
    },
    SCOPES_ALWAYS_ON: ['telegram-hooks'],
    SCOPES_BY_FASE: {
        analisis: ['github'],
        criterios: ['github'],
        sizing: ['github'],
        validacion: ['github'],
        dev: ['github', 'gradle-android', 'aws'],
        build: ['gradle-android'],
        verificacion: ['github', 'gradle-android', 'aws'],
        linteo: [],
        aprobacion: ['github'],
        entrega: ['github'],
        kernel: ['github'],
    },
    CLI_OAUTH_ALLOWLIST: ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'],
    DEFAULT_REQUIRES_BY_SKILL: {
        security: ['github'], guru: ['github'], po: ['github'], ux: ['github'], planner: ['github'],
        review: ['github'], refinar: ['github'], priorizar: ['github'], historia: ['github'],
        doc: ['github'], handoff: ['github'],
        'pipeline-dev': ['github'],
        'android-dev': ['github', 'gradle-android'],
        'backend-dev': ['github', 'aws', 'gradle-android'],
        'web-dev': ['github', 'gradle-android'],
        builder: ['gradle-android'], tester: ['gradle-android'], delivery: ['github'], linter: [],
        qa: ['gradle-android', 'aws', 'github'], build: ['gradle-android'],
        'telegram-commander': [], 'telegram-sherlock': [],
    },
};

test('CA-15 · el JSON y los exports son idénticos (en profundidad y en orden) al snapshot de 5052c08b3', () => {
    for (const [nombre, esperado] of Object.entries(SNAPSHOT_5052c08b3)) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(lib[nombre])), esperado, nombre);
        assert.deepStrictEqual(Object.keys(lib[nombre]), Object.keys(esperado), `${nombre}: orden de claves`);
    }
    const crudo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'child-env-scopes.json'), 'utf8'));
    for (const [nombre, esperado] of Object.entries(SNAPSHOT_5052c08b3)) {
        assert.deepStrictEqual(crudo[nombre], esperado, `child-env-scopes.json · ${nombre}`);
    }
});

test('CA-15 · los exports quedan congelados en profundidad', () => {
    for (const nombre of Object.keys(SNAPSHOT_5052c08b3)) {
        const v = lib[nombre];
        assert.equal(Object.isFrozen(v), true, nombre);
        for (const hijo of Object.values(v)) {
            if (hijo && typeof hijo === 'object') assert.equal(Object.isFrozen(hijo), true, `${nombre} (hijo)`);
        }
    }
    assert.throws(() => { 'use strict'; lib.SCOPES_BY_FASE.dev.push('aws'); }, TypeError);
});

test('CA-15 · las constantes derivadas siguen en JS y conservan su semántica', () => {
    assert.equal(lib.KERNEL_FASE, 'kernel');
    for (const n of [...lib.CREDENTIAL_SCOPES.aws, ...lib.CREDENTIAL_SCOPES.github, 'TELEGRAM_BOT_TOKEN']) {
        assert.ok(lib.ISOLATION_RESERVED_NAMES.includes(n.toUpperCase()), n);
    }
    for (const n of lib.CLI_OAUTH_ALLOWLIST) assert.ok(lib.CHILD_TRANSPORT_ALLOWLIST.includes(n), n);
});
