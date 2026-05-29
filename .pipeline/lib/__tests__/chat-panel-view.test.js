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
