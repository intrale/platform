// =============================================================================
// waves-integrity.test.js — #4370 · Persistencia robusta del roadmap de olas.
//
// Cubre los caminos nuevos de hardening sobre `lib/waves.js`:
//   CA-2  restore corre validateStateStrict ANTES de promover (fail-closed).
//   CA-3  restore exige contención de path (archived/) + whitelist de nombre.
//   CA-4  integrity_hash persistido + verificación (ok/missing/mismatch).
//   CA-5  validateStateStrict rechaza issue.number no-entero y campos no-string.
//   CA-6  rotación conserva N backups, loguea descartes, respeta markers vivos.
//   CA-9  waves.json legacy sin hash carga OK y se sella en el primer save.
//
// Ejecutar:  node --test .pipeline/lib/__tests__/waves-integrity.test.js
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function setupTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waves-integrity-'));
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../waves')];
    const waves = require('../waves');
    waves.invalidateCache();
    return { dir, waves };
}

function teardownTmp(dir) {
    delete process.env.PIPELINE_DIR_OVERRIDE;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function validState(overrides = {}) {
    return {
        version: '1.0',
        meta: {
            created_at: '2026-07-01T00:00:00.000Z',
            updated_at: '2026-07-01T00:00:00.000Z',
            updated_by: 'System',
            source: 'manual',
            note: 'seed',
        },
        active_wave: {
            number: 7,
            name: 'Ola N+7',
            goal: null,
            issues: [{ number: 3451, status: 'in_progress' }],
        },
        planned_waves: [{ number: 8, name: 'Ola N+8', issues: [{ number: 3520 }] }],
        archived_waves: [],
        dependencies: [],
        ...overrides,
    };
}

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function writeBackup(dir, name, content) {
    const archived = path.join(dir, 'archived');
    fs.mkdirSync(archived, { recursive: true });
    const p = path.join(archived, name);
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return p;
}

// ─── CA-4 — hash de integridad canónico ──────────────────────────────────────

test('CA-4: computeIntegrityHash omite el propio campo y es estable ante reordenamiento de claves', () => {
    const { dir, waves } = setupTmp();
    try {
        const a = validState();
        const h1 = waves.computeIntegrityHash(a);
        // Reordenar claves top-level + agregar un integrity_hash falso: el hash
        // no debe cambiar (el campo se omite y el orden es canónico).
        const b = { integrity_hash: 'deadbeef', dependencies: a.dependencies, meta: a.meta, version: a.version, active_wave: a.active_wave, planned_waves: a.planned_waves, archived_waves: a.archived_waves };
        const h2 = waves.computeIntegrityHash(b);
        assert.equal(h1, h2);
        assert.match(h1, /^[0-9a-f]{64}$/);
    } finally {
        teardownTmp(dir);
    }
});

test('CA-4/CA-9: primer save sella integrity_hash y verifyIntegrityHash da OK', () => {
    const { dir, waves } = setupTmp();
    try {
        waves._internal.saveState(validState(), { source: 'manual', note: 'test' });
        const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
        assert.match(persisted.integrity_hash, /^[0-9a-f]{64}$/);
        assert.equal(waves.verifyIntegrityHash(persisted).status, 'ok');
        assert.equal(waves.checkStateIntegrity().status, 'ok');
    } finally {
        teardownTmp(dir);
    }
});

test('CA-4: alterar 1 byte fuera del flujo normal → verifyIntegrityHash mismatch + loadStateStrict tira EWAVES_INTEGRITY', () => {
    const { dir, waves } = setupTmp();
    try {
        waves._internal.saveState(validState(), { source: 'manual' });
        const p = path.join(dir, 'waves.json');
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        // Tamper: cambiar un campo sin recomputar el hash.
        parsed.active_wave.name = 'Ola HACKEADA';
        fs.writeFileSync(p, JSON.stringify(parsed, null, 2));

        assert.equal(waves.verifyIntegrityHash(parsed).status, 'mismatch');
        assert.equal(waves.checkStateIntegrity().status, 'mismatch');
        waves.invalidateCache();
        assert.throws(() => waves.loadStateStrict(), (e) => e.code === 'EWAVES_INTEGRITY');
    } finally {
        teardownTmp(dir);
    }
});

test('CA-9: waves.json legacy sin integrity_hash carga OK (missing) y se sella en el próximo save', () => {
    const { dir, waves } = setupTmp();
    try {
        // Legacy: escrito a mano SIN integrity_hash.
        fs.writeFileSync(path.join(dir, 'waves.json'), JSON.stringify(validState(), null, 2));
        assert.equal(waves.checkStateIntegrity().status, 'missing');
        // loadStateStrict NO tira para legacy (missing se tolera).
        assert.doesNotThrow(() => waves.loadStateStrict());
        // Primer save lo sella.
        waves._internal.saveState(waves.loadWaves(), { source: 'manual' });
        assert.equal(waves.checkStateIntegrity().status, 'ok');
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-5 — validación estricta de tipos ─────────────────────────────────────

test('CA-5: validateStateStrict rechaza issue.number string', () => {
    const { dir, waves } = setupTmp();
    try {
        const bad = validState();
        bad.active_wave.issues = [{ number: '3451' }];
        const errors = waves.validateStateStrict(bad);
        assert.ok(errors.some((e) => /issues\[0\]\.number debe ser entero/.test(e)), errors.join('|'));
    } finally {
        teardownTmp(dir);
    }
});

test('CA-5: validateStateStrict rechaza campos libres no-string (name objeto, note number)', () => {
    const { dir, waves } = setupTmp();
    try {
        const bad = validState();
        bad.active_wave.name = { $gt: '' };
        bad.meta.note = 12345;
        const errors = waves.validateStateStrict(bad);
        assert.ok(errors.some((e) => /active_wave\.name debe ser string/.test(e)), errors.join('|'));
        assert.ok(errors.some((e) => /meta\.note debe ser string/.test(e)), errors.join('|'));
    } finally {
        teardownTmp(dir);
    }
});

test('CA-5: validateStateStrict tolera null en campos libres (goal: null) y acepta estado válido', () => {
    const { dir, waves } = setupTmp();
    try {
        assert.deepEqual(waves.validateStateStrict(validState()), []);
    } finally {
        teardownTmp(dir);
    }
});

test('CA-6: validateStateStrict rechaza arrays que exceden el límite anti-OOM', () => {
    const { dir, waves } = setupTmp();
    try {
        const bad = validState();
        bad.planned_waves = Array.from({ length: 501 }, (_, i) => ({ number: i + 1, issues: [] }));
        const errors = waves.validateStateStrict(bad);
        assert.ok(errors.some((e) => /planned_waves excede el límite/.test(e)), errors.join('|'));
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-2 / CA-3 — restore hardening ─────────────────────────────────────────

test('CA-3: restore rechaza marker con path fuera de archived/ aunque el SHA coincida', () => {
    const { dir, waves } = setupTmp();
    try {
        // Backup "legítimo por contenido" pero ubicado FUERA de archived/.
        const outside = path.join(dir, 'evil-waves.json');
        fs.writeFileSync(outside, JSON.stringify(validState(), null, 2));
        const marker = {
            waves_bak_path: outside,
            waves_bak_sha: sha256File(outside), // SHA correcto → el atacante controla el marker.
        };
        const res = waves._internal.restoreFromSnapshots(marker);
        assert.equal(res.ok, false);
        assert.match(res.reason, /contención de path/);
        // El estado activo no fue tocado (no existe waves.json aún).
        assert.equal(fs.existsSync(path.join(dir, 'waves.json')), false);
    } finally {
        teardownTmp(dir);
    }
});

test('CA-3: restore rechaza nombre de backup que no matchea la whitelist', () => {
    const { dir, waves } = setupTmp();
    try {
        const bak = writeBackup(dir, 'waves.2026-07-01.json', validState()); // nombre NO whitelisted (falta -rollback)
        const marker = { waves_bak_path: bak, waves_bak_sha: sha256File(bak) };
        const res = waves._internal.restoreFromSnapshots(marker);
        assert.equal(res.ok, false);
        assert.match(res.reason, /whitelist/);
    } finally {
        teardownTmp(dir);
    }
});

test('CA-2: restore rechaza .bak con shape inválido (validateStateStrict pre-promote, no promueve)', () => {
    const { dir, waves } = setupTmp();
    try {
        // Estado activo bueno previo.
        waves._internal.saveState(validState(), { source: 'manual' });
        const before = fs.readFileSync(path.join(dir, 'waves.json'), 'utf8');

        // Backup parseable pero hostil: issue.number string.
        const hostile = validState();
        hostile.active_wave.issues = [{ number: '99; DROP TABLE' }];
        const bak = writeBackup(dir, 'waves-rollback.2026-07-01T00-00-00-000Z.json', hostile);
        const marker = { waves_bak_path: bak, waves_bak_sha: sha256File(bak) };

        const res = waves._internal.restoreFromSnapshots(marker);
        assert.equal(res.ok, false);
        assert.match(res.reason, /shape inválido|no se promueve|CA-2/);
        // Estado activo intacto — NO se promovió el hostil.
        assert.equal(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'), before);
    } finally {
        teardownTmp(dir);
    }
});

test('CA-2/CA-3: restore acepta un backup válido dentro de archived/ con nombre whitelisted', () => {
    const { dir, waves } = setupTmp();
    try {
        const good = validState({ active_wave: { number: 9, name: 'Restaurada', goal: null, issues: [{ number: 111 }] } });
        const bak = writeBackup(dir, 'waves-rollback.2026-07-01T12-00-00-000Z.json', good);
        const marker = { waves_bak_path: bak, waves_bak_sha: sha256File(bak) };
        const res = waves._internal.restoreFromSnapshots(marker);
        assert.equal(res.ok, true);
        assert.equal(res.wavesRestored, true);
        const restored = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
        assert.equal(restored.active_wave.number, 9);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-6 — rotación de backups ──────────────────────────────────────────────

test('CA-6: rotateArchivedBackups conserva N más recientes y descarta el resto', () => {
    const { dir, waves } = setupTmp();
    try {
        const archived = path.join(dir, 'archived');
        fs.mkdirSync(archived, { recursive: true });
        // 30 backups de la familia waves-rollback con mtime creciente.
        const created = [];
        for (let i = 0; i < 30; i++) {
            const name = `waves-rollback.2026-07-01T00-00-${String(i).padStart(2, '0')}-000Z.json`;
            const p = path.join(archived, name);
            fs.writeFileSync(p, JSON.stringify(validState(), null, 2));
            const t = new Date(Date.UTC(2026, 6, 1, 0, 0, i)).getTime();
            fs.utimesSync(p, t / 1000, t / 1000);
            created.push(name);
        }
        const result = waves.rotateArchivedBackups(10);
        assert.equal(result.rotated.length, 20);
        const remaining = fs.readdirSync(archived).filter((f) => /^waves-rollback\./.test(f));
        assert.equal(remaining.length, 10);
        // Los 10 más nuevos (índices 20..29) sobreviven.
        assert.ok(remaining.includes(created[29]));
        assert.ok(!remaining.includes(created[0]));
    } finally {
        teardownTmp(dir);
    }
});

test('CA-6: rotación NO toca backups referenciados por un marker in-progress vivo', () => {
    const { dir, waves } = setupTmp();
    try {
        const archived = path.join(dir, 'archived');
        fs.mkdirSync(archived, { recursive: true });
        const names = [];
        for (let i = 0; i < 5; i++) {
            const name = `waves-rollback.2026-07-01T00-00-0${i}-000Z.json`;
            const p = path.join(archived, name);
            fs.writeFileSync(p, JSON.stringify(validState(), null, 2));
            const t = new Date(Date.UTC(2026, 6, 1, 0, 0, i)).getTime();
            fs.utimesSync(p, t / 1000, t / 1000);
            names.push(name);
        }
        // Marker in-progress referenciando el backup MÁS VIEJO (que sino sería rotado).
        fs.writeFileSync(path.join(dir, 'wave-promote.in-progress.json'), JSON.stringify({
            waves_bak_path: path.join(archived, names[0]),
        }, null, 2));

        const result = waves.rotateArchivedBackups(2);
        // El backup referenciado por el marker nunca se rota.
        assert.ok(!result.rotated.includes(names[0]));
        assert.ok(fs.existsSync(path.join(archived, names[0])));
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-6 — redacción de secretos en note/source ─────────────────────────────

test('CA-6/SEC-5: save redacta secretos en meta.note (API keys) preservando texto normal', () => {
    const { dir, waves } = setupTmp();
    try {
        waves._internal.saveState(validState(), {
            source: 'telegram',
            note: 'token AKIAIOSFODNN7EXAMPLE filtrado',
        });
        const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'waves.json'), 'utf8'));
        assert.ok(!/AKIAIOSFODNN7EXAMPLE/.test(persisted.meta.note), `no debe persistir el secreto crudo: ${persisted.meta.note}`);
    } finally {
        teardownTmp(dir);
    }
});

// ─── CA-8 — backward-compat: loadWaves permisivo sigue verde ─────────────────

test('CA-8: loadWaves (permisivo) tolera waves.json con integrity_hash sin romper consumers', () => {
    const { dir, waves } = setupTmp();
    try {
        waves._internal.saveState(validState(), { source: 'manual' });
        // Consumer legacy vía loadWaves: no debe explotar ni exponer integrity_hash como clave requerida.
        const w = waves.loadWaves();
        assert.equal(w.active_wave.number, 7);
        assert.ok(Array.isArray(w.planned_waves));
    } finally {
        teardownTmp(dir);
    }
});
