'use strict';

// =============================================================================
// #6496 rev-3 — Guardianes del REBOTE DE `security` sobre el PR #6669 @ a915ef03.
//
// La auditoría confirmó que los 3 defectos de rev-2 quedaron cerrados, y encontró
// 6 defectos NUEVOS en el código de esa pasada. Un test por defecto: si el fix se
// revierte, acá se prende en rojo.
//
//   F1 [ALTA · A01/A04] `.pipeline/delivery.js` — el GATE 3 entero colgaba de
//        `if (args.issue)`: se desactivaba OMITIENDO UN FLAG. Sin `--issue`, con
//        `--issue ""` o con `--issue` como último argumento, el chequeo no corría
//        y el flujo seguía derecho al push y al `gh pr create`.
//   F2 [ALTA · A01] `skills-deterministicos/delivery.js` — el PR quedaba con
//        `qa:passed` sobre un HEAD que nadie verificó: la propagación al PR corría
//        en Fase 4 y el re-chequeo de frescura en Fase 5, y la rama caduca no
//        retractaba el label ya puesto.
//   F3 [MEDIA · A04] `freshness-gate.js` — la corroboración de `veredicto_caduco`
//        usaba sólo el contador, que no se consume ni expira: quedaba satisfecha
//        de antemano en toda la ventana entre la 1ª caducidad y el próximo push.
//   F4 [MEDIA · A04] el carril de exención de migración devolvía `shaVerificado
//        = null`, que apaga el push pinneado Y el pinneo de head del merge: el
//        carril con la verificación más débil era el único además sin anti-TOCTOU.
//   F5 [BAJA · A04] el early-exit "entrega previa" hacía `gh issue comment` y
//        `gh issue close` ANTES del gate (CA-15: "antes de todo contacto con el
//        remoto").
//   F6 [BAJA] CA-8: el contador se limpiaba con el PUSH y no con el merge, así
//        que el tope de 2 re-encolados se reiniciaba en ciclos push-sin-merge.
//        (Guardián en la suite `...-entrega-6496`, junto al harness que pushea.)
//
// Ningún test escribe en GitHub: todo va contra directorios de `os.tmpdir()`.
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const seal = require('../qa-evidence-seal');
const freshnessGate = require('../delivery/freshness-gate');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_DELIVERY = path.join(REPO_ROOT, '.pipeline', 'delivery.js');
const SKILL_DELIVERY = path.join(REPO_ROOT, '.pipeline', 'skills-deterministicos', 'delivery.js');
const SERVICIO_GITHUB = path.join(REPO_ROOT, '.pipeline', 'servicio-github.js');
const ROL_DELIVERY = path.join(REPO_ROOT, '.pipeline', 'roles', 'delivery.md');

const HEAD_FALSO = 'a'.repeat(40);

// Issues FUERA del rango vivo del repo (lección de rev-1: un fixture con número
// real termina escribiendo en un issue público).
const ISSUE_CLI = 999610;
const ISSUE_STAMP = 999611;
const ISSUE_EXENTO = 999612;
const ISSUE_PR = 999613;

const REPO_INEXISTENTE = 'intrale/no-existe-test-999610';

function tmpDir(prefijo) {
    return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefijo));
}

function crearEstado() {
    const dir = tmpDir('seal-rev3-state-');
    for (const fase of ['verificacion', 'entrega']) {
        for (const sub of ['procesado', 'pendiente', 'trabajando', 'listo', 'archivado']) {
            fs.mkdirSync(path.join(dir, 'desarrollo', fase, sub), { recursive: true });
        }
    }
    fs.mkdirSync(path.join(dir, 'servicios', 'github', 'pendiente'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    return dir;
}

function escribirVeredicto(estado, issue, data) {
    const file = path.join(estado, 'desarrollo', 'verificacion', 'procesado', `${issue}.qa`);
    fs.writeFileSync(file, yaml.dump(data, { lineWidth: -1 }));
    return file;
}

function ordenesGithub(estado) {
    const dir = path.join(estado, 'servicios', 'github', 'pendiente');
    let files;
    try { files = fs.readdirSync(dir); } catch { return []; }
    return files.filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

/** Worktree real, parado en `agent/<issue>-…` y adelantado sobre origin/main. */
function crearWorktree(issue) {
    const dir = tmpDir('seal-rev3-wt-');
    const branch = `agent/${issue}-pipeline-dev`;
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8', windowsHide: true });
    git('config', 'user.email', 'pipeline@intrale.test');
    git('config', 'user.name', 'pipeline');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'uno');
    git('add', '.');
    git('commit', '-q', '-m', 'commit inicial');

    const remoto = tmpDir('seal-rev3-remote-');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remoto], { windowsHide: true });
    git('remote', 'add', 'origin', remoto);
    git('push', '-q', 'origin', 'main');

    git('checkout', '-q', '-b', branch);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'dos');
    git('add', '.');
    git('commit', '-q', '-m', 'feat: cambio por delante de main');

    return { dir, remoto, branch, git, head: git('rev-parse', 'HEAD').trim() };
}

function refsDelRemoto(wt) {
    return execFileSync('git', ['-C', wt.remoto, 'for-each-ref', '--format=%(refname) %(objectname)'],
        { encoding: 'utf8', windowsHide: true }).trim();
}

/** Corre el CLI `.pipeline/delivery.js` (fallback LLM + uso manual del operador). */
function correrCli(wt, estado, args) {
    return spawnSync(process.execPath, [CLI_DELIVERY, ...args], {
        cwd: wt.dir, encoding: 'utf8', windowsHide: true, timeout: 90000,
        env: {
            ...process.env,
            PIPELINE_REPO_ROOT: path.dirname(estado),
            PIPELINE_STATE_DIR: estado,
            GH_REPO: REPO_INEXISTENTE,
            DEBUG: '',
        },
    });
}

// ---------------------------------------------------------------------------
// F1 — el GATE 3 del CLI no se saltea omitiendo un flag
// ---------------------------------------------------------------------------

test('F1: sin --issue el CLI deriva el issue de la rama agent/* y el gate igual corre', () => {
    // El defecto: `if (args.issue)` envolvía el gate entero, así que invocar el
    // CLI sin el flag lo apagaba y el flujo seguía a `git push`. Con el veredicto
    // caduco, el remoto NO puede recibir nada aunque no se pase `--issue`.
    const wt = crearWorktree(ISSUE_CLI);
    const estado = crearEstado();
    escribirVeredicto(estado, ISSUE_CLI, {
        resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] },
    });

    const res = correrCli(wt, estado, ['--description', 'x']);

    const salida = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.match(salida, new RegExp(`derivado de la rama`),
        'el issue tiene que derivarse de la rama cuando falta el flag');
    const contrato = JSON.parse((res.stdout || '').trim().split(/\r?\n/).pop());
    assert.strictEqual(contrato.estado, 'veredicto_caduco', 'el gate corrió y frenó la entrega');
    assert.strictEqual(contrato.issue, ISSUE_CLI, 'el issue derivado es el de la rama');
    assert.ok(!new RegExp(`refs/heads/${wt.branch}`).test(refsDelRemoto(wt)),
        'sin --issue el gate igual frena: el remoto no recibió la rama');
});

test('F1: --issue vacio NO se lee como "segui sin gate": aborta con exit 1', () => {
    // Distinguir flag AUSENTE de flag VACÍO es el corazón del fix: con la
    // implementación vieja, `--issue ""` era falsy y salteaba el gate entero.
    const wt = crearWorktree(ISSUE_CLI);
    const estado = crearEstado();
    escribirVeredicto(estado, ISSUE_CLI, {
        resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] },
    });

    const res = correrCli(wt, estado, ['--issue', '', '--description', 'x']);

    assert.strictEqual(res.status, 1, 'un --issue vacío aborta, no sigue sin gate');
    assert.match(`${res.stderr || ''}`, /--issue inválido/);
    assert.ok(!new RegExp(`refs/heads/${wt.branch}`).test(refsDelRemoto(wt)),
        'no se tocó el remoto');
});

test('F1: --issue como ultimo argumento (undefined) tambien aborta', () => {
    // `argv[++i]` con el flag al final devuelve `undefined`, que también era
    // falsy y apagaba el gate.
    const wt = crearWorktree(ISSUE_CLI);
    const estado = crearEstado();
    escribirVeredicto(estado, ISSUE_CLI, {
        resultado: 'aprobado', sello: { version: 1, head: HEAD_FALSO, artefactos: [] },
    });

    const res = correrCli(wt, estado, ['--description', 'x', '--issue']);

    assert.strictEqual(res.status, 1, 'flag sin valor aborta');
    assert.ok(!new RegExp(`refs/heads/${wt.branch}`).test(refsDelRemoto(wt)));
});

test('F1: el gate del CLI no puede volver a colgar de la verdad de --issue', () => {
    // GUARDIÁN estructural: `if (args.issue)` es exactamente el patrón que
    // reintroduce el defecto.
    const src = fs.readFileSync(CLI_DELIVERY, 'utf8');
    const posGate = src.indexOf('freshnessGate.evaluateFreshnessGate(');
    assert.ok(posGate > 0, 'el CLI tiene que evaluar el gate');
    const ventana = src.slice(Math.max(0, posGate - 800), posGate);
    assert.ok(!/if\s*\(\s*args\.issue\s*\)/.test(ventana),
        'el gate no puede colgar de `if (args.issue)`: se apagaría omitiendo el flag');
    assert.match(src, /AGENT_BRANCH_ISSUE/,
        'el CLI tiene que derivar el issue de la rama cuando falta el flag');
});

// ---------------------------------------------------------------------------
// F2 — el PR no queda con el gate afirmado sobre un HEAD no verificado
// ---------------------------------------------------------------------------

test('F2: el re-chequeo de frescura corre ANTES de propagar el gate al PR', () => {
    // El defecto: `propagateGateLabelToPr` (Fase 4) estampaba el gate y el
    // re-chequeo corría después (Fase 5), así que un HEAD movido dejaba el PR con
    // `qa:passed` encima. Prevención: no estampar nada nuevo con veredicto caduco.
    const src = fs.readFileSync(SKILL_DELIVERY, 'utf8');
    const posPropagacion = src.indexOf('...propagateGateLabelToPr({');
    const posRecheck = src.indexOf('const gate3Merge = freshnessGate.evaluateFreshnessGate(');
    assert.ok(posPropagacion > 0 && posRecheck > 0, 'los dos puntos tienen que existir');
    assert.ok(posRecheck < posPropagacion,
        'el re-chequeo de frescura va ANTES de estampar el gate en el PR, no después');
});

test('F2: la rama caduca RETRACTA el gate ya estampado en el PR', () => {
    // Prevenir no alcanza: el PR pudo nacer con `qa:passed`/`qa:skipped` en el
    // `gh pr create`, o traerlo de un run anterior. Hay que bajarlo activamente.
    const estado = crearEstado();

    const r = seal.retractPrGateLabels({
        pipelineDir: estado, prNumber: ISSUE_PR, prLabels: ['qa:passed', 'area:pipeline'],
    });
    assert.strictEqual(r.ok, true);

    const ordenes = ordenesGithub(estado);
    const aPending = ordenes.find((o) => o.action === 'label' && o.label === 'qa:pending');
    assert.ok(aPending, 'se encola la degradación del gate del PR a qa:pending');
    assert.strictEqual(aPending.target, 'pr', 'la orden apunta al PR, no al issue');
    assert.strictEqual(aPending.issue, ISSUE_PR);
});

test('F2: qa:skipped tambien se retracta — hasQaGate lo acepta igual que qa:passed', () => {
    // `hasQaGate` acepta los dos, pero el `gate-label-reconciler` sólo conoce
    // passed/failed/pending: sin un remove explícito, `qa:skipped` sobrevivía en
    // el PR y seguía siendo autoridad de merge sobre un HEAD no verificado.
    const estado = crearEstado();

    seal.retractPrGateLabels({
        pipelineDir: estado, prNumber: ISSUE_PR, prLabels: ['qa:skipped'],
    });

    const quitaSkipped = ordenesGithub(estado).find(
        (o) => o.action === 'remove-label' && o.label === 'qa:skipped');
    assert.ok(quitaSkipped, 'qa:skipped tiene que bajarse explícitamente del PR');
    assert.strictEqual(quitaSkipped.target, 'pr');
    assert.strictEqual(quitaSkipped.gate_retraction, true,
        'la marca de retractación es lo que habilita el remove sobre un PR');
});

test('F2: el servicio de github ejecuta la retractacion en vez de bloquearla', () => {
    // El bloqueo genérico `non-gate-pr-label-blocked` descartaba la orden de
    // `qa:skipped`. La excepción es monótona hacia lo cerrado: quitar un label
    // que sólo puede ABRIR el gate nunca puede habilitar un merge.
    const src = fs.readFileSync(SERVICIO_GITHUB, 'utf8');
    assert.match(src, /PR_GATE_RETRACTABLE\s*=\s*new Set\(\['qa:passed',\s*'qa:skipped'\]\)/,
        'el conjunto retractable está enumerado, no es un patrón abierto');
    const posCase = src.indexOf("case 'remove-label':");
    const posRetraccion = src.indexOf('data.gate_retraction === true');
    assert.ok(posCase > 0, "el case 'remove-label' tiene que existir");
    assert.ok(posRetraccion > posCase,
        "la retractación vive dentro del case 'remove-label'");
    // El bloqueo genérico de labels no-gate a PRs que sigue a la retractación es
    // el que la descartaba: la excepción tiene que evaluarse ANTES.
    const posBloqueo = src.indexOf('non-gate-pr-label-blocked', posCase);
    assert.ok(posBloqueo > 0, 'el bloqueo genérico sigue existiendo (no se removió la defensa)');
    assert.ok(posRetraccion < posBloqueo,
        'la retractación se evalúa ANTES del bloqueo genérico, si no queda muerta');
});

test('F2: la retractacion NO puede agregar labels que abran el gate', () => {
    // Guardián de dirección: todo lo que la retractación encola tiene que cerrar
    // el gate. Si alguna orden agregara `qa:passed`/`qa:skipped` al PR, la
    // "retractación" sería el bypass.
    const estado = crearEstado();
    seal.retractPrGateLabels({
        pipelineDir: estado, prNumber: ISSUE_PR, prLabels: ['qa:passed', 'qa:skipped'],
    });
    for (const o of ordenesGithub(estado)) {
        if (o.action === 'label') {
            assert.ok(!['qa:passed', 'qa:skipped'].includes(o.label),
                `la retractación jamás agrega un label que abre el gate (encoló ${o.label})`);
        }
    }
});

// ---------------------------------------------------------------------------
// F3 — `veredicto_caduco` se corrobora con un testigo de UN SOLO USO
// ---------------------------------------------------------------------------

test('F3: el contador vivo de una caducidad ANTERIOR ya no corrobora el flag', () => {
    // EL DEFECTO: el contador no se consume ni expira. Quedaba en >0 desde la 1ª
    // caducidad legítima hasta el próximo push exitoso, así que en toda esa
    // ventana `veredicto_caduco: true` se creía solo. Un issue que ya caducó una
    // vez y cuya entrega DESPUÉS falla de verdad (conflicto, CI en rojo) se
    // cancelaba el rechazo: sin rebote, sin rev++, sin circuit breaker.
    const estado = crearEstado();

    // Caducidad legítima: deja contador Y testigo.
    seal.requeueVerification({ pipelineDir: estado, issue: ISSUE_STAMP, motivo: 'head-desincronizado' });
    assert.ok(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_STAMP }).intentos > 0,
        'el contador quedó vivo, como en producción');

    // El Pulpo procesa ESE caduco real: consume el testigo.
    const real = freshnessGate.isStaleVerdictRejection({
        fase: 'entrega', rechazados: [{ veredicto_caduco: true }],
        issue: ISSUE_STAMP, pipelineDir: estado,
    });
    assert.strictEqual(real, true, 'la caducidad real sí cancela el rechazo');

    // Segunda entrega, que falla DE VERDAD, con el contador todavía en >0.
    assert.ok(seal.readSealRetries({ pipelineDir: estado, issue: ISSUE_STAMP }).intentos > 0,
        'el contador sigue vivo: es exactamente la ventana del defecto');
    const falso = freshnessGate.isStaleVerdictRejection({
        fase: 'entrega', rechazados: [{ veredicto_caduco: true }],
        issue: ISSUE_STAMP, pipelineDir: estado,
    });
    assert.strictEqual(falso, false,
        'sin testigo de ESTE run el flag no vale: es un rechazo normal, con rebote y escalada');
});

test('F3: el testigo es de un solo uso — no se puede reusar', () => {
    const estado = crearEstado();
    seal.requeueVerification({ pipelineDir: estado, issue: ISSUE_STAMP, motivo: 'sin-sello' });

    assert.strictEqual(seal.consumeStaleStamp({ pipelineDir: estado, issue: ISSUE_STAMP }), true,
        'la primera lectura lo encuentra');
    assert.strictEqual(seal.consumeStaleStamp({ pipelineDir: estado, issue: ISSUE_STAMP }), false,
        'la segunda ya no: leerlo lo consume');
});

test('F3: sin gate detras, un veredicto_caduco declarado no cancela nada', () => {
    // El caso base del A04: el agente escribe el flag sin que el gate haya
    // encolado reparación alguna.
    const estado = crearEstado();
    const res = freshnessGate.isStaleVerdictRejection({
        fase: 'entrega', rechazados: [{ veredicto_caduco: true }],
        issue: ISSUE_STAMP, pipelineDir: estado,
    });
    assert.strictEqual(res, false);
});

test('F3: la escalada tambien deja testigo (las dos ramas de requeueVerification)', () => {
    // Con el contador en el tope, `requeueVerification` escala en vez de
    // re-encolar. Ese camino también es una caducidad real y tiene que poder
    // corroborarse, si no la escalada se procesaría como rechazo normal.
    const estado = crearEstado();
    for (let i = 0; i < seal.MAX_SEAL_REQUEUES; i += 1) {
        seal.requeueVerification({ pipelineDir: estado, issue: ISSUE_STAMP, motivo: 'head-desincronizado' });
        seal.consumeStaleStamp({ pipelineDir: estado, issue: ISSUE_STAMP });
    }
    const esc = seal.requeueVerification({ pipelineDir: estado, issue: ISSUE_STAMP, motivo: 'head-desincronizado' });
    assert.strictEqual(esc.escalado, true, 'esta vuelta escala');
    assert.strictEqual(seal.consumeStaleStamp({ pipelineDir: estado, issue: ISSUE_STAMP }), true,
        'la rama de escalada también deja testigo');
});

test('F3: integrar un veredicto fresco borra el testigo pendiente', () => {
    const estado = crearEstado();
    seal.requeueVerification({ pipelineDir: estado, issue: ISSUE_STAMP, motivo: 'head-desincronizado' });
    seal.clearSealRetries({ pipelineDir: estado, issue: ISSUE_STAMP });
    assert.strictEqual(seal.consumeStaleStamp({ pipelineDir: estado, issue: ISSUE_STAMP }), false,
        'el episodio de caducidad se cierra entero: contador y testigo');
});

test('F3: el rol ya no promete una corroboracion que el codigo no hace', () => {
    // El doc afirmaba que el Pulpo cruza el flag contra el contador Y la cola
    // `verificacion-requeue/`, pero `isStaleVerdictRejection` descarta
    // `hasOpenRequeue` a propósito (es fail-closed en el sentido opuesto).
    const doc = fs.readFileSync(ROL_DELIVERY, 'utf8');
    assert.match(doc, /seal-caduco-stamp/,
        'el rol tiene que nombrar el testigo, que es la defensa que existe de verdad');
    assert.ok(!/el contador de caducidad del issue y la\s*\n?>?\s*cola `verificacion-requeue\/`/.test(doc),
        'el rol no puede seguir prometiendo la corroboración contra la cola');
});

// ---------------------------------------------------------------------------
// F4 — el carril de exención también pinnea (anti-TOCTOU)
// ---------------------------------------------------------------------------

test('F4: la exencion de migracion pinnea el HEAD en vez de devolver null', () => {
    // EL DEFECTO: `shaVerificado = null` hacía que el push volviera al nombre
    // simbólico de la rama y que `expectedHeadSha: null` apagara entero el
    // pinneo de head del merge (`if (expectedHeadSha)`). El carril con la
    // verificación MÁS DÉBIL era además el único sin anti-TOCTOU: alcanzaba un
    // push concurrente, no hacía falta un agente hostil.
    const wt = crearWorktree(ISSUE_EXENTO);
    const estado = crearEstado();
    escribirVeredicto(estado, ISSUE_EXENTO, {
        resultado: 'aprobado',
        sello_exencion: {
            motivo: seal.MIGRACION_MOTIVO,
            derivado_por: seal.MIGRACION_DERIVADO_POR,
            ts: new Date().toISOString(),
        },
    });

    const r = freshnessGate.evaluateFreshnessGate({
        pipelineDir: estado, issue: ISSUE_EXENTO, cwd: wt.dir,
    });

    assert.strictEqual(r.caduco, false, 'la exención sigue eximiendo (CA-4)');
    assert.strictEqual(r.exento, true, 'y queda identificada como exención');
    assert.strictEqual(r.shaVerificado, wt.head,
        'pero se pinnea al HEAD local: la exención dispensa de tener sello, no de integrar lo que se miró');
});

test('F4: en la exencion, un HEAD no derivable sigue siendo caduco (fail-closed)', () => {
    const estado = crearEstado();
    escribirVeredicto(estado, ISSUE_EXENTO, {
        resultado: 'aprobado',
        sello_exencion: {
            motivo: seal.MIGRACION_MOTIVO,
            derivado_por: seal.MIGRACION_DERIVADO_POR,
            ts: new Date().toISOString(),
        },
    });
    // `cwd` fuera de todo repo git: no hay HEAD que derivar.
    const fuera = tmpDir('seal-rev3-nogit-');
    const r = freshnessGate.evaluateFreshnessGate({
        pipelineDir: estado, issue: ISSUE_EXENTO, cwd: fuera,
    });
    assert.strictEqual(r.caduco, true, 'sin HEAD no hay nada que pinnear ⇒ caduco');
});

// ---------------------------------------------------------------------------
// F5 — el gate corre antes de TODO contacto con el remoto
// ---------------------------------------------------------------------------

test('F5: el gate corre antes del early-exit que cierra el issue en GitHub', () => {
    // El early-exit "entrega previa" hace `gh issue comment` y `gh issue close`:
    // cerraba un issue como ENTREGADO sin chequear frescura. CA-15 dice "antes de
    // todo contacto con el remoto", no "antes del push".
    const src = fs.readFileSync(SKILL_DELIVERY, 'utf8');
    const posGate = src.indexOf('freshnessGate.evaluateFreshnessGate(');
    const posEarlyExit = src.indexOf('const priorRefs = git.getPriorDeliveryRefs(');
    const posClose = src.indexOf("['issue', 'close', String(issue)]");
    assert.ok(posGate > 0 && posEarlyExit > 0 && posClose > 0, 'los tres puntos tienen que existir');
    assert.ok(posGate < posEarlyExit,
        'el gate corre antes del early-exit de "entrega previa"');
    assert.ok(posGate < posClose,
        'el gate corre antes de cerrar el issue en el remoto');
});

// ---------------------------------------------------------------------------
// F6 — el reset del contador cuelga del merge, en TODOS los caminos
// ---------------------------------------------------------------------------

test('F6: el CLI no resetea el contador, porque nunca mergea', () => {
    // El CLI pushea y crea el PR; nunca mergea. Resetear ahí era resetear en el
    // 100% de las corridas, así que el tope de 2 re-encolados de CA-9 se podía
    // reiniciar indefinidamente corriendo `/delivery` a mano.
    const src = fs.readFileSync(CLI_DELIVERY, 'utf8');
    assert.ok(!/qaEvidenceSeal\.clearSealRetries\(/.test(src),
        'el CLI no puede borrar el contador: no tiene con qué afirmar que hubo integración');
    // Y sigue sin mergear — si algún día mergea, el reset habrá que reponerlo ahí.
    assert.ok(!/pulls\/\$\{[^}]*\}\/merge/.test(src),
        'si el CLI empieza a mergear, este guardián tiene que revisarse');
});

test('F5: el gate sigue corriendo antes del push y del pr create', () => {
    // El movimiento de F5 no puede haber aflojado las precondiciones viejas.
    const src = fs.readFileSync(SKILL_DELIVERY, 'utf8');
    const posGate = src.indexOf('freshnessGate.evaluateFreshnessGate(');
    const posCommit = src.indexOf("phaseEnd('stage_commit', t);");
    assert.ok(posCommit > 0 && posGate > posCommit,
        'el gate sigue corriendo DESPUÉS de que Fase 1 cerró los commits: si no, chequea un árbol que no es el que se entrega');
    assert.ok(posGate < src.indexOf('git.pushAndVerify('),
        'y antes del push');
});
