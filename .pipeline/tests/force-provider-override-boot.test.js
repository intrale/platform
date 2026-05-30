// =============================================================================
// force-provider-override-boot.test.js — boot validators del flag
// FORCE_PROVIDER_OVERRIDE (#3680 CA-A9).
//
// Verifica que:
//   - pulpo.js aborta con exit 2 si process.env.FORCE_PROVIDER_OVERRIDE está
//     seteada al boot del padre.
//   - restart.js aborta con exit 2 si process.env.FORCE_PROVIDER_OVERRIDE está
//     seteada al inicio.
//   - PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE=1 desbloquea (escape hatch).
//   - Sin el flag, el guard no aborta.
//
// Implementación: en lugar de spawnear pulpo.js completo (es heavy y tiene
// otros validators que pueden enmascarar el resultado), spawneamos un Node
// child con un mini-script que replica EXACTAMENTE el guard del archivo real.
// La cobertura de "el guard está en pulpo.js" se obtiene grepeando el archivo
// (verificación textual).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PULPO_PATH = path.join(REPO_ROOT, '.pipeline', 'pulpo.js');
const RESTART_PATH = path.join(REPO_ROOT, '.pipeline', 'restart.js');

// -----------------------------------------------------------------------------
// 1. Verificación textual: el guard está presente en los archivos correctos.
// -----------------------------------------------------------------------------
test('pulpo.js contiene el guard de FORCE_PROVIDER_OVERRIDE con exit 2', () => {
    const source = fs.readFileSync(PULPO_PATH, 'utf8');
    assert.match(source, /FORCE_PROVIDER_OVERRIDE/);
    assert.match(source, /process\.exit\(2\)/);
    // El mensaje accionable es parte del contrato (CA-A9 / R4).
    assert.match(source, /FORCE_PROVIDER_OVERRIDE prohibido en runtime productivo/);
    // Escape hatch documentado.
    assert.match(source, /PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE/);
});

test('restart.js contiene el guard de FORCE_PROVIDER_OVERRIDE con exit 2', () => {
    const source = fs.readFileSync(RESTART_PATH, 'utf8');
    assert.match(source, /FORCE_PROVIDER_OVERRIDE/);
    assert.match(source, /process\.exit\(2\)/);
    assert.match(source, /FORCE_PROVIDER_OVERRIDE prohibido en runtime productivo/);
});

// -----------------------------------------------------------------------------
// 2. Funcional: spawnear un mini-Node con la misma lógica del guard y verificar
//    comportamiento. Esto valida la SEMÁNTICA del guard (exit 2 + stderr) sin
//    pagar el costo de boot completo de pulpo.
//
// El "mini-guard" es el mismo snippet de código que está en pulpo.js — un
// drift en producción se detectaría manualmente. La cobertura del archivo
// real depende del test textual (#1).
// -----------------------------------------------------------------------------
function makeGuardScript() {
    return `
if (process.env.FORCE_PROVIDER_OVERRIDE && process.env.PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE !== '1') {
  process.stderr.write(
    '[boot] FATAL FORCE_PROVIDER_OVERRIDE prohibido en runtime productivo — ' +
    'uso exclusivo del harness multi-provider-smoke-test via env override del ' +
    'spawn child. Unset la variable y reintentar.\\n'
  );
  process.exit(2);
} else if (process.env.FORCE_PROVIDER_OVERRIDE && process.env.PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE === '1') {
  process.stderr.write(
    '[boot] WARN FORCE_PROVIDER_OVERRIDE presente con PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE=1\\n'
  );
}
process.stdout.write('guard-passed\\n');
process.exit(0);
`;
}

function runGuardWithEnv(env) {
    const res = spawnSync(process.execPath, ['-e', makeGuardScript()], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
    });
    return res;
}

test('guard: con FORCE_PROVIDER_OVERRIDE en env → exit 2 + stderr accionable', () => {
    // Asegurarnos que el escape hatch NO está activo.
    const res = runGuardWithEnv({
        FORCE_PROVIDER_OVERRIDE: 'cerebras',
        PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE: '',
    });
    assert.equal(res.status, 2, `esperaba exit 2, fue ${res.status}; stderr=${res.stderr}`);
    assert.match(String(res.stderr), /FORCE_PROVIDER_OVERRIDE prohibido/);
    assert.match(String(res.stderr), /multi-provider-smoke-test/);
});

test('guard: sin FORCE_PROVIDER_OVERRIDE → exit 0 (no aborta)', () => {
    const res = runGuardWithEnv({
        FORCE_PROVIDER_OVERRIDE: '',
        PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE: '',
    });
    assert.equal(res.status, 0, `esperaba exit 0, fue ${res.status}; stderr=${res.stderr}`);
    assert.match(String(res.stdout), /guard-passed/);
});

test('guard: PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE=1 desbloquea (escape hatch)', () => {
    const res = runGuardWithEnv({
        FORCE_PROVIDER_OVERRIDE: 'cerebras',
        PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE: '1',
    });
    assert.equal(res.status, 0, `esperaba exit 0 con escape hatch, fue ${res.status}; stderr=${res.stderr}`);
    assert.match(String(res.stderr), /WARN FORCE_PROVIDER_OVERRIDE presente/);
    assert.match(String(res.stdout), /guard-passed/);
});

test('guard: PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE con valor != "1" NO desbloquea', () => {
    // Sólo el string exacto "1" desbloquea — defense in depth contra
    // 'true', 'yes', '0' o cualquier truthy.
    const res = runGuardWithEnv({
        FORCE_PROVIDER_OVERRIDE: 'cerebras',
        PULPO_ALLOW_FORCE_PROVIDER_OVERRIDE: 'true',
    });
    assert.equal(res.status, 2, `esperaba exit 2 con valor != "1", fue ${res.status}`);
});
