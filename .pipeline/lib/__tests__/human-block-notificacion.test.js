// =============================================================================
// Tests de la notificación proactiva de bloqueo humano (#5337).
//
// Cubre CA-7: cada trigger nuevo emite `human:blocked`, el recordatorio NUNCA
// auto-aprueba, y las recomendaciones de agentes quedan excluidas de la señal.
//
// Todo lo que se testea acá es determinístico: los detectores son funciones
// puras sobre estado ya consultado, y el recordatorio recibe `now` y la lista de
// bloqueos inyectados. Sin red, sin `gh`, sin esperar relojes.
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Aislar el filesystem del pipeline a un tmp propio ANTES de requerir human-block
// (el módulo resuelve PIPELINE_DIR en tiempo de carga).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-hb5337-'));
fs.mkdirSync(path.join(TMP_DIR, '.claude'), { recursive: true });
for (const st of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
    fs.mkdirSync(path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', st), { recursive: true });
}
process.env.CLAUDE_PROJECT_DIR = TMP_DIR;
process.env.PIPELINE_REPO_ROOT = TMP_DIR;

delete require.cache[require.resolve('../traceability')];
delete require.cache[require.resolve('../human-block')];
const trace = require('../traceability');
const hb = require('../human-block');
const triggers = require('../human-block-triggers');
const design = require('../design-decision-detect');
const reminder = require('../human-block-reminder');
const recoLabels = require('../recommendation-labels');

function readEvents() {
    if (!fs.existsSync(trace.LOG_FILE)) return [];
    return fs.readFileSync(trace.LOG_FILE, 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function resetFs() {
    for (const state of ['pendiente', 'trabajando', 'listo', 'bloqueado-humano']) {
        const dir = path.join(TMP_DIR, '.pipeline', 'desarrollo', 'dev', state);
        try {
            for (const f of fs.readdirSync(dir)) {
                try { fs.unlinkSync(path.join(dir, f)); } catch {}
            }
        } catch {}
    }
    try { fs.unlinkSync(trace.LOG_FILE); } catch {}
}

// =============================================================================
// CA-3 — Los cuatro casos del 2026-08-01 disparan bloqueo humano notificado
// =============================================================================

test('CA-3 caso 1: hallazgos de seguridad del PR bloquean y emiten human:blocked', () => {
    resetFs();
    const veredicto = triggers.detectSecurityFindingBlock({
        prNumber: 5281,
        headRefName: 'agent/5217-store-credenciales',
        alerts: [
            { number: 401, state: 'open', rule: { id: 'js/hardcoded-credential', security_severity_level: 'high' },
              most_recent_instance: { ref: 'refs/pull/5281/head' } },
        ],
    });
    assert.ok(veredicto, 'el hallazgo del PR tiene que bloquear');
    assert.equal(veredicto.trigger, triggers.TRIGGERS.SECURITY_FINDINGS);
    assert.equal(veredicto.count, 1);

    hb.reportHumanBlock({
        issue: 5217, skill: 'delivery', phase: 'dev', pipeline: 'desarrollo',
        reason: veredicto.reason, question: veredicto.question, skipGithubLabel: true,
    });
    const ev = readEvents().filter((e) => e.event === 'human:blocked');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].issue, 5217);
});

test('CA-3 caso 1 (R1): alertas abiertas sobre main NO bloquean el PR', () => {
    // Al 2026-08-01 hay alertas `open` sobre refs/heads/main (p.ej. #109 de
    // Semgrep). Sin filtrar por ref, TODO PR quedaría bloqueado por deuda
    // preexistente y el pipeline se autobloquearía entero.
    const veredicto = triggers.detectSecurityFindingBlock({
        prNumber: 5281,
        headRefName: 'agent/5217-store-credenciales',
        alerts: [
            { number: 109, state: 'open', rule: { id: 'semgrep.rule' },
              most_recent_instance: { ref: 'refs/heads/main' } },
        ],
    });
    assert.equal(veredicto, null, 'la deuda preexistente de main no puede bloquear el PR');
});

test('CA-3 caso 1: alertas ya resueltas (state != open) no bloquean', () => {
    const veredicto = triggers.detectSecurityFindingBlock({
        prNumber: 5281,
        alerts: [
            { number: 402, state: 'fixed', rule: { id: 'x' }, most_recent_instance: { ref: 'refs/pull/5281/head' } },
            { number: 403, state: 'dismissed', rule: { id: 'y' }, most_recent_instance: { ref: 'refs/pull/5281/head' } },
        ],
    });
    assert.equal(veredicto, null);
});

test('CA-3 caso 2: conflicto de merge real (DIRTY) bloquea', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 5220, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: '',
    });
    assert.ok(v);
    assert.equal(v.trigger, triggers.TRIGGERS.MERGE_CONFLICT);
    assert.match(v.question, /#5220/);
});

test('CA-3 caso 2 (R2): mergeable UNKNOWN es NO CONCLUYENTE, ni bloquea ni aprueba', () => {
    // GitHub calcula `mergeable` de forma asíncrona. Tratar UNKNOWN como
    // conflicto genera bloqueos espurios; tratarlo como limpio es fail-open.
    const v = triggers.detectMergeStateBlock({
        prNumber: 5220, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN',
    });
    assert.equal(v.inconclusive, true);
    assert.equal(v.trigger, null, 'un estado desconocido NUNCA es un veredicto');
});

test('CA-3 caso 4: CODEOWNERS / ruleset (BLOCKED) exige review humana', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 5244, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
    });
    assert.ok(v);
    assert.equal(v.trigger, triggers.TRIGGERS.CODEOWNERS_REVIEW);
    assert.ok(v.recommendation, 'CA-2: tiene que traer recomendación');
});

test('CA-3: PR limpio y aprobado no bloquea', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 5281, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
    });
    assert.equal(v, null);
});

test('CA-3 caso 3: PO devuelve pidiendo una decisión → bloqueo humano', () => {
    const v = triggers.detectDecisionRequestBlock({
        skill: 'po', issue: 5242,
        motivo: 'No corresponde que lo decida el agente: requiere una decisión del operador sobre el alcance.',
    });
    assert.ok(v);
    assert.equal(v.trigger, triggers.TRIGGERS.DECISION_REQUESTED);
});

test('CA-3 caso 3: una corrección de código concreta NO es una decisión', () => {
    // Contraseñal: el falso positivo acá congelaría rebotes técnicos sanos.
    const v = triggers.detectDecisionRequestBlock({
        skill: 'review', issue: 1,
        motivo: 'Faltan tests para la función nueva; hay que decidir el nombre también.',
    });
    assert.equal(v, null, 'missing-tests tiene precedencia sobre la señal de decisión');
});

test('CA-3 caso 3: un skill que no es gate no dispara decisión', () => {
    const v = triggers.detectDecisionRequestBlock({
        skill: 'pipeline-dev', motivo: 'Requiere una decisión del operador.',
    });
    assert.equal(v, null);
});

test('CA-3 caso 5: rebotado 3 veces por la misma causa escala a humano', () => {
    const v = triggers.detectRepeatedRejectionBlock({
        issue: 4242,
        motivos: [
            'El test de login falla en la linea 42',
            'El test de login falla en la linea 57',
            'El test de login falla en la linea 91',
        ],
    });
    assert.ok(v, 'tres fallas de la misma causa tienen que escalar');
    assert.equal(v.trigger, triggers.TRIGGERS.REPEATED_REJECTION);
    assert.equal(v.repeats, 3);
});

test('CA-3 caso 5: causas distintas NO escalan', () => {
    const v = triggers.detectRepeatedRejectionBlock({
        issue: 4242,
        motivos: ['No compila', 'Falta el label', 'El copy esta en ingles'],
    });
    assert.equal(v, null);
});

test('CA-3: los patrones textuales nuevos matchean los 4 casos', () => {
    const casos = [
        'PR con hallazgos de seguridad sin resolver que el ruleset exige',
        'code-scanning con alertas abiertas introducidas por la rama',
        'Hay conflicto de merge contra main que no se resuelve solo',
        'El PO pide una decisión del operador antes de seguir',
        'Review manual exigida por CODEOWNERS',
    ];
    for (const c of casos) {
        assert.equal(hb.isHumanBlockReason(c), true, `deberia matchear: ${c}`);
    }
});

test('CA-3: los patrones nuevos NO matchean motivos técnicos normales', () => {
    // Regresión: si estos patrones se vuelven laxos, el pipeline se congela solo.
    const sanos = [
        'Falta cobertura de tests en el modulo users',
        'El build falla por un import sin usar',
        'El copy del boton no coincide con el mockup',
        'Se agrego seguridad al endpoint y quedo andando',
    ];
    for (const c of sanos) {
        assert.equal(hb.isHumanBlockReason(c), false, `NO deberia matchear: ${c}`);
    }
});

// =============================================================================
// CA-4 — Decisión de arquitectura: escala en vez de resolver por default
// =============================================================================

test('CA-4c: #5217 (store de credenciales, local vs distribuido) escala la decisión', () => {
    // Fixture del caso real que originó el issue: el pipeline eligió "JSON en
    // disco local" por su cuenta y llegó hasta PR sin que nadie decidiera nada.
    const v = design.detectDesignDecision({
        issue: 5217,
        title: 'Store de credenciales del pipeline',
        body: 'Hay que definir dónde se almacenan las credenciales del pipeline. '
            + 'Hoy viven en un archivo JSON en disco local, pero la ejecución tiene '
            + 'que poder ser distribuida multi-host.',
    });
    assert.equal(v.escalate, true, '#5217 tiene que escalar la decisión');
    assert.ok(v.signals.includes('dato-critico'));
    assert.ok(v.signals.includes('local-vs-distribuido'));
    assert.ok(v.question, 'tiene que plantear la pregunta al operador');
    assert.ok(v.recommendation, 'CA-2: con recomendación');
});

test('CA-4b: un issue normal NO dispara bloqueo (default dejar pasar)', () => {
    const v = design.detectDesignDecision({
        issue: 1,
        title: 'Corregir el typo del banner del dashboard',
        body: 'El banner dice "Pendinte". Cambiar el string y agregar un test.',
    });
    assert.equal(v.escalate, false);
    assert.equal(v.signals.length, 0);
    assert.match(v.note, /se deja pasar/, 'CA-4b: el no-escalado queda registrado');
});

test('CA-4b: el tema solo, sin alternativas, no alcanza para frenar', () => {
    // "credenciales" aparece, pero nadie está eligiendo dónde viven.
    const v = design.detectDesignDecision({
        issue: 2,
        title: 'Rotar las credenciales de Telegram',
        body: 'Vencieron los tokens del bot. Rotarlos y actualizar el inventario.',
    });
    assert.equal(v.escalate, false);
});

test('CA-4: una decisión ya cerrada por el operador no se re-escala', () => {
    const v = design.detectDesignDecision({
        issue: 3,
        title: 'Store de credenciales',
        body: 'Decisión tomada: vault externo. Alternativas evaluadas: opción A vs opción B.',
        labels: ['decision:approved'],
    });
    assert.equal(v.escalate, false);
});

test('CA-4a: las señales viven en un solo lugar y están enumeradas', () => {
    assert.ok(Array.isArray(design.DESIGN_DECISION_SIGNALS));
    assert.ok(design.DESIGN_DECISION_SIGNALS.length >= 4);
    for (const s of design.DESIGN_DECISION_SIGNALS) {
        assert.ok(s.key && s.re && s.qualifier && s.pregunta, `señal incompleta: ${s.key}`);
    }
});

test('CA-4b: input basura no frena el pipeline', () => {
    for (const bad of [undefined, {}, { body: null, title: null }]) {
        const v = design.detectDesignDecision(bad);
        assert.equal(v.escalate, false);
    }
});

// =============================================================================
// CA-4 — REGRESIÓN DEL REBOTE DEL REVIEW (2026-08-05)
//
// La primera versión evaluaba `re` y `qualifier` sueltos sobre `title + body`
// concatenado y frenaba el 36% del intake real de definición (18 de 50). Los
// fixtures de abajo son los 5 falsos positivos que el review documentó, con
// bodies LARGOS y multi-sección — que es justo lo que los fixtures originales
// de una línea no cubrían y por eso el defecto pasó con la suite en verde.
// =============================================================================

// Falsos positivos reales del intake de definición. La estructura importa: el
// tema aparece en una sección y el qualifier en otra, a decenas de líneas.
const FALSOS_POSITIVOS_REALES = [
    {
        issue: 5322,
        title: 'Rotar el bot token de Telegram sha8 760e3f4b y ejecutar la purga',
        body: [
            '## Objetivo',
            'Rotar el bot token de Telegram que quedó expuesto y purgar el historial.',
            '',
            '## Contexto',
            'El token vive hoy en el store canónico de credenciales del pipeline.',
            'La rotación es mecánica: generar uno nuevo con BotFather y reemplazarlo.',
            '',
            '## Cambios requeridos',
            '- Generar el token nuevo.',
            '- Actualizar el store con el valor nuevo.',
            '- Purgar el historial del repo.',
        ].join('\n'),
        porque: 'rotación mecánica: menciona token y store, pero no plantea ninguna decisión',
    },
    {
        issue: 5292,
        title: 'El guardrail de procedencia de ramas rechaza las ramas legítimas de agente',
        body: [
            '## Síntoma',
            'El guardrail compara contra el ref local en vez del remoto y rechaza ramas sanas.',
            '',
            '## Causa',
            'La verificación toma el ref local del worktree, que puede estar desfasado',
            'respecto de la rama remota publicada en origin.',
            '',
            '## Fix propuesto',
            'Comparar siempre contra el ref remoto.',
        ].join('\n'),
        porque: '"local" y "remoto" hablan de refs de git, no de topología de hosts',
    },
    {
        issue: 5283,
        title: "[Pipeline] El worktree de agente nace de un ref local 'main' desfasado",
        body: [
            '## Síntoma',
            'El worktree se crea desde un ref local desactualizado.',
            '',
            '## Detalle',
            '`default_base_ref` no está definido en `config.yaml` ni en `pipeline.config.json`,',
            'así que el default es `main` local en vez del remoto `origin/main`.',
            '',
            '## Criterios',
            '- [ ] El base ref efectivo es un ref **remoto**, no un ref local.',
        ].join('\n'),
        porque: '"no está definido" habla de un default de config dentro de backticks, no de una decisión',
    },
    {
        issue: 4817,
        title: 'Idempotencia en la creación de historias del pipeline',
        body: [
            '## Objetivo',
            'Que crear dos veces la misma historia no genere issues duplicados.',
            '',
            '## Contexto',
            'Hoy la clave de deduplicación se calcula sobre el título normalizado.',
            '',
            '## Notas técnicas',
            'La persistencia del índice de dedup vive en el estado operativo del pipeline.',
        ].join('\n'),
        porque: '"clave" y "persistencia" caen en secciones distintas y nadie plantea alternativas',
    },
    {
        issue: 5205,
        title: '[security] Crear CloudTrail para el rastro de Decrypt/GenerateDataKey',
        body: [
            '## Objetivo',
            'Tener rastro de auditoría de las operaciones de KMS.',
            '',
            '## Contexto',
            'Las claves de KMS se usan para cifrar el material del store del pipeline.',
            '',
            '## Cambios requeridos',
            '- Habilitar CloudTrail sobre la región correspondiente.',
        ].join('\n'),
        porque: '"claves" y "store" están a varias secciones de distancia; no hay decisión planteada',
    },
];

for (const fx of FALSOS_POSITIVOS_REALES) {
    test(`CA-4b regresión: #${fx.issue} NO frena (${fx.porque})`, () => {
        const v = design.detectDesignDecision({
            issue: fx.issue, title: fx.title, body: fx.body, labels: [],
        });
        assert.equal(
            v.escalate, false,
            `#${fx.issue} es un falso positivo documentado por el review: ${fx.porque}`
        );
        assert.equal(v.signals.length, 0, 'no debería reconocer ninguna señal estructural');
        assert.match(v.note, /se deja pasar/, 'CA-4b: el no-escalado queda registrado');
    });
}

test('CA-4: el gate de marco decisorio es lo que separa el 36% del 0%', () => {
    // Mismo texto, dos veces: sin marco decisorio y con él. Aísla exactamente la
    // corrección 1 del review.
    const cuerpoBase = 'Las credenciales del pipeline hoy se resuelven desde el store canónico.';
    const sinMarco = design.detectDesignDecision({ issue: 1, title: 'Credenciales', body: cuerpoBase });
    assert.equal(sinMarco.escalate, false, 'sin marco decisorio no se evalúa ninguna señal');
    assert.match(sinMarco.note, /marco decisorio/);

    const conMarco = design.detectDesignDecision({
        issue: 2,
        title: 'Credenciales',
        body: `Hay que definir dónde se almacenan las credenciales del pipeline. ${cuerpoBase}`,
    });
    assert.equal(conMarco.escalate, true, 'con marco decisorio explícito sí escala');
    assert.ok(conMarco.signals.includes('dato-critico'));
});

test('CA-4: co-ocurrencia acotada — tema y qualifier lejos NO cuentan', () => {
    // Hay marco decisorio (para aislar la corrección 2 de la 1), pero el tema y
    // el qualifier viven en oraciones distintas y separadas.
    const relleno = 'Texto de relleno que describe el contexto del issue. '.repeat(12);
    const v = design.detectDesignDecision({
        issue: 3,
        title: 'Refactor del barrido',
        body: `Hay que decidir si lo hacemos en dos pasos. Acá hablamos de tokens del bot. ${relleno} En otra sección aparece la palabra persistencia.`,
    });
    assert.equal(v.escalate, false, 'el qualifier lejano no puede activar la señal');
});

test('CA-4: el código entre backticks no es prosa de decisión', () => {
    const v = design.detectDesignDecision({
        issue: 4,
        title: 'Ajustar el resolver',
        body: 'Hay que definir si migramos el resolver.\n```js\nconst credenciales = store.vault.persistencia;\n```\nNada más.',
    });
    assert.equal(v.escalate, false, 'las señales dentro de un bloque de código se ignoran');
});

test('CA-4c: #5217 con su BODY REAL (largo y multi-sección) sigue escalando', () => {
    // El fixture original era de 3 líneas. El body real de #5217 tiene secciones
    // obsoletas, <details> y tablas — y tiene que seguir escalando igual.
    const v = design.detectDesignDecision({
        issue: 5217,
        title: 'Extender el store unificado de credenciales a Drive OAuth, R2, AWS y GitHub',
        body: [
            '## Objetivo',
            'Que todos los secretos del pipeline se resuelvan desde el store canónico fuera del repo.',
            '',
            '## Contexto',
            'Hay que definir dónde viven las credenciales de Drive, R2, AWS y GitHub:',
            'hoy el store es un archivo JSON en disco local, pero la ejecución tiene que',
            'poder ser distribuida multi-host.',
            '',
            '## Notas técnicas',
            'Alinear con #4917 para no duplicar la lógica de resolución.',
        ].join('\n'),
    });
    assert.equal(v.escalate, true, '#5217 es el caso que originó CA-4: tiene que escalar');
    assert.ok(v.signals.includes('dato-critico'));
    assert.ok(v.recommendation, 'CA-2: con recomendación');
});

// =============================================================================
// CA-3 — REGRESIÓN DEL REBOTE: `BLOCKED` no es siempre "falta la review"
//
// El defecto: el mensaje al operador afirmaba "El PR no tiene conflictos ni
// checks en rojo" sin haber leído los checks. Medido el 2026-08-05, los PRs
// #5277 y #5278 estaban BLOCKED con un check en FAILURE — el pipeline los
// habría invitado a aprobar un merge roto a `main`.
// =============================================================================

test('classifyChecks distingue rojo / pendiente / verde / ilegible', () => {
    assert.equal(triggers.classifyChecks([
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'Semgrep OSS', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]).state, 'failing');

    assert.equal(triggers.classifyChecks([
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
    ]).state, 'pending');

    assert.equal(triggers.classifyChecks([
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'lint', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ]).state, 'green');

    // Sin rollup no se puede afirmar nada: `unknown`, nunca `green`.
    assert.equal(triggers.classifyChecks(undefined).state, 'unknown');
    assert.equal(triggers.classifyChecks([]).state, 'unknown');

    // StatusContext (la otra forma que devuelve GitHub) también se normaliza.
    assert.equal(triggers.classifyChecks([{ context: 'ci/legacy', state: 'FAILURE' }]).state, 'failing');
    assert.equal(triggers.classifyChecks([{ context: 'ci/legacy', state: 'PENDING' }]).state, 'pending');
});

test('CA-3 regresión: BLOCKED con check en rojo NO se reporta como review pendiente', () => {
    // Fixture del PR #5277 real: BLOCKED, mergeable, con Semgrep OSS en FAILURE.
    const v = triggers.detectMergeStateBlock({
        prNumber: 5277,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: '',
        statusCheckRollup: [
            { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'Semgrep OSS', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
    });
    assert.equal(v.trigger, triggers.TRIGGERS.CHECKS_FAILING, 'no es codeowners-review');
    assert.match(v.reason, /Semgrep OSS/, 'nombra el check que está en rojo');
    // El defecto exacto que reportó el review: afirmar que no hay checks en rojo.
    assert.doesNotMatch(
        v.recommendation, /ni checks en rojo|checks están en verde/,
        'NUNCA puede afirmar que los checks están sanos habiendo uno en FAILURE'
    );
    assert.match(v.recommendation, /NO aprobar/, 'no puede invitar a firmar un merge roto');
});

test('CA-3 regresión: BLOCKED con checks corriendo es NO CONCLUYENTE, no un bloqueo', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 5300,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: '',
        statusCheckRollup: [
            { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
        ],
    });
    assert.equal(v.inconclusive, true, 'se reevalúa en el barrido siguiente (igual que R2)');
    assert.equal(v.trigger, null, 'no inventa un bloqueo con los checks a medio correr');
});

test('CA-3: BLOCKED con checks verdes SÍ es CODEOWNERS y recién ahí lo afirma', () => {
    // Fixture del PR #5202 real: BLOCKED, todos los checks en verde.
    const v = triggers.detectMergeStateBlock({
        prNumber: 5202,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [
            { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
    });
    assert.equal(v.trigger, triggers.TRIGGERS.CODEOWNERS_REVIEW);
    assert.match(v.recommendation, /checks están en verde/, 'lo afirma porque LO LEYÓ');
    assert.match(v.recommendation, /aprobarlo destraba el issue/);
});

test('CA-3: BLOCKED sin rollup legible no afirma el estado de los checks', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 5400,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        // sin statusCheckRollup: gh falló, o el PR no tiene checks.
    });
    assert.equal(v.trigger, triggers.TRIGGERS.CODEOWNERS_REVIEW, 'sigue siendo review pendiente');
    assert.doesNotMatch(
        v.recommendation, /ni checks en rojo|checks están en verde/,
        'no puede afirmar un estado que no leyó'
    );
    assert.match(v.recommendation, /no pude leer el estado de sus checks/);
});

test('CA-3 anti-código-muerto: detectPrHumanBlock PASA el rollup a detectMergeStateBlock', () => {
    // Sin este cableado la corrección no sirve de nada: el rollup viaja en el
    // mismo `prInfo` (ya está en FIELDS de pr-info-fetcher) pero hay que
    // enhebrarlo. Este test falla si alguien lo desconecta.
    const v = triggers.detectPrHumanBlock({
        number: 5277,
        headRefName: 'agent/5277-x',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: '',
        statusCheckRollup: [{ name: 'Semgrep OSS', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }, { securityAlerts: [] });
    assert.equal(
        v.trigger, triggers.TRIGGERS.CHECKS_FAILING,
        'si el rollup no llega, esto vuelve a decir codeowners-review'
    );
});

// =============================================================================
// CA-5 — Recordatorio escalado que NUNCA auto-resuelve
// =============================================================================

test('CA-5: el escalado es 2h → 6h → 24h → cada 72h, y nunca se apaga', () => {
    assert.equal(reminder.dueCount(0.5), 0);
    assert.equal(reminder.dueCount(2), 1);
    assert.equal(reminder.dueCount(6), 2);
    assert.equal(reminder.dueCount(24), 3);
    assert.equal(reminder.dueCount(24 + 72), 4);
    assert.equal(reminder.dueCount(24 + 72 * 5), 8, 'a la semana sigue recordando');
});

test('CA-5: un bloqueo sin responder genera recordatorio y sigue bloqueado', () => {
    const now = new Date('2026-08-01T12:00:00Z');
    const blocked = [{
        issue: 5217, skill: 'po', phase: 'dev', pipeline: 'desarrollo',
        reason: 'Falta decidir dónde viven las credenciales',
        question: '¿Vault externo o archivo local?',
        blocked_at: '2026-08-01T09:00:00Z', // 3h atrás
    }];
    const r = reminder.evaluateReminders({ now, blocked, state: { issues: {} } });
    assert.equal(r.due.length, 1);
    assert.equal(r.due[0].issue, 5217);
    // El issue sigue en la lista de bloqueados: el recordatorio no lo sacó.
    assert.equal(blocked.length, 1);
    assert.equal(r.nextState.issues['5217'].sent, 1);
});

test('CA-5: no re-recuerda hasta el escalón siguiente (sin spam por tick)', () => {
    const blocked = [{
        issue: 5217, skill: 'po', phase: 'dev',
        blocked_at: '2026-08-01T09:00:00Z',
    }];
    const state = { issues: { 5217: { sent: 1, blocked_at: '2026-08-01T09:00:00Z' } } };
    // 4h de bloqueo: sigue en el escalón 1, ya avisado.
    const r1 = reminder.evaluateReminders({ now: new Date('2026-08-01T13:00:00Z'), blocked, state });
    assert.equal(r1.due.length, 0, 'no debe repetir el mismo escalón');
    // 7h: entra el escalón 2.
    const r2 = reminder.evaluateReminders({ now: new Date('2026-08-01T16:00:00Z'), blocked, state });
    assert.equal(r2.due.length, 1);
    assert.equal(r2.due[0].reminder_number, 2);
});

test('CA-5: el silencio NUNCA auto-resuelve — el módulo no puede destrabar', () => {
    // Garantía estructural, no una promesa del comentario: el módulo del
    // recordatorio no importa NINGUNA función capaz de mover un marker fuera de
    // bloqueado-humano/. Si alguien agrega un auto-destrabe por timeout, este
    // test se cae.
    const raw = fs.readFileSync(path.join(__dirname, '..', 'human-block-reminder.js'), 'utf8');
    // Los comentarios SÍ nombran estas funciones (explican por qué no están);
    // lo que se audita es el código ejecutable.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const prohibido of ['unblockIssue', 'dismissBlockedIssue', 'reactivateAllBlocked', 'executeQuickAction']) {
        assert.equal(src.includes(prohibido), false,
            `human-block-reminder.js no puede invocar ${prohibido} (auto-aprobación por timeout)`);
    }
    // Tampoco puede alcanzar esas funciones por vía indirecta.
    assert.equal(/require\(['"]\.\/human-block['"]\)/.test(src), false,
        'el recordatorio no importa human-block: recibe la lista de bloqueos inyectada');
    const exportados = Object.keys(reminder);
    for (const k of exportados) {
        assert.equal(/unblock|dismiss|resolve|approve/i.test(k), false,
            `export sospechoso de auto-resolución: ${k}`);
    }
});

test('CA-5: pasado un plazo largo el issue SIGUE bloqueado, sólo cambia el aviso', () => {
    const blocked = [{ issue: 5217, skill: 'po', phase: 'dev', blocked_at: '2026-07-01T00:00:00Z' }];
    const state = { issues: {} };
    const r = reminder.evaluateReminders({ now: new Date('2026-08-01T00:00:00Z'), blocked, state });
    assert.equal(r.due.length, 1);
    // Lo único que produce es un mensaje; el estado del bloqueo no se toca.
    assert.equal(r.nextState.issues['5217'].sent > 3, true);
    assert.ok(!('unblocked' in r), 'evaluateReminders no destraba nada');
});

test('CA-4/CA-5: los recordatorios se agrupan en UN mensaje distinguible del aviso inicial', () => {
    const msg = reminder.buildReminderMessage([
        { issue: 5217, skill: 'po', phase: 'dev', question: 'Vault externo o local', age_hours: 30, reminder_number: 3 },
        { issue: 5220, skill: 'review', phase: 'aprobacion', question: 'Conflicto de merge', age_hours: 5, reminder_number: 1 },
    ]);
    // Un solo mensaje con los dos, no dos mensajes.
    assert.match(msg, /#5217/);
    assert.match(msg, /#5220/);
    // Distinguible del aviso inicial (que usa 🚧 y "marcado como needs-human").
    assert.match(msg, /🔁/);
    assert.equal(msg.includes('🚧'), false);
    // #6190 (H-UX-8) — el encabezado dice el NÚMERO DE AVISO, no "recordatorio":
    // el operador que ya vio dos lee "recordatorio" y archiva sin abrir.
    assert.match(msg, /Tercer aviso:/, 'el número de aviso sube al encabezado');
    // Antigüedad con la redacción unificada del contrato de copy (§5): "1 d 6 h",
    // no "30h" — el operador no tiene que dividir por 24 para entenderlo.
    assert.match(msg, /hace 1 d 6 h/);
    // Garantía explícita de que el tiempo no aprueba nada: es la razón de ser
    // del recordatorio y la única frase que no sale de la ficha.
    assert.match(msg, /Nada se destraba solo por dejar pasar el tiempo./);
    // #5421 — el recordatorio era el 7º camino, el único que salía con Markdown
    // vivo y sin `plain`. Ahora es texto plano: cero metacaracteres.
    assert.doesNotMatch(msg, /[*_`]/, `el recordatorio volvió a emitir markup: ${msg}`);
    assert.doesNotMatch(msg, /<issue>|<orientación>/, 'el pie deja de ser un molde');
    assert.match(msg, /\/unblock 5217 /, 'cada línea lleva su comando con el número real');
    assert.match(msg, /\/unblock 5220 /);
});

test('CA-5: sin bloqueos vencidos no se manda nada', () => {
    assert.equal(reminder.buildReminderMessage([]), '');
});

test('CA-5: si el envío falla, el contador NO avanza (reintenta el próximo tick)', () => {
    const stateFile = path.join(TMP_DIR, 'reminder-fallo.json');
    try { fs.unlinkSync(stateFile); } catch {}
    const blocked = [{ issue: 777, skill: 'po', phase: 'dev', blocked_at: '2026-08-01T00:00:00Z' }];
    const r = reminder.runReminderTick({
        pipelineDir: TMP_DIR, stateFile,
        listBlocked: () => blocked,
        sendTelegram: () => { throw new Error('telegram caido'); },
        now: new Date('2026-08-01T12:00:00Z'),
    });
    assert.equal(r.sent, false);
    assert.match(r.error, /envío falló/);
    assert.equal(fs.existsSync(stateFile), false, 'no persiste un aviso que nunca salió');
});

test('CA-5: el tick manda un mensaje y persiste el estado', () => {
    const stateFile = path.join(TMP_DIR, 'reminder-ok.json');
    try { fs.unlinkSync(stateFile); } catch {}
    const enviados = [];
    const blocked = [{ issue: 888, skill: 'po', phase: 'dev', blocked_at: '2026-08-01T00:00:00Z' }];
    const r = reminder.runReminderTick({
        pipelineDir: TMP_DIR, stateFile,
        listBlocked: () => blocked,
        sendTelegram: (txt) => enviados.push(txt),
        now: new Date('2026-08-01T12:00:00Z'),
    });
    assert.equal(r.sent, true);
    assert.equal(enviados.length, 1, 'UN solo mensaje agrupado');
    const persistido = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(persistido.issues['888'].sent >= 1);
});

test('CA-5: el tick nunca lanza aunque listBlocked explote', () => {
    const r = reminder.runReminderTick({
        pipelineDir: TMP_DIR,
        listBlocked: () => { throw new Error('fs roto'); },
        sendTelegram: () => {},
    });
    assert.equal(r.sent, false);
    assert.match(r.error, /listBlocked/);
});

// =============================================================================
// CA-6 — Las recomendaciones de agentes NO generan notificación de bloqueo
// =============================================================================

test('CA-6: un issue tipo:recomendacion con needs-human NO entra a la lista de bloqueos', () => {
    // Medición 2026-08-01: 865 de 880 issues con `needs-human` eran
    // recomendaciones. Sin este filtro la notificación nace ahogada en ruido.
    const merged = hb.mergeGithubBlockedLabels([], [
        { number: 9001, labels: ['needs-human', 'tipo:recomendacion'], title: '[guru] mejorar caching' },
        { number: 9002, labels: ['needs-human', 'source:recommendation'], title: '[security] revisar JWT' },
        { number: 9003, labels: ['needs-human', 'blocked:routing-manual'], title: 'bloqueo real' },
    ]);
    const nums = merged.map((m) => m.issue);
    assert.deepEqual(nums, [9003], 'sólo el bloqueo real sobrevive');
});

test('CA-6: una recomendación YA aprobada por un humano sí cuenta como bloqueo', () => {
    const merged = hb.mergeGithubBlockedLabels([], [
        { number: 9004, labels: ['needs-human', 'tipo:recomendacion', 'recommendation:approved'] },
    ]);
    assert.equal(merged.length, 1, 'aprobada = trabajo real del pipeline');
});

test('CA-6: un marker en disco NUNCA se filtra por labels de recomendación', () => {
    // Un marker lo crea `reportHumanBlock`: hubo un agente frenado de verdad.
    const fsList = [{ issue: 9005, skill: 'po', phase: 'dev', reason: 'r', question: 'q' }];
    const merged = hb.mergeGithubBlockedLabels(fsList, [
        { number: 9005, labels: ['needs-human', 'tipo:recomendacion'] },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].skill, 'po', 'se preserva la entrada del filesystem');
});

test('CA-6: el discriminador acepta labels como string y como objeto {name}', () => {
    assert.equal(recoLabels.isRecommendationIssue(['tipo:recomendacion']), true);
    assert.equal(recoLabels.isRecommendationIssue([{ name: 'source:recommendation' }]), true);
    assert.equal(recoLabels.isRecommendationIssue(['enhancement', 'needs-human']), false);
    assert.equal(recoLabels.isRecommendationIssue(null), false);
});

test('CA-6: el reconciler y human-block comparten la MISMA fuente de verdad', () => {
    // Una tercera copia inline del criterio sería una tercera fuente que se
    // desincroniza (ya pasó entre reconciler y dashboard).
    const reconciler = require('../../servicio-reconciler');
    assert.equal(reconciler.RECOMMENDATION_LABELS, recoLabels.RECOMMENDATION_LABELS,
        'tiene que ser literalmente el mismo Set, no una copia');
});

// =============================================================================
// CA-2 — El mensaje dice qué issue, qué se necesita, y qué recomienda
// =============================================================================

test('CA-2: el resumen incluye la recomendación cuando existe', () => {
    const md = hb.buildBlockedSummaryMarkdown({
        highlight: {
            issue: 5217, skill: 'po',
            reason: 'Falta decidir dónde viven las credenciales',
            question: '¿Vault externo o archivo local?',
            recommendation: 'Vault externo: el pipeline corre distribuido.',
        },
        blocked: [],
    });
    assert.match(md, /#5217/);
    assert.match(md, /Falta decidir/);
    assert.match(md, /Vault externo o archivo local/);
    assert.match(md, /💡 \*Recomendación:\* Vault externo/);
});

test('CA-2: sin recomendación, la línea se omite (no dice "sin recomendación")', () => {
    const md = hb.buildBlockedSummaryMarkdown({
        highlight: { issue: 5220, skill: 'review', reason: 'Conflicto', question: '¿Lo resolvés?' },
        blocked: [],
    });
    assert.equal(md.includes('💡'), false);
    assert.equal(/sin recomendaci/i.test(md), false);
});

test('CA-2: el audio también narra la recomendación', () => {
    const txt = hb.buildNeedHumanAudioText({
        reason: 'Conflicto de merge en el PR',
        question: 'Lo resolvés a mano o devolvemos a desarrollo',
        recommendation: 'Devolver a desarrollo sale mas barato',
    });
    assert.match(txt, /Atención/);
    assert.match(txt, /Sugerencia del pipeline: Devolver a desarrollo/);
    assert.ok(txt.length <= 600);
});

test('CA-2: el audio sin recomendación mantiene el guion histórico', () => {
    const txt = hb.buildNeedHumanAudioText({ reason: 'motivo', question: 'pregunta' });
    assert.equal(txt.includes('Sugerencia del pipeline'), false);
});

// =============================================================================
// CA-1 — El orquestador de PR devuelve los tres estados posibles
// =============================================================================

test('CA-1: detectPrHumanBlock prioriza seguridad sobre estado de merge', () => {
    const v = triggers.detectPrHumanBlock(
        { number: 5281, headRefName: 'agent/5217-x', mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE' },
        { securityAlerts: [{ number: 1, state: 'open', rule: { id: 'r' }, most_recent_instance: { ref: 'refs/pull/5281/head' } }] },
    );
    assert.equal(v.trigger, triggers.TRIGGERS.SECURITY_FINDINGS);
});

test('CA-1: detectPrHumanBlock sin PR válido devuelve null', () => {
    assert.equal(triggers.detectPrHumanBlock({}), null);
    assert.equal(triggers.detectPrHumanBlock({ number: -1 }), null);
});

// =============================================================================
// CA-3 — GUARDA ANTI-CÓDIGO-MUERTO
//
// Los detectores por estado objetivo (seguridad / conflicto / CODEOWNERS)
// estuvieron escritos y testeados pero NUNCA invocados desde `pulpo.js`: los
// tests pasaban en verde y en producción no se notificaba nada. Un detector que
// nadie llama es exactamente el bug que #5337 vino a arreglar, disfrazado de
// suite verde.
//
// Estos tests leen el fuente del pulpo y verifican el CABLEADO, no la lógica.
// =============================================================================

// `fs` y `path` ya están requeridos arriba en este archivo.
const PULPO_SRC = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'pulpo.js'),
    'utf8'
);

test('CA-3: pulpo.js invoca detectPrHumanBlock (no es código muerto)', () => {
    assert.match(
        PULPO_SRC,
        /detectPrHumanBlock\s*\(/,
        'human-block-triggers.detectPrHumanBlock debe invocarse desde pulpo.js'
    );
    assert.match(
        PULPO_SRC,
        /require\(['"]\.\/lib\/code-scanning-alerts['"]\)/,
        'el fetcher de alertas de code-scanning debe estar cableado'
    );
});

test('CA-3: pulpo.js invoca los detectores de decisión y causa repetida', () => {
    assert.match(PULPO_SRC, /detectDecisionRequestBlock\s*\(/);
    assert.match(PULPO_SRC, /detectRepeatedRejectionBlock\s*\(/);
});

test('CA-4: pulpo.js invoca el detector de decisión de arquitectura en intake', () => {
    assert.match(PULPO_SRC, /detectDesignDecision\s*\(/);
});

test('CA-5: pulpo.js arranca el cron de recordatorio', () => {
    assert.match(PULPO_SRC, /require\(['"]\.\/lib\/human-block-reminder['"]\)/);
    assert.match(PULPO_SRC, /runReminderTick\s*\(/);
});

test('CA-2: el cableado del PR pasa la recomendación al mensaje y al audio', () => {
    // Sin esto el operador ve que algo está trabado pero no qué le conviene hacer.
    const bloque = PULPO_SRC.slice(
        PULPO_SRC.indexOf('detectPrHumanBlock'),
        PULPO_SRC.indexOf('detectPrHumanBlock') + 4000
    );
    assert.match(bloque, /recommendation:\s*veredicto\.recommendation/);
    assert.ok(
        (bloque.match(/recommendation:\s*veredicto\.recommendation/g) || []).length >= 2,
        'la recomendación debe viajar tanto al resumen de Telegram como al audio'
    );
});

test('CA-5 fail-closed: el pulpo NO destraba por vencimiento de plazo', () => {
    // El módulo de recordatorio no puede resolver bloqueos; verificamos que el
    // cableado tampoco le pase ninguna capacidad de destrabe.
    const i = PULPO_SRC.indexOf('runReminderTick');
    // Sólo CÓDIGO: los comentarios de esa zona mencionan `unblockIssue` justamente
    // para explicar que NO se usa, y contarlos daría un falso positivo.
    const bloque = PULPO_SRC.slice(Math.max(0, i - 2000), i + 2000)
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
    for (const prohibido of ['unblockIssue', 'dismissBlockedIssue', 'clearBlockedMarker']) {
        assert.ok(
            !bloque.includes(prohibido),
            `el cron de recordatorio no puede tener acceso a ${prohibido}`
        );
    }
});

// =============================================================================
// #6612 UX-1 / UX-2 / UX-6 — Rótulos del mensaje al operador
//
// EL DEFECTO QUE CUBREN. #6612 agrega en `delivery.js` un gate (5c) que NO
// mergea con un check de `SECURITY_BLOCKING_CONTEXTS` en rojo, y sin reintento.
// El mensaje que el pulpo le manda al operador seguía rotulando ese mismo check
// como "informativo", diciéndole que "no frena el merge" y que "aprobarlo
// destraba el issue": el pipeline afirmando dos cosas opuestas sobre el mismo
// check. El operador aprueba, el merge no avanza, y el texto no explica por qué.
// Es el fail-open de #6602 corrido de la máquina al humano.
//
// El segundo defecto es textual y vive en la misma función: la rama de checks en
// rojo pegaba el adjetivo "requerido(s)" aunque la lista de requeridos no se
// hubiera podido leer — o sea, afirmando algo no verificado. La rama de review
// pendiente ya lo condicionaba; ésta quedó afuera.
// =============================================================================

// Rollup del PR #6602 real, que es el merge que #6612 viene a impedir:
// el único requerido en verde y el secret scan del diff en rojo.
const ROLLUP_6602 = Object.freeze([
    { name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'runtime-state-guard', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'OWASP Dependency Check', status: 'COMPLETED', conclusion: 'SUCCESS' },
]);

const REQ_LEIDOS = { requiredContexts: ['pr-status'], requiredContextsRead: true };

test('#6612 UX-1 — un check de la allowlist en rojo NO se rotula informativo', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 6602,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: ROLLUP_6602.map((c) => ({ ...c })),
        ...REQ_LEIDOS,
    });

    assert.equal(
        v.trigger, triggers.TRIGGERS.SECURITY_CHECK_RED,
        'antes caía en codeowners-review y le pedía la firma al operador'
    );
    assert.match(v.reason, /bloqueante/i, 'usa el rótulo propio de UX-1');
    assert.match(v.reason, /runtime-state-guard/, 'nombra el check');

    // El corazón del rebote: el texto NO puede decir lo contrario de lo que
    // hace el gate (5c) de delivery.js sobre este mismo check.
    const todo = `${v.reason}\n${v.question}\n${v.recommendation}`;
    assert.doesNotMatch(
        todo, /no frenan el merge/,
        'el gate (5c) de delivery.js bloquea el merge por este check, sin reintento'
    );
    assert.doesNotMatch(
        todo, /aprobarlo destraba el issue/,
        'aprobar el PR no destraba nada: el pipeline lo bloquea igual'
    );
    assert.match(v.recommendation, /no lo destraba/i, 'y lo dice explícitamente');

    // Segregado, nunca en la bolsa de los informativos (UX-4).
    assert.deepEqual(v.securityBlocking.failing, ['runtime-state-guard']);
    assert.deepEqual(v.informational.failing, [], 'no se cuela entre los decorativos');
});

test('#6612 UX-2 — la recomendación del check de seguridad es PROPIA, no la del test en rojo', () => {
    const sec = triggers.detectMergeStateBlock({
        prNumber: 6602,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: ROLLUP_6602.map((c) => ({ ...c })),
        ...REQ_LEIDOS,
    });
    const req = triggers.detectMergeStateBlock({
        prNumber: 6603,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [{ name: 'pr-status', status: 'COMPLETED', conclusion: 'FAILURE' }],
        ...REQ_LEIDOS,
    });

    assert.notEqual(sec.recommendation, req.recommendation, 'dos causas distintas, dos acciones distintas');
    assert.notEqual(sec.question, req.question);
    // "Devolver a desarrollo" es correcto para un test requerido en rojo y
    // equivocado para un hallazgo de escáner: ahí lo que corresponde es mirar
    // el hallazgo, no rehacer la feature.
    assert.match(req.recommendation, /devolver el issue a desarrollo/i);
    assert.doesNotMatch(sec.recommendation, /devolver el issue a desarrollo/i);
    assert.match(sec.recommendation, /hallazgo/i);
});

test('#6612 UX-2 — sin lista de requeridos legible NO se pega el adjetivo "requerido"', () => {
    // Ésta es la línea que el issue nombra: la rama (a) escribía
    // "N check(s) requerido(s) en rojo" incondicionalmente. Con el filtro
    // apagado `checks.failing` es el rollup ENTERO, así que ninguno de esos
    // nombres está cotejado contra la protección de rama.
    const v = triggers.detectMergeStateBlock({
        prNumber: 6604,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [{ name: 'OWASP Dependency Check', status: 'COMPLETED', conclusion: 'FAILURE' }],
        // sin requiredContexts: el ruleset no se pudo leer (403, rate limit...)
    });

    assert.equal(v.trigger, triggers.TRIGGERS.CHECKS_FAILING, 'sigue frenando: fail-closed');
    assert.equal(v.requiredFilter.applied, false);
    assert.doesNotMatch(
        v.reason, /check\(s\)\s*requerido/i,
        'afirmar "requerido" sin haber leído el ruleset manda al operador al lugar equivocado'
    );
    // UX-1: y si no se pudo leer, el mensaje lo DICE en vez de callarlo.
    assert.match(v.reason, /No pude leer qué checks exige la protección de main/);
    assert.match(v.reason, /requeridos-no-leidos/, 'con la causa, para poder diagnosticar');
    // Ninguno de los otros dos rótulos se aplica por cuenta propia en ese caso.
    assert.doesNotMatch(v.reason, /informativ/i);
    assert.doesNotMatch(v.reason, /bloqueante por seguridad/i);
});

test('#6612 UX-2 — con la lista leída SÍ se pega el adjetivo, y concuerda en número', () => {
    const uno = triggers.detectMergeStateBlock({
        prNumber: 6605,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [{ name: 'pr-status', status: 'COMPLETED', conclusion: 'FAILURE' }],
        ...REQ_LEIDOS,
    });
    assert.match(uno.reason, /1 check\(s\) requerido en rojo/);
    assert.doesNotMatch(uno.reason, /No pude leer qué checks exige/);

    const dos = triggers.detectMergeStateBlock({
        prNumber: 6606,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
            { name: 'pr-status', status: 'COMPLETED', conclusion: 'FAILURE' },
            { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
        requiredContexts: ['pr-status', 'build'],
        requiredContextsRead: true,
    });
    assert.match(dos.reason, /2 check\(s\) requeridos en rojo/);
});

test('#6612 UX-4 — caso mixto: los tres grupos se listan POR GRUPO, no en bolsa única', () => {
    const v = triggers.detectMergeStateBlock({
        prNumber: 6607,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
            { name: 'pr-status', status: 'COMPLETED', conclusion: 'FAILURE' },
            { name: 'runtime-state-guard', status: 'COMPLETED', conclusion: 'FAILURE' },
            { name: 'OWASP Dependency Check', status: 'IN_PROGRESS', conclusion: '' },
        ],
        ...REQ_LEIDOS,
    });

    assert.equal(v.trigger, triggers.TRIGGERS.CHECKS_FAILING, 'el requerido en rojo manda');
    assert.deepEqual(v.checks.failing, ['pr-status']);
    assert.deepEqual(v.securityBlocking.failing, ['runtime-state-guard']);
    assert.deepEqual(v.informational.pending, ['OWASP Dependency Check']);

    // Cada grupo en su propia línea, con su propio encuadre.
    const lineas = v.reason.split('\n');
    const lSec = lineas.find((l) => /bloqueantes por seguridad/i.test(l));
    const lInfo = lineas.find((l) => /Checks informativos/i.test(l));
    assert.ok(lSec, 'la allowlist tiene línea propia');
    assert.ok(lInfo, 'los informativos tienen línea propia');
    assert.notEqual(lSec, lInfo, 'nunca fusionados en la misma oración');
    assert.match(lSec, /runtime-state-guard/);
    assert.doesNotMatch(lSec, /OWASP/, 'un decorativo no se disfraza de bloqueante');
    assert.match(lInfo, /OWASP Dependency Check/);
    assert.doesNotMatch(lInfo, /runtime-state-guard/, 'y un bloqueante no se disfraza de decorativo');
});

test('#6612 UX-1 — un check de la allowlist EN CURSO no bloquea, pero se dice que puede', () => {
    // SEC-B: la allowlist mira `failure`, no `pending`. El texto no puede frenar
    // por él — pero tampoco puede meterlo entre los decorativos, porque si
    // termina en rojo el gate (5c) sí frena y la firma no lo destraba.
    const v = triggers.detectMergeStateBlock({
        prNumber: 6608,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [
            { name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'runtime-state-guard', status: 'IN_PROGRESS', conclusion: '' },
        ],
        ...REQ_LEIDOS,
    });
    assert.equal(v.trigger, triggers.TRIGGERS.CODEOWNERS_REVIEW, 'en curso no es rojo');
    assert.deepEqual(v.securityBlocking.pending, ['runtime-state-guard']);
    assert.match(v.reason, /bloqueantes por seguridad/i);
    assert.deepEqual(v.informational.pending, [], 'no cae en la bolsa de los decorativos');
});

test('#6612 — regresión: un informativo en rojo SIGUE sin frenar y sin cambiar de rótulo', () => {
    // Contraparte del anterior: lo que NO está en la allowlist se comporta
    // exactamente como antes (#6599 CA-3). Sin esto, el fix de UX-1 podría
    // haberse llevado puesto el comportamiento correcto que ya existía.
    const v = triggers.detectMergeStateBlock({
        prNumber: 6609,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        statusCheckRollup: [
            { name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'OWASP Dependency Check', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
        ...REQ_LEIDOS,
    });
    assert.equal(v.trigger, triggers.TRIGGERS.CODEOWNERS_REVIEW);
    assert.deepEqual(v.informational.failing, ['OWASP Dependency Check']);
    assert.deepEqual(v.securityBlocking.failing, []);
    assert.match(v.reason, /no los exige, así que no frenan el merge/);
    assert.match(v.recommendation, /aprobarlo destraba el issue/);
});

test('#6612 anti-código-muerto — el rótulo sale de la allowlist REAL, sin inyectarle nada', () => {
    // `isSecurityBlockingContext` estaba exportado y sólo se usaba para filtrar
    // en `delivery.js`: nunca para rotular. Este test falla si alguien vuelve a
    // desconectar el predicado por default de `detectMergeStateBlock`.
    const { SECURITY_BLOCKING_CONTEXTS } = require('../security-blocking-checks');
    assert.ok(SECURITY_BLOCKING_CONTEXTS.length > 0, 'la allowlist no puede estar vacía');

    for (const ctx of SECURITY_BLOCKING_CONTEXTS) {
        const v = triggers.detectPrHumanBlock({
            number: 6610,
            headRefName: 'agent/6610-x',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BLOCKED',
            reviewDecision: 'REVIEW_REQUIRED',
            statusCheckRollup: [
                { name: 'pr-status', status: 'COMPLETED', conclusion: 'SUCCESS' },
                { name: ctx, status: 'COMPLETED', conclusion: 'FAILURE' },
            ],
        }, { securityAlerts: [], ...REQ_LEIDOS });

        assert.equal(v.trigger, triggers.TRIGGERS.SECURITY_CHECK_RED, `${ctx} debe rotularse bloqueante`);
        const todo = `${v.reason}\n${v.question}\n${v.recommendation}`;
        assert.doesNotMatch(todo, /no frenan el merge/, `${ctx}: contradice al gate (5c)`);
        assert.doesNotMatch(todo, /aprobarlo destraba el issue/, `${ctx}: la firma no lo destraba`);
    }
});

test('#6612 — groupChecksByLabel reparte en tres y no pierde ni duplica nombres', () => {
    const checks = {
        failing: ['pr-status'],
        pending: ['build'],
        informational: { failing: ['OWASP Dependency Check', 'runtime-state-guard'], pending: ['docs'] },
    };
    const g = triggers.groupChecksByLabel(checks, (n) => n === 'runtime-state-guard');
    assert.deepEqual(g.required, { failing: ['pr-status'], pending: ['build'] });
    assert.deepEqual(g.securityBlocking, { failing: ['runtime-state-guard'], pending: [] });
    assert.deepEqual(g.informational, { failing: ['OWASP Dependency Check'], pending: ['docs'] });

    // Conservación: nada se pierde ni se duplica en el reparto.
    const entra = ['pr-status', 'build', 'OWASP Dependency Check', 'runtime-state-guard', 'docs'].sort();
    const sale = [g.required, g.securityBlocking, g.informational]
        .flatMap((x) => [...x.failing, ...x.pending]).sort();
    assert.deepEqual(sale, entra);

    // Forma inesperada => grupos vacíos, nunca una excepción que tumbe el barrido.
    assert.deepEqual(
        triggers.groupChecksByLabel(null, () => false),
        {
            required: { failing: [], pending: [] },
            securityBlocking: { failing: [], pending: [] },
            informational: { failing: [], pending: [] },
        }
    );
});

test('#6612 — el rótulo NO cierra el ciclo de require con security-blocking-checks', () => {
    // `security-blocking-checks.js` importa los enums de `human-block-triggers`
    // en su top-level (CA-23 de #6431). Un require top-level en esta dirección
    // dejaría a uno de los dos leyendo un `exports` a medio poblar, y el síntoma
    // sería un `isSecurityBlockingContext is not a function` intermitente según
    // qué módulo se cargue primero.
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'human-block-triggers.js'), 'utf8');
    const topLevel = SRC.split('\n').filter((l) => /^const .*require\(/.test(l)).join('\n');
    assert.doesNotMatch(topLevel, /security-blocking-checks/, 'el require tiene que ser diferido');
    assert.match(SRC, /require\('\.\/security-blocking-checks'\)/, 'y tiene que existir: si no, no rotula nada');

    // Y carga en cualquier orden.
    const ordenes = [
        ['../security-blocking-checks', '../human-block-triggers'],
        ['../human-block-triggers', '../security-blocking-checks'],
    ];
    for (const orden of ordenes) {
        for (const m of orden) delete require.cache[require.resolve(m)];
        const cargados = orden.map((m) => require(m));
        assert.ok(cargados.every(Boolean), `carga OK en el orden ${orden.join(' -> ')}`);
    }
});
