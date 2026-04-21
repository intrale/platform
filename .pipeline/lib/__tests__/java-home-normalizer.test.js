// Tests del normalizador global de JAVA_HOME.
//
// Contexto: incidente 2026-04-21 — varios builds abortaron con "JAVA_HOME is
// set to an invalid directory" porque el pulpo heredó JBR de IntelliJ viejo.
// El normalizer detecta rutas inválidas y reemplaza por un Temurin 21 del
// sistema. Estos tests cubren los casos clave:
//   1) Ruta válida → se preserva + se propaga PIPELINE_JAVA_HOME
//   2) Ruta inválida + Temurin disponible → se reemplaza
//   3) Ruta inválida + ningún Temurin → no pisa, reporta reason=no-temurin-found
//   4) PATH se reforzará con bin/ del nuevo JDK
//   5) isValidJavaHome se comporta correctamente frente a null/strings vacíos.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    normalizeJavaHome,
    isValidJavaHome,
    pickTemurin21,
} = require('../java-home-normalizer');

// Crea un JAVA_HOME falso con la estructura mínima (bin/java o java.exe) para
// que isValidJavaHome lo considere válido.
function makeFakeJdk(name) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `fake-jdk-${name}-`));
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    fs.writeFileSync(path.join(binDir, exe), '#!/bin/sh\necho fake\n', { mode: 0o755 });
    return root;
}

function rmrf(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function saveEnv() {
    return {
        JAVA_HOME: process.env.JAVA_HOME,
        PIPELINE_JAVA_HOME: process.env.PIPELINE_JAVA_HOME,
        JAVA_HOME_21: process.env.JAVA_HOME_21,
        PATH: process.env.PATH,
    };
}

function restoreEnv(snapshot) {
    for (const key of Object.keys(snapshot)) {
        if (snapshot[key] === undefined) delete process.env[key];
        else process.env[key] = snapshot[key];
    }
}

test('isValidJavaHome devuelve false para null/vacío/no-string', () => {
    assert.equal(isValidJavaHome(null), false);
    assert.equal(isValidJavaHome(''), false);
    assert.equal(isValidJavaHome(undefined), false);
    assert.equal(isValidJavaHome(42), false);
});

test('isValidJavaHome devuelve false cuando bin/java no existe', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
    try {
        assert.equal(isValidJavaHome(tmp), false);
    } finally {
        rmrf(tmp);
    }
});

test('isValidJavaHome devuelve true cuando bin/java existe', () => {
    const fake = makeFakeJdk('valid');
    try {
        assert.equal(isValidJavaHome(fake), true);
    } finally {
        rmrf(fake);
    }
});

test('normalizeJavaHome preserva JAVA_HOME válido y propaga PIPELINE_JAVA_HOME', () => {
    const snapshot = saveEnv();
    const fake = makeFakeJdk('preserve');
    try {
        process.env.JAVA_HOME = fake;
        delete process.env.PIPELINE_JAVA_HOME;

        const result = normalizeJavaHome();

        assert.equal(result.changed, false);
        assert.equal(result.reason, 'valid');
        assert.equal(result.current, fake);
        assert.equal(process.env.JAVA_HOME, fake);
        // PIPELINE_JAVA_HOME se propaga para que los roles bash lo usen.
        assert.equal(process.env.PIPELINE_JAVA_HOME, fake);
    } finally {
        rmrf(fake);
        restoreEnv(snapshot);
    }
});

test('normalizeJavaHome reemplaza JAVA_HOME stale por Temurin desde JAVA_HOME_21', () => {
    const snapshot = saveEnv();
    const fakeValid = makeFakeJdk('from-env');
    const staleDir = path.join(os.tmpdir(), 'jbr-intellij-2024-stale-' + Date.now());
    try {
        process.env.JAVA_HOME = staleDir; // no existe
        process.env.JAVA_HOME_21 = fakeValid;

        const logs = [];
        const result = normalizeJavaHome({ log: (m) => logs.push(m) });

        assert.equal(result.changed, true);
        assert.equal(result.reason, 'stale-path');
        assert.equal(result.current, fakeValid);
        assert.equal(process.env.JAVA_HOME, fakeValid);
        assert.equal(process.env.PIPELINE_JAVA_HOME, fakeValid);
        assert.ok(logs.some((l) => l.includes('stale-path')), 'debe loguear stale-path');
        // PATH reforzado con bin/ del nuevo JDK (al frente).
        const sep = process.platform === 'win32' ? ';' : ':';
        const firstPathEntry = (process.env.PATH || '').split(sep)[0];
        assert.equal(path.resolve(firstPathEntry), path.resolve(path.join(fakeValid, 'bin')));
    } finally {
        rmrf(fakeValid);
        restoreEnv(snapshot);
    }
});

test('normalizeJavaHome prioriza PIPELINE_JAVA_HOME sobre JAVA_HOME_21', () => {
    const snapshot = saveEnv();
    const preferred = makeFakeJdk('preferred');
    const fallback = makeFakeJdk('fallback');
    try {
        process.env.JAVA_HOME = path.join(os.tmpdir(), 'nope-' + Date.now());
        process.env.PIPELINE_JAVA_HOME = preferred;
        process.env.JAVA_HOME_21 = fallback;

        const result = normalizeJavaHome();

        assert.equal(result.changed, true);
        assert.equal(result.current, preferred);
        assert.equal(process.env.JAVA_HOME, preferred);
    } finally {
        rmrf(preferred);
        rmrf(fallback);
        restoreEnv(snapshot);
    }
});

test('normalizeJavaHome no pisa JAVA_HOME si no hay Temurin 21 disponible', () => {
    const snapshot = saveEnv();
    const stale = path.join(os.tmpdir(), 'stale-jbr-' + Date.now());
    try {
        // Forzamos a que no encuentre ningún candidato válido.
        process.env.JAVA_HOME = stale;
        delete process.env.PIPELINE_JAVA_HOME;
        delete process.env.JAVA_HOME_21;

        // HOME apuntando a un dir sin .jdks para que pickTemurin21 no encuentre nada.
        const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
        const prevHome = process.env.HOME;
        const prevUserprofile = process.env.USERPROFILE;
        const prevProgramFiles = process.env.ProgramFiles;
        process.env.HOME = emptyHome;
        process.env.USERPROFILE = emptyHome;
        process.env.ProgramFiles = emptyHome; // sin carpeta Eclipse Adoptium dentro

        try {
            const logs = [];
            const result = normalizeJavaHome({ log: (m) => logs.push(m) });

            assert.equal(result.changed, false);
            assert.equal(result.reason, 'no-temurin-found');
            // No pisa: JAVA_HOME queda tal cual y PIPELINE_JAVA_HOME NO se setea a basura.
            assert.equal(process.env.JAVA_HOME, stale);
            assert.ok(logs.some((l) => l.includes('no se encontró Temurin 21')));
        } finally {
            process.env.HOME = prevHome;
            process.env.USERPROFILE = prevUserprofile;
            if (prevProgramFiles === undefined) delete process.env.ProgramFiles;
            else process.env.ProgramFiles = prevProgramFiles;
            rmrf(emptyHome);
        }
    } finally {
        restoreEnv(snapshot);
    }
});

test('normalizeJavaHome detecta unset (JAVA_HOME vacío) y lo resuelve con fallback', () => {
    const snapshot = saveEnv();
    const fake = makeFakeJdk('unset');
    try {
        delete process.env.JAVA_HOME;
        process.env.JAVA_HOME_21 = fake;

        const logs = [];
        const result = normalizeJavaHome({ log: (m) => logs.push(m) });

        assert.equal(result.changed, true);
        assert.equal(result.reason, 'unset');
        assert.equal(process.env.JAVA_HOME, fake);
        assert.ok(logs.some((l) => l.includes('unset')));
    } finally {
        rmrf(fake);
        restoreEnv(snapshot);
    }
});

test('normalizeJavaHome no duplica bin/ en el PATH si ya estaba presente', () => {
    const snapshot = saveEnv();
    const fake = makeFakeJdk('path-idempotent');
    try {
        const binDir = path.join(fake, 'bin');
        const sep = process.platform === 'win32' ? ';' : ':';
        process.env.PATH = [binDir, 'C:/foo', 'C:/bar'].join(sep);
        process.env.JAVA_HOME = path.join(os.tmpdir(), 'doesnt-exist-' + Date.now());
        process.env.JAVA_HOME_21 = fake;

        normalizeJavaHome();

        const parts = (process.env.PATH || '').split(sep).filter(Boolean);
        const binOccurrences = parts.filter(
            (p) => path.resolve(p).toLowerCase() === path.resolve(binDir).toLowerCase(),
        );
        assert.equal(binOccurrences.length, 1, 'bin/ debe aparecer una sola vez en PATH');
    } finally {
        rmrf(fake);
        restoreEnv(snapshot);
    }
});

test('pickTemurin21 devuelve null cuando no hay ningún candidato válido', () => {
    const snapshot = saveEnv();
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-home-'));
    const prevHome = process.env.HOME;
    const prevUserprofile = process.env.USERPROFILE;
    const prevProgramFiles = process.env.ProgramFiles;
    try {
        delete process.env.PIPELINE_JAVA_HOME;
        delete process.env.JAVA_HOME_21;
        process.env.HOME = emptyHome;
        process.env.USERPROFILE = emptyHome;
        process.env.ProgramFiles = emptyHome;

        assert.equal(pickTemurin21(), null);
    } finally {
        process.env.HOME = prevHome;
        process.env.USERPROFILE = prevUserprofile;
        if (prevProgramFiles === undefined) delete process.env.ProgramFiles;
        else process.env.ProgramFiles = prevProgramFiles;
        rmrf(emptyHome);
        restoreEnv(snapshot);
    }
});
