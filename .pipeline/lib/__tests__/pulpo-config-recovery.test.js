// =============================================================================
// pulpo-config-recovery.test.js — Test de INTEGRACIÓN del ciclo loadConfig ↔
// haltOnConfigCorruption ↔ auto-recovery (#4832).
//
// La Definition of Done (fase criterios, PO) exige un test de integración del
// ciclo completo, no sólo del helper puro `readFullPauseOrigin` (ya cubierto en
// partial-pause.test.js). Este archivo ejercita el WIRING real dentro de
// pulpo.js:
//   - CA-1: config.yaml corrupto → `haltOnConfigCorruption` escribe el marker
//     `.paused` como JSON estructurado con `source: config-corruption-halt`.
//   - CA-2: config.yaml vuelve a parsear OK → `loadConfig` (branch de éxito)
//     levanta la pausa auto-generada en un tick (clearFullPause) + log + flag
//     `paused` en false.
//   - CA-5 (⇔ CA-3): una pausa MANUAL/legacy preexistente (ISO plano) sobrevive
//     al halt (idempotente, no la pisa) y NUNCA se auto-levanta al sanar el
//     config → la pausa deliberada del operador se respeta (límite de control
//     authorization-like que marcó security).
//
// Aislamiento (convención del repo, ver partial-pause.test.js y
// pulpo-corruption.test.js): se setea `PIPELINE_DIR_OVERRIDE` a un tmpdir ANTES
// de requerir pulpo.js con `PULPO_NO_AUTOSTART=1`. Ese override redirige
// CONFIG_PATH, PAUSE_FILE, el `pauseFile()` de partial-pause y la cola de
// Telegram al MISMO tmpdir → cero contacto con el `.paused` real ni con la cola
// de Telegram de producción. Cada archivo de `node --test` corre en su propio
// proceso, así el env queda contenido.
// node --test
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Aislamiento: tmpdir + override ANTES de requerir pulpo.js ----------------
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulpo-config-recovery-'));
const TG_QUEUE = path.join(TMP_DIR, 'servicios', 'telegram', 'pendiente');
fs.mkdirSync(path.join(TMP_DIR, 'logs'), { recursive: true });
fs.mkdirSync(TG_QUEUE, { recursive: true });

// Fixture "config sano": copiamos el config.yaml real (garantiza pasar
// validateConfig — es el mismo schema con el que corre el pipeline).
const REAL_CONFIG = path.join(__dirname, '..', '..', 'config.yaml');
const GOOD_YAML = fs.readFileSync(REAL_CONFIG, 'utf8');
const BAD_YAML = 'foo: : : bad\n  : indentacion rota\n :nope';

process.env.PULPO_NO_AUTOSTART = '1';
process.env.PIPELINE_DIR_OVERRIDE = TMP_DIR;

const pulpo = require('../../pulpo.js');
const { PAUSE_FILE, CONFIG_PATH } = pulpo;

// Sanity del seam: los paths tienen que caer dentro del tmpdir, no en el real.
assert.ok(CONFIG_PATH.startsWith(TMP_DIR), 'CONFIG_PATH debe apuntar al tmpdir aislado');
assert.ok(PAUSE_FILE.startsWith(TMP_DIR), 'PAUSE_FILE debe apuntar al tmpdir aislado');

function writeConfig(content) { fs.writeFileSync(CONFIG_PATH, content); }
function removePause() { try { fs.unlinkSync(PAUSE_FILE); } catch {} }
function clearTelegramQueue() {
    for (const f of fs.readdirSync(TG_QUEUE)) fs.unlinkSync(path.join(TG_QUEUE, f));
}

test('CA-1: config.yaml corrupto → halt escribe .paused como marker JSON con source config-corruption-halt', () => {
    pulpo._resetConfigCorruptionState();
    removePause();
    writeConfig(BAD_YAML);

    const returned = pulpo.loadConfig();

    // El halt debe activar el flag global y crear el marker.
    assert.equal(pulpo._getPaused(), true, 'loadConfig sobre config corrupto debe dejar el pipeline en paused');
    assert.ok(fs.existsSync(PAUSE_FILE), 'el marker .paused debe existir tras el halt');

    // El marker debe ser JSON estructurado con el origen distinguible (no ISO plano).
    const marker = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
    assert.equal(marker.source, 'config-corruption-halt', 'el marker debe declarar el origen auto-generado');
    assert.equal(typeof marker.ts, 'string', 'el marker debe llevar timestamp');

    // Fail-safe de loadConfig: devuelve lastGoodConfig || {} para no matar el loop.
    assert.deepEqual(returned, {}, 'sin config buena previa, loadConfig degrada a {} manteniendo el loop vivo');
});

test('CA-2: config.yaml sano → auto-recovery levanta la pausa auto-generada en un tick', () => {
    // Precondición: pausa auto-generada activa (heredada del ciclo de corrupción).
    pulpo._resetConfigCorruptionState();
    removePause();
    writeConfig(BAD_YAML);
    pulpo.loadConfig();
    assert.ok(fs.existsSync(PAUSE_FILE), 'precondición: la pausa por corrupción debe estar activa');
    clearTelegramQueue();

    // El operador corrige config.yaml → un solo tick de loadConfig debe reanudar.
    writeConfig(GOOD_YAML);
    const returned = pulpo.loadConfig();

    assert.equal(fs.existsSync(PAUSE_FILE), false, 'la pausa auto-generada debe levantarse (marker removido) al sanar el config');
    assert.equal(pulpo._getPaused(), false, 'el flag paused debe quedar en false tras el auto-recovery');
    assert.equal(returned && returned !== null && typeof returned, 'object', 'loadConfig devuelve el config parseado real');

    // CA-4: la reanudación emite alerta Telegram (encolada al tmpdir, no a prod).
    const enqueued = fs.readdirSync(TG_QUEUE);
    assert.ok(enqueued.length >= 1, 'el auto-recovery debe encolar la alerta de reanudación (evidencia del tick)');
});

test('CA-5: pausa manual/legacy preexistente + corrupción posterior → NO se auto-levanta al sanar', () => {
    // El operador pausó a propósito (marker legacy = ISO plano, no JSON).
    pulpo._resetConfigCorruptionState();
    const manualMarker = '2026-07-21T00:00:00.000Z';
    fs.writeFileSync(PAUSE_FILE, manualMarker);

    // Sobreviene corrupción de config: el halt NO debe pisar la pausa manual.
    writeConfig(BAD_YAML);
    pulpo.loadConfig();
    assert.ok(fs.existsSync(PAUSE_FILE), 'la pausa manual debe seguir activa tras el halt');
    assert.equal(
        fs.readFileSync(PAUSE_FILE, 'utf8'),
        manualMarker,
        'haltOnConfigCorruption es idempotente: no pisa el marker manual preexistente',
    );

    // El operador corrige el config → el auto-recovery NO debe tocar la pausa
    // manual (readFullPauseOrigin la clasifica como 'manual' → fail-closed).
    writeConfig(GOOD_YAML);
    pulpo.loadConfig();
    assert.ok(fs.existsSync(PAUSE_FILE), 'la pausa MANUAL debe persistir: sanar el config no la auto-levanta');
    assert.equal(
        fs.readFileSync(PAUSE_FILE, 'utf8'),
        manualMarker,
        'el marker manual queda intacto: cero auto-clear de una pausa deliberada (CA-3/CA-5)',
    );

    removePause();
});
