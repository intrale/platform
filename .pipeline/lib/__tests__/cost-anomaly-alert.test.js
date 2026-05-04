// =============================================================================
// Tests cost-anomaly-alert.js — #2892 PR-C
//
// Cubre:
//   - CA-2.6 + CA-Sec-A09 — formato del mensaje Telegram + sanitización
//   - CA-5.5 — snapshot determinístico del payload sanitizado
//   - sendTelegramAlert encola en `servicios/telegram/pendiente/`
//   - Skill names inválidos se filtran con `[skill_invalid]`
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    formatTelegramMessage,
    sendTelegramAlert,
    safeSkillName,
    MAX_SNOOZE_HOURS,
} = require('../cost-anomaly-alert');

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function fakeEvaluation(overrides) {
    return Object.assign({
        type: 'anomaly',
        ts: '2026-04-30T14:32:00.000Z',
        hour: '14',
        baseline_usd: 1.51,
        actual_usd: 4.72,
        ratio: 3.13,
        alerted: true,
    }, overrides || {});
}

function fakeSnapshot(overrides) {
    return Object.assign({
        currentHour: {
            hour: '14',
            cost_usd: 4.72,
            bySkill: [
                { skill: 'android-dev', cost_usd: 2.10 },
                { skill: 'backend-dev', cost_usd: 1.34 },
                { skill: 'guru', cost_usd: 0.78 },
            ],
        },
        hourlyMeta: { lookbackDays: 7, daysWithData: 7 },
    }, overrides || {});
}

// -----------------------------------------------------------------------------
// formatTelegramMessage — formato base
// -----------------------------------------------------------------------------

test('CA-2.6 · formato del mensaje Telegram con franja, ratio, top 3 skills', () => {
    const text = formatTelegramMessage(fakeEvaluation(), fakeSnapshot());

    // Header
    assert.match(text, /⚠ \*Consumo anómalo detectado\*/);
    // Franja con hora siguiente calculada
    assert.match(text, /Franja 14:00–15:00 · ratio \+213%/);
    // Actual y baseline
    assert.match(text, /Actual: \*\$4\.72 USD\/h\*/);
    assert.match(text, /Esperado: \*\$1\.51 USD\/h\* \(rolling 7d\)/);
    // Top 3 skills con orden y porcentajes
    assert.match(text, /\*TOP 3 SKILLS\*/);
    assert.match(text, /1\. \*android-dev\* — \$2\.10 \(44%\)/);
    assert.match(text, /2\. \*backend-dev\* — \$1\.34 \(28%\)/);
    // 0.78/4.72 = 0.1652... → 17% (Math.round)
    assert.match(text, /3\. \*guru\* — \$0\.78 \(17%\)/);
    // Footer
    assert.match(text, /→ Ver detalle en el dashboard/);
});

test('formato — wraparound: hora 23:00 → franja 23:00–00:00', () => {
    const text = formatTelegramMessage(
        fakeEvaluation({ hour: '23' }),
        fakeSnapshot()
    );
    assert.match(text, /Franja 23:00–00:00/);
});

test('formato — sin bySkill: omite el bloque "TOP 3"', () => {
    const text = formatTelegramMessage(
        fakeEvaluation(),
        fakeSnapshot({ currentHour: { hour: '14', cost_usd: 4.72 } })
    );
    assert.doesNotMatch(text, /TOP 3 SKILLS/);
    // Pero el header y resumen siguen
    assert.match(text, /⚠ \*Consumo anómalo detectado\*/);
});

test('formato — ratio Infinity (baseline=0): muestra "—"', () => {
    const text = formatTelegramMessage(
        fakeEvaluation({ ratio: null, baseline_usd: 0 }),
        fakeSnapshot()
    );
    assert.match(text, /Franja 14:00–15:00 · ratio —/);
    assert.match(text, /\$0\.00 USD\/h\* \(rolling/);
});

// -----------------------------------------------------------------------------
// CA-Sec-A09 — sanitización: el payload NO contiene tokens, paths absolutos
// Windows, ni emails. Se inyectan valores tóxicos en skill names para
// verificar que se filtran (vía safeSkillName + sanitize/redact).
// -----------------------------------------------------------------------------

test('CA-Sec-A09 · skill names malformados se reemplazan por [skill_invalid]', () => {
    assert.equal(safeSkillName('android-dev'), 'android-dev');
    assert.equal(safeSkillName('backend_dev'), 'backend_dev');
    assert.equal(safeSkillName('GuruAgent42'), 'GuruAgent42');
    // Paths con backslash
    assert.equal(safeSkillName('C:\\Users\\Admin'), '[skill_invalid]');
    // Espacios
    assert.equal(safeSkillName('skill with spaces'), '[skill_invalid]');
    // Demasiado largo (>40)
    assert.equal(safeSkillName('a'.repeat(41)), '[skill_invalid]');
    // Vacío / no-string
    assert.equal(safeSkillName(''), '[skill_invalid]');
    assert.equal(safeSkillName(null), '[skill_invalid]');
    assert.equal(safeSkillName(undefined), '[skill_invalid]');
    assert.equal(safeSkillName(42), '[skill_invalid]');
});

test('CA-Sec-A09 · si un skill tóxico llega al snapshot, no se filtra al usuario', () => {
    const text = formatTelegramMessage(
        fakeEvaluation(),
        fakeSnapshot({
            currentHour: {
                hour: '14',
                cost_usd: 4.72,
                bySkill: [
                    { skill: 'C:\\Workspaces\\Intrale\\secret', cost_usd: 2.10 },
                    { skill: 'normal-skill', cost_usd: 1.34 },
                ],
            },
        })
    );
    // El skill name tóxico se reemplaza
    assert.match(text, /\*\[skill_invalid\]\* — \$2\.10/);
    assert.match(text, /\*normal-skill\* — \$1\.34/);
    // Path original NO aparece
    assert.doesNotMatch(text, /C:\\\\Workspaces|C:\\Workspaces/);
});

test('CA-Sec-A09 · NO contiene tokens (sk-, ghp_, xoxb-) ni paths Windows ni emails', () => {
    // Forzamos que el sanitize/redact intercepte todo lo que pueda escaparse.
    // El detector NO produce estos campos, pero defendemos en profundidad
    // por si en una versión futura alguien agrega un campo libre por error.
    const text = formatTelegramMessage(fakeEvaluation(), fakeSnapshot());
    // Patrones prohibidos según CA-Sec-A09
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}/);
    assert.doesNotMatch(text, /ghp_[A-Za-z0-9]{30,}/);
    assert.doesNotMatch(text, /xoxb-[A-Za-z0-9-]{20,}/);
    assert.doesNotMatch(text, /C:\\[A-Za-z0-9]/);
    assert.doesNotMatch(text, /[a-z0-9]+@[a-z0-9]+\.[a-z]{2,}/);
});

test('CA-Sec-A09 · es determinístico: mismos inputs → mismo string', () => {
    const a = formatTelegramMessage(fakeEvaluation(), fakeSnapshot());
    const b = formatTelegramMessage(fakeEvaluation(), fakeSnapshot());
    assert.equal(a, b, 'el mensaje debe ser determinístico para que los snapshots no flapeen');
});

// -----------------------------------------------------------------------------
// CA-5.5 — Snapshot del payload sanitizado.
// El snapshot está committeado al test (string literal abajo). Si cambia
// el formato, hay que actualizar este test EXPLÍCITAMENTE — eso es la
// barrera contra cambios accidentales que rompan el contrato (fuga de
// secretos, cambio de redacción que enmascare patrones, etc.).
// -----------------------------------------------------------------------------

const EXPECTED_SNAPSHOT = [
    '⚠ *Consumo anómalo detectado*',
    'Franja 14:00–15:00 · ratio +213%',
    'Actual: *$4.72 USD/h*',
    'Esperado: *$1.51 USD/h* (rolling 7d)',
    '',
    '*TOP 3 SKILLS*',
    '1. *android-dev* — $2.10 (44%)',
    '2. *backend-dev* — $1.34 (28%)',
    '3. *guru* — $0.78 (17%)',
    '',
    '→ Ver detalle en el dashboard',
].join('\n');

test('CA-5.5 · SNAPSHOT — payload sanitizado del mensaje Telegram (committeado)', () => {
    const text = formatTelegramMessage(fakeEvaluation(), fakeSnapshot());
    assert.equal(
        text,
        EXPECTED_SNAPSHOT,
        '\nEl formato del mensaje Telegram cambió. Si es intencional, actualizá EXPECTED_SNAPSHOT.\n' +
        'Si no, alguien rompió el contrato CA-Sec-A09 — verificá que la sanitización siga interceptando secretos.\n\n' +
        '----- ESPERADO -----\n' + EXPECTED_SNAPSHOT + '\n\n----- OBTENIDO -----\n' + text + '\n'
    );
});

// -----------------------------------------------------------------------------
// sendTelegramAlert — encolado fire-and-forget
// -----------------------------------------------------------------------------

test('sendTelegramAlert · escribe JSON válido en servicios/telegram/pendiente/', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-test-anomaly-'));
    try {
        const result = sendTelegramAlert(fakeEvaluation(), fakeSnapshot(), {
            pipelineDir: tmpDir,
            now: () => 1714502520000, // determinístico
        });
        assert.equal(result.ok, true, 'send debe ok=true');
        assert.ok(result.file, 'debe devolver path al archivo');
        assert.match(result.text, /Consumo anómalo/);

        // Contenido del archivo es JSON con text + parse_mode
        const contents = JSON.parse(fs.readFileSync(result.file, 'utf8'));
        assert.equal(contents.parse_mode, 'Markdown');
        assert.equal(contents.text, EXPECTED_SNAPSHOT);

        // Archivo está en pendiente/ (lo que svc-telegram lee)
        assert.match(result.file, /servicios[\\\/]telegram[\\\/]pendiente[\\\/]/);
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
});

test('sendTelegramAlert · si el dir no existe lo crea, no tira', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-test-anomaly-'));
    const targetSub = path.join(tmpDir, 'inexistente'); // NO existe
    try {
        const result = sendTelegramAlert(fakeEvaluation(), fakeSnapshot(), {
            pipelineDir: targetSub,
        });
        assert.equal(result.ok, true);
        assert.ok(fs.existsSync(result.file));
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
});

// -----------------------------------------------------------------------------
// MAX_SNOOZE_HOURS — exposición del cap (CA-Sec-A04b)
// -----------------------------------------------------------------------------

test('MAX_SNOOZE_HOURS · es 24 (CA-2.8 / CA-Sec-A04b)', () => {
    assert.equal(MAX_SNOOZE_HOURS, 24);
});
