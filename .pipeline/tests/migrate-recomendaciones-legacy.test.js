// =============================================================================
// Tests del migrador del backlog legacy de #5678 (issue #5691, parte 3 de 3).
//
// REESCRITOS EN BLOQUE. Los 7 tests previos afirmaban la semántica INVERTIDA
// (uno literal: "descarta si ya tiene tipo:recomendacion" — lo contrario del
// predicado nuevo) y quedaron obsoletos con la reescritura del módulo.
//
// El candidate set real se movió ~34× en un mes (~924 → 27), así que ningún
// test fija una constante numérica de producción: todo se demuestra con
// fixtures y un `ghRunner` inyectado, sin red.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mig = require('../migrate-recomendaciones-legacy');

const {
    NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, TRIAGE_BACKLOG_LABEL,
    RECOMMENDATION_APPROVED_LABEL, AbortoMigracion,
} = mig;

const MODULO = path.join(__dirname, '..', 'migrate-recomendaciones-legacy.js');

/**
 * Fuente del módulo SIN comentarios. Las prohibiciones (`execSync`,
 * `writeFileSync`, `isRecommendationIssue`) están documentadas en el header
 * como advertencias, así que un grep crudo daría falso positivo: lo que hay que
 * afirmar es que no aparecen en el CÓDIGO.
 */
function codigoSinComentarios() {
    return fs.readFileSync(MODULO, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
        .join('\n');
}

// --- Helpers de fixture ------------------------------------------------------

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mig5678-'));
}

/**
 * Runner de `gh` falso. Registra todas las invocaciones en `calls` y responde
 * según el sub-comando. `paginas` permite simular el `--paginate` de ≥N páginas.
 */
function crearGh({
    issues = [],
    paginas = null,
    totalSearch = null,
    labelExiste = true,
    labelsAlReleer = null,
    editResponder = null,
} = {}) {
    const calls = [];
    const runner = (args) => {
        calls.push(args.slice());
        const [c0, c1] = args;

        if (c0 === 'api' && c1 === '--paginate') {
            const cuerpos = paginas || [issues];
            return { ok: true, stdout: cuerpos.map((p) => JSON.stringify(p)).join(''), stderr: '', status: 0 };
        }
        if (c0 === 'api' && args.includes('search/issues')) {
            assert.ok(args.includes('-X') && args.includes('GET'), 'la Search API se consulta por GET, no por POST');
            const n = totalSearch === null
                ? (paginas ? paginas.reduce((a, p) => a + p.filter((i) => !i.pull_request).length, 0)
                    : issues.filter((i) => !i.pull_request).length)
                : totalSearch;
            return { ok: true, stdout: `${n}\n`, stderr: '', status: 0 };
        }
        if (c0 === 'label' && c1 === 'list') {
            return labelExiste
                ? { ok: true, stdout: JSON.stringify([{ name: TRIAGE_BACKLOG_LABEL }]), stderr: '', status: 0 }
                : { ok: true, stdout: '[]', stderr: '', status: 0 };
        }
        if (c0 === 'issue' && c1 === 'view') {
            const num = Number(args[2]);
            const labels = labelsAlReleer
                ? (labelsAlReleer[num] || [])
                : ((issues.find((i) => Number(i.number) === num) || {}).labels || []).map((l) => (typeof l === 'string' ? l : l.name));
            return { ok: true, stdout: JSON.stringify({ labels: labels.map((n) => ({ name: n })) }), stderr: '', status: 0 };
        }
        if (c0 === 'issue' && c1 === 'edit') {
            if (editResponder) return editResponder(args, calls);
            return { ok: true, stdout: '', stderr: '', status: 0 };
        }
        return { ok: true, stdout: '', stderr: '', status: 0 };
    };
    runner.calls = calls;
    return runner;
}

const issue = (number, labels, extra = {}) => ({
    number, title: `issue ${number}`, labels: labels.map((name) => ({ name })),
    created_at: '2026-09-01T00:00:00Z', ...extra,
});

const CANDIDATO = [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL];

function conConfirmacion(dir, token = 'token-del-dia-abc') {
    const file = path.join(dir, 'confirm.txt');
    fs.writeFileSync(file, `${token}\n`, 'utf8');
    return { confirmFile: file, env: { MIGRATE_5678_CONFIRM: token } };
}

const sinLog = () => {};
const sleepInstantaneo = async () => {};

// =============================================================================
// A · Predicado y seguridad del migrador
// =============================================================================

test('A1 · el predicado es exclusivamente por label: no queda heurística de título en el módulo', () => {
    const src = fs.readFileSync(MODULO, 'utf8');
    // Las menciones que sobreviven son la explicación de POR QUÉ se eliminaron,
    // dentro del header; no puede haber declaración de las constantes.
    assert.doesNotMatch(src, /^\s*const\s+TITLE_RE\s*=/m, 'no debe declararse TITLE_RE');
    assert.doesNotMatch(src, /^\s*const\s+AGENT_LABEL_RE\s*=/m, 'no debe declararse AGENT_LABEL_RE');
    // Y el predicado ignora el título por completo.
    assert.strictEqual(mig.esCandidato(CANDIDATO), true);
    assert.strictEqual(mig.esCandidato(['bug']), false);
});

test('A2 · exige needs-human Y tipo:recomendacion Y ausencia de recommendation:approved', () => {
    assert.strictEqual(mig.esCandidato(CANDIDATO), true);
    assert.strictEqual(mig.esCandidato([NEEDS_HUMAN_LABEL]), false, 'falta tipo:recomendacion');
    assert.strictEqual(mig.esCandidato([TIPO_RECOMENDACION_LABEL]), false, 'falta needs-human');
    assert.strictEqual(mig.esCandidato([...CANDIDATO, RECOMMENDATION_APPROVED_LABEL]), false, 'ya aprobado');
    // La constante se importa, no se hardcodea.
    assert.strictEqual(
        mig.RECOMMENDATION_APPROVED_LABEL,
        require('../lib/recommendation-labels').RECOMMENDATION_APPROVED_LABEL,
    );
});

test('A3 · no usa isRecommendationIssue(): source:recommendation sola NO es candidato', () => {
    const labels = [NEEDS_HUMAN_LABEL, 'source:recommendation'];
    const { isRecommendationIssue } = require('../lib/recommendation-labels');
    assert.strictEqual(isRecommendationIssue(labels), true, 'el helper sí lo considera recomendación');
    assert.strictEqual(mig.esCandidato(labels), false, 'el migrador NO, porque falta tipo:recomendacion');
    assert.doesNotMatch(codigoSinComentarios(), /isRecommendationIssue/, 'el helper no debe importarse ni invocarse');
});

test('A4 · un elemento sin tipo:recomendacion aborta la corrida entera, no saltea el ítem', async () => {
    const dir = tmpDir();
    const gh = crearGh({ issues: [issue(1, CANDIDATO), issue(2, [NEEDS_HUMAN_LABEL]), issue(3, CANDIDATO)] });
    await assert.rejects(
        () => mig.run({ ghRunner: gh, auditDir: dir, log: sinLog }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'candidato-sin-tipo-recomendacion',
    );
    const edits = gh.calls.filter((c) => c[0] === 'issue' && c[1] === 'edit');
    assert.strictEqual(edits.length, 0, 'no se muta nada tras el aborto');
});

test('A5 · todo `gh` se invoca con array de argumentos, sin shell — título hostil incluido', async () => {
    const codigo = codigoSinComentarios();
    assert.match(codigo, /spawnSync\(bin, args/, 'debe usar spawnSync con array');
    assert.match(codigo, /shell:\s*false/, 'debe declarar shell: false');
    assert.doesNotMatch(codigo, /execSync/, 'no debe migrar a execSync');

    const dir = tmpDir();
    const hostil = '"; rm -rf / #$(whoami)`id`';
    const gh = crearGh({ issues: [issue(7, CANDIDATO, { title: hostil })] });
    const { confirmFile, env } = conConfirmacion(dir);
    await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    for (const c of gh.calls) {
        assert.ok(Array.isArray(c), 'cada invocación es un array');
        assert.ok(!c.some((a) => String(a).includes('rm -rf')), 'el título hostil nunca entra en los argumentos');
    }
});

test('A6 · pagina hasta agotar el set (fixture de 3 páginas) y filtra pull requests', async () => {
    const dir = tmpDir();
    const p1 = Array.from({ length: 100 }, (_, i) => issue(1000 + i, CANDIDATO));
    const p2 = Array.from({ length: 100 }, (_, i) => issue(2000 + i, CANDIDATO));
    const p3 = [
        ...Array.from({ length: 7 }, (_, i) => issue(3000 + i, CANDIDATO)),
        issue(3999, CANDIDATO, { pull_request: { url: 'x' } }),
    ];
    const gh = crearGh({ paginas: [p1, p2, p3] });
    const r = await mig.run({ ghRunner: gh, auditDir: dir, log: sinLog });
    assert.strictEqual(r.total, 207, 'las 3 páginas se agotan y el PR queda afuera');
    const api = gh.calls.find((c) => c[0] === 'api' && c[1] === '--paginate');
    assert.ok(api, 'usa gh api --paginate');
    assert.match(api[2], /^repos\/[\w.-]+\/[\w.-]+\/issues\?/, 'sobre el REST de issues');
});

test('A6b · si el total paginado no coincide con search/issues, --apply no se habilita', async () => {
    const dir = tmpDir();
    const gh = crearGh({ issues: [issue(1, CANDIDATO)], totalSearch: 99 });
    const { confirmFile, env } = conConfirmacion(dir);
    await assert.rejects(
        () => mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'cross-check-fallido',
    );
    assert.strictEqual(gh.calls.filter((c) => c[1] === 'edit').length, 0);
});

test('A7 · un label por flag, nunca CSV — migración y reversión con un label que trae coma', async () => {
    const dir = tmpDir();
    const gh = crearGh({ issues: [issue(11, CANDIDATO)] });
    const { confirmFile, env } = conConfirmacion(dir);
    await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    for (const c of gh.calls.filter((x) => x[1] === 'edit')) {
        const valor = c[c.length - 1];
        assert.ok(!String(valor).includes(','), `label CSV detectado: ${valor}`);
    }

    // Reversión con un nombre de label hostil que contiene una coma.
    const wal = path.join(dir, 'rev.jsonl');
    mig.appendWal(wal, { issue: 42, labels_antes: ['needs-human', 'area:x,tipo:recomendacion'], labels_despues: [], authorized_by: 'migracion-5678', status: 'intent' });
    mig.appendWal(wal, { issue: 42, status: 'ok' });
    const gh2 = crearGh({});
    const rev = await mig.revertirDesdeWal({ walFile: wal, ghRunner: gh2, apply: true, sleep: sleepInstantaneo });
    assert.deepStrictEqual(rev.revertidos, [42]);
    const usados = gh2.calls.filter((c) => c[1] === 'edit').map((c) => c[c.length - 1]);
    assert.ok(usados.includes('area:x,tipo:recomendacion'), 'el label con coma va entero en UN flag');
    assert.strictEqual(usados.filter((v) => v === 'needs-human,area:x,tipo:recomendacion').length, 0, 'jamás un join(",")');
});

test('A8 · un token ghp_ sintético no sobrevive al WAL — se verifica el string persistido en disco', async () => {
    const dir = tmpDir();
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';   // 36 chars
    assert.strictEqual(token.length, 36);
    const gh = crearGh({
        issues: [issue(21, CANDIDATO)],
        editResponder: (args) => (args.includes('--add-label')
            ? { ok: false, stdout: '', stderr: `HTTP 401 Bad credentials: token ${token} rechazado`, status: 1 }
            : { ok: true, stdout: '', stderr: '', status: 0 }),
    });
    const { confirmFile, env } = conConfirmacion(dir);
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    const persistido = fs.readFileSync(r.walFile, 'utf8');
    assert.ok(!persistido.includes(token), 'el token NO puede estar en el WAL');
    assert.match(persistido, /\[REDACTED\]/, 'quedó la marca de redacción');
});

test('A9 · --apply sin la confirmación fuera de banda degrada a dry-run y no muta nada', async () => {
    const dir = tmpDir();
    const gh = crearGh({ issues: [issue(31, CANDIDATO), issue(32, CANDIDATO)] });
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, env: {}, confirmFile: path.join(dir, 'no-existe.txt'), log: sinLog });
    assert.strictEqual(r.apply, false, 'degradó a dry-run');
    assert.strictEqual(r.ok, 0);
    assert.strictEqual(gh.calls.filter((c) => c[1] === 'edit').length, 0, 'CERO mutaciones');

    // Y la confirmación con un valor equivocado tampoco habilita.
    const { confirmFile } = conConfirmacion(dir);
    assert.strictEqual(mig.verificarConfirmacion({ env: { MIGRATE_5678_CONFIRM: 'otro' }, confirmFile }).ok, false);
    assert.strictEqual(mig.verificarConfirmacion({ env: { MIGRATE_5678_CONFIRM: 'token-del-dia-abc' }, confirmFile }).ok, true);
});

test('A10 · TOCTOU: el candidato que dejó de calificar se saltea, no aborta', async () => {
    const dir = tmpDir();
    const gh = crearGh({
        issues: [issue(41, CANDIDATO), issue(42, CANDIDATO)],
        // Entre el listado y la mutación, un humano aprobó el 41.
        labelsAlReleer: {
            41: [...CANDIDATO, RECOMMENDATION_APPROVED_LABEL],
            42: CANDIDATO,
        },
    });
    const { confirmFile, env } = conConfirmacion(dir);
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r.ok, 1, 'sólo se migra el que sigue calificando');
    assert.strictEqual(r.skipped, 1);
    const registros = mig.leerWal(r.walFile);
    assert.ok(registros.some((x) => x.issue === 41 && x.status === 'skipped' && x.motivo === 'predicado-invalidado'));
    assert.ok(registros.some((x) => x.issue === 42 && x.status === 'ok'));
});

test('A11 · backoff exponencial ante 403 leyendo Retry-After, y rate limit de la ventana', async () => {
    // Backoff: el primer intento devuelve 403 con Retry-After, el segundo pasa.
    const esperas = [];
    let intento = 0;
    const r = await mig.ejecutarConBackoff(() => {
        intento++;
        return intento === 1
            ? { ok: false, stdout: '', stderr: 'HTTP 403: You have exceeded a secondary rate limit. Retry-After: 7', status: 1 }
            : { ok: true, stdout: '', stderr: '', status: 0 };
    }, { sleep: async (ms) => { esperas.push(ms); } });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(esperas, [7000], 'respetó Retry-After');
    assert.strictEqual(mig.esperaPorRetryAfter({ ok: true }), null, 'un resultado OK no dispara backoff');

    // Rate limit: con la ventana llena, la próxima mutación espera.
    const ahora = 1_000_000;
    const llena = Array.from({ length: mig.MAX_MUTACIONES_POR_MINUTO }, (_, i) => ahora - 59_000 + i);
    assert.ok(mig.esperaPorRateLimit(llena, ahora) > 0, 'ventana llena → espera');
    assert.strictEqual(mig.esperaPorRateLimit([ahora - 100], ahora), 0, 'ventana con lugar → no espera');
});

// =============================================================================
// B · Procedencia ante el guardrail de #5690
// =============================================================================

test('B1 · sin procedencia declarada el guardrail rechaza; el migrador la declara siempre', () => {
    const guardrail = require('../lib/label-guardrail');
    const sin = guardrail.evaluateLabelOrder({ action: 'remove-label', label: NEEDS_HUMAN_LABEL, order: {} });
    assert.strictEqual(sin.allowed, false, 'sin procedencia el guardrail rechaza');
    const con = mig.autorizarRemocion();
    assert.strictEqual(con, mig.AUTHORIZED_BY, 'el migrador declara procedencia y obtiene authorizedBy');
});

test('B2 · el authorized_by devuelto por el guardrail queda persistido en el registro intent del WAL', async () => {
    const dir = tmpDir();
    const gh = crearGh({ issues: [issue(51, CANDIDATO)] });
    const { confirmFile, env } = conConfirmacion(dir);
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    const intent = mig.leerWal(r.walFile).find((x) => x.status === 'intent' && x.issue === 51);
    assert.ok(intent, 'existe registro intent');
    assert.strictEqual(intent.authorized_by, mig.AUTHORIZED_BY, 'el WAL responde "quién autorizó"');
});

test('B3 · el header del módulo se declara como bypass auditado del choke point de #5690', () => {
    const src = fs.readFileSync(MODULO, 'utf8').slice(0, 6000);
    assert.match(src, /BYPASS AUDITADO/i);
    assert.match(src, /#5690/);
    assert.match(src, /servicio-github/);
});

// =============================================================================
// C · Write-ahead log
// =============================================================================

test('C1 · el WAL se escribe en modo append: el contenido previo sobrevive a una segunda corrida', () => {
    const dir = tmpDir();
    const wal = path.join(dir, 'a.jsonl');
    mig.appendWal(wal, { issue: 1, status: 'ok' });
    mig.appendWal(wal, { issue: 2, status: 'ok' });
    const registros = mig.leerWal(wal);
    assert.strictEqual(registros.length, 2, 'nada se pisó');
    const codigo = codigoSinComentarios();
    assert.match(codigo, /appendFileSync/);
    assert.doesNotMatch(codigo, /writeFileSync/, 'writeFileSync destruiría la reversibilidad');
});

test('C2 · el primer registro es el run-start con el candidate set congelado', async () => {
    const dir = tmpDir();
    const gh = crearGh({ issues: [issue(61, CANDIDATO), issue(62, CANDIDATO)] });
    const r = await mig.run({ ghRunner: gh, auditDir: dir, log: sinLog });
    const registros = mig.leerWal(r.walFile);
    assert.strictEqual(registros[0].tipo, 'run-start');
    assert.ok(registros[0].started_at, 'tiene started_at');
    const { candidateSet, startedAt } = mig.runStartDesdeWal(registros);
    assert.deepStrictEqual(candidateSet, [61, 62]);
    assert.ok(startedAt);
});

test('C3 · dos registros por mutación: intent antes de mutar, luego ok', async () => {
    const dir = tmpDir();
    const orden = [];
    const gh = crearGh({
        issues: [issue(71, CANDIDATO)],
        editResponder: (args) => { orden.push(`edit:${args[args.length - 1]}`); return { ok: true, stdout: '', stderr: '', status: 0 }; },
    });
    const { confirmFile, env } = conConfirmacion(dir);
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    const delIssue = mig.leerWal(r.walFile).filter((x) => x.issue === 71);
    assert.strictEqual(delIssue.length, 2);
    assert.strictEqual(delIssue[0].status, 'intent');
    assert.deepStrictEqual(delIssue[0].labels_antes, CANDIDATO);
    assert.ok(delIssue[0].labels_despues.includes(TRIAGE_BACKLOG_LABEL));
    assert.ok(!delIssue[0].labels_despues.includes(NEEDS_HUMAN_LABEL));
    assert.strictEqual(delIssue[1].status, 'ok');
    // Orden fail-safe: primero agrega el destino, después remueve el gate.
    assert.deepStrictEqual(orden, [`edit:${TRIAGE_BACKLOG_LABEL}`, `edit:${NEEDS_HUMAN_LABEL}`]);
});

test('C4 · reanudación: la segunda pasada saltea los status ok de la corrida cortada', async () => {
    const dir = tmpDir();
    const cortada = path.join(dir, 'cortada.jsonl');
    mig.appendWal(cortada, { tipo: 'run-start', started_at: '2026-09-09T00:00:00Z', candidate_set: [81, 82], total: 2 });
    mig.appendWal(cortada, { issue: 81, labels_antes: CANDIDATO, labels_despues: [TIPO_RECOMENDACION_LABEL, TRIAGE_BACKLOG_LABEL], authorized_by: 'migracion-5678', status: 'intent' });
    mig.appendWal(cortada, { issue: 81, status: 'ok' });

    const gh = crearGh({ issues: [issue(81, CANDIDATO), issue(82, CANDIDATO)] });
    const { confirmFile, env } = conConfirmacion(dir);
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, resumeFrom: cortada, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r.reanudados, 1, 'el 81 no se vuelve a tocar');
    assert.strictEqual(r.ok, 1, 'sólo se procesa el 82');
    const editados = gh.calls.filter((c) => c[1] === 'edit').map((c) => Number(c[2]));
    assert.ok(!editados.includes(81));
    assert.ok(editados.includes(82));
});

test('C5 · reversión: a partir de labels_antes de los ok se reconstruye el estado previo', async () => {
    const dir = tmpDir();
    const wal = path.join(dir, 'r.jsonl');
    mig.appendWal(wal, { issue: 91, labels_antes: [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL], labels_despues: [TIPO_RECOMENDACION_LABEL, TRIAGE_BACKLOG_LABEL], authorized_by: 'migracion-5678', status: 'intent' });
    mig.appendWal(wal, { issue: 91, status: 'ok' });
    mig.appendWal(wal, { issue: 92, labels_antes: [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL], labels_despues: [], authorized_by: 'migracion-5678', status: 'intent' });
    mig.appendWal(wal, { issue: 92, status: 'error', msg: 'boom' });

    const gh = crearGh({});
    const r = await mig.revertirDesdeWal({ walFile: wal, ghRunner: gh, apply: true, sleep: sleepInstantaneo });
    assert.deepStrictEqual(r.revertidos, [91], 'sólo se revierte lo que salió ok');
    const edits = gh.calls.filter((c) => c[1] === 'edit');
    assert.ok(edits.some((c) => c.includes('--add-label') && c.includes(NEEDS_HUMAN_LABEL)), 'repone needs-human');
    assert.ok(edits.some((c) => c.includes('--remove-label') && c.includes(TRIAGE_BACKLOG_LABEL)), 'saca el label agregado');
});

// =============================================================================
// D · Controles de regresión
// =============================================================================

test('D1 · un issue con needs-human SIN tipo:recomendacion no es tocado por el migrador', async () => {
    const dir = tmpDir();
    // El bloqueo real llega en el listado (query hipotéticamente malformada del
    // lado del servidor): el migrador debe abortar antes que mutarlo.
    const ghConBloqueo = crearGh({ issues: [issue(101, CANDIDATO), issue(102, [NEEDS_HUMAN_LABEL, 'bug'])] });
    await assert.rejects(() => mig.run({ ghRunner: ghConBloqueo, auditDir: dir, log: sinLog }), AbortoMigracion);
    assert.strictEqual(ghConBloqueo.calls.filter((c) => c[1] === 'edit').length, 0);

    // Y si nunca entra al listado, el predicado igual lo excluye.
    assert.strictEqual(mig.esCandidato([NEEDS_HUMAN_LABEL, 'bug']), false);

    // Corrida limpia con el bloqueo real fuera del set: conserva needs-human.
    const gh = crearGh({ issues: [issue(101, CANDIDATO)] });
    const { confirmFile, env } = conConfirmacion(dir);
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r.ok, 1);
    const tocados = gh.calls.filter((c) => c[1] === 'edit').map((c) => Number(c[2]));
    assert.ok(!tocados.includes(102), 'el bloqueo real nunca se toca');
});

test('D3 · la alerta de pérdida del gate no grita en la corrida exitosa, pero sí ante una desaparición', () => {
    // Rama 1 — lista previa vacía: 0 es el resultado esperado, NO se alerta.
    const sinBloqueos = mig.detectarPerdidaDeGate({ listaPrevia: [], canario: null, conNeedsHumanDespues: [] });
    assert.strictEqual(sinBloqueos.alerta, false);

    // Rama 2 — un elemento de la lista previa perdió needs-human: se alerta.
    const perdido = mig.detectarPerdidaDeGate({ listaPrevia: [500, 501], conNeedsHumanDespues: [500] });
    assert.strictEqual(perdido.alerta, true);
    assert.deepStrictEqual(perdido.desaparecidos, [501]);

    // Rama 3 — el canario cuenta como elemento de la lista.
    assert.strictEqual(mig.detectarPerdidaDeGate({ listaPrevia: [], canario: 777, conNeedsHumanDespues: [777] }).alerta, false);
    assert.strictEqual(mig.detectarPerdidaDeGate({ listaPrevia: [], canario: 777, conNeedsHumanDespues: [] }).alerta, true);
});

test('D5 · idempotencia: la segunda corrida sobre el candidate set congelado produce 0 mutaciones', async () => {
    const dir = tmpDir();
    const { confirmFile, env } = conConfirmacion(dir);
    const gh1 = crearGh({ issues: [issue(111, CANDIDATO), issue(112, CANDIDATO)] });
    const r1 = await mig.run({ apply: true, ghRunner: gh1, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r1.ok, 2);

    // Segunda corrida: los issues ya migrados salieron del candidate set.
    const gh2 = crearGh({ issues: [] });
    const r2 = await mig.run({ apply: true, ghRunner: gh2, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r2.total, 0);
    assert.strictEqual(gh2.calls.filter((c) => c[1] === 'edit').length, 0, 'cero mutaciones');

    // Y si el listado devolviera lo mismo, la re-lectura TOCTOU los saltea.
    const gh3 = crearGh({
        issues: [issue(111, CANDIDATO)],
        labelsAlReleer: { 111: [TIPO_RECOMENDACION_LABEL, TRIAGE_BACKLOG_LABEL] },
    });
    const r3 = await mig.run({ apply: true, ghRunner: gh3, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r3.ok, 0);
    assert.strictEqual(r3.skipped, 1);
});

test('D6 · el dry-run lista aparte los candidatos con labels de flujo del pipeline', async () => {
    const dir = tmpDir();
    const lineas = [];
    const gh = crearGh({
        issues: [issue(121, CANDIDATO), issue(122, [...CANDIDATO, 'bug', 'needs-definition'])],
    });
    const r = await mig.run({ ghRunner: gh, auditDir: dir, log: (s) => lineas.push(String(s)) });
    assert.deepStrictEqual(r.noRecomendacion, [122]);
    assert.ok(lineas.some((l) => l.includes('#122')), 'el operador lo ve en el output del dry-run');
    assert.strictEqual(mig.esCandidatoNoRecomendacion(CANDIDATO), false);
});

// =============================================================================
// Higiene del propio módulo
// =============================================================================

test('G · --repo se valida contra owner/name y el token no se acepta por argv', () => {
    assert.match('intrale/platform', mig.REPO_RE);
    assert.doesNotMatch('intrale/platform;rm -rf /', mig.REPO_RE);
    assert.doesNotMatch('--token=x', mig.REPO_RE);
    const src = fs.readFileSync(MODULO, 'utf8');
    assert.match(src, /--token/, 'el CLI rechaza --token explícitamente');
});

test('G · parseJsonArrays soporta un array único y varios arrays concatenados', () => {
    assert.deepStrictEqual(mig.parseJsonArrays('[{"number":1}]').length, 1);
    assert.deepStrictEqual(mig.parseJsonArrays('[{"number":1}][{"number":2}]').map((x) => x.number), [1, 2]);
    assert.deepStrictEqual(mig.parseJsonArrays('[{"title":"con ] adentro"}]')[0].title, 'con ] adentro');
    assert.deepStrictEqual(mig.parseJsonArrays(''), []);
});

test('G · el label destino se verifica al arranque y su ausencia aborta', async () => {
    const dir = tmpDir();
    const gh = crearGh({ issues: [issue(131, CANDIDATO)], labelExiste: false });
    const { confirmFile, env } = conConfirmacion(dir);
    await assert.rejects(
        () => mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'label-destino-inexistente',
    );
});
