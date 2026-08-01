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
    // Antigüedad por ítem y garantía explícita de que nada se aprueba solo.
    assert.match(msg, /30h/);
    assert.match(msg, /nada se aprueba solo/i);
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
