// =============================================================================
// atomic-json.test.js — Write atómico compartido (#5400 rev-1).
//
// Es la primitiva de integridad que usan la estampa de despacho, el estado del
// watchdog y su status. Si deja temporales colgados, escribe a medias o lanza,
// el daño es silencioso: el pipeline sigue andando con estado corrupto.
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeJsonAtomic, readJsonSafe } = require('../atomic-json');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-'));
}

test('escribe, relee y no deja temporales colgados', () => {
    const dir = tmpDir();
    try {
        const file = path.join(dir, 'estado.json');
        assert.equal(writeJsonAtomic(file, { a: 1, b: 'x' }), true);
        assert.deepEqual(readJsonSafe(file), { a: 1, b: 'x' });
        assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('crea el directorio destino si no existe', () => {
    const dir = tmpDir();
    try {
        const file = path.join(dir, 'sub', 'anidado', 'estado.json');
        assert.equal(writeJsonAtomic(file, { ok: true }), true);
        assert.deepEqual(readJsonSafe(file), { ok: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sobrescribir es atómico: el lector nunca ve el archivo a medias', () => {
    const dir = tmpDir();
    try {
        const file = path.join(dir, 'estado.json');
        writeJsonAtomic(file, { v: 1 });
        for (let i = 2; i <= 20; i++) {
            writeJsonAtomic(file, { v: i, relleno: 'x'.repeat(5000) });
            const leido = readJsonSafe(file);
            assert.ok(leido && Number.isInteger(leido.v), 'siempre JSON completo');
        }
        assert.equal(readJsonSafe(file).v, 20);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('un destino imposible devuelve false en vez de lanzar (fail-soft)', () => {
    const dir = tmpDir();
    try {
        const archivo = path.join(dir, 'soy-un-archivo');
        fs.writeFileSync(archivo, 'x');
        // Escribir "dentro" de un archivo regular: el FS lo rechaza.
        assert.equal(writeJsonAtomic(path.join(archivo, 'sub', 'x.json'), { a: 1 }), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('un valor no serializable devuelve false y no deja basura', () => {
    const dir = tmpDir();
    try {
        const file = path.join(dir, 'ciclico.json');
        const ciclico = {};
        ciclico.yo = ciclico;
        assert.equal(writeJsonAtomic(file, ciclico), false);
        assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [],
            'el temporal se limpia aunque el write falle');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readJsonSafe: ausente, corrupto o vacío devuelve el fallback', () => {
    const dir = tmpDir();
    try {
        assert.equal(readJsonSafe(path.join(dir, 'no-existe.json')), null);
        assert.deepEqual(readJsonSafe(path.join(dir, 'no-existe.json'), { d: 1 }), { d: 1 });
        const roto = path.join(dir, 'roto.json');
        fs.writeFileSync(roto, '{no json');
        assert.equal(readJsonSafe(roto), null);
        fs.writeFileSync(roto, '');
        assert.equal(readJsonSafe(roto), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('indent opcional para archivos que se leen a mano', () => {
    const dir = tmpDir();
    try {
        const file = path.join(dir, 'legible.json');
        writeJsonAtomic(file, { a: 1 }, { indent: 2 });
        assert.ok(fs.readFileSync(file, 'utf8').includes('\n  "a": 1'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
