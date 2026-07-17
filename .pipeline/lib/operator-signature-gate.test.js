// .pipeline/lib/operator-signature-gate.test.js
// Tests node --test del gate de auto-aprobación (#4576, CA-5/6/7/10/11/12).
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audit = require('./audit-log');
const ladder = require('./autonomy-ladder');
const {
    evaluateSignatureGate,
    seleccionarAuditoria,
    DECISION,
    MODE,
    CALIBRATION_CHAIN_FILE,
    AUTOAPPROVAL_AUDIT_FILE,
} = require('./operator-signature-gate');

const T0 = 1_700_000_000_000;

// Crea un pipelineDir temporal con su carpeta audit/.
// Usa mkdtempSync para garantizar un directorio único por corrida: evita que
// archivos de audit residuales de ejecuciones previas (PID reusado por el SO en
// suites grandes con node --test) se acumulen y contaminen aserciones de
// `entries.length` (bug de aislamiento observado en CA-12: 2 !== 1).
const _tmpDirs = [];
function tmpPipelineDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsig-gate-test-'));
    fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });
    _tmpDirs.push(dir);
    return dir;
}

// Limpia los directorios temporales al terminar la suite para no acumular
// basura en os.tmpdir() entre corridas.
after(() => {
    for (const dir of _tmpDirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // best-effort: si otro proceso lo tomó, se ignora
        }
    }
});
function chainPath(dir) {
    return path.join(dir, 'audit', CALIBRATION_CHAIN_FILE);
}

// Config base con gate activo en modo enforce.
function cfg(overrides = {}) {
    return {
        enabled: true,
        kill_switch: false,
        modo: MODE.ENFORCE,
        umbral_acuerdo_pct: 90,
        muestras_minimas: 3,
        decay_dias: 30,
        auditoria_pct: 10,
        go_live_date: null,
        ...overrides,
    };
}

// Criterios máquina-verificables (para que la rama solo-humano no corte).
const CRITERIOS_MAQUINA = [
    { key: 'a', text: 'node --test verde' },
    { key: 'b', text: 'build compila con ./gradlew build' },
];
const GATE_PASS = { a: 'pass', b: 'pass' };
const ISSUE = { number: 4576, tipoIssue: 'area:pipeline', createdAt: '2026-07-10T00:00:00Z' };
const FASE = 'aprobacion';

// Siembra un bucket calibrado con N decisiones humanas de acuerdo.
function sembrarBucketCalibrado(dir, n = 3) {
    for (let i = 0; i < n; i++) {
        ladder.recordHumanDecision({
            chainFile: chainPath(dir),
            bucket: { fase: FASE, tipoIssue: ISSUE.tipoIssue },
            issue: 1000 + i,
            sugerencia: 'aprobar',
            decision: 'aprobar',
            operador: 'leitolarreta',
            nowMs: T0,
        });
    }
}

// ----------------------------------------------------------------------------
// CA-10 · kill switch / sin datos ⇒ toda auto-aprobación off / firma humana
// ----------------------------------------------------------------------------

test('CA-10 · enabled !== true ⇒ firma humana (cortocircuito, sin invocar)', () => {
    const dir = tmpPipelineDir();
    const res = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg({ enabled: false }), options: { pipelineDir: dir, nowMs: T0 },
    });
    assert.strictEqual(res.effective_decision, DECISION.FIRMA_HUMANA);
    assert.strictEqual(res.invoked, false);
    assert.strictEqual(res.gate_mode, MODE.DISABLED);
});

test('CA-10 · kill_switch activo ⇒ firma humana', () => {
    const dir = tmpPipelineDir();
    const res = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg({ kill_switch: true }), options: { pipelineDir: dir, nowMs: T0 },
    });
    assert.strictEqual(res.effective_decision, DECISION.FIRMA_HUMANA);
    assert.match(res.reason, /kill_switch/);
});

test('CA-10 · sin datos de calibración ⇒ firma humana (default seguro)', () => {
    const dir = tmpPipelineDir(); // audit/ vacío, sin muestras.
    const res = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg(), options: { pipelineDir: dir, nowMs: T0 },
    });
    assert.strictEqual(res.effective_decision, DECISION.FIRMA_HUMANA);
    assert.match(res.reason, /bucket no calibrado/);
});

// ----------------------------------------------------------------------------
// CA-5 · chain adulterado ⇒ firma humana (fail-closed)
// ----------------------------------------------------------------------------

test('CA-5 · chain adulterado ⇒ firma humana (fail-closed antes de leer bucket)', () => {
    const dir = tmpPipelineDir();
    sembrarBucketCalibrado(dir, 3); // bucket que SÍ estaría calibrado.
    // Adulterar la última línea del chain (romper el hash).
    const cf = chainPath(dir);
    const lines = fs.readFileSync(cf, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    last.acuerdo = false; // muta el contenido sin recomputar hash ⇒ chain roto.
    lines[lines.length - 1] = JSON.stringify(last);
    fs.writeFileSync(cf, lines.join('\n') + '\n');

    // Sanity: la cadena ahora está rota.
    assert.strictEqual(audit.verifyChain(cf).ok, false);

    const res = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg(), options: { pipelineDir: dir, nowMs: T0 },
    });
    assert.strictEqual(res.effective_decision, DECISION.FIRMA_HUMANA);
    assert.strictEqual(res.fail_closed, true);
    assert.match(res.reason, /chain_roto/);
});

// ----------------------------------------------------------------------------
// CA-2 · criterio solo-humano ⇒ firma humana (coherente con GATE 0)
// ----------------------------------------------------------------------------

test('CA-2 · algún criterio solo-humano ⇒ firma humana aunque el bucket calibre', () => {
    const dir = tmpPipelineDir();
    sembrarBucketCalibrado(dir, 3);
    const res = evaluateSignatureGate({
        issue: ISSUE, fase: FASE,
        criterios: [{ key: 'a', text: 'node --test verde' }, { key: 'v', text: 'coincide con el mockup visual' }],
        gateResults: { a: 'pass', v: 'pass' },
        config: cfg(), options: { pipelineDir: dir, nowMs: T0 },
    });
    assert.strictEqual(res.effective_decision, DECISION.FIRMA_HUMANA);
    assert.match(res.reason, /solo-humano/);
});

// ----------------------------------------------------------------------------
// CA-6 · bucket calibrado ⇒ auto-aprobado en enforce
// ----------------------------------------------------------------------------

test('CA-6 · bucket calibrado + criterios máquina + enforce ⇒ auto_aprobado', () => {
    const dir = tmpPipelineDir();
    sembrarBucketCalibrado(dir, 3);
    const res = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg(), options: { pipelineDir: dir, nowMs: T0, rngFloat: () => 0.99 },
    });
    assert.strictEqual(res.decision, DECISION.AUTO_APROBADO);
    assert.strictEqual(res.effective_decision, DECISION.AUTO_APROBADO);
    assert.strictEqual(res.bucket, 'aprobacion::area:pipeline');
    assert.ok(res.version_calibracion);
});

test('dry-run: lógica auto_aprobado pero effective firma_humana (nunca auto-aprueba)', () => {
    const dir = tmpPipelineDir();
    sembrarBucketCalibrado(dir, 3);
    const res = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg({ modo: MODE.DRY_RUN }), options: { pipelineDir: dir, nowMs: T0, rngFloat: () => 0.99 },
    });
    assert.strictEqual(res.decision, DECISION.AUTO_APROBADO);
    assert.strictEqual(res.effective_decision, DECISION.FIRMA_HUMANA);
    assert.strictEqual(res.gate_mode, MODE.DRY_RUN);
});

// ----------------------------------------------------------------------------
// CA-7 · intento de agente de alimentar su propia calibración ⇒ no auto-aprueba
// ----------------------------------------------------------------------------

test('CA-7 · muestras con fuente de agente no calibran ⇒ firma humana', () => {
    const dir = tmpPipelineDir();
    // El "agente" inyecta N muestras de acuerdo pero con fuente no-humana.
    for (let i = 0; i < 5; i++) {
        audit.appendChained({
            file: chainPath(dir),
            entry: {
                type: ladder.ENTRY_TYPE.MUESTRA,
                fuente: 'sugerencia_agente',
                bucket: 'aprobacion::area:pipeline',
                sugerencia: 'aprobar', decision: 'aprobar', acuerdo: true,
                created_at: T0,
            },
        });
    }
    // El chain es íntegro (las entries son válidas), pero no cuentan (CA-7).
    assert.strictEqual(audit.verifyChain(chainPath(dir)).ok, true);
    const res = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg(), options: { pipelineDir: dir, nowMs: T0 },
    });
    assert.strictEqual(res.effective_decision, DECISION.FIRMA_HUMANA);
    assert.match(res.reason, /bucket no calibrado/);
});

// ----------------------------------------------------------------------------
// CA-11 · selección de auditoría no reproducible desde el input del sujeto
// ----------------------------------------------------------------------------

test('CA-11 · seleccionarAuditoria usa CSPRNG (no reproducible desde el input)', () => {
    // Con el mismo pct, dos llamadas sin rng inyectado pueden diferir: la
    // selección NO depende de ningún input del sujeto (issue/criterios).
    const N = 2000;
    let trues = 0;
    for (let i = 0; i < N; i++) {
        if (seleccionarAuditoria(50)) trues++;
    }
    // ~50% con tolerancia amplia — prueba que no es constante ni sembrado fijo.
    assert.ok(trues > N * 0.35 && trues < N * 0.65, `distribución fuera de rango: ${trues}/${N}`);
});

test('CA-11 · auditoria_pct 0 ⇒ nunca; 100 ⇒ siempre', () => {
    assert.strictEqual(seleccionarAuditoria(0), false);
    assert.strictEqual(seleccionarAuditoria(100), true);
});

test('CA-11 · la selección de auditoría no se deriva del issue (mismo issue, resultado varía)', () => {
    const dir = tmpPipelineDir();
    sembrarBucketCalibrado(dir, 3);
    // Forzamos rng determinista distinto en dos evaluaciones del MISMO issue:
    // el flag sigue al rng, no al issue ⇒ prueba que el input no lo determina.
    const r1 = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg({ auditoria_pct: 50 }), options: { pipelineDir: dir, nowMs: T0, rngFloat: () => 0.1 },
    });
    const r2 = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg({ auditoria_pct: 50 }), options: { pipelineDir: dir, nowMs: T0, rngFloat: () => 0.9 },
    });
    assert.strictEqual(r1.en_muestra_auditoria, true);
    assert.strictEqual(r2.en_muestra_auditoria, false);
});

// ----------------------------------------------------------------------------
// CA-12 · auto-aprobación deja traza en el audit-log tamper-evident
// ----------------------------------------------------------------------------

test('CA-12 · auto_aprobado deja traza con bucket, versión y flag auditoría', () => {
    const dir = tmpPipelineDir();
    sembrarBucketCalibrado(dir, 3);
    const res = evaluateSignatureGate({
        issue: ISSUE, fase: FASE, criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg(), options: { pipelineDir: dir, nowMs: T0, rngFloat: () => 0.01 },
    });
    assert.strictEqual(res.decision, DECISION.AUTO_APROBADO);
    assert.strictEqual(res.traza_persistida, true);

    const trazaFile = path.join(dir, 'audit', AUTOAPPROVAL_AUDIT_FILE);
    const entries = audit.readAll(trazaFile);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].type, 'auto_aprobacion');
    assert.strictEqual(entries[0].issue, '4576');
    assert.strictEqual(entries[0].bucket, 'aprobacion::area:pipeline');
    assert.ok(entries[0].version_calibracion);
    assert.strictEqual(entries[0].en_muestra_auditoria, true); // rng 0.01 < 10%.
    assert.strictEqual(audit.verifyChain(trazaFile).ok, true);
});

// ----------------------------------------------------------------------------
// Grandfathering fail-closed
// ----------------------------------------------------------------------------

test('issue previo a go_live_date ⇒ firma humana (sin auto-aprobación retroactiva)', () => {
    const dir = tmpPipelineDir();
    sembrarBucketCalibrado(dir, 3);
    const res = evaluateSignatureGate({
        issue: { ...ISSUE, createdAt: '2026-01-01T00:00:00Z' }, fase: FASE,
        criterios: CRITERIOS_MAQUINA, gateResults: GATE_PASS,
        config: cfg({ go_live_date: '2026-07-01T00:00:00Z' }),
        options: { pipelineDir: dir, nowMs: T0 },
    });
    assert.strictEqual(res.effective_decision, DECISION.FIRMA_HUMANA);
    assert.match(res.reason, /go_live_date/);
});
