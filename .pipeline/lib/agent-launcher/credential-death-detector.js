// =============================================================================
// agent-launcher/credential-death-detector.js — Detección ESTRUCTURAL de
// "muerte por credencial vencida" en la cola del log stream-json de un agente.
// Issue #6238 (hermano de #4648, que introdujo provider-death / agent-death).
//
// QUÉ ES
// ------
// Una señal TIPADA que significa exactamente una cosa: **el CLI del provider
// rechazó la sesión/credencial y por eso el proceso murió a los pocos segundos**.
// Nada más. No es cuota, no es 5xx, no es permisos, no es un crash del agente.
//
// POR QUÉ EXISTE
// --------------
// El 2026-08-20, entre 12:49 y 13:27, #6226 y #6146 rebotaron 4 veces cada uno
// muriendo a los 2 segundos con una sesión OAuth vencida.
// `classifyPrematureDeath()` decidía SÓLO por `source`, así que un spawn por
// primary quedaba clasificado `agent-death` ⇒ `registerFastFail` + cooldown de
// hasta 60 min al `(skill,issue)` ⇒ reintento cada 15 min contra la MISMA
// credencial muerta. Una credencial vencida no se arregla reintentando.
//
// SEGURIDAD — POR QUÉ ESTA SEÑAL NO PUEDE FILTRAR SECRETOS NI SER INDUCIDA
// -----------------------------------------------------------------------
// (Contrato escrito, mismo espíritu que `auth-rejection.js:1-52`.)
//
// 1. NUNCA copiamos texto del provider al retorno. `token` sólo puede tomar
//    valores que ya viven en la tabla cerrada `CREDENTIAL_DEATH_TOKENS`: para
//    emitirlo hubo que matchear por IGUALDAD contra esa tabla, así que el
//    string devuelto es NUESTRO, no del payload. No hay ningún campo del
//    retorno donde un mensaje, header, token, stdout o stderr pueda viajar.
//
// 2. NUNCA decidimos por substring sobre texto libre (SEC-1 del issue). La
//    frase que denuncia el vencimiento de la sesión viaja en
//    `message.content[].text` y en `result` — texto libre que el agente vuelca
//    cuando LEE un issue. El body de #6238 la contiene varias veces: un
//    detector por substring se auto-envenenaría y, peor, cualquier persona
//    anónima podría comentar esa frase en un issue público y apagar el provider
//    de todo el pipeline (DoS disparable desde afuera).
//
// 3. La señal confiable es el par TOP-LEVEL del frame parseado:
//       frame.error === 'authentication_failed' && frame.is_api_error_message === true
//    Son campos que emite el CLI en su propio frame de stream-json, no
//    contenido del agente. El contenido no confiable (body/comments del issue,
//    `tool_result`, archivos leídos) viaja ESCAPADO DENTRO de un campo string
//    del frame: `JSON.parse` de la línea devuelve el frame externo, cuyo
//    `error` top-level es `undefined`. Para forjar la firma habría que emitir
//    una línea de stream-json propia por stdout — cosa que el contenido no
//    puede hacer.
//
// PROHIBIDO EN ESTE MÓDULO (invariantes, no preferencias de estilo)
// ----------------------------------------------------------------
//   * `includes()` / regex / substring sobre texto plano del log.
//   * Leer `message`, `message.content[].text`, `result`, `error_description`,
//     `detail` o cualquier otro campo que transporte texto del modelo o del
//     provider. Sólo campos top-level del frame, comparados por igualdad.
//   * El patrón `401`: aparece en 26 de 40 `.attempt-*.log` SANOS (65% de
//     falsos positivos — SEC-2). No se implementa; hay test negativo.
//   * `num_turns <= 1` / `output_tokens === 0` como condición NECESARIA: el
//     frame real de una muerte por credencial trae `num_turns: 110`
//     (evidencia: `.pipeline/logs/5213-pipeline-dev.attempt-1.log`). El gate de
//     "muerte prematura" ya lo aporta `elapsedSec < 15` en el caller.
//   * IO de cualquier tipo. La función es PURA: el caller le pasa el texto ya
//     leído (y ya sanitizado por `createSanitizeStream`, #2334).
//
// FAIL-CLOSED: tail vacío, `null`, no-string, o sin una sola línea parseable ⇒
// `{ matched:false, token:null, signature:null }`. Nunca tira, nunca clasifica
// `credential-death` "por las dudas".
//
// NOTA DE COORDINACIÓN (UX, #6238): la clave de dedupe del aviso al operador se
// deriva del PROVIDER, nunca de datos del log. Ese eje debería compartirse con
// los otros emisores que hablan del mismo incidente (#6179, #6197, #6239)
// cuando #6244 extraiga el helper de dedupe.
//
// Sin dependencias (Node puro, sin `require`).
// =============================================================================
'use strict';

// -----------------------------------------------------------------------------
// Tabla CERRADA de identificadores de rechazo de credencial. El valor devuelto
// en `token` sale de acá, matcheado por igualdad contra `frame.error`. Ampliar
// esta tabla es la ÚNICA forma legítima de extender la detección: agregar un
// token acá obliga a agregar su test positivo y su fixture.
// -----------------------------------------------------------------------------
const CREDENTIAL_DEATH_TOKENS = Object.freeze(['authentication_failed']);

// Código de `{` — comparamos por charCode para no tentarnos con substring.
const OPEN_BRACE = 123;

// Resultado canónico de "no matcheó". Se construye fresco en cada retorno para
// que ningún caller pueda mutar un objeto compartido.
function noMatch() {
    return { matched: false, token: null, signature: null };
}

function isPlainFrame(f) {
    return !!f && typeof f === 'object' && !Array.isArray(f);
}

/**
 * detectCredentialDeath — busca la firma estructural de credencial rechazada en
 * la cola del log stream-json de un agente. PURA, sin IO.
 *
 * Firma A (NECESARIA y suficiente):
 *   `frame.error === '<token de la tabla cerrada>'` **y**
 *   `frame.is_api_error_message === true`
 *
 * Firma B (REFUERZO, opcional — sola NO clasifica):
 *   `frame.type === 'result'` **y** `frame.is_error === true` **y**
 *   `frame.terminal_reason === 'api_error'`
 *   Un 5xx terminal produce exactamente este frame, así que por sí sola sería
 *   un falso positivo. Sólo eleva `signature` a `'A+B'` cuando A ya matcheó en
 *   el mismo tail.
 *
 * @param {string} logTail cola del log (texto ya leído por el caller).
 * @returns {{ matched: boolean, token: string|null, signature: 'A'|'A+B'|null }}
 */
function detectCredentialDeath(logTail) {
    // Fail-closed ante cualquier entrada que no sea un string con contenido.
    if (typeof logTail !== 'string' || logTail.length === 0) return noMatch();

    let sawA = false;
    let sawB = false;
    let token = null;

    const lines = logTail.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trimStart();
        // Sólo líneas que arrancan como objeto JSON. Prosa, banners del CLI y
        // la primera línea truncada del slice se descartan sin ruido.
        if (t.charCodeAt(0) !== OPEN_BRACE) continue;
        let frame;
        try {
            frame = JSON.parse(t);
        } catch {
            // Línea partida a la mitad (slice del tail) o JSON inválido: se
            // descarta, NO rompe el barrido.
            continue;
        }
        if (!isPlainFrame(frame)) continue;

        // --- Firma A: par top-level emitido por el CLI, no por el agente. ---
        if (typeof frame.error === 'string' && frame.is_api_error_message === true) {
            const idx = CREDENTIAL_DEATH_TOKENS.indexOf(frame.error);
            if (idx !== -1) {
                sawA = true;
                // Valor de NUESTRA tabla cerrada (igualdad ya verificada por el
                // indexOf), nunca una copia de texto del provider.
                token = CREDENTIAL_DEATH_TOKENS[idx];
            }
        }

        // --- Firma B: refuerzo terminal. Sola NO clasifica. ---
        if (frame.type === 'result'
            && frame.is_error === true
            && frame.terminal_reason === 'api_error') {
            sawB = true;
        }
    }

    if (!sawA) return noMatch();
    return { matched: true, token, signature: sawB ? 'A+B' : 'A' };
}

module.exports = {
    detectCredentialDeath,
    CREDENTIAL_DEATH_TOKENS,
};
