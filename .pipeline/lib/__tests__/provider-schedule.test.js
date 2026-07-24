// =============================================================================
// provider-schedule.test.js — Tests del scheduler horario por provider (#3871)
//
// Cobertura:
//   - isProviderActiveNow: dentro/fuera de ventana OFF intra-día.
//   - Cross-midnight ({22:00 → 08:00}: 23:30 ⇒ inactivo, 08:30 ⇒ activo).
//   - Persistencia atómica + tolerancia a corrupción (JSON roto ⇒ fail-open).
//   - Validación de horarios (HH:MM, fuera de rango, máx 24 periodos/día).
//   - Allowlist `:name` rechaza provider inválido / path-traversal.
//   - active:false ⇒ no gatea (24/7).
//   - getProviderSchedule / listProviderSchedules / clearProviderSchedule.
//   - Precedencia (ver provider-schedule-precedence.test.js para el orden con
//     rest-mode + kill-switch — acá testeamos el gate aislado).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TZ = 'America/Argentina/Buenos_Aires';

// Sandbox por test: dir temporal apuntado por PIPELINE_DIR_OVERRIDE + reimport fresco.
function withSandbox(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-schedule-'));
    const prev = process.env.PIPELINE_DIR_OVERRIDE;
    process.env.PIPELINE_DIR_OVERRIDE = dir;
    delete require.cache[require.resolve('../provider-schedule')];
    const mod = require('../provider-schedule');
    try {
        fn(mod, dir);
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_DIR_OVERRIDE;
        else process.env.PIPELINE_DIR_OVERRIDE = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
}

const NOAUDIT = { auditLogEnabled: false };

// Construye un epoch ms en el timezone de test para un weekday/hora dados.
// Usamos fechas concretas conocidas: 2026-06-08 es LUNES (UTC). Para evitar
// ambigüedad de DST y offset, comparamos vía partsInTz dentro del propio módulo
// pasando `now` ya en ms. Construimos el ms con un offset fijo de -03:00 (AR).
function arMs(yyyy_mm_dd, hh, mm) {
    // AR = UTC-3 sin DST desde 2009. 'YYYY-MM-DDTHH:MM:00-03:00'.
    const iso = `${yyyy_mm_dd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-03:00`;
    return Date.parse(iso);
}

// 2026-06-08 lunes, 2026-06-09 martes (verificable: 2026-06-08 % 7).
const MONDAY = '2026-06-08';
const TUESDAY = '2026-06-09';

// -----------------------------------------------------------------------------
// Allowlist / validación de provider (SEC #1, anti path-traversal)
// -----------------------------------------------------------------------------

test('isValidProvider acepta solo la allowlist reusada de provider-disabled', () => {
    withSandbox((mod) => {
        assert.equal(mod.isValidProvider('anthropic'), true);
        assert.equal(mod.isValidProvider('gemini-google'), true);
        assert.equal(mod.isValidProvider('groq'), false); // NO está en allowlist real
        assert.equal(mod.isValidProvider('../../etc/passwd'), false);
        assert.equal(mod.isValidProvider(null), false);
        assert.equal(mod.isValidProvider(123), false);
    });
});

test('setProviderSchedule rechaza provider inválido sin escribir archivo', () => {
    withSandbox((mod) => {
        const r = mod.setProviderSchedule('../../etc', { active: true, schedule: {}, timezone: TZ }, NOAUDIT);
        assert.equal(r.ok, false);
        assert.match(r.error, /provider inválido/);
        assert.equal(fs.existsSync(mod.flagFile()), false);
    });
});

// -----------------------------------------------------------------------------
// isProviderActiveNow — fail-open por defecto
// -----------------------------------------------------------------------------

test('isProviderActiveNow es true (24/7) sin archivo de schedule', () => {
    withSandbox((mod) => {
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 23, 30)), true);
    });
});

test('isProviderActiveNow es true para provider inválido (no apaga lo inexistente)', () => {
    withSandbox((mod) => {
        assert.equal(mod.isProviderActiveNow('groq', arMs(MONDAY, 23, 30)), true);
    });
});

test('active:false NO gatea — provider activo 24/7 aunque tenga schedule', () => {
    withSandbox((mod) => {
        const r = mod.setProviderSchedule('anthropic', {
            active: false,
            schedule: { monday: [{ start: '22:00', end: '23:59' }] },
            timezone: TZ,
        }, NOAUDIT);
        assert.equal(r.ok, true);
        // 22:30 dentro de la ventana, pero active:false ⇒ no se gatea.
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 22, 30), NOAUDIT), true);
    });
});

// -----------------------------------------------------------------------------
// Ventana intra-día
// -----------------------------------------------------------------------------

test('intra-día: dentro de la ventana OFF ⇒ inactivo; fuera ⇒ activo', () => {
    withSandbox((mod) => {
        const r = mod.setProviderSchedule('anthropic', {
            active: true,
            schedule: { monday: [{ start: '09:00', end: '18:00' }] },
            timezone: TZ,
        }, NOAUDIT);
        assert.equal(r.ok, true);
        // Lunes 12:00 dentro de [09:00,18:00) ⇒ inactivo.
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 12, 0), NOAUDIT), false);
        // Lunes 08:00 antes de la ventana ⇒ activo.
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 8, 0), NOAUDIT), true);
        // Lunes 18:00 (borde superior exclusivo) ⇒ activo.
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 18, 0), NOAUDIT), true);
    });
});

// -----------------------------------------------------------------------------
// Cross-midnight (Gherkin del issue)
// -----------------------------------------------------------------------------

test('cross-midnight {22:00→08:00}: lunes 23:30 inactivo, martes 08:30 activo', () => {
    withSandbox((mod) => {
        const r = mod.setProviderSchedule('anthropic', {
            active: true,
            schedule: { monday: [{ start: '22:00', end: '08:00' }] },
            timezone: TZ,
        }, NOAUDIT);
        assert.equal(r.ok, true);
        // Lunes 23:30 dentro de la mitad nocturna ⇒ inactivo.
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 23, 30), NOAUDIT), false);
        // Martes 07:30 dentro del residual matinal del periodo del lunes ⇒ inactivo.
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(TUESDAY, 7, 30), NOAUDIT), false);
        // Martes 08:30 fuera (residual termina a las 08:00) ⇒ activo.
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(TUESDAY, 8, 30), NOAUDIT), true);
    });
});

test('granularidad por provider: apagar anthropic no afecta a gemini', () => {
    withSandbox((mod) => {
        mod.setProviderSchedule('anthropic', {
            active: true,
            schedule: { monday: [{ start: '00:00', end: '23:59' }] }, // off todo el lunes
            timezone: TZ,
        }, NOAUDIT);
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 12, 0), NOAUDIT), false);
        assert.equal(mod.isProviderActiveNow('gemini-google', arMs(MONDAY, 12, 0), NOAUDIT), true);
    });
});

// -----------------------------------------------------------------------------
// Validación de horarios (delegada a rest-mode-window.validatePayload)
// -----------------------------------------------------------------------------

test('rechaza horarios mal formados (HH:MM fuera de rango)', () => {
    withSandbox((mod) => {
        const r = mod.setProviderSchedule('anthropic', {
            active: true,
            schedule: { monday: [{ start: '25:00', end: '08:00' }] },
            timezone: TZ,
        }, NOAUDIT);
        assert.equal(r.ok, false);
        assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
        assert.equal(fs.existsSync(mod.flagFile()), false);
    });
});

test('rechaza más de 24 periodos por día', () => {
    withSandbox((mod) => {
        const many = [];
        for (let i = 0; i < 25; i++) {
            const hh = String(i).padStart(2, '0');
            many.push({ start: `${hh}:00`, end: `${hh}:30` });
        }
        const r = mod.setProviderSchedule('anthropic', {
            active: true,
            schedule: { monday: many },
            timezone: TZ,
        }, NOAUDIT);
        assert.equal(r.ok, false);
    });
});

test('rechaza timezone no soportada', () => {
    withSandbox((mod) => {
        const r = mod.setProviderSchedule('anthropic', {
            active: true,
            schedule: { monday: [{ start: '09:00', end: '18:00' }] },
            timezone: 'Foo/Bar',
        }, NOAUDIT);
        assert.equal(r.ok, false);
    });
});

// -----------------------------------------------------------------------------
// Persistencia atómica + tolerancia a corrupción (fail-open)
// -----------------------------------------------------------------------------

test('persistencia atómica: el archivo queda con shape {providers:{...}}', () => {
    withSandbox((mod) => {
        mod.setProviderSchedule('anthropic', {
            active: true,
            schedule: { monday: [{ start: '22:00', end: '08:00' }] },
            timezone: TZ,
        }, NOAUDIT);
        const raw = JSON.parse(fs.readFileSync(mod.flagFile(), 'utf8'));
        assert.ok(raw.providers && raw.providers.anthropic);
        assert.equal(raw.providers.anthropic.active, true);
        assert.equal(raw.providers.anthropic.timezone, TZ);
        assert.ok(typeof raw.providers.anthropic.updated_at === 'string');
    });
});

test('JSON corrupto ⇒ fail-open: isProviderActiveNow devuelve true', () => {
    withSandbox((mod) => {
        fs.writeFileSync(mod.flagFile(), '{ this is not json', 'utf8');
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 23, 30), NOAUDIT), true);
    });
});

test('shape inválido (sin providers) ⇒ fail-open activo', () => {
    withSandbox((mod) => {
        fs.writeFileSync(mod.flagFile(), JSON.stringify({ garbage: 1 }), 'utf8');
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 12, 0), NOAUDIT), true);
    });
});

// -----------------------------------------------------------------------------
// get / list / clear
// -----------------------------------------------------------------------------

test('getProviderSchedule sin entrada devuelve default activo-24/7', () => {
    withSandbox((mod) => {
        const s = mod.getProviderSchedule('anthropic', NOAUDIT);
        assert.equal(s.active, false);
        assert.equal(s.timezone, mod.DEFAULT_TIMEZONE);
        assert.deepEqual(Object.values(s.schedule).flat(), []);
    });
});

test('getProviderSchedule provider inválido devuelve null', () => {
    withSandbox((mod) => {
        assert.equal(mod.getProviderSchedule('groq', NOAUDIT), null);
    });
});

test('listProviderSchedules incluye todos los providers válidos con isActiveNow', () => {
    withSandbox((mod) => {
        mod.setProviderSchedule('anthropic', {
            active: true,
            schedule: { monday: [{ start: '00:00', end: '23:59' }] },
            timezone: TZ,
        }, NOAUDIT);
        const list = mod.listProviderSchedules({ ...NOAUDIT, now: new Date(arMs(MONDAY, 12, 0)) });
        assert.equal(Object.keys(list).length, mod.VALID_PROVIDERS.length);
        assert.equal(list['anthropic'].isActiveNow, false);
        assert.equal(list['gemini-google'].isActiveNow, true);
        assert.ok('nextTransition' in list['anthropic']);
    });
});

test('clearProviderSchedule elimina la entrada y vuelve a 24/7', () => {
    withSandbox((mod) => {
        mod.setProviderSchedule('anthropic', {
            active: true,
            schedule: { monday: [{ start: '00:00', end: '23:59' }] },
            timezone: TZ,
        }, NOAUDIT);
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 12, 0), NOAUDIT), false);
        const cleared = mod.clearProviderSchedule('anthropic', NOAUDIT);
        assert.equal(cleared, true);
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 12, 0), NOAUDIT), true);
        // segundo clear no encuentra nada.
        assert.equal(mod.clearProviderSchedule('anthropic', NOAUDIT), false);
    });
});

test('clear de un provider preserva los schedules de los demás', () => {
    withSandbox((mod) => {
        mod.setProviderSchedule('anthropic', {
            active: true, schedule: { monday: [{ start: '00:00', end: '23:59' }] }, timezone: TZ,
        }, NOAUDIT);
        mod.setProviderSchedule('openai-codex', {
            active: true, schedule: { monday: [{ start: '00:00', end: '23:59' }] }, timezone: TZ,
        }, NOAUDIT);
        mod.clearProviderSchedule('anthropic', NOAUDIT);
        assert.equal(mod.isProviderActiveNow('anthropic', arMs(MONDAY, 12, 0), NOAUDIT), true);
        assert.equal(mod.isProviderActiveNow('openai-codex', arMs(MONDAY, 12, 0), NOAUDIT), false);
    });
});

// -----------------------------------------------------------------------------
// Audit log (SEC #5 — anti log-injection)
// -----------------------------------------------------------------------------

test('audit escapa newlines del source (anti log-injection)', () => {
    withSandbox((mod, dir) => {
        mod.setProviderSchedule('anthropic', {
            active: true, schedule: { monday: [{ start: '09:00', end: '18:00' }] }, timezone: TZ,
        }, { source: 'evil\ninjected line', now: arMs(MONDAY, 12, 0) });
        const logFile = mod.auditLogFile(new Date(arMs(MONDAY, 12, 0)));
        const content = fs.readFileSync(logFile, 'utf8');
        // Cada evento es exactamente una línea JSON: el newline del source no
        // debe crear una segunda línea de log.
        const lines = content.trim().split('\n').filter(Boolean);
        for (const l of lines) JSON.parse(l); // todas parsean
        assert.ok(content.includes('evil injected line'));
    });
});
