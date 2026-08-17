// =============================================================================
// admission-gate.test.js — Tests unitarios del módulo (issue #3175)
//
// Cobertura:
//   - isAdmitted: detecta needs-definition, Ready, ausencia, case-sensitive.
//   - filterOrphans: separa items admitidos de huérfanos.
//   - applyBootstrapCap: cap a 10 + flag bootstrap si N>10.
//   - formatTelegramAlert: modo silencioso, 🟡 normal, 🔴 bootstrap, sin
//     leak de campos prohibidos (body/user/diff).
//   - getAdmissionComment: textos literales (issue vs PR).
//   - alreadyCommented: idempotencia.
//   - Defensa contra inputs maliciosos (CA-S3 / CA-S4).
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../admission-gate');

// -----------------------------------------------------------------------------
// isAdmitted
// -----------------------------------------------------------------------------

test('isAdmitted: needs-definition cuenta como admitido', () => {
    assert.equal(gate.isAdmitted([{ name: 'needs-definition' }]), true);
});

test('isAdmitted: Ready cuenta como admitido', () => {
    assert.equal(gate.isAdmitted([{ name: 'Ready' }]), true);
});

test('isAdmitted: array vacío → no admitido', () => {
    assert.equal(gate.isAdmitted([]), false);
});

test('isAdmitted: array null/undefined → no admitido (defensivo)', () => {
    assert.equal(gate.isAdmitted(null), false);
    assert.equal(gate.isAdmitted(undefined), false);
});

test('isAdmitted: no match si solo tiene labels de área', () => {
    assert.equal(gate.isAdmitted([
        { name: 'area:pipeline' },
        { name: 'priority:high' },
    ]), false);
});

test('isAdmitted: acepta strings simples (no solo {name})', () => {
    assert.equal(gate.isAdmitted(['needs-definition']), true);
    assert.equal(gate.isAdmitted(['Ready']), true);
});

test('isAdmitted: case-sensitive — "ready" en minúscula NO cuenta', () => {
    // Si en el futuro queremos relajar esto, debe ser decisión explícita.
    // Por ahora `Ready` con R mayúscula es el canónico de config.yaml.
    assert.equal(gate.isAdmitted([{ name: 'ready' }]), false);
});

test('isAdmitted: detecta admisión mezclada con otros labels', () => {
    assert.equal(gate.isAdmitted([
        { name: 'bug' },
        { name: 'area:pipeline' },
        { name: 'needs-definition' },
    ]), true);
});

test('isAdmitted: ignora entradas malformadas en el array', () => {
    assert.equal(gate.isAdmitted([
        null,
        undefined,
        42,
        { foo: 'bar' },
        { name: 'Ready' },
    ]), true);
});

// -----------------------------------------------------------------------------
// filterOrphans
// -----------------------------------------------------------------------------

test('filterOrphans: separa huérfanos de admitidos', () => {
    const items = [
        { number: 100, labels: [{ name: 'Ready' }], title: 'admitido', url: 'u1' },
        { number: 101, labels: [{ name: 'bug' }], title: 'huérfano', url: 'u2' },
        { number: 102, labels: [], title: 'sin labels', url: 'u3' },
    ];
    const orphans = gate.filterOrphans(items);
    assert.equal(orphans.length, 2);
    assert.equal(orphans[0].number, 101);
    assert.equal(orphans[1].number, 102);
});

test('filterOrphans: input no-array → []', () => {
    assert.deepEqual(gate.filterOrphans(null), []);
    assert.deepEqual(gate.filterOrphans(undefined), []);
    assert.deepEqual(gate.filterOrphans('foo'), []);
});

test('filterOrphans: ignora items sin number', () => {
    const items = [
        { labels: [] }, // sin number
        { number: 'abc', labels: [] }, // number no-numérico
        { number: 200, labels: [{ name: 'bug' }] },
    ];
    const orphans = gate.filterOrphans(items);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].number, 200);
});

test('filterOrphans: solo retiene number/title/url (no body, no user)', () => {
    // CA-S4: el módulo no debe propagar campos prohibidos. Si la API trae más
    // datos, filterOrphans los descarta.
    const items = [
        {
            number: 300,
            labels: [],
            title: 'huérfano',
            url: 'http://x',
            body: 'secreto AWS_SECRET_KEY=AKIAFOO',
            user: { login: 'malo' },
            assignees: [{ login: 'malo' }],
        },
    ];
    const orphans = gate.filterOrphans(items);
    assert.equal(orphans.length, 1);
    const keys = Object.keys(orphans[0]).sort();
    assert.deepEqual(keys, ['number', 'title', 'url']);
    assert.equal('body' in orphans[0], false);
    assert.equal('user' in orphans[0], false);
});

// -----------------------------------------------------------------------------
// applyBootstrapCap
// -----------------------------------------------------------------------------

test('applyBootstrapCap: N=0 → apply vacío, bootstrap=false', () => {
    const r = gate.applyBootstrapCap([]);
    assert.deepEqual(r.apply, []);
    assert.deepEqual(r.deferred, []);
    assert.equal(r.bootstrap, false);
});

test('applyBootstrapCap: N<=10 → no bootstrap', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ number: i, title: `t${i}`, url: `u${i}` }));
    const r = gate.applyBootstrapCap(items);
    assert.equal(r.apply.length, 5);
    assert.deepEqual(r.deferred, []);
    assert.equal(r.bootstrap, false);
});

test('applyBootstrapCap: N>10 → bootstrap=true, apply=10 primeros', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({ number: i, title: `t${i}`, url: `u${i}` }));
    const r = gate.applyBootstrapCap(items);
    assert.equal(r.apply.length, 10);
    assert.equal(r.deferred.length, 13);
    assert.equal(r.bootstrap, true);
});

test('applyBootstrapCap: input no-array → vacío seguro', () => {
    const r = gate.applyBootstrapCap(null);
    assert.deepEqual(r.apply, []);
    assert.deepEqual(r.deferred, []);
    assert.equal(r.bootstrap, false);
});

// -----------------------------------------------------------------------------
// formatTelegramAlert
// -----------------------------------------------------------------------------

test('formatTelegramAlert: modo silencioso con N=0 → null (CA-UX5)', () => {
    const r = gate.applyBootstrapCap([]);
    assert.equal(gate.formatTelegramAlert(r), null);
});

test('formatTelegramAlert: sweep normal usa emoji 🟡 (CA-UX4)', () => {
    const items = [{ number: 100, title: 'algo', url: 'http://x/100' }];
    const r = gate.applyBootstrapCap(items);
    const msg = gate.formatTelegramAlert(r);
    assert.ok(msg.startsWith('🟡 Admission gate'), `prefix esperado, got: ${msg.slice(0, 40)}`);
    assert.ok(msg.includes('1 huérfanos'));
    assert.ok(msg.includes('[#100]'));
});

test('formatTelegramAlert: bootstrap usa emoji 🔴 (CA-UX4)', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ number: 1000 + i, title: `t${i}`, url: `u${i}` }));
    const r = gate.applyBootstrapCap(items);
    const msg = gate.formatTelegramAlert(r);
    assert.ok(msg.startsWith('🔴 Admission gate'), `prefix esperado, got: ${msg.slice(0, 40)}`);
    assert.ok(msg.includes('15 huérfanos preexistentes'));
    assert.ok(msg.includes('cap 10 aplicado'));
    assert.ok(msg.includes('Acción REQUERIDA'));
});

test('formatTelegramAlert: NO incluye body/user/diff (CA-S4)', () => {
    const items = [
        {
            number: 500,
            title: 'titulo legitimo',
            url: 'http://x/500',
            // estos no deberían viajar nunca al output, pero defensivo:
        },
    ];
    const r = gate.applyBootstrapCap(items);
    const msg = gate.formatTelegramAlert(r);
    assert.equal(msg.includes('body'), false);
    assert.equal(msg.includes('diff'), false);
    assert.equal(msg.includes('user'), false);
    assert.equal(msg.includes('login'), false);
});

test('formatTelegramAlert: trunca títulos largos a 80 chars + … (CA-S4)', () => {
    const longTitle = 'A'.repeat(200);
    const items = [{ number: 600, title: longTitle, url: 'http://x/600' }];
    const r = gate.applyBootstrapCap(items);
    const msg = gate.formatTelegramAlert(r);
    // El título redactado y truncado debe terminar en … y tener máximo 80 chars
    // dentro del mensaje. No buscamos exact len del mensaje completo.
    const lineWithTitle = msg.split('\n').find((l) => l.includes('#600'));
    assert.ok(lineWithTitle.includes('…'), `esperaba truncado con elipsis, got: ${lineWithTitle}`);
});

test('formatTelegramAlert: redacta emails en el título (defensa CA-S4)', () => {
    const items = [{
        number: 700,
        title: 'reporte con leito.larreta@gmail.com adentro',
        url: 'http://x/700',
    }];
    const r = gate.applyBootstrapCap(items);
    const msg = gate.formatTelegramAlert(r);
    // El email completo NO debe aparecer textual.
    assert.equal(msg.includes('leito.larreta@gmail.com'), false);
});

test('formatTelegramAlert: incluye label por defecto needs-definition', () => {
    const items = [{ number: 800, title: 't', url: 'http://x/800' }];
    const r = gate.applyBootstrapCap(items);
    const msg = gate.formatTelegramAlert(r);
    assert.ok(msg.includes('labels:[needs-definition]'));
});

test('formatTelegramAlert: opts.labelApplied override', () => {
    const items = [{ number: 801, title: 't', url: 'http://x/801' }];
    const r = gate.applyBootstrapCap(items);
    const msg = gate.formatTelegramAlert(r, { labelApplied: 'custom-label' });
    assert.ok(msg.includes('labels:[custom-label]'));
});

// -----------------------------------------------------------------------------
// getAdmissionComment / alreadyCommented
// -----------------------------------------------------------------------------

test('getAdmissionComment: texto issue es literal y contiene link a doc', () => {
    const txt = gate.getAdmissionComment('issue');
    assert.ok(txt.startsWith('Este issue fue auto-etiquetado con `needs-definition`'));
    assert.ok(txt.includes('docs/pipeline-v2-diseno.md'));
    assert.ok(txt.includes('Ready'));
});

test('getAdmissionComment: texto PR menciona PR (no issue)', () => {
    const txt = gate.getAdmissionComment('pr');
    assert.ok(txt.startsWith('Este PR fue auto-etiquetado con `needs-definition`'));
    assert.equal(txt.startsWith('Este issue'), false);
});

test('getAdmissionComment: texto es estático — sin interpolación (CA-S6)', () => {
    // Misma invocación → mismo texto. Cero fuentes de variabilidad.
    const a = gate.getAdmissionComment('issue');
    const b = gate.getAdmissionComment('issue');
    assert.equal(a, b);
});

test('alreadyCommented: detecta comentario previo del gate (idempotencia)', () => {
    const comments = [
        { body: 'Hola, comentario humano' },
        { body: 'Este issue fue auto-etiquetado con `needs-definition` porque ...' },
    ];
    assert.equal(gate.alreadyCommented(comments, 'issue'), true);
});

test('alreadyCommented: sin match → false', () => {
    const comments = [
        { body: 'Hola, comentario humano' },
        { body: 'Otro comentario sin relación' },
    ];
    assert.equal(gate.alreadyCommented(comments, 'issue'), false);
});

test('alreadyCommented: ignora comentarios con body no-string', () => {
    const comments = [
        { body: null },
        { body: 42 },
        {},
        { body: 'Este issue fue auto-etiquetado con `needs-definition` foo' },
    ];
    assert.equal(gate.alreadyCommented(comments, 'issue'), true);
});

test('alreadyCommented: PR detecta su propio prefijo (no el de issue)', () => {
    const comments = [
        { body: 'Este issue fue auto-etiquetado con `needs-definition` foo' },
    ];
    assert.equal(gate.alreadyCommented(comments, 'pr'), false);
});

// -----------------------------------------------------------------------------
// needsAdmissionLabel (#5680)
//
// El gate deja de proponer label de admisión para recomendaciones de agente
// pendientes de triaje. `isAdmitted` NO cambia (tiene consumidor externo en
// `wizards/ola/index.js:245`); la pregunta nueva vive en un predicado propio.
// -----------------------------------------------------------------------------

// T1 — las recomendaciones pendientes de triaje quedan afuera, por los dos
// labels: `tipo:recomendacion` (vigente) y `source:recommendation` (histórico).
test('needsAdmissionLabel: tipo:recomendacion → false (#5680)', () => {
    assert.equal(gate.needsAdmissionLabel([{ name: 'tipo:recomendacion' }]), false);
});

test('needsAdmissionLabel: source:recommendation (histórico) → false (#5680)', () => {
    assert.equal(gate.needsAdmissionLabel([{ name: 'source:recommendation' }]), false);
});

test('needsAdmissionLabel: recomendación con labels extra sigue excluida (#5680)', () => {
    assert.equal(
        gate.needsAdmissionLabel([{ name: 'tipo:recomendacion' }, { name: 'needs-human' }, { name: 'area:pipeline' }]),
        false,
    );
});

// Una recomendación YA aprobada por un humano dejó de ser backlog: es trabajo
// real. `isRecommendationIssue()` ya devuelve false ante `recommendation:approved`.
test('needsAdmissionLabel: recommendation:approved → true (ya no es backlog) (#5680)', () => {
    assert.equal(
        gate.needsAdmissionLabel([{ name: 'tipo:recomendacion' }, { name: 'recommendation:approved' }]),
        true,
    );
});

// T2 — blinda R4 (excluir de más = DoS auto-infligido sobre la cola de entrada).
// Los issues reales sin label de admisión SIGUEN necesitándolo.
test('needsAdmissionLabel: issue sin labels → true (#5680)', () => {
    assert.equal(gate.needsAdmissionLabel([]), true);
    assert.equal(gate.needsAdmissionLabel(null), true);
    assert.equal(gate.needsAdmissionLabel(undefined), true);
});

test('needsAdmissionLabel: issue real (bug) → true (#5680)', () => {
    assert.equal(gate.needsAdmissionLabel([{ name: 'bug' }]), true);
});

test('needsAdmissionLabel: ya admitido (needs-definition / Ready) → false (#5680)', () => {
    assert.equal(gate.needsAdmissionLabel([{ name: 'needs-definition' }]), false);
    assert.equal(gate.needsAdmissionLabel([{ name: 'Ready' }]), false);
});

test('needsAdmissionLabel: acepta labels como strings planos (#5680)', () => {
    assert.equal(gate.needsAdmissionLabel(['tipo:recomendacion']), false);
    assert.equal(gate.needsAdmissionLabel(['bug']), true);
});

// T5 — blinda R3: `isAdmitted` conserva su semántica EXACTA. Devuelve false para
// una recomendación porque no tiene label de admisión, no porque sea recomendación.
test('isAdmitted: semántica intacta ante tipo:recomendacion (#5680, R3)', () => {
    assert.equal(gate.isAdmitted([{ name: 'tipo:recomendacion' }]), false);
    assert.equal(gate.isAdmitted([{ name: 'source:recommendation' }]), false);
    // …y sigue devolviendo true si la recomendación SÍ tiene label de admisión.
    assert.equal(gate.isAdmitted([{ name: 'tipo:recomendacion' }, { name: 'needs-definition' }]), true);
    assert.equal(gate.isAdmitted([{ name: 'tipo:recomendacion' }, { name: 'Ready' }]), true);
});

// filterOrphans hereda la exclusión — es lo que consume el sweep del reconciler
// (`servicio-reconciler.js:1168-1169`), que ya trae `labels` en su `--json`.
test('filterOrphans: excluye recomendaciones y conserva huérfanos reales (#5680)', () => {
    const items = [
        { number: 1, title: 'bug real', url: 'u1', labels: [] },
        { number: 2, title: 'reco', url: 'u2', labels: [{ name: 'tipo:recomendacion' }] },
        { number: 3, title: 'reco histórica', url: 'u3', labels: [{ name: 'source:recommendation' }] },
        { number: 4, title: 'ya admitido', url: 'u4', labels: [{ name: 'Ready' }] },
        { number: 5, title: 'reco aprobada', url: 'u5', labels: [{ name: 'tipo:recomendacion' }, { name: 'recommendation:approved' }] },
    ];
    assert.deepEqual(gate.filterOrphans(items).map(o => o.number), [1, 5]);
});

// -----------------------------------------------------------------------------
// T4 (#5680) — test de empaquetado: blinda R1
//
// El módulo corre en el runner de Actions bajo el `sparse-checkout` acotado de
// `.github/workflows/admission-gate.yml`. Un `require` de un archivo que no está
// en esa lista no degrada: hace throw y voltea el gate para TODO issue/PR nuevo
// (la regresión exacta que #3175 vino a cerrar).
//
// Este test parsea la lista DEL YAML (no la hardcodea, así sigue siendo válido
// cuando alguien la edite), copia sólo esos archivos a un tmpdir y hace
// require(). Cubre el árbol de dependencias entero para el próximo require que
// alguien agregue sin acordarse del workflow.
// -----------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const WORKFLOW_PATH = nodePath.join(__dirname, '..', '..', '..', '.github', 'workflows', 'admission-gate.yml');

// Parser mínimo del bloque `sparse-checkout: |` — sin dependencia de YAML.
function parseSparseCheckout(yamlText) {
    const lines = yamlText.split(/\r?\n/);
    const start = lines.findIndex(l => /^\s*sparse-checkout:\s*\|\s*$/.test(l));
    assert.notEqual(start, -1, 'el workflow debe declarar un bloque `sparse-checkout: |`');
    const indent = lines[start].match(/^(\s*)/)[1].length;
    const out = [];
    for (const line of lines.slice(start + 1)) {
        if (!line.trim()) continue;
        // El bloque literal termina cuando la indentación vuelve al nivel de la clave.
        if (line.match(/^(\s*)/)[1].length <= indent) break;
        out.push(line.trim());
    }
    return out;
}

test('T4 sparse-checkout del workflow incluye recommendation-labels.js (#5680)', () => {
    const files = parseSparseCheckout(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
    assert.ok(
        files.includes('.pipeline/lib/recommendation-labels.js'),
        `el gate requiere recommendation-labels.js; sparse-checkout actual: ${files.join(', ')}`,
    );
});

test('T4 admission-gate.js carga con SOLO los archivos del sparse-checkout (#5680, R1)', () => {
    const files = parseSparseCheckout(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
    const repoRoot = nodePath.join(__dirname, '..', '..', '..');
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'admission-gate-pkg-'));
    try {
        for (const rel of files) {
            const src = nodePath.join(repoRoot, rel);
            assert.ok(fs.existsSync(src), `el sparse-checkout lista un archivo inexistente: ${rel}`);
            const dst = nodePath.join(tmp, rel);
            fs.mkdirSync(nodePath.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
        }
        // require() real desde el árbol recortado: si falta una dependencia,
        // esto throwea igual que el github-script del runner.
        const isolated = require(nodePath.join(tmp, '.pipeline', 'lib', 'admission-gate.js'));
        assert.equal(typeof isolated.needsAdmissionLabel, 'function');
        // Y con el árbol completo la exclusión funciona de verdad (no degradada).
        assert.equal(isolated.needsAdmissionLabel([{ name: 'tipo:recomendacion' }]), false);
        assert.equal(isolated.needsAdmissionLabel([{ name: 'bug' }]), true);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// Contracara del try/catch: si `recommendation-labels.js` NO está (empaquetado
// incompleto), el módulo debe CARGAR IGUAL y degradar a "aplicar el label".
// Degradar es benigno; throwear voltea el gate entero.
test('T4 admission-gate.js carga aunque falte recommendation-labels.js (#5680, R1)', () => {
    const files = parseSparseCheckout(fs.readFileSync(WORKFLOW_PATH, 'utf8'))
        .filter(f => !f.endsWith('recommendation-labels.js'));
    const repoRoot = nodePath.join(__dirname, '..', '..', '..');
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'admission-gate-degraded-'));
    try {
        for (const rel of files) {
            const dst = nodePath.join(tmp, rel);
            fs.mkdirSync(nodePath.dirname(dst), { recursive: true });
            fs.copyFileSync(nodePath.join(repoRoot, rel), dst);
        }
        let isolated;
        assert.doesNotThrow(() => {
            isolated = require(nodePath.join(tmp, '.pipeline', 'lib', 'admission-gate.js'));
        }, 'el require debe ser opcional: un throw acá deja sin label a TODO issue nuevo');
        // Degradación explícita: sin el discriminador, se aplica el label.
        assert.equal(isolated.needsAdmissionLabel([{ name: 'tipo:recomendacion' }]), true);
        // El comportamiento para issues reales no cambia.
        assert.equal(isolated.needsAdmissionLabel([{ name: 'bug' }]), true);
        assert.equal(isolated.needsAdmissionLabel([{ name: 'Ready' }]), false);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
