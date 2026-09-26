// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

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
 *
 * Es STATEFUL: cada `issue edit --add-label/--remove-label` que responde OK
 * muta los labels del issue en memoria, así el listado posterior de
 * `needs-human` (control R6 / D3) refleja lo que la corrida hizo.
 *
 * - El listado del CANDIDATE SET (`labels=needs-human,tipo:recomendacion`)
 *   devuelve `issues` TAL CUAL: modela "lo que el servidor contesta", incluso
 *   una query malformada (A4 / D1).
 * - El listado de `needs-human` a secas (R6) filtra por el label real en
 *   memoria: es lo que el control necesita para detectar una desaparición.
 * - `perderNeedsHumanAlFinal`: números a los que el fake les "arranca"
 *   `needs-human` recién en la relectura posterior (sabotaje del gate).
 * - `fallarListado`: 'previo' | 'posterior' hace fallar ese listado de
 *   `needs-human` (gate no verificable).
 */
function crearGh({
    issues = [],
    paginas = null,
    totalSearch = null,
    labelExiste = true,
    labelsAlReleer = null,
    editResponder = null,
    perderNeedsHumanAlFinal = [],
    fallarListado = null,
} = {}) {
    const calls = [];
    const estado = new Map();
    for (const it of (paginas ? paginas.flat() : issues)) {
        estado.set(Number(it.number), { ...it, labels: (it.labels || []).map((l) => (typeof l === 'string' ? l : l.name)) });
    }
    const labelsDe = (num) => (estado.get(Number(num)) || { labels: [] }).labels;
    let listadosNeedsHuman = 0;

    const runner = (args) => {
        calls.push(args.slice());
        const [c0, c1] = args;

        if (c0 === 'api' && c1 === '--paginate') {
            const labelsParam = decodeURIComponent((String(args[2]).match(/labels=([^&]+)/) || [])[1] || '');
            if (labelsParam === NEEDS_HUMAN_LABEL) {
                listadosNeedsHuman++;
                const cual = listadosNeedsHuman === 1 ? 'previo' : 'posterior';
                if (fallarListado === cual) return { ok: false, stdout: '', stderr: 'HTTP 502', status: 1 };
                const conNh = [...estado.values()]
                    .filter((it) => it.labels.includes(NEEDS_HUMAN_LABEL))
                    .filter((it) => !(cual === 'posterior' && perderNeedsHumanAlFinal.includes(Number(it.number))))
                    .map((it) => ({ ...it, labels: it.labels.map((name) => ({ name })) }));
                return { ok: true, stdout: JSON.stringify(conNh), stderr: '', status: 0 };
            }
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
            const labels = labelsAlReleer ? (labelsAlReleer[num] || []) : labelsDe(num);
            return { ok: true, stdout: JSON.stringify({ labels: labels.map((n) => ({ name: n })) }), stderr: '', status: 0 };
        }
        if (c0 === 'issue' && c1 === 'edit') {
            const r = editResponder ? editResponder(args, calls) : { ok: true, stdout: '', stderr: '', status: 0 };
            if (r.ok) {
                const num = Number(args[2]);
                if (!estado.has(num)) estado.set(num, { number: num, title: '', labels: [] });
                const it = estado.get(num);
                const iAdd = args.indexOf('--add-label');
                const iRem = args.indexOf('--remove-label');
                if (iAdd >= 0 && !it.labels.includes(args[iAdd + 1])) it.labels.push(args[iAdd + 1]);
                if (iRem >= 0) it.labels = it.labels.filter((l) => l !== args[iRem + 1]);
            }
            return r;
        }
        return { ok: true, stdout: '', stderr: '', status: 0 };
    };
    runner.calls = calls;
    runner.labelsDe = labelsDe;
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

/**
 * WAL de una corrida "previa" para probar la reversión: en el directorio de
 * auditoría, con el nombre del módulo y con `run-start` del repo. Cada entrada
 * `[numero, labelsAntes, status]` genera su `intent` + su registro final.
 */
function walDeCorrida(dir, entradas, { repo = 'intrale/platform', nombre = 'migrate-5678-2026-09-14T10-00-00-000Z.jsonl' } = {}) {
    const wal = path.join(dir, nombre);
    mig.appendWal(wal, { tipo: 'run-start', started_at: '2026-09-14T10:00:00.000Z', candidate_set: entradas.map((e) => e[0]), total: entradas.length, repo, apply: true });
    for (const [numero, labelsAntes, status = 'ok'] of entradas) {
        mig.appendWal(wal, { issue: numero, labels_antes: labelsAntes, labels_despues: labelsAntes.filter((l) => l !== NEEDS_HUMAN_LABEL).concat([TRIAGE_BACKLOG_LABEL]), authorized_by: 'migracion-5678', status: 'intent' });
        mig.appendWal(wal, status === 'ok' ? { issue: numero, status: 'ok' } : { issue: numero, status, msg: 'boom' });
    }
    return wal;
}

/** Estado post-migración de un issue: sin needs-human, con triage. */
const MIGRADO = [TIPO_RECOMENDACION_LABEL, TRIAGE_BACKLOG_LABEL];
const edits = (gh) => gh.calls.filter((c) => c[0] === 'issue' && c[1] === 'edit');

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

    // Reversión con un nombre de label hostil que contiene una coma. El WAL es
    // legítimo (su `labels_antes` satisface el predicado del candidate set) y
    // un humano ya repuso la mezcla sensible a mano: queda por reponer el
    // label con coma y sacar el de triaje (ver C5/C5b para el guardrail).
    const wal = walDeCorrida(dir, [[42, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, 'area:x,prio:alta']]]);
    const gh2 = crearGh({ issues: [issue(42, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, TRIAGE_BACKLOG_LABEL])] });
    const rev = await mig.revertirDesdeWal({ walFile: wal, ghRunner: gh2, apply: true, auditDir: dir, confirmFile, env, sleep: sleepInstantaneo, log: sinLog });
    assert.deepStrictEqual(rev.revertidos, [42]);
    const usados = edits(gh2).map((c) => c[c.length - 1]);
    assert.ok(usados.includes('area:x,prio:alta'), 'el label con coma va entero en UN flag');
    assert.strictEqual(usados.filter((v) => v.includes('needs-human,')).length, 0, 'jamás un join(",")');
    for (const c of edits(gh2)) {
        assert.strictEqual(c.filter((a) => a === '--add-label' || a === '--remove-label').length, 1, 'un label por invocación');
    }
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

test('A9b · PoC de security (A01): el invocador fabrica su propio archivo y lo apunta por MIGRATE_5678_CONFIRM_FILE → --apply falla cerrado', async () => {
    // Reproduce el PoC del rechazo del 2026-09-09: quien puede exportar
    // variables también puede escribir un archivo y proveer los DOS lados de
    // la comparación. Ese origen tiene que ser ignorado por completo.
    const dir = tmpDir();
    const propio = path.join(dir, 'confirm-autogenerado.txt');
    fs.writeFileSync(propio, 'secreto-que-elegi-yo\n', 'utf8');
    const envHostil = { MIGRATE_5678_CONFIRM: 'secreto-que-elegi-yo', MIGRATE_5678_CONFIRM_FILE: propio };

    // La función, contra la ruta FIJA del módulo (sin costura de test).
    const v = mig.verificarConfirmacion({ env: envHostil });
    assert.strictEqual(v.ok, false, `el archivo elegido por el invocador NO puede validar (motivo: ${v.motivo})`);
    assert.notStrictEqual(v.motivo, 'confirmacion-valida');

    // Y de punta a punta: `run()` con ese entorno, sin `confirmFile` inyectado,
    // igual que lo haría el CLI. Cero mutaciones.
    const gh = crearGh({ issues: [issue(9001, CANDIDATO)] });
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, env: envHostil, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r.apply, false, 'degradó a dry-run');
    assert.strictEqual(r.ok, 0);
    assert.strictEqual(edits(gh).length, 0, 'CERO mutaciones — el PoC ya no pasa');

    // Aun con la costura de test apuntando a un archivo válido, la variable
    // hostil NO puede redirigir la comparación a otro archivo.
    const { confirmFile } = conConfirmacion(dir, 'token-legitimo');
    const redirigido = mig.verificarConfirmacion({ env: { MIGRATE_5678_CONFIRM: 'secreto-que-elegi-yo', MIGRATE_5678_CONFIRM_FILE: propio }, confirmFile });
    assert.strictEqual(redirigido.ok, false, 'la variable de entorno no redirige el origen del secreto');
    assert.strictEqual(redirigido.motivo, 'confirmacion-no-coincide');
});

test('A9c · la ubicación del secreto la resuelve el SO, nunca el entorno: ni MIGRATE_5678_CONFIRM_FILE ni HOME/USERPROFILE', () => {
    // 1) Fuente: la variable no existe en el código y no se usa `os.homedir()`
    //    (que lee HOME/USERPROFILE antes que al SO). Si alguien relaja el gate
    //    reintroduciendo cualquiera de las dos, este test cae.
    const codigo = codigoSinComentarios();
    assert.doesNotMatch(codigo, /MIGRATE_5678_CONFIRM_FILE/, 'el override por env fue eliminado');
    assert.doesNotMatch(codigo, /os\.homedir\s*\(/, 'os.homedir() deriva de HOME/USERPROFILE');
    assert.match(codigo, /os\.userInfo\(\)\.homedir/, 'el home lo resuelve el SO');
    assert.ok(mig.CONFIRM_FILE_DEFAULT === null || mig.CONFIRM_FILE_DEFAULT.endsWith(mig.CONFIRM_FILE_NAME));

    // 2) Empírico: un proceso hijo con HOME y USERPROFILE redirigidos a un
    //    directorio del invocador que SÍ contiene el archivo con el secreto, y
    //    MIGRATE_5678_CONFIRM con ese mismo valor. La ruta por default NO puede
    //    caer ahí y la confirmación NO puede validar.
    const { spawnSync } = require('child_process');
    const homeFalso = tmpDir();
    fs.mkdirSync(path.join(homeFalso, '.claude', 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(homeFalso, '.claude', 'secrets', mig.CONFIRM_FILE_NAME), 'mio\n', 'utf8');
    const script = `
        const m = require(${JSON.stringify(MODULO)});
        const v = m.verificarConfirmacion({ env: { MIGRATE_5678_CONFIRM: 'mio' } });
        process.stdout.write(JSON.stringify({ file: m.CONFIRM_FILE_DEFAULT, ok: v.ok, motivo: v.motivo }));
    `;
    const hijo = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, HOME: homeFalso, USERPROFILE: homeFalso, MIGRATE_5678_CONFIRM: 'mio' },
    });
    assert.strictEqual(hijo.status, 0, hijo.stderr);
    const out = JSON.parse(hijo.stdout);
    const homeFalsoReal = fs.realpathSync(homeFalso);
    const relAlHomeFalso = out.file ? path.relative(homeFalsoReal, path.resolve(out.file)) : '..';
    assert.ok(relAlHomeFalso.startsWith('..') || path.isAbsolute(relAlHomeFalso), `la ruta por default NO sigue a HOME/USERPROFILE: ${out.file}`);
    assert.strictEqual(out.ok, false, `con el home redirigido la confirmación NO valida (motivo: ${out.motivo})`);
});

test('A9d · el secreto no puede vivir dentro del árbol del repo', () => {
    // Un archivo dentro del checkout lo puede leer (y escribir) cualquier
    // agente: aunque la ruta fuese fija, no sería "fuera de banda".
    const dentro = path.join(__dirname, '..', 'audit', `tmp-confirm-${process.pid}.txt`);
    fs.mkdirSync(path.dirname(dentro), { recursive: true });
    fs.writeFileSync(dentro, 'x\n', 'utf8');
    try {
        const v = mig.verificarConfirmacion({ env: { MIGRATE_5678_CONFIRM: 'x' }, confirmFile: dentro });
        assert.strictEqual(v.ok, false);
        assert.strictEqual(v.motivo, 'secreto-dentro-del-repo');
    } finally {
        fs.rmSync(dentro, { force: true });
    }
    // Y sin home resoluble no hay dónde leer: fail-closed.
    assert.strictEqual(mig.verificarConfirmacion({ env: { MIGRATE_5678_CONFIRM: 'x' }, confirmFile: null }).motivo, 'home-del-so-indeterminable');
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

test('C5 · reversión: a partir de labels_antes de los ok se reconstruye el estado previo, con confirmación y guardrail', async () => {
    const dir = tmpDir();
    const wal = walDeCorrida(dir, [
        [91, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL], 'ok'],
        [92, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL], 'error'],
    ]);
    const { confirmFile, env } = conConfirmacion(dir);

    // Dry-run: el plan sale de `labels_antes` de los `ok`, y sólo de esos.
    const ghDry = crearGh({ issues: [issue(91, MIGRADO), issue(92, MIGRADO)] });
    const plan = await mig.revertirDesdeWal({ walFile: wal, ghRunner: ghDry, apply: false, auditDir: dir, sleep: sleepInstantaneo, log: sinLog });
    assert.strictEqual(edits(ghDry).length, 0);
    const intents = mig.leerWal(plan.walFile).filter((x) => x.status === 'intent');
    assert.deepStrictEqual(intents.map((x) => x.issue), [91], 'el 92 salió error: no se planifica');
    assert.deepStrictEqual(intents[0].labels_a_reponer, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL], 'reconstruye el estado previo desde labels_antes');
    assert.strictEqual(intents[0].remover_triage, true);

    // Apply: un humano ya repuso la mezcla sensible a mano (única forma bajo
    // #5690, ver C5b); la reversión completa el estado previo: saca
    // `needs:triage-backlog`, un label por flag, con procedencia declarada.
    const gh = crearGh({ issues: [issue(91, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, TRIAGE_BACKLOG_LABEL]), issue(92, MIGRADO)] });
    const r = await mig.revertirDesdeWal({ walFile: wal, ghRunner: gh, apply: true, auditDir: dir, confirmFile, env, sleep: sleepInstantaneo, log: sinLog });
    assert.strictEqual(r.apply, true);
    assert.deepStrictEqual(r.revertidos, [91], 'sólo se revierte lo que salió ok');
    assert.ok(edits(gh).some((c) => c.includes('--remove-label') && c.includes(TRIAGE_BACKLOG_LABEL)), 'saca el label agregado');
    assert.ok(!edits(gh).some((c) => Number(c[2]) === 92), 'el que salió error no se toca');
    assert.deepStrictEqual(gh.labelsDe(91).sort(), [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL].sort(), 'estado previo reconstruido');

    // La reversión deja su propio WAL, con procedencia por issue.
    const regs = mig.leerWal(r.walFile);
    assert.strictEqual(regs[0].tipo, 'revert-start');
    assert.strictEqual(regs[0].repo, 'intrale/platform');
    const intent = regs.find((x) => x.status === 'intent' && x.issue === 91);
    assert.strictEqual(intent.authorized_by, mig.AUTHORIZED_BY_REVERT);
    assert.deepStrictEqual(intent.autorizaciones, { [`remove-label:${TRIAGE_BACKLOG_LABEL}`]: mig.AUTHORIZED_BY_REVERT });
    assert.ok(regs.some((x) => x.issue === 91 && x.status === 'ok'));
    assert.strictEqual(regs[regs.length - 1].tipo, 'revert-end');
});

test('C5b · el guardrail de #5690 gobierna la reversión: reponer la mezcla legacy es rechazado en cualquier orden y aborta ANTES de escribir', async () => {
    const dir = tmpDir();
    const { confirmFile, env } = conConfirmacion(dir);
    const antes = [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL];

    // (a) El issue conserva `tipo:recomendacion` (estado post-migración real):
    //     reponer `needs-human` es mezcla-needs-human-sobre-recomendacion.
    const walA = walDeCorrida(dir, [[93, antes], [94, antes]]);
    const ghA = crearGh({ issues: [issue(93, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, TRIAGE_BACKLOG_LABEL]), issue(94, MIGRADO)] });
    await assert.rejects(
        () => mig.revertirDesdeWal({ walFile: walA, ghRunner: ghA, apply: true, auditDir: dir, confirmFile, env, sleep: sleepInstantaneo, log: sinLog }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'guardrail-rechazo-la-reversion' && /#94 label needs-human: mezcla-needs-human-sobre-recomendacion/.test(e.detalle),
    );
    // Preflight sobre TODOS los issues antes de la primera escritura: el 93,
    // que sí estaba permitido, tampoco se tocó.
    assert.strictEqual(edits(ghA).length, 0, 'cero escrituras — el rechazo del 94 frena la reversión entera');

    // (b) El issue quedó limpio de ambos: `needs-human` pasa sobre la foto,
    //     pero `tipo:recomendacion` se evalúa sobre el estado SIMULADO (ya con
    //     needs-human) y cae. El orden de aplicación no esquiva al guardrail.
    const walB = walDeCorrida(dir, [[95, antes]], { nombre: 'migrate-5678-b.jsonl' });
    const ghB = crearGh({ issues: [issue(95, [TRIAGE_BACKLOG_LABEL])] });
    await assert.rejects(
        () => mig.revertirDesdeWal({ walFile: walB, ghRunner: ghB, apply: true, auditDir: dir, confirmFile, env, sleep: sleepInstantaneo, log: sinLog }),
        (e) => e instanceof AbortoMigracion && /#95 label tipo:recomendacion: mezcla-recomendacion-sobre-needs-human/.test(e.detalle),
    );
    assert.strictEqual(edits(ghB).length, 0);
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

test('D3b · la alerta está CABLEADA en run(): captura la lista previa, la congela en el run-start y la verifica al cerrar', async () => {
    // Hallazgo 3 de security (A09): `detectarPerdidaDeGate` sólo tenía
    // consumidores en los tests. Acá se ejercita sobre la corrida completa.
    assert.match(codigoSinComentarios(), /detectarPerdidaDeGate\(\{\s*listaPrevia/, 'run() invoca al detector');

    // Corrida sana: el bloqueo real 102 conserva needs-human → no alerta,
    // y el registro gate-check queda persistido ANTES del run-end.
    const dir = tmpDir();
    const gh = crearGh({ issues: [issue(101, CANDIDATO)] });
    // El bloqueo real no entra al listado de candidatos (labels distintos),
    // pero sí al de needs-human: se lo agrega al estado del fake por un edit.
    gh(['issue', 'edit', '102', '--repo', 'intrale/platform', '--add-label', NEEDS_HUMAN_LABEL]);
    gh(['issue', 'edit', '102', '--repo', 'intrale/platform', '--add-label', 'bug']);
    gh.calls.length = 0;
    const { confirmFile, env } = conConfirmacion(dir);
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r.ok, 1);
    assert.deepStrictEqual(r.gateCheck, { alerta: false, desaparecidos: [], motivo: 'todos-los-bloqueos-reales-conservan-needs-human' });
    const regs = mig.leerWal(r.walFile);
    assert.deepStrictEqual(regs[0].bloqueos_reales_previos, [102], 'la lista previa queda congelada en el run-start');
    const iCheck = regs.findIndex((x) => x.tipo === 'gate-check');
    const iEnd = regs.findIndex((x) => x.tipo === 'run-end');
    assert.ok(iCheck > 0 && iCheck < iEnd, 'gate-check persistido antes del run-end');
    assert.strictEqual(regs[iCheck].alerta, false);
    assert.strictEqual(mig.codigoDeSalida(r), 0);

    // Lista previa vacía: el 0 post-migración es lo esperado, NO alerta.
    const dir2 = tmpDir();
    const gh2 = crearGh({ issues: [issue(111, CANDIDATO)] });
    const c2 = conConfirmacion(dir2);
    const r2 = await mig.run({ apply: true, ghRunner: gh2, auditDir: dir2, confirmFile: c2.confirmFile, env: c2.env, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r2.gateCheck.alerta, false);
    assert.strictEqual(r2.gateCheck.motivo, 'lista-previa-vacia-cero-es-lo-esperado');
    assert.strictEqual(mig.codigoDeSalida(r2), 0);
});

test('D3c · un bloqueo real que pierde needs-human durante la corrida dispara la alerta, queda en el WAL y el código de salida es 2', async () => {
    const dir = tmpDir();
    const gh = crearGh({ issues: [issue(121, CANDIDATO)], perderNeedsHumanAlFinal: [122] });
    gh(['issue', 'edit', '122', '--repo', 'intrale/platform', '--add-label', NEEDS_HUMAN_LABEL]);
    gh.calls.length = 0;
    const { confirmFile, env } = conConfirmacion(dir);
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r.gateCheck.alerta, true);
    assert.deepStrictEqual(r.gateCheck.desaparecidos, [122]);
    assert.strictEqual(r.gateCheck.motivo, 'perdida-del-gate-humano');
    const check = mig.leerWal(r.walFile).find((x) => x.tipo === 'gate-check');
    assert.strictEqual(check.alerta, true);
    assert.deepStrictEqual(check.desaparecidos, [122]);
    assert.strictEqual(mig.codigoDeSalida(r), 2, 'una alerta nunca sale en 0');

    // Y si la relectura posterior falla, el gate queda NO verificable: tampoco 0.
    const dir2 = tmpDir();
    const gh2 = crearGh({ issues: [issue(131, CANDIDATO)], fallarListado: 'posterior' });
    const c2 = conConfirmacion(dir2);
    const r2 = await mig.run({ apply: true, ghRunner: gh2, auditDir: dir2, confirmFile: c2.confirmFile, env: c2.env, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r2.gateCheck.alerta, null);
    assert.strictEqual(mig.codigoDeSalida(r2), 2);
    assert.strictEqual(mig.codigoDeSalida({}), 2, 'sin gate-check tampoco es 0');

    // Sin lista previa no hay control: no se muta.
    const gh3 = crearGh({ issues: [issue(141, CANDIDATO)], fallarListado: 'previo' });
    await assert.rejects(
        () => mig.run({ apply: true, ghRunner: gh3, auditDir: tmpDir(), confirmFile, env, log: sinLog, sleep: sleepInstantaneo }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'bloqueos-reales-no-listables',
    );
    assert.strictEqual(edits(gh3).length, 0);
});

test('D2/D3d · el canario (--canario N) se verifica antes y después: ausente o candidato → aborto; perdido → alerta', async () => {
    const dir = tmpDir();
    const { confirmFile, env } = conConfirmacion(dir);
    const base = () => {
        const gh = crearGh({ issues: [issue(151, CANDIDATO)] });
        gh(['issue', 'edit', '777', '--repo', 'intrale/platform', '--add-label', NEEDS_HUMAN_LABEL]);
        gh.calls.length = 0;
        return gh;
    };

    // Canario sano: sigue con needs-human → no alerta y queda en el run-start.
    const gh = base();
    const r = await mig.run({ apply: true, ghRunner: gh, auditDir: dir, confirmFile, env, canario: 777, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(r.gateCheck.alerta, false);
    assert.strictEqual(mig.leerWal(r.walFile)[0].canario, 777);

    // Canario que NO tiene needs-human antes de la corrida: no probaría nada → aborto.
    const ghSin = crearGh({ issues: [issue(151, CANDIDATO)] });
    await assert.rejects(
        () => mig.run({ apply: true, ghRunner: ghSin, auditDir: dir, confirmFile, env, canario: 777, log: sinLog, sleep: sleepInstantaneo }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'canario-sin-needs-human',
    );
    assert.strictEqual(edits(ghSin).length, 0);

    // Canario que es candidato: lo migraríamos nosotros → aborto.
    await assert.rejects(
        () => mig.run({ apply: true, ghRunner: base(), auditDir: dir, confirmFile, env, canario: 151, log: sinLog, sleep: sleepInstantaneo }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'canario-es-candidato',
    );
    await assert.rejects(
        () => mig.run({ ghRunner: base(), auditDir: dir, canario: 'abc', log: sinLog }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'canario-invalido',
    );

    // Canario que pierde needs-human durante la corrida → alerta.
    const ghPerdido = crearGh({ issues: [issue(151, CANDIDATO)], perderNeedsHumanAlFinal: [777] });
    ghPerdido(['issue', 'edit', '777', '--repo', 'intrale/platform', '--add-label', NEEDS_HUMAN_LABEL]);
    const rp = await mig.run({ apply: true, ghRunner: ghPerdido, auditDir: dir, confirmFile, env, canario: 777, log: sinLog, sleep: sleepInstantaneo });
    assert.strictEqual(rp.gateCheck.alerta, true);
    assert.deepStrictEqual(rp.gateCheck.desaparecidos, [777]);
});

// =============================================================================
// R · Reversión — mismos tres controles que la migración (hallazgo 2 de
//     security, A01: `--revert --apply` escribía sin confirmación, sin
//     guardrail y sin validar --repo, desde un WAL fabricable)
// =============================================================================

test('R1 · --revert --apply sin la confirmación fuera de banda degrada a dry-run: cero mutaciones', async () => {
    const dir = tmpDir();
    const wal = walDeCorrida(dir, [[201, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL]]]);
    const gh = crearGh({ issues: [issue(201, [TRIAGE_BACKLOG_LABEL])] });
    const r = await mig.revertirDesdeWal({ walFile: wal, ghRunner: gh, apply: true, auditDir: dir, env: {}, confirmFile: path.join(dir, 'no-existe.txt'), sleep: sleepInstantaneo, log: sinLog });
    assert.strictEqual(r.apply, false, 'degradó a dry-run');
    assert.strictEqual(r.degradado, 'falta-env-MIGRATE_5678_CONFIRM');
    assert.strictEqual(edits(gh).length, 0, 'CERO mutaciones');
    assert.ok(mig.leerWal(r.walFile).some((x) => x.status === 'skipped' && x.motivo === 'dry-run'));

    // Y el PoC del rechazo: archivo autogenerado + MIGRATE_5678_CONFIRM_FILE.
    const propio = path.join(dir, 'mio.txt');
    fs.writeFileSync(propio, 'mio\n');
    const gh2 = crearGh({ issues: [issue(201, [TRIAGE_BACKLOG_LABEL])] });
    const r2 = await mig.revertirDesdeWal({ walFile: wal, ghRunner: gh2, apply: true, auditDir: dir, env: { MIGRATE_5678_CONFIRM: 'mio', MIGRATE_5678_CONFIRM_FILE: propio }, sleep: sleepInstantaneo, log: sinLog });
    assert.strictEqual(r2.apply, false);
    assert.strictEqual(edits(gh2).length, 0);
});

test('R2 · PoC de security: un WAL fabricado con recommendation:approved en labels_antes aborta la reversión entera', async () => {
    const dir = tmpDir();
    const { confirmFile, env } = conConfirmacion(dir);
    // El predicado del candidate set EXCLUYE recommendation:approved: ningún
    // intent real puede tenerlo en labels_antes. Es fabricado.
    const wal = walDeCorrida(dir, [
        [7001, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, RECOMMENDATION_APPROVED_LABEL]],
        [7002, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, RECOMMENDATION_APPROVED_LABEL]],
    ]);
    const gh = crearGh({ issues: [issue(7001, [TRIAGE_BACKLOG_LABEL]), issue(7002, [TRIAGE_BACKLOG_LABEL])] });
    await assert.rejects(
        () => mig.revertirDesdeWal({ walFile: wal, ghRunner: gh, apply: true, auditDir: dir, confirmFile, env, sleep: sleepInstantaneo, log: sinLog }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'wal-inconsistente-labels-antes-fuera-del-candidate-set',
    );
    assert.strictEqual(edits(gh).length, 0, 'recommendation:approved jamás se escribe desde acá');

    // Lo mismo con labels_antes que no son del candidate set (sin tipo:recomendacion):
    // el atacante intenta reponer needs-human + blocked:routing-manual.
    const wal2 = walDeCorrida(dir, [[1234, [NEEDS_HUMAN_LABEL, 'blocked:routing-manual']]], { nombre: 'migrate-5678-2026-09-14T11-00-00-000Z.jsonl' });
    const gh2 = crearGh({ issues: [issue(1234, [])] });
    await assert.rejects(
        () => mig.revertirDesdeWal({ walFile: wal2, ghRunner: gh2, apply: true, auditDir: dir, confirmFile, env, sleep: sleepInstantaneo, log: sinLog }),
        (e) => e instanceof AbortoMigracion && e.motivo === 'wal-inconsistente-labels-antes-fuera-del-candidate-set',
    );
    assert.strictEqual(edits(gh2).length, 0);
});

test('R3 · el WAL no es entrada confiable: sólo bajo el directorio de auditoría, con nombre del módulo, con run-start y del mismo repo', async () => {
    const dir = tmpDir();
    const { confirmFile, env } = conConfirmacion(dir);
    const base = { ghRunner: crearGh({}), apply: true, auditDir: dir, confirmFile, env, sleep: sleepInstantaneo, log: sinLog };
    const entradas = [[301, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL]]];

    // Fuera del directorio de auditoría (path arbitrario de argv).
    const otroDir = tmpDir();
    const fuera = walDeCorrida(otroDir, entradas);
    await assert.rejects(() => mig.revertirDesdeWal({ ...base, walFile: fuera }), (e) => e.motivo === 'wal-fuera-del-directorio-de-auditoria');
    // Subdirectorio del de auditoría tampoco.
    fs.mkdirSync(path.join(dir, 'sub'));
    const sub = walDeCorrida(path.join(dir, 'sub'), entradas);
    await assert.rejects(() => mig.revertirDesdeWal({ ...base, walFile: sub }), (e) => e.motivo === 'wal-fuera-del-directorio-de-auditoria');
    // Nombre que no es de este módulo.
    const malNombre = walDeCorrida(dir, entradas, { nombre: 'cualquiera.jsonl' });
    await assert.rejects(() => mig.revertirDesdeWal({ ...base, walFile: malNombre }), (e) => e.motivo === 'wal-con-nombre-invalido');
    // El WAL de una reversión no se revierte con este camino.
    const deRevert = walDeCorrida(dir, entradas, { nombre: 'migrate-5678-revert-2026-09-14T10-00-00-000Z.jsonl' });
    await assert.rejects(() => mig.revertirDesdeWal({ ...base, walFile: deRevert }), (e) => e.motivo === 'wal-con-nombre-invalido');
    // Sin run-start.
    const sinHeader = path.join(dir, 'migrate-5678-sin-header.jsonl');
    mig.appendWal(sinHeader, { issue: 301, labels_antes: entradas[0][1], labels_despues: [], authorized_by: 'x', status: 'intent' });
    mig.appendWal(sinHeader, { issue: 301, status: 'ok' });
    await assert.rejects(() => mig.revertirDesdeWal({ ...base, walFile: sinHeader }), (e) => e.motivo === 'wal-sin-run-start');
    // De otro repo (el PoC apuntaba a `atacante/repo-ajeno`).
    const otroRepo = walDeCorrida(dir, entradas, { repo: 'atacante/repo-ajeno', nombre: 'migrate-5678-otro-repo.jsonl' });
    await assert.rejects(() => mig.revertirDesdeWal({ ...base, walFile: otroRepo }), (e) => e.motivo === 'wal-de-otro-repo');
    // --repo inválido también aborta en la reversión.
    const ok = walDeCorrida(dir, entradas, { nombre: 'migrate-5678-ok.jsonl' });
    await assert.rejects(() => mig.revertirDesdeWal({ ...base, walFile: ok, repo: 'atacante/repo;rm -rf' }), (e) => e.motivo === 'repo-invalido');
    assert.strictEqual(edits(base.ghRunner).length, 0, 'ninguna de las variantes escribió nada');
});

test('R4 · la reversión declara procedencia por cada label ante el guardrail y consulta los labels actuales (TOCTOU)', async () => {
    const dir = tmpDir();
    const { confirmFile, env } = conConfirmacion(dir);
    const guardrail = require('../lib/label-guardrail');
    const original = guardrail.evaluateLabelOrder;
    const consultas = [];
    guardrail.evaluateLabelOrder = (params) => { consultas.push(params); return original(params); };
    try {
        const wal = walDeCorrida(dir, [[401, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, 'area:pipeline', 'priority:high']]]);
        // Un humano repuso la mezcla sensible y `area:pipeline`; falta
        // `priority:high` y sobra el de triaje. Lo que ya está no se repone.
        const gh = crearGh({ issues: [issue(401, [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, TRIAGE_BACKLOG_LABEL, 'area:pipeline'])] });
        const r = await mig.revertirDesdeWal({ walFile: wal, ghRunner: gh, apply: true, auditDir: dir, confirmFile, env, sleep: sleepInstantaneo, log: sinLog });
        assert.deepStrictEqual(r.revertidos, [401]);
        const labelsConsultados = consultas.map((c) => `${c.action}:${c.label}`);
        assert.deepStrictEqual(labelsConsultados, [`remove-label:${TRIAGE_BACKLOG_LABEL}`, 'label:priority:high'], 'una consulta por label que se saca o se repone, en el orden de aplicación');
        for (const c of consultas) {
            assert.strictEqual(c.order.guardrail_authorized, true);
            assert.strictEqual(c.order.authorized_by, mig.AUTHORIZED_BY_REVERT);
            assert.strictEqual(typeof c.getCurrentLabels, 'function', 'consulta el estado ACTUAL del issue, no el del WAL');
            assert.ok(c.getCurrentLabels().includes(NEEDS_HUMAN_LABEL), 'el estado consultado es el releído del issue');
        }
        assert.ok(!edits(gh).some((c) => c.includes('area:pipeline')), 'lo que el issue ya tiene no se repone');
        assert.ok(!edits(gh).some((c) => c.includes('--add-label') && c.includes(NEEDS_HUMAN_LABEL)), 'needs-human ya estaba: no se toca');
        assert.ok(edits(gh).some((c) => c.includes('--add-label') && c.includes('priority:high')));
        assert.deepStrictEqual(gh.labelsDe(401).sort(), [NEEDS_HUMAN_LABEL, TIPO_RECOMENDACION_LABEL, 'area:pipeline', 'priority:high'].sort());

        // Y sin re-lectura posible, fail-closed: aborta.
        const ghSinLectura = crearGh({ issues: [issue(401, MIGRADO)] });
        const original2 = ghSinLectura;
        const runner = (args) => (args[0] === 'issue' && args[1] === 'view' ? { ok: false, stdout: '', stderr: 'HTTP 502', status: 1 } : original2(args));
        runner.calls = ghSinLectura.calls;
        await assert.rejects(
            () => mig.revertirDesdeWal({ walFile: wal, ghRunner: runner, apply: true, auditDir: dir, confirmFile, env, sleep: sleepInstantaneo, log: sinLog }),
            (e) => e instanceof AbortoMigracion && e.motivo === 'reversion-relectura-fallida',
        );
        assert.strictEqual(edits(ghSinLectura).length, 0);
    } finally {
        guardrail.evaluateLabelOrder = original;
    }
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
