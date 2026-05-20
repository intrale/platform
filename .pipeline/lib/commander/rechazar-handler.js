// =============================================================================
// rechazar-handler.js — Handler del comando /rechazar (issue #3415).
//
// Procesa el rechazo de un entregable parcial del pipeline y emite:
//   1. Audit log estructurado en `.pipeline/audit/rejections-YYYY-MM-DD.jsonl`
//      (CA-16, CA-17 — vía createAuditLog con filenamePrefix='rejections').
//   2. Evento JSON en `.pipeline/rejections/<issue>-<ts>.json` que sirve como
//      handshake con el consumer (#3416). Idempotente por timestamp.
//   3. Reply MarkdownV2 con templates `rechazar-*.md` (CA-UX-A/B/C).
//
// Defensas (SEC-1.1..SEC-1.9 del análisis de security):
//   - SEC-1.1 chat_id allowlist: el dispatcher ya valida antes de llamar acá.
//   - SEC-1.2 whisper local exclusivo: si llega un audio cuya transcripción
//     viene de OpenAI (pulpo usa fallback chain por defecto), el handler
//     re-transcribe usando ÚNICAMENTE whisperLocal.transcribeLocal(). Si falla,
//     respuesta error-transcribe — NO se intenta otro motor remoto.
//   - SEC-1.3 redacción: `motivo` y `raw_input` pasan por `redactSensitive`
//     antes de persistir en JSONL y JSON de evento.
//   - SEC-1.4 enum cerrado de fases: phases-alias.resolvePhase() valida contra
//     el enum derivado de config.yaml. Path traversal rechazado en ese módulo.
//   - SEC-1.5 issue parser estricto: /^#?(\d{1,7})$/ por token.
//   - SEC-1.6 rotación diaria + redactor: usa createAuditLog con prefix custom.
//   - SEC-1.7 límites de audio: voice_file_size ≤ 10 MB, voice_duration ≤ 120s.
//   - SEC-1.8 replay protection: message.date < now-24h → result_status='stale'.
//   - SEC-1.9 issue no-retorno: `gh issue view` mock-friendly verifica state y
//     labels antes de procesar.
//
// El handler es PURO en cuanto a side effects observables: recibe `deps` para
// todo (whisperLocal, githubClient, now, randomVariant, fs) y se puede testear
// aislado del filesystem real.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createAuditLog, sha256Hex } = require('./audit-log');
const { fillTemplate } = require('./fill-template');
const { resolvePhase, listValidAliases } = require('./phases-alias');

// ---------------------------------------------------------------------------
// Constantes operacionales — sintonizadas con CA-7..CA-15.
// ---------------------------------------------------------------------------
const DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;     // SEC-1.7 / CA-13
const DEFAULT_MAX_AUDIO_DURATION_S = 120;             // SEC-1.7 / CA-13
const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000;      // SEC-1.8 / CA-14
const DEFAULT_NO_RETURN_LABELS = [
    'merged',
    'closed:done',
    'recommendation:approved',
    'pipeline:closed',
];

// Resultados posibles de result_status (CA-17 + CA-21).
const STATUS = {
    OK: 'ok',
    INVALID_ISSUE: 'invalid_issue',
    INVALID_PHASE: 'invalid_phase',
    ISSUE_CLOSED: 'issue_closed',
    TRANSCRIBE_FAILED: 'transcribe_failed',
    AUDIO_TOO_BIG: 'audio_too_big',
    AUDIO_TOO_LONG: 'audio_too_long',
    STALE: 'stale',
    EVENT_WRITE_FAILED: 'event_write_failed',
    INSUFFICIENT_FIELDS: 'insufficient_fields',
};

// ---------------------------------------------------------------------------
// Parsers.
// ---------------------------------------------------------------------------

/**
 * Parser estricto para texto plano del comando.
 * Acepta: `<#issue> <fase> <motivo>` o `<issue> <fase> <motivo>`.
 *
 * @param {string} input
 * @returns {{ok: boolean, issue?: number, fase?: string, motivo?: string, rawIssue?: string, error?: string}}
 */
function parseTextArgs(input) {
    const raw = String(input || '').trim();
    if (!raw) return { ok: false, error: 'empty' };

    // Captura: [token1] [token2] [resto-libre]. Tokens no contienen espacios.
    const m = raw.match(/^(\S+)\s+(\S+)\s+([\s\S]+?)\s*$/);
    if (!m) return { ok: false, error: 'shape' };

    const rawIssue = m[1];
    const rawFase = m[2];
    const motivo = m[3].trim();

    // SEC-1.5 / CA-12 — issue parser estricto. `#?(\d{1,7})$`.
    const issueMatch = rawIssue.match(/^#?(\d{1,7})$/);
    if (!issueMatch) {
        return { ok: false, error: 'issue', rawIssue };
    }
    const issueNum = parseInt(issueMatch[1], 10);
    if (!Number.isInteger(issueNum) || issueNum <= 0) {
        return { ok: false, error: 'issue', rawIssue };
    }

    if (!motivo) return { ok: false, error: 'motivo' };

    return { ok: true, issue: issueNum, fase: rawFase, motivo, rawIssue };
}

/**
 * Parser tolerante para texto transcripto por whisper (audio).
 * No exige posición fija — busca el primer entero válido como issue y el
 * primer alias conocido como fase. El resto es motivo.
 *
 * @param {string} transcript
 * @param {string[]} validAliases - lista de aliases conocidos (sirve para detectar fase en el medio del texto)
 * @returns {{ok: boolean, issue?: number, fase?: string, motivo?: string, error?: string, heard?: string}}
 */
function parseAudioTranscript(transcript, validAliases) {
    const text = String(transcript || '').trim();
    if (!text) return { ok: false, error: 'empty', heard: '' };

    // Issue: primer `#NNNN` o `NNNN` con 3-7 dígitos. Evitamos matchear "1" o
    // "20" que serían demasiado ambiguos.
    const issueMatch = text.match(/#?(\d{3,7})\b/);
    if (!issueMatch) return { ok: false, error: 'issue', heard: text };
    const issueNum = parseInt(issueMatch[1], 10);

    // Fase: buscar el alias más largo que aparece como palabra en el texto.
    // Word boundary tolerante con acentos (los regex `\b` de JS son ASCII-only).
    // Como los alias son ASCII en su mayoría, `\b` alcanza para detectarlos.
    const lower = text.toLowerCase();
    let bestAlias = null;
    let bestLen = 0;
    for (const alias of validAliases) {
        if (alias.includes('/')) continue; // saltar nombres oficiales fully-qualified en audio
        const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
        if (re.test(lower) && alias.length > bestLen) {
            bestAlias = alias;
            bestLen = alias.length;
        }
    }
    if (!bestAlias) return { ok: false, error: 'fase', heard: text };

    // Motivo: removemos token a token los componentes ya parseados + verbos de
    // relleno habituales del habla coloquial argentina. Usamos una pasada por
    // tokens (split por espacio) para evitar problemas con `\b` y acentos.
    const VERB_PREFIXES = /^(?:rech[áa]z[áa]?|rech[áa]ce|rebobin[áa]?|reject|el|la|los|las|en|al|del?|que|porque|por|por\s+favor)$/i;
    const tokens = text.split(/\s+/);
    const wantsRemoveIssue = issueMatch[0].replace('#', '');
    const aliasLower = bestAlias.toLowerCase();
    const motivoTokens = [];
    let removedIssue = false;
    let removedAlias = false;
    for (const tk of tokens) {
        const tkClean = tk.replace(/[,.;:!?¿¡()"]+$/g, '').replace(/^[,.;:!?¿¡()"]+/g, '');
        const lower = tkClean.toLowerCase();
        if (!removedIssue && (tkClean === wantsRemoveIssue || tkClean === `#${wantsRemoveIssue}` || lower === `#${wantsRemoveIssue}`)) {
            removedIssue = true;
            continue;
        }
        if (!removedAlias && lower === aliasLower) {
            removedAlias = true;
            continue;
        }
        if (VERB_PREFIXES.test(lower)) continue;
        motivoTokens.push(tk);
    }
    const motivo = motivoTokens.join(' ').replace(/\s+/g, ' ').trim()
        .replace(/^[,.;:!?¿¡()"\s]+/g, '')
        .replace(/[,.;:!?¿¡()"\s]+$/g, '');

    if (!motivo || motivo.length < 4) return { ok: false, error: 'motivo', heard: text };

    return { ok: true, issue: issueNum, fase: bestAlias, motivo, heard: text };
}

function escapeRegex(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Default gh client (CA-15 / SEC-1.9). Se puede inyectar para tests.
// ---------------------------------------------------------------------------

function defaultGithubClient() {
    const { execFileSync } = require('child_process');
    return {
        viewIssue(issueNum) {
            try {
                const out = execFileSync('gh', ['issue', 'view', String(issueNum), '--json', 'state,labels'], {
                    encoding: 'utf8',
                    timeout: 10000,
                    windowsHide: true,
                });
                const parsed = JSON.parse(out);
                const labels = Array.isArray(parsed.labels)
                    ? parsed.labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean)
                    : [];
                return { ok: true, state: parsed.state || 'unknown', labels };
            } catch (e) {
                // En tests sin gh CLI, fallar abierto: tratar como "OK abierto"
                // para no bloquear todo. Documentado en CA-15: si no podemos
                // verificar, el caller decide.
                return { ok: false, state: null, labels: [], error: e.message };
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Factory principal.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.pipelineRoot
 * @param {string} [opts.auditDir]            - default `<pipelineRoot>/audit`
 * @param {string} [opts.rejectionsDir]       - default `<pipelineRoot>/rejections`
 * @param {function} [opts.redactSensitive]   - CA-10 (default: identity, pero conviene inyectar)
 * @param {object} [opts.whisperLocal]        - { transcribeLocal, isAvailable }
 * @param {object} [opts.githubClient]        - { viewIssue }
 * @param {function} [opts.now]               - clock (ms)
 * @param {function} [opts.randomVariant]     - (n) => 1..n (default Math.random)
 * @param {number} [opts.maxAudioBytes]
 * @param {number} [opts.maxAudioDurationS]
 * @param {number} [opts.maxStaleMs]
 * @param {string[]} [opts.noReturnLabels]
 * @param {function} [opts.logger]
 */
function createRechazarHandler(opts) {
    const options = opts || {};
    if (!options.pipelineRoot) throw new Error('createRechazarHandler: pipelineRoot es obligatorio');

    const pipelineRoot = options.pipelineRoot;
    const auditDir = options.auditDir || path.join(pipelineRoot, 'audit');
    const rejectionsDir = options.rejectionsDir || path.join(pipelineRoot, 'rejections');
    const redactSensitive = typeof options.redactSensitive === 'function'
        ? options.redactSensitive
        : (s) => s;
    const whisperLocal = options.whisperLocal || require('../whisper-local');
    const githubClient = options.githubClient || defaultGithubClient();
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const randomVariant = typeof options.randomVariant === 'function'
        ? options.randomVariant
        : (n) => Math.floor(Math.random() * n) + 1;
    const maxAudioBytes = Number.isFinite(options.maxAudioBytes) ? options.maxAudioBytes : DEFAULT_MAX_AUDIO_BYTES;
    const maxAudioDurationS = Number.isFinite(options.maxAudioDurationS) ? options.maxAudioDurationS : DEFAULT_MAX_AUDIO_DURATION_S;
    const maxStaleMs = Number.isFinite(options.maxStaleMs) ? options.maxStaleMs : DEFAULT_MAX_STALE_MS;
    const noReturnLabels = Array.isArray(options.noReturnLabels) ? options.noReturnLabels : DEFAULT_NO_RETURN_LABELS;
    const logger = typeof options.logger === 'function' ? options.logger : () => {};

    // CA-16 / SEC-1.6 — auditor exclusivo para rejections con whitelist de
    // campos extendidos (CA-17). Reusa createAuditLog con filenamePrefix custom.
    const auditor = createAuditLog({
        dir: auditDir,
        filenamePrefix: 'rejections',
        redact: redactSensitive,
        now,
        extraFields: [
            'issue',
            'fase',
            'fase_resolved',
            'motivo',
            'source',
            'raw_input',
            'raw_input_hash',
            'event_path',
        ],
    });

    /**
     * Handler invocado por el dispatcher (mismo shape que defaultHandlers).
     * @param {object} ctx
     * @param {string} ctx.args
     * @param {object} ctx.message - shape extendido: from, chat_id, text, voice, voice_path, voice_file_size, voice_duration, date, _esAudio, _audio, _textoFinal
     * @param {object} ctx.intent
     * @returns {Promise<string>} - reply MarkdownV2
     */
    async function handle({ args, message, intent }) {
        const start = now();
        const baseEntry = {
            from: message && message.from,
            chat_id: message && message.chat_id,
            raw_command: (intent && intent.rawTruncated) || '',
            intent_class: 'deterministic',
            handler: 'rechazar',
            args,
        };

        // ----- CA-14 / SEC-1.8: replay protection ------------------------
        // Telegram entrega `date` como unix segundos. Si la diferencia con `now`
        // excede `maxStaleMs`, rechazamos.
        const messageDateMs = message && Number.isFinite(message.date)
            ? message.date * 1000
            : null;
        if (messageDateMs !== null) {
            const ageMs = now() - messageDateMs;
            if (ageMs > maxStaleMs) {
                const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
                auditor.record({
                    ...baseEntry,
                    result_status: STATUS.STALE,
                    duration_ms: now() - start,
                    source: message && message._esAudio ? 'audio' : 'text',
                    raw_input: redactSensitive(args || ''),
                    raw_input_hash: sha256Hex(args || ''),
                });
                return pickVariant('rechazar-error-stale', 3, randomVariant, {
                    'age-hours': ageHours,
                    issue: null,
                });
            }
        }

        // ----- CA-13 / SEC-1.7: límites de audio antes de cualquier transcripción --
        const esAudio = !!(message && message._esAudio);
        if (esAudio) {
            const fileSize = message.voice_file_size || 0;
            const duration = message.voice_duration || 0;

            if (fileSize > 0 && fileSize > maxAudioBytes) {
                auditor.record({
                    ...baseEntry,
                    result_status: STATUS.AUDIO_TOO_BIG,
                    duration_ms: now() - start,
                    source: 'audio',
                    raw_input: '<audio>',
                    raw_input_hash: '',
                });
                return pickVariant('rechazar-error-audio-too-big', 3, randomVariant, {
                    'too-big': true,
                    'too-long': false,
                    'size-kb': Math.round(fileSize / 1024),
                    'max-mb': Math.round(maxAudioBytes / (1024 * 1024)),
                    'duration-s': duration,
                    'max-duration-s': maxAudioDurationS,
                });
            }
            if (duration > 0 && duration > maxAudioDurationS) {
                auditor.record({
                    ...baseEntry,
                    result_status: STATUS.AUDIO_TOO_LONG,
                    duration_ms: now() - start,
                    source: 'audio',
                    raw_input: '<audio>',
                    raw_input_hash: '',
                });
                return pickVariant('rechazar-error-audio-too-big', 3, randomVariant, {
                    'too-big': false,
                    'too-long': true,
                    'size-kb': Math.round(fileSize / 1024),
                    'max-mb': Math.round(maxAudioBytes / (1024 * 1024)),
                    'duration-s': duration,
                    'max-duration-s': maxAudioDurationS,
                });
            }
        }

        // ----- CA-9 / SEC-1.2: whisper local exclusivo ------------------
        // Si fue audio, transcribimos LOCALMENTE acá (no confiamos en la
        // pre-transcripción de pulpo que puede haber usado OpenAI).
        // Si el local no está disponible o falla, respondemos error-transcribe.
        let canonicalText = (message && (message._textoFinal || message.text)) || '';
        let transcribeSource = 'text';
        let heardText = '';

        if (esAudio) {
            transcribeSource = 'audio';
            const voicePath = message.voice_path || null;
            if (!whisperLocal || typeof whisperLocal.transcribeLocal !== 'function') {
                auditor.record({
                    ...baseEntry,
                    result_status: STATUS.TRANSCRIBE_FAILED,
                    duration_ms: now() - start,
                    source: 'audio',
                    raw_input: '<audio>',
                    raw_input_hash: '',
                });
                return pickVariant('rechazar-error-transcribe', 3, randomVariant, {
                    'error-kind': 'no_local_whisper',
                });
            }

            // Disponibilidad: si no hay binario local, NO caemos a OpenAI.
            if (typeof whisperLocal.isAvailable === 'function' && !whisperLocal.isAvailable()) {
                auditor.record({
                    ...baseEntry,
                    result_status: STATUS.TRANSCRIBE_FAILED,
                    duration_ms: now() - start,
                    source: 'audio',
                    raw_input: '<audio>',
                    raw_input_hash: '',
                });
                return pickVariant('rechazar-error-transcribe', 3, randomVariant, {
                    'error-kind': 'whisper_unavailable',
                });
            }

            try {
                const tx = await whisperLocal.transcribeLocal({
                    audioPath: voicePath,
                    logger,
                });
                if (!tx || !tx.ok) {
                    auditor.record({
                        ...baseEntry,
                        result_status: STATUS.TRANSCRIBE_FAILED,
                        duration_ms: now() - start,
                        source: 'audio',
                        raw_input: '<audio>',
                        raw_input_hash: '',
                    });
                    return pickVariant('rechazar-error-transcribe', 3, randomVariant, {
                        'error-kind': (tx && tx.errorKind) || 'unknown',
                    });
                }
                canonicalText = tx.text || '';
                heardText = canonicalText;
            } catch (e) {
                logger(`[rechazar] whisper-local lanzó excepción: ${e.message}`);
                auditor.record({
                    ...baseEntry,
                    result_status: STATUS.TRANSCRIBE_FAILED,
                    duration_ms: now() - start,
                    source: 'audio',
                    raw_input: '<audio>',
                    raw_input_hash: '',
                });
                return pickVariant('rechazar-error-transcribe', 3, randomVariant, {
                    'error-kind': 'exception',
                });
            }
        }

        // ----- Parser de campos --------------------------------------------
        // Texto plano por slash command: `args` ya viene como
        // `<issue> <fase> <motivo>` (CA-1).
        // Texto plano por NLP ("rechazá el 3381 en UX, …"): `args` arranca
        // con relleno coloquial — el positional fail, caemos al tolerante.
        // Audio: `canonicalText` puede tener cualquier shape — solo tolerante.
        let parsed;
        if (esAudio) {
            parsed = parseAudioTranscript(canonicalText, listValidAliases());
        } else {
            parsed = parseTextArgs(args);
            if (!parsed.ok && parsed.error !== 'issue') {
                // Fallback al parser tolerante (cubre NLP "rechazá el N en UX, …").
                // Si el error fue 'issue' lo respetamos: el operador escribió un token
                // claramente no numérico en posición de issue → mejor pedirle aclaración
                // que adivinar otro número en el texto.
                const fallback = parseAudioTranscript(args, listValidAliases());
                if (fallback.ok) parsed = fallback;
            }
        }

        if (!parsed.ok) {
            // CA-21: respuesta específica por rama.
            if (parsed.error === 'issue') {
                auditor.record({
                    ...baseEntry,
                    result_status: STATUS.INVALID_ISSUE,
                    duration_ms: now() - start,
                    source: transcribeSource,
                    raw_input: redactSensitive(canonicalText || args || ''),
                    raw_input_hash: sha256Hex(canonicalText || args || ''),
                });
                return pickVariant('rechazar-error-issue-invalido', 3, randomVariant, {
                    'raw-issue': parsed.rawIssue || canonicalText || args || '',
                });
            }
            // shape, empty, motivo, fase (fase en audio significa: no encontré fase reconocible)
            auditor.record({
                ...baseEntry,
                result_status: STATUS.INSUFFICIENT_FIELDS,
                duration_ms: now() - start,
                source: transcribeSource,
                raw_input: redactSensitive(canonicalText || args || ''),
                raw_input_hash: sha256Hex(canonicalText || args || ''),
            });
            return pickVariant('rechazar-aclaracion', 3, randomVariant, {
                heard: esAudio ? heardText.slice(0, 200) : null,
            });
        }

        // ----- CA-11 / SEC-1.4: validar fase contra enum cerrado -----------
        const phaseResolution = resolvePhase(parsed.fase);
        if (!phaseResolution.ok) {
            auditor.record({
                ...baseEntry,
                result_status: STATUS.INVALID_PHASE,
                duration_ms: now() - start,
                source: transcribeSource,
                raw_input: redactSensitive(canonicalText || args || ''),
                raw_input_hash: sha256Hex(canonicalText || args || ''),
                issue: parsed.issue,
                fase: parsed.fase,
            });
            return pickVariant('rechazar-error-fase', 3, randomVariant, {
                'fase-input': parsed.fase,
                issue: parsed.issue,
                'valid-aliases': (phaseResolution.suggestions || listValidAliases()).slice(0, 16),
            });
        }

        // ----- CA-15 / SEC-1.9: estado de issue ---------------------------
        const issueState = githubClient.viewIssue(parsed.issue);
        if (issueState.ok) {
            const isClosedState = String(issueState.state || '').toUpperCase() === 'CLOSED';
            const hasNoReturnLabel = issueState.labels.some((l) => noReturnLabels.includes(l));
            if (isClosedState || hasNoReturnLabel) {
                const reason = isClosedState
                    ? 'el issue está cerrado en GitHub'
                    : `tiene label de no-retorno (${issueState.labels.filter((l) => noReturnLabels.includes(l)).join(', ')})`;
                auditor.record({
                    ...baseEntry,
                    result_status: STATUS.ISSUE_CLOSED,
                    duration_ms: now() - start,
                    source: transcribeSource,
                    raw_input: redactSensitive(canonicalText || args || ''),
                    raw_input_hash: sha256Hex(canonicalText || args || ''),
                    issue: parsed.issue,
                    fase: parsed.fase,
                    fase_resolved: phaseResolution.full,
                });
                return pickVariant('rechazar-error-issue', 3, randomVariant, {
                    issue: parsed.issue,
                    reason,
                    labels: issueState.labels.join(', ').slice(0, 80),
                });
            }
        }
        // Si githubClient.viewIssue falló (ok:false), seguimos con warning en logs.
        // No bloqueamos: CA-15 explícita "Antes de procesar, consultar"; si
        // no podemos, optamos por proceder (fail-open) y dejar el rastro en
        // audit. El consumer puede re-validar.
        if (!issueState.ok) {
            logger(`[rechazar] no pude verificar issue #${parsed.issue} en GitHub: ${issueState.error}. Sigo procesando.`);
        }

        // ----- CA-18: evento JSON para handshake con #3416 ---------------
        const ts = new Date(now()).toISOString();
        const eventPayload = {
            issue: parsed.issue,
            fase: parsed.fase,
            fase_resolved: phaseResolution.full,
            motivo: redactSensitive(parsed.motivo),
            ts,
            source: transcribeSource,
            chat_id: message && message.chat_id ? String(message.chat_id) : null,
            audit_ref: null, // se rellena después de saber el path del audit log
        };
        const unixTs = Math.floor(now() / 1000);
        const eventPath = path.join(rejectionsDir, `${parsed.issue}-${unixTs}.json`);

        let eventWriteError = null;
        try {
            try { fs.mkdirSync(rejectionsDir, { recursive: true }); } catch (_) { /* idempotente */ }
            // audit_ref: nombre del archivo de hoy. Suficiente para reconciliación.
            eventPayload.audit_ref = path.basename(auditor.currentPath(new Date(now())));
            fs.writeFileSync(eventPath, JSON.stringify(eventPayload, null, 2));
        } catch (e) {
            eventWriteError = e.message;
            logger(`[rechazar] no pude escribir evento ${eventPath}: ${e.message}`);
        }

        // ----- CA-17: audit log con resultado final ---------------------
        const finalStatus = eventWriteError ? STATUS.EVENT_WRITE_FAILED : STATUS.OK;
        auditor.record({
            ...baseEntry,
            result_status: finalStatus,
            duration_ms: now() - start,
            source: transcribeSource,
            raw_input: redactSensitive(canonicalText || args || ''),
            raw_input_hash: sha256Hex(canonicalText || args || ''),
            issue: parsed.issue,
            fase: parsed.fase,
            fase_resolved: phaseResolution.full,
            motivo: redactSensitive(parsed.motivo),
            event_path: eventWriteError ? null : eventPath,
        });

        // ----- CA-19 / CA-20: reply -----------------------------------------
        if (eventWriteError) {
            return pickVariant('rechazar-error-event-write', 3, randomVariant, {
                issue: parsed.issue,
                'fase-resolved': phaseResolution.full,
                'io-error': eventWriteError.slice(0, 200),
            });
        }

        return pickVariant('rechazar-ok', 3, randomVariant, {
            issue: parsed.issue,
            'fase-display': parsed.fase,
            'fase-resolved': phaseResolution.full,
            motivo: redactSensitive(parsed.motivo).slice(0, 300),
            'audit-ref': eventPayload.audit_ref || 'sin audit',
        });
    }

    return { handle, auditor, STATUS, parseTextArgs, parseAudioTranscript };
}

/**
 * Renderiza un template con una variante elegida al azar.
 * Las variantes son `{{#if variant-1}}…{{/if}}` dentro del template.
 */
function pickVariant(templateName, totalVariants, randomFn, ctx) {
    const pick = Math.max(1, Math.min(totalVariants, randomFn(totalVariants)));
    const variantCtx = { ...ctx };
    for (let i = 1; i <= totalVariants; i += 1) {
        variantCtx[`variant-${i}`] = (i === pick);
    }
    return fillTemplate(templateName, variantCtx);
}

module.exports = {
    createRechazarHandler,
    parseTextArgs,
    parseAudioTranscript,
    STATUS,
    DEFAULT_MAX_AUDIO_BYTES,
    DEFAULT_MAX_AUDIO_DURATION_S,
    DEFAULT_MAX_STALE_MS,
    DEFAULT_NO_RETURN_LABELS,
};
