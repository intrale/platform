// smart-build-heap.test.js — Guarda de regresión para el override de heap (#4155).
//
// Contexto: el gradle.properties GLOBAL (~/.gradle) puede fijar un org.gradle.jvmargs
// con -Xmx menor que el del proyecto y SOMBREARLO (GRADLE_USER_HOME gana). Con ese
// techo, la compilación Wasm de :app:composeApp OOMea ("Not enough memory to run
// compilation"). smart-build.sh re-impone el heap del proyecto vía -Dorg.gradle.jvmargs
// (system property de -D, máxima precedencia) en TODAS sus invocaciones de gradlew.
//
// Estos tests aseguran que el override siga cableado: si alguien agrega un `./gradlew`
// sin el heap, o quita la definición, el test falla antes de volver a romper el build.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'smart-build.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');

test('smart-build.sh — define GRADLE_HEAP_ARGS con -Dorg.gradle.jvmargs y -Xmx6g', () => {
    assert.match(
        src,
        /GRADLE_HEAP_ARGS=\(-Dorg\.gradle\.jvmargs="-Xmx6g[^"]*"\)/,
        'Falta la definición de GRADLE_HEAP_ARGS con -Dorg.gradle.jvmargs=-Xmx6g…',
    );
});

test('smart-build.sh — preserva -Dfile.encoding=UTF-8 en el override de heap', () => {
    const def = src.match(/GRADLE_HEAP_ARGS=\([^\n]*\)/);
    assert.ok(def, 'No se encontró la definición de GRADLE_HEAP_ARGS');
    assert.match(def[0], /-Dfile\.encoding=UTF-8/, 'El override debe preservar file.encoding=UTF-8');
});

test('smart-build.sh — toda invocación de ./gradlew aplica el heap override', () => {
    const lines = src.split('\n');
    const gradlewCalls = lines.filter((l) => {
        const t = l.trim();
        // Líneas que invocan gradlew (no comentarios ni el echo descriptivo).
        return t.startsWith('./gradlew');
    });
    assert.ok(gradlewCalls.length >= 3, `Se esperaban >=3 invocaciones de ./gradlew, hay ${gradlewCalls.length}`);
    for (const call of gradlewCalls) {
        assert.match(
            call,
            /\$\{GRADLE_HEAP_ARGS\[@\]\}/,
            `Invocación de gradlew sin heap override: ${call.trim()}`,
        );
    }
});
