// chat-panel.js (view module) — generación de markup del panel (#3605).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const chatPanel = require('../../views/log-viewer/chat-panel');

test('parseLogFileName extrae issue y skill del formato canónico', () => {
    assert.deepEqual(chatPanel.parseLogFileName('3559.guru.log'), { issue: '3559', skill: 'guru' });
    assert.deepEqual(chatPanel.parseLogFileName('123.tester.log'), { issue: '123', skill: 'tester' });
});

test('parseLogFileName maneja build-NNN.log legacy', () => {
    assert.deepEqual(chatPanel.parseLogFileName('build-3520.log'), { issue: '3520', skill: 'build' });
});

test('parseLogFileName rechaza nombres inválidos', () => {
    assert.equal(chatPanel.parseLogFileName('whatever.log'), null);
    assert.equal(chatPanel.parseLogFileName(''), null);
    assert.equal(chatPanel.parseLogFileName(null), null);
    assert.equal(chatPanel.parseLogFileName(123), null);
});

test('buildChatPanel devuelve css/html/js/sprite', () => {
    const bundle = chatPanel.buildChatPanel({
        logFile: '3559.guru.log',
        issue: '3559',
        skill: 'guru',
        fase: 'dev',
    });
    assert.equal(typeof bundle.css, 'string');
    assert.equal(typeof bundle.html, 'string');
    assert.equal(typeof bundle.js, 'string');
    assert.equal(typeof bundle.sprite, 'string');
    assert.ok(bundle.css.length > 0);
    assert.ok(bundle.html.length > 0);
    assert.ok(bundle.js.length > 0);
});

test('buildPanelHtml inyecta data attributes saneados', () => {
    const html = chatPanel._buildPanelHtml({
        logFile: '3559.guru.log',
        issue: '3559',
        skill: 'guru',
        fase: 'dev',
    });
    assert.match(html, /data-logfile="3559\.guru\.log"/);
    assert.match(html, /data-issue="3559"/);
    assert.match(html, /data-skill="guru"/);
    assert.match(html, /data-fase="dev"/);
});

test('buildPanelHtml escapa caracteres HTML en data attributes (defensa XSS)', () => {
    const html = chatPanel._buildPanelHtml({
        logFile: '<script>alert(1)</script>',
        issue: '"><script>',
        skill: 'g&u',
        fase: "x'y",
    });
    // No debe contener tags ejecutables
    assert.doesNotMatch(html, /data-logfile="<script>/);
    assert.match(html, /data-logfile="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
    assert.match(html, /data-issue="&quot;&gt;&lt;script&gt;"/);
    assert.match(html, /data-skill="g&amp;u"/);
    assert.match(html, /data-fase="x&#39;y"/);
});

test('buildPanelHtml renderiza estructura accesible (aria-labels, role)', () => {
    const html = chatPanel._buildPanelHtml({ logFile: '1.x.log', issue: '1', skill: 'x', fase: '' });
    assert.match(html, /aria-label="Chat con agente"/);
    assert.match(html, /aria-label="Expandir o colapsar chat con agente"/);
    assert.match(html, /aria-label="Mensaje al agente"/);
    assert.match(html, /aria-label="Enviar mensaje al agente"/);
    assert.match(html, /role="button"/);
    assert.match(html, /role="log"/);
    assert.match(html, /maxlength="2000"/);
});

test('PANEL_CSS define las clases visuales clave', () => {
    assert.match(chatPanel.PANEL_CSS, /\.chat-panel/);
    assert.match(chatPanel.PANEL_CSS, /\.chat-bubble\.is-operator/);
    assert.match(chatPanel.PANEL_CSS, /\.chat-bubble\.is-agent/);
    assert.match(chatPanel.PANEL_CSS, /\.chat-input/);
    assert.match(chatPanel.PANEL_CSS, /\.chat-dead-cover/);
    // Usa custom properties --chat-* (sin hex hardcoded — CA-UX-1)
    assert.match(chatPanel.PANEL_CSS, /var\(--chat-operator/);
    assert.match(chatPanel.PANEL_CSS, /var\(--chat-agent/);
});

test('PANEL_JS hooks de teclado: Enter envía, Esc colapsa', () => {
    assert.match(chatPanel.PANEL_JS, /e\.key === 'Enter' && !e\.shiftKey/);
    assert.match(chatPanel.PANEL_JS, /e\.key === 'Escape'/);
    // Atajo global Ctrl+/
    assert.match(chatPanel.PANEL_JS, /e\.key === '\/'/);
});

test('PANEL_JS hace POST /api/agent-chat con content-type JSON', () => {
    assert.match(chatPanel.PANEL_JS, /fetch\('\/api\/agent-chat'/);
    assert.match(chatPanel.PANEL_JS, /'Content-Type': 'application\/json'/);
});

test('PANEL_JS hace GET /api/agent-chat/history con logFile', () => {
    assert.match(chatPanel.PANEL_JS, /fetch\('\/api\/agent-chat\/history\?logFile='/);
});

test('PANEL_JS aplica rate limit cliente (10 msg/s)', () => {
    assert.match(chatPanel.PANEL_JS, /sentTimestamps\.length >= 10/);
});

test('PANEL_JS aplica timeout 5s del envío', () => {
    assert.match(chatPanel.PANEL_JS, /SEND_TIMEOUT_MS = 5000/);
});

// ---------------------------------------------------------------------------
// #3718 — desincronía agent-registry: 412 (post-restart) vs 410 (terminado),
// preservación del input al fallar, y traducción del reason a copy de operador.
// ---------------------------------------------------------------------------

test('PANEL_JS discrimina 412 (recuperable) de 410 (terminado)', () => {
    // 412 → estado recuperable con reconexión
    assert.match(chatPanel.PANEL_JS, /res\.status === 412/);
    assert.match(chatPanel.PANEL_JS, /markAgentUnavailable/);
    // 410 → estado terminal
    assert.match(chatPanel.PANEL_JS, /res\.status === 410/);
    assert.match(chatPanel.PANEL_JS, /markAgentDead/);
    // Son dos ramas distintas, no el mismo tratamiento genérico
    assert.notEqual(
        chatPanel.PANEL_JS.indexOf('markAgentUnavailable'),
        chatPanel.PANEL_JS.indexOf('markAgentDead'),
    );
});

test('PANEL_JS preserva el input al fallar el envío (G-3 / TC-4)', () => {
    // Existe la función de restauración y se invoca en el path de fallo
    assert.match(chatPanel.PANEL_JS, /function restoreInput/);
    assert.match(chatPanel.PANEL_JS, /function onSendFailed/);
    assert.match(chatPanel.PANEL_JS, /restoreInput\(raw\)/);
    // Sólo restaura si el input quedó vacío (no pisa escritura nueva del operador)
    assert.match(chatPanel.PANEL_JS, /if \(!\(inputEl\.value \|\| ''\)\.trim\(\)\)\{\s*inputEl\.value = raw;/);
});

test('PANEL_JS traduce el reason técnico a copy de operador (RS-2: no expone reason crudo)', () => {
    assert.match(chatPanel.PANEL_JS, /function reasonToCopy/);
    // Copy específico para el caso post-restart (causa raíz del issue)
    assert.match(chatPanel.PANEL_JS, /agent_alive_pulpo_restarted_or_no_interactive/);
    assert.match(chatPanel.PANEL_JS, /El pipeline se reinició hace poco/);
    assert.match(chatPanel.PANEL_JS, /orphan_heartbeat/);
    assert.match(chatPanel.PANEL_JS, /heartbeat_expired/);
    // RS-2: markAgentDead ya NO concatena el reason crudo al cartel
    assert.doesNotMatch(chatPanel.PANEL_JS, /'Sin agente activo — ' \+ reason/);
});

test('PANEL_JS expone acciones de recuperación Reintentar / Ver logs (G-2)', () => {
    assert.match(chatPanel.PANEL_JS, /function retryConnection/);
    assert.match(chatPanel.PANEL_JS, /function viewLogs/);
    assert.match(chatPanel.PANEL_JS, /function clearAgentState/);
    // Reintentar reenvía el último mensaje fallido
    assert.match(chatPanel.PANEL_JS, /lastFailedMessage/);
    assert.match(chatPanel.PANEL_JS, /retryBtn\.addEventListener\('click', retryConnection\)/);
    assert.match(chatPanel.PANEL_JS, /viewLogsBtn\.addEventListener\('click', viewLogs\)/);
});

test('PANEL_JS limpia el estado de no-disponible tras un envío exitoso', () => {
    // En el path 200 OK se invoca clearAgentState() (reconexión transparente)
    assert.match(chatPanel.PANEL_JS, /updateBubbleStatus\(bubble, 'sent'\);[\s\S]*?clearAgentState\(\);/);
});

test('PANEL_CSS define el estado recuperable y los botones del cover (#3718)', () => {
    assert.match(chatPanel.PANEL_CSS, /\.chat-panel\.is-agent-unavailable/);
    assert.match(chatPanel.PANEL_CSS, /\.chat-cover-actions/);
    assert.match(chatPanel.PANEL_CSS, /\.chat-cover-btn/);
    // El estado recuperable usa color de advertencia, no el rojo de error
    assert.match(chatPanel.PANEL_CSS, /is-agent-unavailable[\s\S]*?--chat-status-pending/);
});

test('buildPanelHtml renderiza el cover con mensaje + botones de recuperación', () => {
    const html = chatPanel._buildPanelHtml({ logFile: '1.x.log', issue: '1', skill: 'x', fase: 'dev' });
    assert.match(html, /id="chat-cover-msg"/);
    assert.match(html, /id="chat-retry-btn"/);
    assert.match(html, /id="chat-viewlogs-btn"/);
    assert.match(html, /aria-label="Reintentar conexión con el agente"/);
    assert.match(html, /aria-label="Ver logs del agente"/);
});
