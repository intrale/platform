#!/usr/bin/env node
// =============================================================================
// skills-deterministicos/report.js — Skill determinístico para `/report` (#2904)
//
// Comando `/report <seccion>` desde Telegram. Cero tokens LLM, lectura de
// dashboard HTTP + fallback FS, render Markdown V2.
//
// Modos de uso:
//   1. Modulo:  const { runReport } = require('./skills-deterministicos/report');
//               const { messages, status } = await runReport('cuota');
//   2. CLI:     node skills-deterministicos/report.js cuota
//               (imprime el primer mensaje a stdout, exit 0 si ok, 1 si invalido)
//
// La separación entre módulo y CLI permite:
//   - El listener-telegram.js consumir runReport() en proceso, sin spawn.
//   - El operador testear/debuggear cualquier sección con un node one-shot.
//   - Los tests poder importar la API sin levantar Telegram.
//
// Whitelist de secciones validada por `lib/telegram-reports.js` (SR-1).
// =============================================================================

'use strict';

const reports = require('../lib/telegram-reports');

/**
 * Genera el reporte solicitado y lo parte en mensajes <=4096 chars si excede.
 *
 * @param {string} section  Nombre del subcomando (agentes/cuota/sistema/...)
 * @returns {Promise<{ messages: string[], status: 'ok'|'help'|'error', section: string|null }>}
 *
 * - `status: 'ok'`: el reporte se generó correctamente. `messages` contiene
 *   1+ chunks Markdown V2 listos para enviar a Telegram con `parse_mode:
 *   'MarkdownV2'`. Si hay más de 1 chunk, cada uno viene con `*N/M*` prefix.
 * - `status: 'help'`: sección inválida o ausente — `messages[0]` contiene
 *   el menú de ayuda canónico (UX-4).
 * - `status: 'error'`: el generador tiró excepción. `messages[0]` tiene un
 *   mensaje user-friendly sin paths del SO (SR-3).
 */
async function runReport(section) {
    const result = await reports.dispatch(section);
    const messages = reports.splitMessage(result.body || '');
    let status = 'ok';
    if (result.kind === 'help') status = 'help';
    else if (result.kind === 'error') status = 'error';
    return {
        messages,
        status,
        section: result.section || null,
    };
}

/**
 * Helper para que el caller arme la respuesta a Telegram con fallback HTML
 * si el envío MarkdownV2 falla (TR-4: fallback automático a HTML + <pre>).
 *
 * @param {string} mdBody  String Markdown V2 ya escapado.
 * @returns {{ markdown: string, html: string }}
 */
function buildFallbacks(mdBody) {
    // Para HTML: envolver el cuerpo en <pre> evita problemas con el bold/code
    // de Markdown. Escapamos los caracteres HTML especiales del texto plano
    // (después de "desescapar" los backslashes de MarkdownV2 que sobrarían).
    const unescaped = String(mdBody)
        .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');
    const html = `<pre>${reports.escapeHtml(unescaped)}</pre>`;
    return { markdown: mdBody, html };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

async function mainCli() {
    const args = process.argv.slice(2);

    // Self-check (consistente con delivery.js / tester.js).
    if (args.includes('--self-check')) {
        const failures = [];
        // 1. runReport('foo') debe devolver help.
        try {
            const r = await runReport('foo-invalida');
            if (r.status !== 'help') failures.push('runReport(invalida) debió devolver status=help');
            if (!r.messages[0] || !r.messages[0].includes('Reportes')) {
                failures.push('runReport(invalida) debió incluir el menú de ayuda');
            }
        } catch (e) { failures.push('runReport(invalida) tiró: ' + e.message); }

        // 2. runReport() sin section devuelve help.
        try {
            const r = await runReport();
            if (r.status !== 'help') failures.push('runReport() sin section debió devolver help');
        } catch (e) { failures.push('runReport() sin section tiró: ' + e.message); }

        // 3. runReport('cuota') debe terminar (dashboard puede estar caído, va a FS fallback).
        try {
            const r = await runReport('cuota');
            if (r.status !== 'ok') failures.push('runReport(cuota) debió devolver status=ok (FS fallback OK)');
            if (!Array.isArray(r.messages) || r.messages.length === 0) {
                failures.push('runReport(cuota) debió devolver al menos 1 mensaje');
            }
        } catch (e) { failures.push('runReport(cuota) tiró: ' + e.message); }

        if (failures.length > 0) {
            process.stderr.write(`[report] self-check FAIL\n${failures.map(f => '  - ' + f).join('\n')}\n`);
            process.exit(1);
        }
        process.stdout.write('[report] self-check OK\n');
        return;
    }

    const section = args[0];
    const r = await runReport(section);
    // Imprimir cada mensaje separado por --- para que el operador pueda
    // ver el split sin tener que parsear.
    process.stdout.write(r.messages.join('\n\n---\n\n') + '\n');
    if (r.status === 'error') process.exit(1);
    process.exit(0);
}

if (require.main === module) {
    mainCli().catch((e) => {
        process.stderr.write(`[report] fatal: ${e.stack || e.message}\n`);
        process.exit(2);
    });
}

module.exports = {
    runReport,
    buildFallbacks,
    VALID_SECTIONS: reports.VALID_SECTIONS,
    HELP_MENU: reports.HELP_MENU,
};
