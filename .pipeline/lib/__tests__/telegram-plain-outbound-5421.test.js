// =============================================================================
// #5421 — El aviso crítico llega SIN `parse_mode` y sin ser destruido.
//
// Contexto (decisión del operador, 2026-08-06): después de seis ciclos de QA
// parcheando el escapado de Markdown, se cambió de enfoque — los avisos críticos
// del pipeline se mandan en TEXTO PLANO. Un mensaje crítico no puede perderse
// por un problema de formato.
//
// Estos tests cubren los dos puntos donde esa decisión se caía en la práctica, y
// los dos son cruces de proceso o de responsabilidad, no lógica de formato:
//
//   1. `plain` se perdía entre pulpo y svc-telegram. La intención se codificaba
//      OMITIENDO `parse_mode`, y el servicio la reinyectaba con su default.
//   2. El agrupador de ráfagas fusionaba avisos no relacionados y descartaba su
//      texto, perdiéndolos enteros incluso sin ningún error de formato.
//
// Convención del repo: sin credenciales, sin red. Sandbox de env antes del
// require (requerir el servicio sin esto arrancaría el loop del servicio).
// =============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-plain-5421-'));
const PIPELINE_DIR = path.join(SANDBOX, '.pipeline');
process.env.PIPELINE_STATE_DIR = PIPELINE_DIR;
process.env.PIPELINE_DIR_OVERRIDE = PIPELINE_DIR;
fs.mkdirSync(PIPELINE_DIR, { recursive: true });

const svc = require('../../servicio-telegram');
const burstGrouper = require('../telegram-burst-grouper');

// -----------------------------------------------------------------------------
// 1) `plain: true` sobrevive el cruce de proceso
// -----------------------------------------------------------------------------

test('#5421 — `plain:true` produce un saliente SIN parse_mode', () => {
    assert.equal(svc.resolveOutboundParseMode({ text: 'x', plain: true }), null);
});

test('#5421 — REGRESIÓN: omitir parse_mode ya NO alcanza para pedir texto plano', () => {
    // Ésta es la forma vieja de expresar la intención (la que fallaba en silencio).
    // Se documenta como Markdown a propósito: el contrato ahora es explícito, así
    // que un emisor que sólo omita el campo recibe el default histórico. Si algún
    // día alguien "simplifica" el productor volviendo a omitir el flag, este test
    // NO lo protege — lo protege el test de integración de más abajo.
    assert.equal(svc.resolveOutboundParseMode({ text: 'x' }), 'Markdown');
});

test('#5421 — un dropfile legacy con parse_mode explícito conserva su dialecto', () => {
    assert.equal(svc.resolveOutboundParseMode({ text: 'x', parse_mode: 'MarkdownV2' }), 'MarkdownV2');
    assert.equal(svc.resolveOutboundParseMode({ text: 'x', parse_mode: 'HTML' }), 'HTML');
});

test('#5421 — `plain:true` gana sobre un parse_mode presente en el mismo payload', () => {
    assert.equal(svc.resolveOutboundParseMode({ text: 'x', plain: true, parse_mode: 'MarkdownV2' }), null);
});

test('#5421 — sólo el booleano `true` activa el modo plano (default cerrado)', () => {
    // Un valor truthy que no sea `true` estricto no debe desactivar el parseo:
    // el modo plano se pide a propósito, no por accidente de tipos.
    for (const raro of ['true', 1, {}, [], 'plain']) {
        assert.equal(
            svc.resolveOutboundParseMode({ text: 'x', plain: raro }),
            'Markdown',
            `plain=${JSON.stringify(raro)} no debe activar el modo plano`,
        );
    }
    assert.equal(svc.resolveOutboundParseMode({ text: 'x', plain: false }), 'Markdown');
});

test('#5421 — payload ilegible cae al default histórico, no rompe el envío', () => {
    assert.equal(svc.resolveOutboundParseMode(null), 'Markdown');
    assert.equal(svc.resolveOutboundParseMode(undefined), 'Markdown');
    assert.equal(svc.resolveOutboundParseMode('no soy un objeto'), 'Markdown');
});

// -----------------------------------------------------------------------------
// 2) Integración productor → consumidor
//
// El bug vivía ENTRE los dos módulos: cada lado era defendible por separado y el
// contrato se rompía en el medio. Por eso este test recorre el payload real que
// escribe el productor, en vez de afirmar sobre un objeto inventado a mano.
// -----------------------------------------------------------------------------

/**
 * Réplica del armado de payload de `pulpo.js::sendTelegramWithMarkup`.
 *
 * Que sea una réplica es deuda conocida: el test de guarda del final del
 * archivo (#6190) la afirma contra el fuente real, así que si producción cambia
 * y esto no, falla acá en vez de en Telegram.
 */
function payloadDePulpo(msg, { plain, parseMode = 'Markdown' }) {
    const payload = plain ? { text: msg, plain: true } : { text: msg, parse_mode: parseMode };
    // #6190 / SEC-D — sin vista previa en los salientes de texto plano.
    if (plain) payload.disable_web_page_preview = true;
    return payload;
}

test('#5421 — INTEGRACIÓN: el aviso crítico de pulpo llega a Telegram sin parse_mode', () => {
    // Texto realista: un email hostil ya saneado más un path con `_`, que es
    // exactamente lo que venía desbalanceando el Markdown y produciendo el 400.
    const aviso = '🚧 Issue #5421 (pipeline-dev) marcado como needs-human\n'
        + '📝 El pipeline no reconoce al committer "a`b@x.io"\n'
        + '   worktree: platform.agent_5421_pipeline-dev';

    const dropfile = payloadDePulpo(aviso, { plain: true });
    // El dropfile cruza como JSON: si la intención no fuera serializable, se
    // perdería exactamente acá.
    const recibido = JSON.parse(JSON.stringify(dropfile));

    assert.equal(
        svc.resolveOutboundParseMode(recibido), null,
        'el aviso crítico debe viajar sin parse_mode, o Telegram puede rechazarlo con 400',
    );
});

test('#5421 — INTEGRACIÓN: un mensaje NO crítico conserva su formato Markdown', () => {
    const dropfile = payloadDePulpo('*negrita* de un reporte', { plain: false });
    const recibido = JSON.parse(JSON.stringify(dropfile));
    assert.equal(svc.resolveOutboundParseMode(recibido), 'Markdown');
});

// -----------------------------------------------------------------------------
// 3) El agrupador de ráfagas no destruye avisos no relacionados
// -----------------------------------------------------------------------------

/** Entrada de burst como la arma `loadFileSafe` para un `<ts>-cmd.json` del pulpo. */
function avisoDePulpo(file, mtimeMs, text) {
    return {
        ok: true, file, filePath: file, parsed: { text, plain: true }, meta: {},
        mtimeMs, key: 'unknown|unknown|unknown|unknown',
        pid: 'unknown', type: 'unknown', skill: 'unknown', issue: 'unknown',
    };
}

test('#5421 — dos avisos críticos sin metadata NO se consolidan (se perdía el texto)', () => {
    const group = {
        key: 'unknown|unknown|unknown|unknown',
        files: [
            avisoDePulpo('1-cmd.json', 1000, '🚧 Issue #5421 needs-human — committer no reconocido'),
            avisoDePulpo('2-cmd.json', 2000, '🚧 Issue #5999 needs-human — otro aviso distinto'),
        ],
    };

    assert.equal(
        burstGrouper.formatConsolidatedMessage(group), null,
        'sin metadata no es una ráfaga: consolidar descartaría el texto de ambos avisos',
    );
});

test('#5421 — la ráfaga real de cross-provider SÍ se sigue consolidando (no regresión #3668)', () => {
    const intento = (file, mtimeMs, provider) => ({
        ok: true, file, filePath: file,
        parsed: { text: 'fallback' },
        meta: { type: 'cross-provider-fallback', skill: 'pipeline-dev', issue: '5421', provider },
        mtimeMs, key: '123|cross-provider-fallback|pipeline-dev|5421',
        pid: '123', type: 'cross-provider-fallback', skill: 'pipeline-dev', issue: '5421',
    });
    const group = {
        key: '123|cross-provider-fallback|pipeline-dev|5421',
        files: [intento('a.json', 1000, 'anthropic'), intento('b.json', 1007, 'openai')],
    };

    const out = burstGrouper.formatConsolidatedMessage(group);
    assert.ok(out, 'una ráfaga con metadata debe seguir consolidándose');
    assert.match(out, /2 intentos/, 'el consolidado enumera los intentos');
    assert.match(out, /5421/, 'el consolidado conserva el issue');
});

test('#5421 — alcanza con que UN archivo del grupo traiga metadata para consolidar', () => {
    const conMeta = {
        ok: true, file: 'a.json', filePath: 'a.json', parsed: { text: 'x' },
        meta: { type: 'cost-anomaly' }, mtimeMs: 1000,
        key: 'k', pid: '1', type: 'cost-anomaly', skill: 'unknown', issue: 'unknown',
    };
    const sinMeta = avisoDePulpo('b.json', 1500, 'otro');
    const out = burstGrouper.formatConsolidatedMessage({ key: 'k', files: [conMeta, sinMeta] });
    assert.ok(out, 'el grupo declara un tipo conocido: es una ráfaga legítima');
});

// -----------------------------------------------------------------------------
// 4) #6190 / SEC-D — el saliente de texto plano va SIN vista previa
//
// Complemento defensivo del filtro de enlaces de `decision-card.js`: el aviso
// del canal de bloqueados cita texto que escribió un tercero (el repo es
// público), y la vista previa es una segunda superficie por la que el contenido
// de ese tercero se dibuja adentro del mensaje del pipeline.
//
// Vale la misma advertencia que en el módulo: esto NO reemplaza al filtro. Si
// estos tests pasaran y el filtro estuviera roto, el enlace seguiría llegando
// tappable — quien protege es `URL_RE` (ver `decision-card.test.js`, SEC-D).
// -----------------------------------------------------------------------------

test('#6190 — `disable_web_page_preview:true` sobrevive el cruce de proceso', () => {
    assert.equal(svc.resolveOutboundPreview({ text: 'x', disable_web_page_preview: true }), true);
});

test('#6190 — default cerrado: sin el campo, el saliente conserva la vista previa', () => {
    assert.equal(svc.resolveOutboundPreview({ text: 'x' }), false);
    assert.equal(svc.resolveOutboundPreview({ text: 'x', disable_web_page_preview: false }), false);
});

test('#6190 — sólo el booleano `true` desactiva la previa (default cerrado sobre el tipo)', () => {
    for (const raro of ['true', 1, {}, [], 'plain']) {
        assert.equal(
            svc.resolveOutboundPreview({ text: 'x', disable_web_page_preview: raro }),
            false,
            `disable_web_page_preview=${JSON.stringify(raro)} no debe contar como declaración`,
        );
    }
});

test('#6190 — payload ilegible no rompe el envío', () => {
    assert.equal(svc.resolveOutboundPreview(null), false);
    assert.equal(svc.resolveOutboundPreview(undefined), false);
    assert.equal(svc.resolveOutboundPreview('no soy un objeto'), false);
});

test('#6190 — INTEGRACIÓN: el aviso plano de pulpo pide explícitamente sin previa', () => {
    // Mismo recorrido que el test de `plain`: payload del productor → JSON →
    // consumidor. El bug de #5421 vivía justo en ese cruce.
    const dropfile = payloadDePulpo('🚧 #6190 «enlace omitido» esperando tu decisión', { plain: true });
    const recibido = JSON.parse(JSON.stringify(dropfile));
    assert.equal(svc.resolveOutboundParseMode(recibido), null);
    assert.equal(svc.resolveOutboundPreview(recibido), true,
        'el saliente de texto plano debe viajar con disable_web_page_preview');
});

test('#6190 — un saliente con formato (no plano) conserva su vista previa', () => {
    // La previa sólo se apaga donde se cita texto externo. Un reporte con
    // Markdown que el pipeline arma entero no pierde nada por tenerla.
    const recibido = JSON.parse(JSON.stringify(payloadDePulpo('*reporte*', { plain: false })));
    assert.equal(svc.resolveOutboundPreview(recibido), false);
});

test('#6190 — GUARDA: la réplica de payload de este test no divergió de pulpo.js', () => {
    // `payloadDePulpo` es una RÉPLICA del armado real. Una réplica que diverge
    // deja los dos tests de integración de arriba verdes mientras producción
    // manda otra cosa — que es exactamente la clase de fallo que se rechazó dos
    // veces en este issue (una tabla/secuencia duplicada que se separó del
    // original). Se afirma contra el fuente real de `pulpo.js`.
    const pulpoSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'pulpo.js'), 'utf8');
    assert.ok(
        /if \(plain\) payload\.disable_web_page_preview = true;/.test(pulpoSrc),
        'pulpo.js ya no marca los salientes planos como sin-previa: la réplica de este test quedó desactualizada',
    );
    assert.ok(
        /const payload = plain \? \{ text: msg, plain: true \}/.test(pulpoSrc),
        'cambió el armado de payload de pulpo.js: actualizar `payloadDePulpo`',
    );
});
