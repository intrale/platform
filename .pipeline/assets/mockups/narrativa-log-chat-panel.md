# Chat operador↔agente en log viewer — Narrativa UX (#3605)

> **Mockup**: `.pipeline/assets/mockups/21-log-chat-panel.svg`
> **Tokens**: `design-tokens.css` §3.f (CHAT OPERADOR-AGENTE)
> **Iconos**: `sprite.svg` (`ic-chat-bubble`, `ic-chat-operator`, `ic-chat-agent`, `ic-chat-collapsed`, `ic-chat-expanded`, `ic-chat-sent`, `ic-chat-pending`, `ic-chat-send`)

---

## Job-to-be-done (JTBD)

> "Cuando detecto que un agente está yendo por el camino equivocado, quiero corregirlo sin interrumpir la ejecución para ahorrar tokens y no perder el contexto."

El operador del pipeline pierde ciclos y tokens cuando un agente toma una dirección incorrecta. Esta feature permite intervenir a tiempo sin matar y relanzar.

## Decisiones de diseño visual

### 1. Panel colapsado por default

**Decisión:** El panel arranca **colapsado** al abrir la ventana de logs.

**Por qué:**
- El caso de uso primario del log viewer es **leer logs**, no chatear. Mantener el split 70/30 expandido por default reduce el área útil del log sin justificación.
- El operador que **necesita** chatear lo abre con un click visible (la tira inferior es 50px de alto y persistente).
- Cuando el panel está colapsado, un **badge** muestra `N nuevos` si el agente respondió mientras estaba cerrado — el operador NO se pierde la respuesta.
- Atajo `Ctrl+/` para expandir desde teclado (mostrado en hint a la derecha).

### 2. Burbujas asimétricas (operador derecha / agente izquierda)

**Decisión:** El operador alinea a la **derecha** con acento cyan; el agente a la **izquierda** con acento púrpura.

**Por qué:**
- Convención universal de chat (WhatsApp, Telegram, iMessage) — el operador entiende el patrón sin aprender nada.
- La diferenciación visual es **redundante** (alineación + color + avatar + borde lateral): cualquiera de los 4 canales basta para distinguir el sender. Cumple WCAG 1.4.1 "no information by color alone".
- Cyan (`--brand-cyan` #00D6FF) para el operador refuerza que **TÚ** estás interactuando con el sistema; púrpura (`--purple` #BC8CFF) para el agente comparte familia con la lane "definicion/planning" del dashboard, donde "el sistema piensa".

### 3. Avatares distintivos

**Decisión:**
- Operador: `ic-chat-operator` — silueta humana minimal dentro de círculo cyan.
- Agente: `ic-chat-agent` — chip/spark dentro de cuadrado púrpura.

**Por qué:**
- La forma del marco (círculo vs cuadrado) es la primera señal de "humano vs máquina" en el sistema visual de Intrale (heredado de `ic-architect-*` y `ic-agents-count`).
- El glyph interno (silueta vs spark) refuerza la misma división sin redundar literalmente con emojis del SO (que se ven inconsistentes entre Windows/Linux/macOS).

### 4. Indicadores de entrega

**Decisión:** Cada mensaje del operador tiene un estado visible:
- `ic-chat-pending` (reloj amarillo) → enviado al endpoint, esperando ACK del IPC.
- `ic-chat-sent` (doble check verde) → el agente confirmó vía stdin.
- Borde de la burbuja con `stroke-dasharray` mientras está pendiente, sólido cuando se confirma.
- Si pasa **timeout 5s sin ACK** → la burbuja vira a `--chat-status-failed` (rojo) + texto "sin respuesta".

**Por qué:**
- El operador necesita feedback inmediato de que su intervención **llegó al agente** — sino podría asumir que se perdió y reescribir, generando ruido.
- El doble check es convención universal de mensajería; el reloj durante el pendiente comunica "trabajando" sin animación que distraiga del log.

### 5. Estado "agente terminado"

**Decisión:** Cuando el agente muere (voluntario o crash), el cartel cubre el **input completo** (no solo deshabilita el botón).

**Por qué:**
- Deshabilitar solo el botón "Enviar" deja al operador escribir un mensaje largo que después no podrá enviar — frustrante y desperdicia trabajo.
- El cartel rojo (`--chat-disabled-bg`) + icono warning explica **qué pasó** y **qué hacer** ("el historial sigue disponible para auditoría").
- El historial previo permanece visible y legible (las burbujas no se desactivan visualmente).

### 6. Contador de caracteres visible

**Decisión:** `1234 / 2000` en gris claro a la derecha del input, siempre visible.

**Por qué:**
- El backend sanitiza con `message.slice(0, 2000)` — si el operador escribe más, el corte es silencioso y puede generar mensajes ambiguos.
- Hacerlo visible es **honest UI**: el operador sabe el límite y se autorregula. A los 1800 chars cambia a `--warning`; a los 2000 cambia a `--danger` + bloquea envío.

### 7. Split draggable persistente

**Decisión:** La border-strong entre log (arriba) y chat (abajo) es draggable con `cursor: row-resize`. El ratio se persiste en `localStorage` por log file.

**Por qué:**
- El default 70/30 es razonable, pero un operador que esté en sesión de debugging intensivo puede preferir 50/50 o 30/70.
- Persistir por log file (no global) permite que cada agente "recuerde" su ratio preferido.

## Estados visuales del panel

| Estado | Trigger | Comportamiento |
|--------|---------|----------------|
| **Colapsado** (default) | Apertura del log viewer | Tira inferior 50px con `ic-chat-bubble` + label + badge nuevos |
| **Expandido vacío** | Click en tira / Ctrl+/ | Split 70/30, placeholder educativo, input habilitado |
| **Expandido con conversación** | Operador envió ≥1 mensaje | Historial + input habilitado, autoscroll al último |
| **Agente muerto** | Proceso del agente termina | Cartel rojo cubre input, historial visible |
| **Rate limited** | >10 msg/s desde cliente | Input habilitado pero el botón muestra `ic-chat-pending` con "esperando" |

## Tokens semánticos disponibles

Toda la implementación en `.pipeline/dashboard.js` debe consumir los tokens de §3.f:

```css
/* Burbuja operador */
.chat-msg-operator {
  background: var(--chat-operator-bg);
  border: 1px solid var(--chat-operator-border);
  color: var(--chat-operator-fg);
  border-left: 3px solid var(--chat-operator);  /* franja lateral */
}

/* Burbuja agente */
.chat-msg-agent {
  background: var(--chat-agent-bg);
  border: 1px solid var(--chat-agent-border);
  color: var(--chat-agent-fg);
  border-left: 3px solid var(--chat-agent);
}

/* Cartel agente muerto */
.chat-input-dead {
  background: var(--chat-disabled-bg);
  border: 1px solid var(--chat-disabled);
  color: var(--chat-disabled-fg);
}

/* Timestamp relativo */
.chat-ts { color: var(--chat-timestamp-fg); font-size: 0.85em; }

/* Panel completo */
.chat-panel { background: var(--chat-panel-bg); }
.chat-panel-header { background: var(--chat-panel-header-bg); }
```

**Prohibido**: hardcodear colores hex en el panel. Si necesitás un tono nuevo, agregarlo a §3.f con justificación en docs.

## Iconografía

| Símbolo | Uso | Color recomendado |
|---------|-----|-------------------|
| `ic-chat-bubble` | Header colapsable | `var(--chat-operator)` cuando hay agente, `var(--text-dim)` si no |
| `ic-chat-operator` | Avatar humano en burbujas | `var(--chat-operator)` siempre |
| `ic-chat-agent` | Avatar IA en burbujas | `var(--chat-agent)` siempre |
| `ic-chat-collapsed` | Toggle "expandir" (chevron up) | `var(--text-dim)`, hover `var(--text-primary)` |
| `ic-chat-expanded` | Toggle "colapsar" (chevron down) | idem |
| `ic-chat-sent` | Doble check de entrega | `var(--chat-status-sent)` |
| `ic-chat-pending` | Reloj de envío en curso | `var(--chat-status-pending)` |
| `ic-chat-send` | Botón "Enviar" | `var(--surface-0)` sobre gradient cyan; `var(--text-dim)` si disabled |

**Uso típico:**

```html
<svg width="14" height="14" aria-hidden="true">
  <use href="#ic-chat-operator" style="color: var(--chat-operator)" />
</svg>
```

## Accesibilidad

- **Contraste**: todos los pares fg/bg pasan WCAG AA (texto normal ≥ 4.5:1, texto grande ≥ 3:1). Verificado en §3.f del CSS.
- **Sin información solo por color**: cada burbuja combina avatar + alineación + glyph + bg distintos. El estado de entrega combina color + icono + texto ("enviado" / "pendiente" / "sin respuesta").
- **Touch targets**: botón Enviar y toggle del header mínimo 36×36 px.
- **aria-labels obligatorios**:
  - Toggle colapsable: `"Expandir chat con agente, ${unread} mensajes nuevos"` / `"Colapsar chat"`.
  - Textarea: `"Mensaje al agente ${skill} #${issue}"`.
  - Send button: `"Enviar mensaje al agente"` (o `"Sin agente activo"` si disabled).
  - Cada burbuja: `role="article" aria-label="Mensaje del operador, hace 2 minutos"` o equivalente.
- **Teclado**:
  - `Enter` envía (si hay texto válido).
  - `Shift+Enter` inserta newline.
  - `Tab` NO debe saltar fuera del textarea (mantener el foco hasta enviar/escapar).
  - `Esc` cierra el panel **solo si el textarea está vacío** (no perder texto sin querer).
  - `Ctrl+/` toggle del panel (alternativa al click).
- **Respeto a `prefers-reduced-motion`**: animación pulse de la badge `LIVE` se desactiva; el resize del split sigue funcional.

## Seguridad (refuerzos visuales del review de security)

El sistema visual refuerza las mitigaciones obligatorias del review:

- **CA-Sec-Input**: contador `N / 2000` siempre visible → el operador no es sorprendido por truncamiento silencioso.
- **CA-Sec-Dead**: cartel cubre el input completo cuando el agente muere → imposible escribir y "enviar" a la nada.
- **CA-Sec-Asymetria**: avatares y alineación asimétricos → el operador nunca confunde un mensaje suyo con respuesta del agente (mitigación humana contra spoofing visual).
- **CA-Sec-Redaction**: los mensajes que el redactor (`lib/redact.js`) modifique se renderizan con `[redacted]` en gris (`var(--text-dim)`) en la posición original, **no se ocultan** — el operador ve que pasó.

## Notas para el dev (pipeline-dev / android-dev)

### Archivos a consumir

| Archivo | Cómo |
|---------|------|
| `.pipeline/assets/design-tokens.css` | Si el dashboard ya carga este CSS, los tokens `--chat-*` están disponibles. Si no, agregarlo al `<style>` inicial del log viewer. |
| `.pipeline/assets/icons/sprite.svg` | Inyectar el sprite inline al inicio del `<body>` del log viewer (ya hay precedente con otros íconos). |
| `.pipeline/assets/mockups/21-log-chat-panel.svg` | Referencia visual al implementar el HTML/CSS. |

### Reglas de implementación

1. **NO hardcodear colores hex** en el panel. Usar siempre `var(--chat-*)`.
2. **NO usar emojis del SO** (👤, 💬, ✓) en el HTML final — usar el sprite. Los emojis en el mockup SVG son ilustrativos.
3. **Persistir el ratio del split** en `localStorage` con key `chat-split-ratio:${logFile}`.
4. **Persistir el estado colapsado** en `localStorage` con key `chat-collapsed:${logFile}` — si el operador lo dejó abierto, recordar.
5. **Auto-scroll del historial** debe ser independiente del auto-scroll del log (ambos pueden estar activos a la vez).

### Validación visual (lo que va a verificar UX en aprobacion)

- [ ] El split renderiza sin flicker al abrir el log viewer.
- [ ] El panel arranca colapsado y se expande con click en la tira o Ctrl+/.
- [ ] Las burbujas del operador van a la derecha con bg cyan; las del agente a la izquierda con bg púrpura.
- [ ] Los avatares usan `ic-chat-operator` / `ic-chat-agent` del sprite (NO emojis).
- [ ] El contador `N / 2000` cambia a warning a los 1800 y a danger a los 2000.
- [ ] Cuando el agente muere, el cartel cubre el input completo (no solo deshabilita el botón).
- [ ] Los `aria-label` están presentes en todos los controles interactivos.
- [ ] Contraste verificado con WebAIM en pantalla real (no solo en el SVG).

---

**Producido por:** UX (fase `criterios`, pipeline `definicion`)
**Issue:** [#3605](https://github.com/intrale/platform/issues/3605)
**Fecha:** 2026-05-29
