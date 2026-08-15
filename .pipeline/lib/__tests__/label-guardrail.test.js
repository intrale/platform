// =============================================================================
// label-guardrail.test.js — #5690
//
// Cubre las reglas del guardrail fail-closed a nivel unidad (`evaluateLabelOrder`,
// auditoría y rotación). La integración con el worker de la cola —el CA que
// exige que `editIssue` NO sea invocado— vive en
// `.pipeline/tests/servicio-github-label-guardrail.test.js`.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guardrail = require('../label-guardrail');
const auditLog = require('../audit-log');

const AUTORIZADA = { guardrail_authorized: true, authorized_by: 'test:operador' };

function tmpDir(nombre) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `5690-${nombre}-`));
}

test.beforeEach(() => guardrail._resetDedupeForTests());

// -----------------------------------------------------------------------------
// Reglas de mezcla (CA del issue)
// -----------------------------------------------------------------------------

test('rechaza agregar needs-human a un issue que ya es recomendacion', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'needs-human',
        order: { issue: 1 },
        getCurrentLabels: () => ['tipo:recomendacion', 'enhancement'],
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO);
    assert.deepStrictEqual(v.currentLabels, ['tipo:recomendacion', 'enhancement']);
});

test('rechaza agregar tipo:recomendacion a un issue bloqueado por un humano', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'tipo:recomendacion',
        order: { issue: 2 },
        getCurrentLabels: () => ['needs-human'],
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_RECO_SOBRE_BLOQUEO);
});

test('permite agregar needs-human a un issue que no es recomendacion', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'needs-human',
        order: { issue: 3 },
        getCurrentLabels: () => ['bug', 'priority:high'],
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.motivo, 'sin-conflicto');
});

// -----------------------------------------------------------------------------
// SEC-A — el gate nuevo es aditivo y la cola no puede dispararlo
// -----------------------------------------------------------------------------

test('SEC-A: rechaza recommendation:approved sin procedencia declarada', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'recommendation:approved',
        order: { issue: 4 },
        getCurrentLabels: () => { throw new Error('no deberia consultarse'); },
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.APPROVED_SIN_ORIGEN_HUMANO);
    assert.strictEqual(v.consulted, false);
});

test('SEC-A: permite recommendation:approved con procedencia declarada y la atribuye', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'recommendation:approved',
        order: { issue: 4, ...AUTORIZADA },
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.authorizedBy, 'test:operador');
});

test('la procedencia exige AMBOS campos: el booleano y un authorized_by no vacio', () => {
    assert.strictEqual(guardrail.declaredAuthorization({ guardrail_authorized: true }), null);
    assert.strictEqual(guardrail.declaredAuthorization({ guardrail_authorized: true, authorized_by: '   ' }), null);
    assert.strictEqual(guardrail.declaredAuthorization({ authorized_by: 'x' }), null);
    assert.strictEqual(guardrail.declaredAuthorization({ guardrail_authorized: 'true', authorized_by: 'x' }), null);
    assert.strictEqual(guardrail.declaredAuthorization({ guardrail_authorized: true, authorized_by: 'x' }), 'x');
});

// -----------------------------------------------------------------------------
// SEC-B — el guardrail cubre el case 'remove-label'
// -----------------------------------------------------------------------------

test('SEC-B: rechaza remove-label de needs-human sin procedencia declarada', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'remove-label',
        label: 'needs-human',
        order: { issue: 5 },
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.REMOVE_NEEDS_HUMAN_SIN_ORIGEN_HUMANO);
});

test('SEC-B: permite remove-label de needs-human con procedencia declarada', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'remove-label',
        label: 'needs-human',
        order: { issue: 5, guardrail_authorized: true, authorized_by: 'human-block:unblock' },
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.authorizedBy, 'human-block:unblock');
});

test('remove-label de un label sensible que no es needs-human no queda restringido', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'remove-label',
        label: 'tipo:recomendacion',
        order: { issue: 6 },
    });
    assert.strictEqual(v.allowed, true);
});

// -----------------------------------------------------------------------------
// SEC-4 / R4 — el guardrail nunca remueve needs-human
// -----------------------------------------------------------------------------

test('SEC-4: ningun veredicto del guardrail ordena remover un label', () => {
    const escenarios = [
        { action: 'label', label: 'needs-human', getCurrentLabels: () => ['tipo:recomendacion'] },
        { action: 'label', label: 'tipo:recomendacion', getCurrentLabels: () => ['needs-human'] },
        { action: 'label', label: 'recommendation:approved' },
        { action: 'remove-label', label: 'needs-human' },
        { action: 'label', label: 'needs-human', getCurrentLabels: () => { throw new Error('rate limit'); } },
        { action: 'label', label: 'qa:passed' },
        { action: 'comment', label: null },
    ];
    for (const esc of escenarios) {
        const v = guardrail.evaluateLabelOrder({ ...esc, order: { issue: 7 } });
        // La API sólo emite un veredicto. Cualquier campo que pudiera leerse
        // como una instrucción de mutación es una regresión de SEC-4.
        for (const prohibido of ['toRemove', 'removeLabel', 'actions', 'toAdd', 'addLabel']) {
            assert.ok(!(prohibido in v), `veredicto expone "${prohibido}" para ${esc.action}/${esc.label}`);
        }
        assert.deepStrictEqual(
            Object.keys(v).filter((k) => !['allowed', 'motivo', 'consulted', 'currentLabels', 'authorizedBy', 'error'].includes(k)),
            [],
            `veredicto con claves inesperadas para ${esc.action}/${esc.label}`,
        );
    }
});

test('SEC-4: el modulo no invoca ninguna API de mutacion de GitHub', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'label-guardrail.js'), 'utf8');
    // Se excluyen los comentarios para no matchear la documentación del módulo.
    const codigo = fuente
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
        .join('\n');
    for (const patron of ['editIssue', 'removeLabel', 'execFileSync', 'execSync', 'spawnSync']) {
        assert.ok(!codigo.includes(patron), `el guardrail no debe usar "${patron}"`);
    }
});

// -----------------------------------------------------------------------------
// SEC-C — fail-closed ante consulta indeterminada
// -----------------------------------------------------------------------------

test('SEC-C: si la consulta de labels tira, se rechaza (nunca "ante la duda, aplicar")', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'needs-human',
        order: { issue: 8 },
        getCurrentLabels: () => { throw new Error('gh: API rate limit exceeded'); },
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.INDETERMINADO);
    assert.match(v.error, /rate limit/);
});

test('SEC-C: una consulta que devuelve algo que no es array tambien falla cerrado', () => {
    for (const malo of [null, undefined, {}, 'needs-human']) {
        const v = guardrail.evaluateLabelOrder({
            action: 'label',
            label: 'tipo:recomendacion',
            order: { issue: 9 },
            getCurrentLabels: () => malo,
        });
        assert.strictEqual(v.allowed, false, `deberia rechazar con ${JSON.stringify(malo)}`);
        assert.strictEqual(v.motivo, guardrail.MOTIVOS.INDETERMINADO);
    }
});

test('SEC-C: la procedencia declarada NO saltea el fail-closed de la regla de mezcla', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'needs-human',
        order: { issue: 10, ...AUTORIZADA },
        getCurrentLabels: () => { throw new Error('timeout'); },
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.INDETERMINADO);
});

// -----------------------------------------------------------------------------
// SEC-D — la consulta se dispara sólo para el conjunto sensible
// -----------------------------------------------------------------------------

test('SEC-D: un label no sensible no dispara la consulta de labels actuales', () => {
    let llamadas = 0;
    for (const label of ['qa:passed', 'priority:high', 'Ready', 'needs-definition', 'bug']) {
        const v = guardrail.evaluateLabelOrder({
            action: 'label',
            label,
            order: { issue: 11 },
            getCurrentLabels: () => { llamadas++; return []; },
        });
        assert.strictEqual(v.allowed, true);
        assert.strictEqual(v.consulted, false);
    }
    assert.strictEqual(llamadas, 0, 'ninguna orden no sensible debe costar un `gh issue view`');
});

test('SEC-D: source:recommendation es sensible pero no requiere consulta', () => {
    let llamadas = 0;
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'source:recommendation',
        order: { issue: 12 },
        getCurrentLabels: () => { llamadas++; return []; },
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(llamadas, 0);
});

test('acciones fuera del dominio del guardrail pasan sin evaluarse', () => {
    for (const action of ['comment', 'create-issue', 'close-issue']) {
        const v = guardrail.evaluateLabelOrder({ action, label: 'needs-human', order: { issue: 13 } });
        assert.strictEqual(v.allowed, true);
        assert.strictEqual(v.motivo, 'accion-fuera-del-dominio');
    }
});

// -----------------------------------------------------------------------------
// Auditoría — contenido, dedupe y rotación (SEC-E)
// -----------------------------------------------------------------------------

test('el conflicto se registra con ts, issue, label_solicitado, labels_actuales y origen', () => {
    const dir = tmpDir('audit');
    const r = guardrail.auditConflict({
        issue: 1732,
        label_solicitado: 'needs-human',
        labels_actuales: ['tipo:recomendacion'],
        origen: '1732-label-abc.json',
        accion: 'label',
        motivo: guardrail.MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO,
    });
    assert.ok(r.written, r.error);
    // El path por default depende de PIPELINE_STATE_DIR; acá verificamos el
    // contenido escrito en un dir propio para no ensuciar el del repo.
    const r2 = guardrail.auditConflict({
        dir,
        issue: 1733,
        label_solicitado: 'needs-human',
        labels_actuales: ['tipo:recomendacion', 'enhancement'],
        origen: '1733-label-def.json',
        accion: 'label',
        motivo: guardrail.MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO,
    });
    assert.ok(r2.written, r2.error);
    const entries = auditLog.readAll(r2.file);
    assert.strictEqual(entries.length, 1);
    const e = entries[0];
    assert.ok(e.ts, 'falta ts');
    assert.strictEqual(e.issue, 1733);
    assert.strictEqual(e.label_solicitado, 'needs-human');
    assert.deepStrictEqual(e.labels_actuales, ['tipo:recomendacion', 'enhancement']);
    assert.strictEqual(e.origen, '1733-label-def.json');
    assert.strictEqual(e.accion, 'label');
    assert.strictEqual(e.event, 'label_guardrail_conflict');
    // Hash chain intacto (tamper-evident).
    assert.strictEqual(auditLog.verifyChain(r2.file).ok, true);
});

test('SEC-E: conflictos identicos consecutivos se deduplican (productor en bucle)', () => {
    const dir = tmpDir('dedupe');
    const base = {
        dir, issue: 42, label_solicitado: 'needs-human', labels_actuales: ['tipo:recomendacion'],
        origen: 'bucle.json', accion: 'label', motivo: guardrail.MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO,
    };
    const primero = guardrail.auditConflict(base);
    assert.strictEqual(primero.written, true);
    for (let i = 0; i < 50; i++) {
        const r = guardrail.auditConflict(base);
        assert.strictEqual(r.written, false);
        assert.strictEqual(r.deduped, true);
    }
    // Un conflicto distinto rompe el dedupe y vuelve a escribir.
    const otro = guardrail.auditConflict({ ...base, issue: 43 });
    assert.strictEqual(otro.written, true);
    assert.strictEqual(auditLog.readAll(primero.file).length, 2);
});

test('SEC-E: el archivo de audit rota por tamano y no crece sin techo', () => {
    const dir = tmpDir('rota');
    fs.mkdirSync(dir, { recursive: true });
    const file = guardrail.auditFileFor(dir, '2026-08-07T00:00:00.000Z');
    fs.writeFileSync(file, 'x'.repeat(2048));
    const rotado = guardrail.rotateIfNeeded(file, 1024);
    assert.strictEqual(rotado, true);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(fs.existsSync(file + '.1'), true);
    // Segunda rotación: descarta el `.1` previo, techo duro de 2 archivos.
    fs.writeFileSync(file, 'y'.repeat(2048));
    guardrail.rotateIfNeeded(file, 1024);
    assert.strictEqual(fs.readFileSync(file + '.1', 'utf8')[0], 'y');
    assert.strictEqual(fs.existsSync(file + '.2'), false);
});

test('SEC-E: el archivo de audit se separa por dia', () => {
    const dir = tmpDir('dia');
    const a = guardrail.auditFileFor(dir, '2026-08-07T23:59:59.000Z');
    const b = guardrail.auditFileFor(dir, '2026-08-08T00:00:01.000Z');
    assert.notStrictEqual(a, b);
    assert.ok(a.endsWith('label-guardrail-2026-08-07.jsonl'));
    assert.ok(b.endsWith('label-guardrail-2026-08-08.jsonl'));
});

test('un fallo de escritura de auditoria no tira (nunca puede volverse una mutacion)', () => {
    const r = guardrail.auditConflict({
        dir: path.join(os.tmpdir(), 'no-existe-5690'),
        issue: 99,
        label_solicitado: 'needs-human',
        accion: 'label',
        motivo: guardrail.MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO,
        fsImpl: {
            existsSync: () => false,
            mkdirSync: () => { throw new Error('EACCES'); },
        },
    });
    assert.strictEqual(r.written, false);
    assert.ok(r.error);
});

test('el bypass autorizado queda registrado con su atribucion', () => {
    const dir = tmpDir('bypass');
    const r = guardrail.auditAuthorizedBypass({
        dir,
        issue: 77,
        label_solicitado: 'needs-human',
        accion: 'remove-label',
        motivo: 'remove-needs-human-con-origen-autorizado',
        origen: '77-remove-hb.json',
        authorized_by: 'human-block:unblock',
    });
    assert.ok(r.written, r.error);
    const e = auditLog.readAll(r.file)[0];
    assert.strictEqual(e.event, 'label_guardrail_bypass_autorizado');
    assert.strictEqual(e.authorized_by, 'human-block:unblock');
});

// -----------------------------------------------------------------------------
// UX-4 — mensaje legible en español, sin payload ni secretos
// -----------------------------------------------------------------------------

test('UX-4a: el rechazo produce una linea legible en espanol con issue, label y motivo', () => {
    const msg = guardrail.describeRejection({
        issue: 1732,
        label_solicitado: 'needs-human',
        labels_actuales: ['tipo:recomendacion', 'enhancement'],
        motivo: guardrail.MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO,
        accion: 'label',
        origen: '1732-label-abc.json',
    });
    assert.match(msg, /#1732/);
    assert.match(msg, /needs-human/);
    assert.match(msg, /tipo:recomendacion/);
    assert.match(msg, /NO fue modificado/);
    assert.match(msg, /Origen: 1732-label-abc\.json/);
});

test('UX-4a: el rechazo de remove-label explica que el destrabe es accion humana', () => {
    const msg = guardrail.describeRejection({
        issue: 500,
        label_solicitado: 'needs-human',
        labels_actuales: null,
        motivo: guardrail.MOTIVOS.REMOVE_NEEDS_HUMAN_SIN_ORIGEN_HUMANO,
        accion: 'remove-label',
        origen: 'anonimo.json',
    });
    assert.match(msg, /remover/);
    assert.match(msg, /no por la cola/);
});

// -----------------------------------------------------------------------------
// SEC-F — NORMALIZACIÓN CSV (regresión del bypass encontrado en verificación)
//
// El campo `label` es una LISTA CSV: `gh issue edit --add-label "a,b"` aplica
// DOS labels, y el repo ya emite ese formato (`servicio-github.js` hace
// `labelsStr.split(',')`, `migrate-recomendaciones-legacy.js` hace
// `toAdd.join(',')`). Comparar el string entero por igualdad exacta hacía que
// UNA COMA desarmara el guardrail: `"needs-human,priority:high"` no matcheaba
// ningún elemento sensible → `label-no-sensible` → pasaba a `editIssue` → `gh`
// separaba por la coma y removía `needs-human` igual, en silencio.
//
// Cada test de acá abajo es un vector verificado antes del fix.
// -----------------------------------------------------------------------------

test('SEC-F: isSensitiveLabel detecta el label sensible en cualquier posicion del CSV', () => {
    assert.strictEqual(guardrail.isSensitiveLabel('needs-human'), true);
    assert.strictEqual(guardrail.isSensitiveLabel('needs-human,priority:high'), true);
    assert.strictEqual(guardrail.isSensitiveLabel('priority:high,needs-human'), true);
    assert.strictEqual(guardrail.isSensitiveLabel('a,b, needs-human ,c'), true, 'trimea cada componente');
    assert.strictEqual(guardrail.isSensitiveLabel('area:infra,bug'), false, 'sin sensibles: sigue barato (SEC-D)');
    assert.strictEqual(guardrail.isSensitiveLabel(''), false);
    assert.strictEqual(guardrail.isSensitiveLabel(null), false);
});

test('SEC-F: parseLabelList descompone, trimea y descarta vacios', () => {
    assert.deepStrictEqual(guardrail.parseLabelList('a, b ,,c'), ['a', 'b', 'c']);
    assert.deepStrictEqual(guardrail.parseLabelList('needs-human'), ['needs-human']);
    assert.deepStrictEqual(guardrail.parseLabelList(''), []);
    assert.deepStrictEqual(guardrail.parseLabelList(null), []);
});

test('SEC-F: remove-label con needs-human dentro de un CSV exige procedencia igual', () => {
    for (const label of ['needs-human,priority:high', 'priority:high,needs-human', 'a, needs-human ,b']) {
        const v = guardrail.evaluateLabelOrder({ action: 'remove-label', label, order: {} });
        assert.strictEqual(v.allowed, false, `deberia rechazar: ${label}`);
        assert.strictEqual(v.motivo, guardrail.MOTIVOS.REMOVE_NEEDS_HUMAN_SIN_ORIGEN_HUMANO);
    }
});

test('SEC-F: remove-label CSV con procedencia declarada sigue permitido y atribuido', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'remove-label',
        label: 'needs-human,priority:high',
        order: { guardrail_authorized: true, authorized_by: 'human-block:unblock' },
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.authorizedBy, 'human-block:unblock', 'el bypass tiene que quedar auditado');
});

test('SEC-F: agregar needs-human via CSV sobre una recomendacion es mezcla y se rechaza', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'needs-human,area:infra',
        order: {},
        getCurrentLabels: () => ['tipo:recomendacion', 'enhancement'],
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO);
});

test('SEC-F: agregar tipo:recomendacion via CSV sobre un issue bloqueado se rechaza', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'tipo:recomendacion,enhancement',
        order: {},
        getCurrentLabels: () => ['needs-human'],
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_RECO_SOBRE_BLOQUEO);
});

test('SEC-F: pedir needs-human y tipo:recomendacion en la MISMA orden es mezcla por construccion', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'needs-human,tipo:recomendacion',
        order: {},
        getCurrentLabels: () => [],
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_EN_LA_MISMA_ORDEN);
    assert.strictEqual(v.consulted, false, 'la orden ya es la mezcla: no hace falta consultar');
});

test('SEC-F: la procedencia declarada NO habilita la mezcla en la misma orden', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'tipo:recomendacion,needs-human',
        order: { guardrail_authorized: true, authorized_by: 'atacante' },
        getCurrentLabels: () => [],
    });
    assert.strictEqual(v.allowed, false, 'el CA pide que la mezcla sea imposible POR CONSTRUCCION');
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_EN_LA_MISMA_ORDEN);
});

test('SEC-F: auto-aprobar una recomendacion via CSV sin procedencia se rechaza', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'recommendation:approved,enhancement',
        order: {},
        getCurrentLabels: () => [],
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.APPROVED_SIN_ORIGEN_HUMANO);
});

test('SEC-F: approved via CSV CON procedencia pasa y queda atribuido', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'recommendation:approved,enhancement',
        order: { guardrail_authorized: true, authorized_by: 'dashboard:leito' },
        getCurrentLabels: () => [],
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.authorizedBy, 'dashboard:leito');
});

test('SEC-F: SEC-C sigue fail-closed cuando el label sensible viene dentro de un CSV', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'needs-human,area:infra',
        order: {},
        getCurrentLabels: () => { throw new Error('rate limit'); },
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.INDETERMINADO);
});

test('SEC-F: SEC-D se conserva — un CSV sin sensibles no gasta la consulta', () => {
    let consultas = 0;
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'area:infra,bug,enhancement',
        order: {},
        getCurrentLabels: () => { consultas += 1; return []; },
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.motivo, 'label-no-sensible');
    assert.strictEqual(consultas, 0, 'no puede dispararse un gh issue view por cada orden trivial');
});

test('SEC-F: el motivo de mezcla en la misma orden tiene explicacion legible en espanol', () => {
    const msg = guardrail.describeRejection({
        issue: 4242,
        label_solicitado: 'needs-human,tipo:recomendacion',
        labels_actuales: null,
        motivo: guardrail.MOTIVOS.MEZCLA_EN_LA_MISMA_ORDEN,
        accion: 'label',
        origen: 'cola-anonima.json',
    });
    assert.match(msg, /#4242/);
    assert.match(msg, /juntos/);
    assert.match(msg, /NO fue modificado/);
    assert.doesNotMatch(msg, /mezcla-needs-human-y-recomendacion/, 'debe explicar, no volcar el slug');
});

// -----------------------------------------------------------------------------
// SEC-G — NORMALIZACIÓN DE CASE (regresión del 2do bypass, misma clase que SEC-F)
//
// SEC-F cubrió el separador y no el case. `Array.includes()` es case-sensitive;
// GitHub y `gh` resuelven los nombres de label case-insensitive (verificado
// contra la API real: `gh api .../labels/NEEDS-HUMAN` devuelve `needs-human`, y
// `gh issue edit --remove-label "ZZZ-CASETEST"` removió el `zzz-casetest`).
//
// Entonces `{"action":"remove-label","label":"NEEDS-HUMAN"}` salía por el
// early-return `label-no-sensible`, llegaba a `editIssue` y removía el
// `needs-human` REAL — rompiendo SEC-4/R4 y sin dejar línea de auditoría.
//
// Cada test de acá abajo es un vector verificado ROJO antes del fix.
// -----------------------------------------------------------------------------

test('SEC-G: normalizeLabelName baja a minusculas y trimea (solo para comparar)', () => {
    assert.strictEqual(guardrail.normalizeLabelName('  NEEDS-HUMAN '), 'needs-human');
    assert.strictEqual(guardrail.normalizeLabelName('Tipo:Recomendacion'), 'tipo:recomendacion');
    assert.strictEqual(guardrail.normalizeLabelName(''), '');
    assert.strictEqual(guardrail.normalizeLabelName(null), '');
});

test('SEC-G: isSensitiveLabel detecta el sensible en cualquier variante de case', () => {
    for (const l of ['NEEDS-HUMAN', 'Needs-Human', 'needs-Human', ' NeEdS-HuMaN ', 'Tipo:Recomendacion', 'RECOMMENDATION:APPROVED']) {
        assert.strictEqual(guardrail.isSensitiveLabel(l), true, `deberia ser sensible: ${l}`);
    }
    // Combinado con SEC-F: case raro + CSV.
    assert.strictEqual(guardrail.isSensitiveLabel('priority:high,NEEDS-HUMAN'), true);
    assert.strictEqual(guardrail.isSensitiveLabel('Area:Infra,Bug'), false, 'sin sensibles sigue barato (SEC-D)');
});

test('SEC-G: parseLabelList NO altera el case (el original es lo que viaja a gh y al audit)', () => {
    assert.deepStrictEqual(guardrail.parseLabelList('NEEDS-HUMAN, Area:Infra'), ['NEEDS-HUMAN', 'Area:Infra']);
    assert.deepStrictEqual(guardrail.normalizedLabelList('NEEDS-HUMAN, Area:Infra'), ['needs-human', 'area:infra']);
});

test('SEC-G: remove-label de needs-human en MAYUSCULAS exige procedencia igual', () => {
    for (const label of ['NEEDS-HUMAN', 'Needs-Human', 'needs-Human', ' NeEdS-HuMaN ', 'NEEDS-HUMAN,priority:high']) {
        const v = guardrail.evaluateLabelOrder({ action: 'remove-label', label, order: {} });
        assert.strictEqual(v.allowed, false, `deberia rechazar: ${label}`);
        assert.strictEqual(v.motivo, guardrail.MOTIVOS.REMOVE_NEEDS_HUMAN_SIN_ORIGEN_HUMANO);
    }
});

test('SEC-G: agregar Needs-Human sobre una recomendacion sigue siendo mezcla', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'Needs-Human',
        order: {},
        getCurrentLabels: () => ['tipo:recomendacion'],
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO);
});

test('SEC-G: la normalizacion aplica tambien a los labels ACTUALES del issue', () => {
    // El otro lado de la comparación: si GitHub reporta `Tipo:Recomendacion`,
    // comparar contra la constante en minúsculas dejaba pasar la mezcla.
    const v1 = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'needs-human',
        order: {},
        getCurrentLabels: () => ['Tipo:Recomendacion', 'Enhancement'],
    });
    assert.strictEqual(v1.allowed, false);
    assert.strictEqual(v1.motivo, guardrail.MOTIVOS.MEZCLA_BLOQUEO_SOBRE_RECO);

    const v2 = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'tipo:recomendacion',
        order: {},
        getCurrentLabels: () => ['NEEDS-HUMAN'],
    });
    assert.strictEqual(v2.allowed, false);
    assert.strictEqual(v2.motivo, guardrail.MOTIVOS.MEZCLA_RECO_SOBRE_BLOQUEO);
});

test('SEC-G: currentLabels devuelto conserva el case ORIGINAL para el forense', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'needs-human',
        order: {},
        getCurrentLabels: () => ['Tipo:Recomendacion'],
    });
    assert.deepStrictEqual(v.currentLabels, ['Tipo:Recomendacion'], 'el audit registra lo que GitHub reporta, no una version reescrita');
});

test('SEC-G: auto-aprobar con Recommendation:Approved sin procedencia se rechaza', () => {
    const v = guardrail.evaluateLabelOrder({ action: 'label', label: 'Recommendation:Approved', order: {} });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.APPROVED_SIN_ORIGEN_HUMANO);
});

test('SEC-G: mezcla en la misma orden con case mixto se rechaza aun con procedencia', () => {
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'NEEDS-HUMAN,Tipo:Recomendacion',
        order: { guardrail_authorized: true, authorized_by: 'atacante' },
    });
    assert.strictEqual(v.allowed, false, 'imposible POR CONSTRUCCION: la procedencia no habilita la mezcla');
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_EN_LA_MISMA_ORDEN);
});

test('SEC-G: SEC-D preservado — un label no sensible con case raro no consulta la API', () => {
    let consultas = 0;
    const v = guardrail.evaluateLabelOrder({
        action: 'label',
        label: 'Area:Infra,BUG',
        order: {},
        getCurrentLabels: () => { consultas++; return []; },
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(consultas, 0, 'normalizar no puede encarecer el camino comun');
});

test('SEC-G/SEC-4: ningun veredicto del modulo ordena remover needs-human', () => {
    // El invariante R4: la salida es un veredicto, nunca una accion.
    const variantes = ['needs-human', 'NEEDS-HUMAN', 'Needs-Human', 'needs-human,x'];
    for (const label of variantes) {
        for (const action of ['label', 'remove-label']) {
            for (const order of [{}, { guardrail_authorized: true, authorized_by: 'quien-sea' }]) {
                const v = guardrail.evaluateLabelOrder({ action, label, order, getCurrentLabels: () => [] });
                assert.ok(!('removeLabel' in v), 'el veredicto no puede traer una accion de remocion');
                assert.ok(!('accion' in v) && !('mutacion' in v));
                assert.strictEqual(typeof v.allowed, 'boolean');
            }
        }
    }
});

// -----------------------------------------------------------------------------
// SEC-H — EL NACIMIENTO TAMBIÉN ES UNA MUTACIÓN
//
// `case 'create-issue'` seteaba `data.labels` y llegaba a `createIssue` sin
// pasar por ningún guardrail: un issue podía NACER con `needs-human` y
// `tipo:recomendacion` juntos. El CA pide que la mezcla sea imposible por
// construcción, y el nacimiento no estaba cubierto.
// -----------------------------------------------------------------------------

test('SEC-H: crear un issue con needs-human + tipo:recomendacion se rechaza', () => {
    for (const labels of [
        'needs-human,tipo:recomendacion',
        'tipo:recomendacion,needs-human',
        'NEEDS-HUMAN,Tipo:Recomendacion',
        'enhancement,tipo:recomendacion,area:infra,needs-human',
    ]) {
        const v = guardrail.evaluateCreateIssueLabels({ labels, order: {} });
        assert.strictEqual(v.allowed, false, `deberia rechazar: ${labels}`);
        assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_EN_LA_MISMA_ORDEN);
    }
});

test('SEC-H: la procedencia declarada NO habilita nacer mezclado', () => {
    const v = guardrail.evaluateCreateIssueLabels({
        labels: 'needs-human,tipo:recomendacion',
        order: { guardrail_authorized: true, authorized_by: 'atacante' },
    });
    assert.strictEqual(v.allowed, false);
    assert.strictEqual(v.motivo, guardrail.MOTIVOS.MEZCLA_EN_LA_MISMA_ORDEN);
});

test('SEC-H: nacer con recommendation:approved sin procedencia se rechaza (SEC-A al nacimiento)', () => {
    for (const labels of ['recommendation:approved', 'Recommendation:Approved,enhancement']) {
        const v = guardrail.evaluateCreateIssueLabels({ labels, order: {} });
        assert.strictEqual(v.allowed, false, `deberia rechazar: ${labels}`);
        assert.strictEqual(v.motivo, guardrail.MOTIVOS.APPROVED_SIN_ORIGEN_HUMANO);
    }
});

test('SEC-H: nacer con recommendation:approved CON procedencia queda permitido y atribuido', () => {
    const v = guardrail.evaluateCreateIssueLabels({
        labels: 'recommendation:approved,enhancement',
        order: { guardrail_authorized: true, authorized_by: 'dashboard:panel-reco' },
    });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.authorizedBy, 'dashboard:panel-reco');
});

test('SEC-H: crear un issue bloqueado (needs-human SOLO) sigue siendo legitimo', () => {
    // El circuit breaker de infra crea issues ya bloqueados. Lo prohibido es la
    // COMBINACION, no el label de bloqueo.
    const v = guardrail.evaluateCreateIssueLabels({ labels: 'needs-human,priority:critical', order: {} });
    assert.strictEqual(v.allowed, true);
});

test('SEC-H: crear una recomendacion limpia (el flujo de los 5 roles) pasa', () => {
    const v = guardrail.evaluateCreateIssueLabels({
        labels: 'tipo:recomendacion,source:recommendation,needs:triage-backlog,enhancement,priority:low',
        order: {},
    });
    assert.strictEqual(v.allowed, true);
});

test('SEC-H: labels sin sensibles ni siquiera evalua reglas (SEC-D)', () => {
    const v = guardrail.evaluateCreateIssueLabels({ labels: 'bug,area:infra', order: {} });
    assert.strictEqual(v.allowed, true);
    assert.strictEqual(v.motivo, 'label-no-sensible');
    assert.strictEqual(v.consulted, false);
});

test('SEC-H: describeRejection de create-issue no habla de un issue inexistente', () => {
    const msg = guardrail.describeRejection({
        issue: null,
        label_solicitado: 'needs-human,tipo:recomendacion',
        labels_actuales: null,
        motivo: guardrail.MOTIVOS.MEZCLA_EN_LA_MISMA_ORDEN,
        accion: 'create-issue',
        origen: 'cola-anonima.json',
    });
    assert.match(msg, /NO fue creado/);
    assert.doesNotMatch(msg, /#null/, 'no puede citar un numero de issue que todavia no existe');
});
