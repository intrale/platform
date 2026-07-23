// =============================================================================
// chat-panel.js — Panel de chat operador↔agente para el log viewer (#3605)
//
// Provee 3 strings (css, html, js) que generateLogViewerHTML inyecta al
// renderizar el log viewer. Estructurado como módulo aparte para mantener
// dashboard.js manejable (no inflamos el monolito; #3610 cubrirá modularización
// global).
//
// Diseño visual basado en `assets/mockups/21-log-chat-panel.svg` y
// `assets/mockups/narrativa-log-chat-panel.md`. Consume `design-tokens.css`
// sección 3.f (CHAT OPERADOR-AGENTE) — todos los hex viven en var(--chat-*).
//
// API pública:
//   buildChatPanel({ logFile, issue, skill, fase }) →
//     { css, html, js, sprite }
//
// - css/html/js son strings listos para `<style>`, body markup, `<script>`.
// - sprite es el snippet `<svg style="display:none">...</svg>` con los
//   símbolos `ic-chat-*`. Si el log viewer ya inyecta el sprite global, se
//   puede ignorar.
//
// Caller en dashboard.js → generateLogViewerHTML:
//   1. Incluye `sprite` arriba del body (o reutiliza el sprite global).
//   2. Incluye `css` dentro del `<style>` del viewer.
//   3. Incluye `html` adyacente al `#log-body` (sibling, posicionado bottom).
//   4. Incluye `js` al final del `<script>` que ya tiene el viewer.
//
// El componente NO toca `#log-body` directamente; los IDs propios son
// `#chat-panel-*` (no colisiona con el log viewer existente).
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');

// Carga el sprite sólo con los símbolos `ic-chat-*`. Si el sprite no se puede
// leer, devolvemos un fallback inline mínimo (chevrons solamente — la
// funcionalidad básica sigue viva, los avatares se reemplazan por texto).
function loadChatSpriteFromAssets() {
    try {
        const raw = fs.readFileSync(path.join(ASSETS_DIR, 'icons', 'sprite.svg'), 'utf8');
        // Devolver el sprite completo es lo más simple y consistente con cómo
        // los demás views consumen el sprite global. Los símbolos no usados
        // no se renderizan, no hay penalty visual.
        return raw;
    } catch {
        return '<svg style="display:none" aria-hidden="true"></svg>';
    }
}

// Carga la sección 3.f del design-tokens.css. El log viewer ya importa
// `theme.css` (variables base) pero NO los tokens de chat, así que los
// inyectamos acá. Es la única dependencia visual del panel.
function loadChatTokensCss() {
    try {
        const raw = fs.readFileSync(path.join(ASSETS_DIR, 'design-tokens.css'), 'utf8');
        return raw;
    } catch {
        // Fallback minimal: declaramos sólo las custom props que el CSS del
        // panel necesita, con valores legibles. El panel queda funcional pero
        // sin la paleta canónica.
        return `:root{
            --chat-operator:#00D6FF;--chat-operator-bg:rgba(0,214,255,.10);
            --chat-operator-border:rgba(0,214,255,.30);--chat-operator-fg:#E6EDF3;
            --chat-agent:#BC8CFF;--chat-agent-bg:rgba(188,140,255,.10);
            --chat-agent-border:rgba(188,140,255,.30);--chat-agent-fg:#E6EDF3;
            --chat-status-sent:#3FB950;--chat-status-pending:#D29922;--chat-status-failed:#F85149;
            --chat-disabled:#F85149;--chat-disabled-bg:rgba(248,81,73,.10);--chat-disabled-fg:#E6EDF3;
            --chat-panel-bg:#0D1117;--chat-panel-header-bg:#161B22;--chat-panel-input-bg:#161B22;
            --chat-panel-input-field:#0D1117;--chat-panel-divider:#30363D;
            --chat-timestamp-fg:#7D8590;
            --chat-collapsed-accent:#00D6FF;--chat-collapsed-badge-bg:rgba(0,214,255,.18);
        }`;
    }
}

// -----------------------------------------------------------------------------
// CSS del panel — consume tokens `--chat-*` y heredera de `theme.css`.
// -----------------------------------------------------------------------------
const PANEL_CSS = `
/* #3605 — Chat operador↔agente en log viewer */
.chat-panel{position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--chat-panel-bg,#0D1117);border-top:1px solid var(--chat-panel-divider,#30363D);transition:height .15s ease,box-shadow .15s ease;display:flex;flex-direction:column}
.chat-panel.is-collapsed{height:50px;box-shadow:0 -2px 8px rgba(0,0,0,.3)}
.chat-panel.is-expanded{height:30vh;min-height:240px;max-height:60vh;box-shadow:0 -4px 16px rgba(0,0,0,.5)}
.chat-toggle{display:flex;align-items:center;gap:10px;padding:14px 22px;height:50px;cursor:pointer;background:var(--chat-panel-header-bg,#161B22);border-left:3px solid var(--chat-collapsed-accent,#00D6FF);user-select:none}
.chat-toggle:hover{filter:brightness(1.1)}
.chat-toggle-icon{width:18px;height:18px;color:var(--chat-collapsed-accent,#00D6FF);flex-shrink:0}
.chat-toggle-label{font-family:var(--in-font,sans-serif);font-size:13px;color:var(--in-fg,#E6EDF3);font-weight:600}
.chat-toggle-hint{font-family:var(--in-mono,monospace);font-size:11px;color:var(--chat-timestamp-fg,#7D8590);margin-left:auto}
.chat-toggle-badge{background:var(--chat-collapsed-badge-bg,rgba(0,214,255,.18));color:var(--chat-operator,#00D6FF);font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;margin-left:8px}
.chat-toggle-badge.is-hidden{display:none}
.chat-panel.is-expanded .chat-toggle{border-left-color:transparent;border-bottom:1px solid var(--chat-panel-divider,#30363D)}
.chat-panel.is-expanded .chat-toggle-icon{transform:rotate(180deg)}

.chat-history{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.chat-history:empty::before{content:"Sin mensajes — escribí abajo para empezar.";display:block;color:var(--chat-timestamp-fg,#7D8590);font-style:italic;font-size:12px;text-align:center;padding:20px}

.chat-bubble{display:flex;gap:8px;max-width:80%;align-items:flex-start}
.chat-bubble.is-operator{align-self:flex-end;flex-direction:row-reverse}
.chat-bubble.is-agent{align-self:flex-start}
.chat-bubble-avatar{width:28px;height:28px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--chat-operator,#00D6FF)}
.chat-bubble.is-agent .chat-bubble-avatar{border-radius:6px;background:var(--chat-agent,#BC8CFF)}
.chat-bubble-avatar svg{width:16px;height:16px;color:#0D1117}
.chat-bubble-content{display:flex;flex-direction:column;gap:2px;min-width:0}
.chat-bubble-message{padding:8px 12px;border-radius:10px;font-family:var(--in-mono,monospace);font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.chat-bubble.is-operator .chat-bubble-message{background:var(--chat-operator-bg,rgba(0,214,255,.10));border:1px solid var(--chat-operator-border,rgba(0,214,255,.30));border-right:3px solid var(--chat-operator,#00D6FF);color:var(--chat-operator-fg,#E6EDF3)}
.chat-bubble.is-agent .chat-bubble-message{background:var(--chat-agent-bg,rgba(188,140,255,.10));border:1px solid var(--chat-agent-border,rgba(188,140,255,.30));border-left:3px solid var(--chat-agent,#BC8CFF);color:var(--chat-agent-fg,#E6EDF3)}
.chat-bubble-meta{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--chat-timestamp-fg,#7D8590)}
.chat-bubble.is-operator .chat-bubble-meta{justify-content:flex-end}
.chat-bubble-status{width:14px;height:14px;flex-shrink:0}
.chat-bubble-status.is-pending{color:var(--chat-status-pending,#D29922)}
.chat-bubble-status.is-sent{color:var(--chat-status-sent,#3FB950)}
.chat-bubble-status.is-failed{color:var(--chat-status-failed,#F85149)}

.chat-input-row{display:flex;gap:8px;padding:10px 12px;background:var(--chat-panel-input-bg,#161B22);border-top:1px solid var(--chat-panel-divider,#30363D);position:relative}
.chat-input{flex:1;min-height:36px;max-height:120px;resize:none;background:var(--chat-panel-input-field,#0D1117);border:1px solid var(--chat-panel-divider,#30363D);border-radius:6px;color:var(--in-fg,#E6EDF3);padding:8px 12px;font-family:var(--in-mono,monospace);font-size:13px;line-height:1.5;outline:none}
.chat-input:focus{border-color:var(--chat-operator,#00D6FF)}
.chat-input:disabled{opacity:.5;cursor:not-allowed}
.chat-send-btn{background:var(--chat-operator,#00D6FF);color:#0D1117;border:none;border-radius:6px;width:36px;height:36px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;align-self:flex-end}
.chat-send-btn:hover:not(:disabled){filter:brightness(1.1)}
.chat-send-btn:disabled{background:var(--chat-panel-divider,#30363D);color:var(--chat-timestamp-fg,#7D8590);cursor:not-allowed}
.chat-send-btn svg{width:18px;height:18px}
.chat-counter{position:absolute;right:60px;bottom:14px;font-size:11px;color:var(--chat-timestamp-fg,#7D8590);pointer-events:none;font-family:var(--in-mono,monospace)}
.chat-counter.is-warning{color:var(--chat-status-pending,#D29922)}
.chat-counter.is-danger{color:var(--chat-status-failed,#F85149);font-weight:600}

/* Estado: agente muerto (410) o no disponible temporalmente (412 post-restart).
   El cartel cubre toda la zona del input. Layout en columna para alojar el
   mensaje de operador + las acciones de recuperación (#3718). */
.chat-dead-cover{position:absolute;inset:0;background:var(--chat-disabled-bg,rgba(248,81,73,.10));border:1px solid var(--chat-disabled,#F85149);display:none;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--chat-disabled-fg,#E6EDF3);font-size:13px;text-align:center;padding:12px;border-radius:0}
.chat-cover-icon{font-size:16px;line-height:1}
.chat-cover-msg{max-width:520px;line-height:1.4}
.chat-cover-actions{display:none;gap:8px;margin-top:2px}
.chat-cover-btn{background:transparent;border:1px solid var(--chat-operator,#00D6FF);color:var(--chat-operator,#00D6FF);border-radius:6px;padding:5px 12px;font-family:var(--in-font,sans-serif);font-size:12px;font-weight:600;cursor:pointer;line-height:1.2}
.chat-cover-btn:hover{filter:brightness(1.2)}
/* 410 — agente terminado de verdad: cartel rojo, sin acciones de reconexión. */
.chat-panel.is-agent-dead .chat-dead-cover{display:flex}
.chat-panel.is-agent-dead .chat-input,.chat-panel.is-agent-dead .chat-send-btn{visibility:hidden}
/* 412 — agente vivo pero canal IPC no disponible (pulpo reiniciado): cartel de
   advertencia (no error) con acciones Reintentar / Ver logs (#3718 G-1/G-2). */
.chat-panel.is-agent-unavailable .chat-dead-cover{display:flex;background:var(--chat-operator-bg,rgba(0,214,255,.10));border-color:var(--chat-status-pending,#D29922)}
.chat-panel.is-agent-unavailable .chat-dead-cover .chat-cover-actions{display:flex}
.chat-panel.is-agent-unavailable .chat-input,.chat-panel.is-agent-unavailable .chat-send-btn{visibility:hidden}

/* Pantallas chicas: panel ocupa más alto pero el toggle sigue accesible */
@media (max-width:1280px){.chat-panel.is-expanded{height:40vh}}
`;

// -----------------------------------------------------------------------------
// HTML del panel — el caller lo inyecta como último child del body. Recibe los
// metadatos {logFile, issue, skill, fase} como `data-*` attributes para que el
// JS los consuma sin hardcode global.
// -----------------------------------------------------------------------------
function buildPanelHtml({ logFile, issue, skill, fase }) {
    // Encoder simple para data attribute. NO depende del browser-side `esc()`
    // del log viewer porque corremos server-side.
    const dq = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return `
<div class="chat-panel is-collapsed" id="chat-panel"
     data-logfile="${dq(logFile)}" data-issue="${dq(issue)}"
     data-skill="${dq(skill)}" data-fase="${dq(fase)}"
     aria-label="Chat con agente">
  <div class="chat-toggle" id="chat-toggle" role="button" tabindex="0"
       aria-expanded="false" aria-controls="chat-body" aria-label="Expandir o colapsar chat con agente">
    <svg class="chat-toggle-icon" aria-hidden="true"><use href="#ic-chat-bubble"></use></svg>
    <span class="chat-toggle-label">Chat con agente</span>
    <span class="chat-toggle-badge is-hidden" id="chat-badge" aria-live="polite"></span>
    <span class="chat-toggle-hint">Ctrl+/</span>
  </div>
  <div class="chat-body" id="chat-body" style="display:none;flex:1;flex-direction:column;min-height:0">
    <div class="chat-history" id="chat-history" role="log" aria-live="polite" aria-atomic="false"></div>
    <div class="chat-input-row">
      <textarea class="chat-input" id="chat-input"
                placeholder="Escribí un mensaje al agente — Enter envía, Shift+Enter nueva línea"
                aria-label="Mensaje al agente" rows="1" maxlength="2000"></textarea>
      <span class="chat-counter" id="chat-counter" aria-hidden="true">0 / 2000</span>
      <button class="chat-send-btn" id="chat-send" type="button"
              aria-label="Enviar mensaje al agente" disabled>
        <svg aria-hidden="true"><use href="#ic-chat-send"></use></svg>
      </button>
      <div class="chat-dead-cover" id="chat-dead-cover" role="status" aria-live="polite">
        <span class="chat-cover-icon" id="chat-cover-icon" aria-hidden="true">⚠️</span>
        <span class="chat-cover-msg" id="chat-cover-msg">Sin agente activo — esta ejecución ya terminó.</span>
        <div class="chat-cover-actions" id="chat-cover-actions">
          <button class="chat-cover-btn" id="chat-retry-btn" type="button"
                  aria-label="Reintentar conexión con el agente">🔄 Reintentar conexión</button>
          <button class="chat-cover-btn" id="chat-viewlogs-btn" type="button"
                  aria-label="Ver logs del agente">📋 Ver logs</button>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

// -----------------------------------------------------------------------------
// JavaScript del panel — corre en el browser. Se inyecta al final del script
// del log viewer (que ya levanta el SSE del log).
//
// Convención: TODO el código del panel usa el prefijo `chat` para identificadores
// globales (función `chatSend`, var `chatPanel`, etc.) — no colisiona con el
// scope del log viewer (`body`, `allLines`, `processRawLines`).
//
// Persistencia: localStorage por logFile —
//   `chat-collapsed:${logFile}` (bool) → estado colapsado/expandido.
//   El historial NO va a localStorage (vive en .chat.jsonl en el server, se
//   reconstruye via GET /api/agent-chat/history).
// -----------------------------------------------------------------------------
const PANEL_JS = `
(function chatPanelInit(){
  var panel = document.getElementById('chat-panel');
  if (!panel) return; // log viewer sin panel → noop

  var toggle = document.getElementById('chat-toggle');
  var bodyEl = document.getElementById('chat-body');
  var historyEl = document.getElementById('chat-history');
  var inputEl = document.getElementById('chat-input');
  var sendBtn = document.getElementById('chat-send');
  var counterEl = document.getElementById('chat-counter');
  var badgeEl = document.getElementById('chat-badge');
  var coverMsgEl = document.getElementById('chat-cover-msg');
  var coverIconEl = document.getElementById('chat-cover-icon');
  var retryBtn = document.getElementById('chat-retry-btn');
  var viewLogsBtn = document.getElementById('chat-viewlogs-btn');

  var logFile = panel.dataset.logfile || '';
  var issue = panel.dataset.issue || '';
  var skill = panel.dataset.skill || '';
  var fase = panel.dataset.fase || '';

  var STORAGE_KEY = 'chat-collapsed:' + logFile;
  var MAX_CHARS = 2000;
  var WARN_AT = 1800;
  var SEND_TIMEOUT_MS = 5000;

  // ---- helpers DOM ----
  function escapeHtml(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function relativeTime(iso){
    try{
      var t = new Date(iso).getTime();
      var diff = Math.max(0, Date.now() - t);
      if (diff < 60000) return 'hace ' + Math.floor(diff/1000) + 's';
      if (diff < 3600000) return 'hace ' + Math.floor(diff/60000) + ' min';
      if (diff < 86400000) return 'hace ' + Math.floor(diff/3600000) + ' h';
      return new Date(iso).toLocaleString('es-AR');
    } catch(_) { return ''; }
  }

  function statusIconRef(state){
    if (state === 'sent') return '#ic-chat-sent';
    if (state === 'failed') return '#ic-chat-bubble'; // sin ícono dedicado, fallback
    return '#ic-chat-pending';
  }

  // Traduce el \`reason\` técnico del backend (#3721) a lenguaje de operador.
  // RS-2: NUNCA mostramos el string crudo (puede filtrar detalle interno); el
  // operador ve una explicación accionable. Ver getAgentAliveDetails() en
  // agent-ipc.js para el catálogo de reasons.
  function reasonToCopy(reason){
    switch (reason) {
      case 'agent_alive_pulpo_restarted_or_no_interactive':
        return 'El pipeline se reinició hace poco. El agente sigue ejecutándose pero el chat no puede conectarse aún.';
      case 'orphan_heartbeat':
        return 'El agente sigue activo pero el canal de comunicación no está disponible por ahora.';
      case 'heartbeat_expired':
        return 'El agente no respondió a tiempo. Esta ejecución probablemente terminó.';
      case 'invalid_params':
        return 'No se pudo identificar al agente de este log.';
      default:
        return 'Esta ejecución ya terminó.';
    }
  }

  function renderBubble(entry){
    var div = document.createElement('div');
    var isOp = entry.type === 'operator_message';
    div.className = 'chat-bubble ' + (isOp ? 'is-operator' : 'is-agent');
    div.dataset.messageId = entry.message_id || '';
    var avatarRef = isOp ? '#ic-chat-operator' : '#ic-chat-agent';
    var statusHtml = '';
    if (isOp) {
      var state = entry.deliveryState || 'sent';
      statusHtml = '<svg class="chat-bubble-status is-' + escapeHtml(state) + '" aria-label="' + escapeHtml(state) + '"><use href="' + statusIconRef(state) + '"></use></svg>';
    }
    div.innerHTML = ''
      + '<div class="chat-bubble-avatar" aria-hidden="true"><svg><use href="' + avatarRef + '"></use></svg></div>'
      + '<div class="chat-bubble-content">'
      +   '<div class="chat-bubble-message">' + escapeHtml(entry.message || '') + '</div>'
      +   '<div class="chat-bubble-meta">'
      +     '<span title="' + escapeHtml(entry.timestamp || '') + '">' + escapeHtml(relativeTime(entry.timestamp)) + '</span>'
      +     statusHtml
      +   '</div>'
      + '</div>';
    return div;
  }

  function appendBubble(entry){
    var div = renderBubble(entry);
    historyEl.appendChild(div);
    historyEl.scrollTop = historyEl.scrollHeight;
    return div;
  }

  function updateBubbleStatus(div, state){
    if (!div) return;
    var status = div.querySelector('.chat-bubble-status');
    if (!status) return;
    status.className = 'chat-bubble-status is-' + state;
    status.setAttribute('aria-label', state);
    var use = status.querySelector('use');
    if (use) use.setAttribute('href', statusIconRef(state));
  }

  // Ajusta el log-body para que no quede tapado por el panel.
  function adjustLogViewport(){
    var logBody = document.getElementById('body'); // el log viewer existente
    if (!logBody) return;
    var panelHeight = panel.getBoundingClientRect().height;
    // 54px header + altura del panel
    logBody.style.height = 'calc(100vh - 54px - ' + Math.max(50, panelHeight) + 'px)';
  }

  // ---- toggle expand/collapse ----
  function setCollapsed(collapsed){
    if (collapsed) {
      panel.classList.add('is-collapsed');
      panel.classList.remove('is-expanded');
      bodyEl.style.display = 'none';
      toggle.setAttribute('aria-expanded', 'false');
    } else {
      panel.classList.remove('is-collapsed');
      panel.classList.add('is-expanded');
      bodyEl.style.display = 'flex';
      toggle.setAttribute('aria-expanded', 'true');
      // Al expandir, limpiamos el badge (el operador ya está viendo el chat)
      badgeEl.classList.add('is-hidden');
      badgeEl.textContent = '';
      // Focus inicial al input para acelerar la entrada de texto
      setTimeout(function(){ try{ inputEl.focus(); } catch(_){} }, 50);
    }
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch(_) {}
    // Re-ajustar viewport tras la transición CSS (150ms)
    setTimeout(adjustLogViewport, 180);
  }
  window.addEventListener('resize', adjustLogViewport);

  function isCollapsed(){ return panel.classList.contains('is-collapsed'); }

  toggle.addEventListener('click', function(){ setCollapsed(!isCollapsed()); });
  toggle.addEventListener('keydown', function(e){
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(!isCollapsed()); }
  });

  // Atajo global Ctrl+/ para abrir el panel.
  document.addEventListener('keydown', function(e){
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      setCollapsed(!isCollapsed());
    }
    // Esc colapsa el panel si el input está vacío (CA-F12)
    if (e.key === 'Escape' && !isCollapsed() && !(inputEl.value || '').trim()) {
      setCollapsed(true);
    }
  });

  // Estado inicial: colapsado por default. Honra preferencia local.
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    setCollapsed(saved !== '0'); // ausente o '1' → colapsado
  } catch(_) { setCollapsed(true); }

  // ---- input handling ----
  var newBadgeCount = 0;
  var pending = {}; // messageId → bubble div (para update de status)
  // Rate limit cliente (CA-NF: 10 msg/s) — el server hace el real, esto es UX.
  var sentTimestamps = [];

  function updateCounter(){
    var len = (inputEl.value || '').length;
    counterEl.textContent = len + ' / ' + MAX_CHARS;
    counterEl.classList.toggle('is-warning', len >= WARN_AT && len < MAX_CHARS);
    counterEl.classList.toggle('is-danger', len >= MAX_CHARS);
    sendBtn.disabled = len === 0 || !(inputEl.value || '').trim() || panel.classList.contains('is-agent-dead');
    // Autosize textarea
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
  }

  inputEl.addEventListener('input', updateCounter);
  inputEl.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      doSend();
    }
  });
  sendBtn.addEventListener('click', doSend);

  // Último mensaje que falló al enviarse — lo reusa "Reintentar conexión".
  var lastFailedMessage = null;

  function doSend(){
    var raw = (inputEl.value || '').trim();
    if (!raw) return;
    // Rate limit cliente (10 msg/s)
    var now = Date.now();
    sentTimestamps = sentTimestamps.filter(function(t){ return now - t < 1000; });
    if (sentTimestamps.length >= 10){
      // No bloqueamos hard; el server hace el real rate limit
      console.warn('rate limit cliente alcanzado (10/s)');
      return;
    }
    sentTimestamps.push(now);
    // Limpieza optimista del input. Si el envío falla, restoreInput() devuelve
    // el texto para que el operador no lo pierda (#3718 G-3 / TC-4).
    inputEl.value = '';
    updateCounter();
    sendMessage(raw);
  }

  // Restaura el texto en el input tras un fallo, SOLO si el operador no empezó
  // a escribir algo nuevo (no pisamos su escritura en curso). #3718 G-3.
  function restoreInput(raw){
    if (!(inputEl.value || '').trim()){
      inputEl.value = raw;
      updateCounter();
    }
  }

  function onSendFailed(bubble, raw){
    updateBubbleStatus(bubble, 'failed');
    lastFailedMessage = raw;
    restoreInput(raw);
  }

  function sendMessage(raw){
    var localId = 'tmp-' + Math.random().toString(36).slice(2);
    var optimistic = {
      type: 'operator_message',
      timestamp: new Date().toISOString(),
      message_id: localId,
      message: raw,
      deliveryState: 'pending',
    };
    var bubble = appendBubble(optimistic);
    pending[localId] = bubble;

    var abortCtrl = new AbortController();
    var timeoutId = setTimeout(function(){ abortCtrl.abort(); }, SEND_TIMEOUT_MS);

    fetch('/api/agent-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue: issue, skill: skill, fase: fase, message: raw }),
      signal: abortCtrl.signal,
    })
      .then(function(r){ return r.json().then(function(j){ return { status: r.status, body: j }; }); })
      .then(function(res){
        clearTimeout(timeoutId);
        delete pending[localId];
        var reason = res.body && res.body.reason;
        if (res.status === 200 && res.body && res.body.ok){
          // Update messageId al server-derived (para reconciliar con historial)
          bubble.dataset.messageId = res.body.message_id || localId;
          updateBubbleStatus(bubble, 'sent');
          // Envío OK → el agente volvió a estar comunicable: limpiamos cualquier
          // cartel de no-disponible que hubiera quedado de un intento anterior.
          clearAgentState();
          lastFailedMessage = null;
        } else if (res.status === 412){
          // Agente VIVO pero canal IPC no disponible (pulpo reiniciado). Caso
          // recuperable: cartel de advertencia + acción de reintento (G-1/G-2).
          onSendFailed(bubble, raw);
          markAgentUnavailable(reason);
        } else if (res.status === 410){
          // Agente terminado de verdad: cartel permanente, sin reintento.
          onSendFailed(bubble, raw);
          markAgentDead(reason);
        } else if (res.status === 429){
          // Rate limit del server: transitorio, preservamos el texto.
          onSendFailed(bubble, raw);
        } else {
          onSendFailed(bubble, raw);
        }
      })
      .catch(function(err){
        clearTimeout(timeoutId);
        delete pending[localId];
        onSendFailed(bubble, raw);
        if (err.name === 'AbortError'){
          // Mostrar feedback inline de timeout
          var meta = bubble.querySelector('.chat-bubble-meta');
          if (meta) meta.appendChild(document.createTextNode(' — sin respuesta del agente'));
        }
      });
  }

  // ---- estados de disponibilidad del agente ----
  function setCoverMessage(reason){
    if (coverMsgEl) coverMsgEl.textContent = reasonToCopy(reason);
  }

  // 410 — agente terminado: deshabilita el chat de forma permanente.
  function markAgentDead(reason){
    panel.classList.remove('is-agent-unavailable');
    panel.classList.add('is-agent-dead');
    if (coverIconEl) coverIconEl.textContent = '⛔';
    setCoverMessage(reason);
    sendBtn.disabled = true;
    inputEl.disabled = true;
  }

  // 412 — agente vivo pero sin canal IPC (post-restart): recuperable. Muestra
  // motivo + acciones Reintentar / Ver logs (#3718 G-1/G-2).
  function markAgentUnavailable(reason){
    panel.classList.remove('is-agent-dead');
    panel.classList.add('is-agent-unavailable');
    if (coverIconEl) coverIconEl.textContent = '⚠️';
    setCoverMessage(reason);
    // No deshabilitamos el input de forma permanente: el cover lo tapa, pero
    // tras un reintento exitoso el chat vuelve a estar operativo.
    inputEl.disabled = false;
  }

  // Limpia ambos estados (vuelve a chat operativo).
  function clearAgentState(){
    panel.classList.remove('is-agent-dead');
    panel.classList.remove('is-agent-unavailable');
    inputEl.disabled = false;
    updateCounter();
  }

  // "Reintentar conexión" (412): limpia el cartel y reenvía el último mensaje
  // que falló. Si no hay, sólo devuelve el foco al input.
  function retryConnection(){
    var msg = lastFailedMessage;
    clearAgentState();
    if (msg){
      lastFailedMessage = null;
      sendMessage(msg);
    } else {
      try { inputEl.focus(); } catch(_){}
    }
  }

  // "Ver logs": colapsa el chat para revelar el log viewer (esta misma pantalla)
  // sin perder el contexto del cartel.
  function viewLogs(){
    setCollapsed(true);
  }

  if (retryBtn) retryBtn.addEventListener('click', retryConnection);
  if (viewLogsBtn) viewLogsBtn.addEventListener('click', viewLogs);

  // ---- reconstruir historial al abrir ----
  function loadHistory(){
    if (!logFile) return;
    fetch('/api/agent-chat/history?logFile=' + encodeURIComponent(logFile))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (!j || !j.ok || !Array.isArray(j.entries)) return;
        // Vaciamos y reaplicamos para no duplicar tras refresh
        historyEl.innerHTML = '';
        j.entries.forEach(function(e){
          if (e.type === 'operator_message' && pending[e.message_id]) return; // skip dupes
          // En reconstruir, los del operador ya están sent (vinieron del JSONL → ack-eados)
          if (e.type === 'operator_message') e.deliveryState = 'sent';
          appendBubble(e);
        });
      })
      .catch(function(_){ /* silencio: peor de los casos, historial vacío */ });
  }

  loadHistory();
  updateCounter();
  adjustLogViewport();
})();`;

/**
 * Punto de entrada del módulo. Devuelve los strings para inyectar.
 */
function buildChatPanel({ logFile, issue, skill, fase }) {
    return {
        css: PANEL_CSS + '\n' + loadChatTokensCss(),
        html: buildPanelHtml({ logFile, issue, skill, fase }),
        js: PANEL_JS,
        sprite: loadChatSpriteFromAssets(),
    };
}

/**
 * Deriva {issue, skill} desde un filename `<issue>-<skill>.log` o
 * `build-<issue>.log`. Devuelve null si no matchea ningún patrón conocido.
 */
function parseLogFileName(filename) {
    if (typeof filename !== 'string' || !filename) return null;
    let m;
    // Formato canónico nuevo `<issue>.<skill>.log` (compat con tests).
    m = filename.match(/^(\d+)\.([\w-]+)\.log$/);
    if (m) return { issue: m[1], skill: m[2] };
    // Formato `<issue>-<skill>.log` (formato real del pulpo, ver dashboard.js).
    m = filename.match(/^(\d+)-([\w-]+)\.log$/);
    if (m) return { issue: m[1], skill: m[2] };
    // Skill build legacy: `build-<issue>.log`.
    m = filename.match(/^build-(\d+)\.log$/);
    if (m) return { issue: m[1], skill: 'build' };
    return null;
}

module.exports = {
    buildChatPanel,
    parseLogFileName,
    // Para tests
    _loadChatSpriteFromAssets: loadChatSpriteFromAssets,
    _loadChatTokensCss: loadChatTokensCss,
    _buildPanelHtml: buildPanelHtml,
    PANEL_CSS,
    PANEL_JS,
};
