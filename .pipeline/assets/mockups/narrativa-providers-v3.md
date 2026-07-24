# Narrativa — Mockup Providers V3 (#3737)

> Mockup adjunto: `.pipeline/assets/mockups/33-providers-v3.html`
> Split: #3737 (parte de #3715 — rediseño UX integral del Dashboard V3).
> Decisión D-UX-1: **UN solo HTML con todos los estados de la ventana Providers** (mantiene la coherencia con `29-matriz-v3.html` y `30-kpis-v3.html`).
> Decisión D-UX-2: **vista nueva — sin pieza heredada de `dashboard.js`** (cierra la D0/D1 del PO; no se extrae nada del monolito).

## Por qué un único mockup

La ventana "Providers" del dashboard V3 es **la consola de credenciales del operador**. Es un lugar dual:

- **Observabilidad** de qué proveedores LLM/TTS están cargados (`present` / `placeholder` / `absent` / `error`).
- **Disparador de reload** cuando el operador ya editó `credentials.json` desde terminal Windows y necesita que el dashboard re-hidrate.

No es la consola de configuración avanzada — eso vive en `/dashboard?view=multi-provider` (split #3733, bindings por agente, fallback chain, catálogo, health, permission overrides). Las dos vistas coexisten y comparten **una única fuente de masking**: `lib/multi-provider/secrets-rw.js`. Esto cierra el riesgo que `guru` levantó en `analisis`: si una de las dos vistas regresa al raw value, la otra no la cubre porque ambas leen del mismo lib.

El mockup junta:
1. Estado normal (mix de `present`/`placeholder`/`absent`).
2. Estado degradado (1 provider `error` con detalle saneado, sin paths absolutos del disco).
3. Modal instructional "Cómo rotar / setear una key" (read-only, SEC-2).
4. Variante fallback inerte (CA-A3 / CA-PRV-14).

Sacarlos a archivos separados rompería la lectura cruzada entre estados (cómo cambia la card cuando un provider pasa de `placeholder` a `present`, qué pasa con el degradado, cómo se ve el fallback). Los reviewers (PO, security, dev) los necesitan juntos.

## Origen declarado

**Vista nueva — sin pieza heredada de `dashboard.js`.** Como verificó `guru` en `analisis` (#issuecomment-4587478317), la palabra "Providers" solo aparece en `dashboard.js` dentro del drill-down de costos TTS (líneas 8150, 8407, 8415–8428, 9021–9060) — y eso es scope del split de Costos (#3735), no de esta historia. Por lo tanto:

- Esta vista nace nueva en `views/dashboard/providers.js`.
- El verbo "EXTRAER" del scope del issue queda resuelto como **NO APLICA** para este split (decisión D1 del PO).
- El inventario `dashboard-v3-inventory.md` lo registra explícitamente para futuros reviewers.

## Recorrido del mockup, de arriba hacia abajo

### 1. Header de ventana (slug `providers`)

Título grande con badge teal **V3** (mismo token `--teal` que usan las otras ventanas del rediseño — coherencia visual). A la derecha, tres acciones:

- `← Home` — vuelve a la vista principal.
- `⚙ Multi-Provider config →` — abre la consola avanzada `/dashboard?view=multi-provider` (#3733). **Cruz operativa explícita**: si el operador busca editar bindings o fallback chain, debe ir a la otra vista. Acá es solo metadata + reload.
- `📖 Runbook` (primary, info-bg) — abre `docs/runbooks/credential-rotation.md` (si existe; si no, el dev abre un issue paralelo).

El layout horizontal con título a la izquierda y acciones a la derecha replica el header de Matriz y KPIs — el operador no tiene que reaprender dónde está cada cosa al moverse entre ventanas.

### 2. Leyenda (CA-PRV-13 + anti-leak callout CA-PRV-5)

Bloque seco, baja jerarquía visual. Es la **primera vez** que un operador nuevo aterriza acá y debe entender:

- Los 4 estados posibles del status badge (`present`/`placeholder`/`absent`/`error`) con dual-encoding (color + icono + texto, WCAG AA).
- Que la ventana **NO leakea la API key real** — el callout rojo de la derecha es deliberadamente prominente: `🔒 SEC-1 · la API key jamás viaja por HTTP — solo masked`.

El callout de SEC-1 está visualmente arriba de las cards para que sea lo primero que vea el operador: si ve `sk-•••••<last4>` en una card, ya sabe **antes de inspeccionar el DOM** que eso NO es la key completa. Eso reduce ansiedad operativa.

### 3. Provider cards (`#providers-list`)

Grilla `2 columnas × 3 filas` con una `<article class="provider-card">` por cada entry de `MANAGED_KEYS` del lib `secrets-rw.js`. Hoy son 6:

| # | Provider | Editable UI | Estado ilustrado en el mockup |
|---|---|---|---|
| 1 | `anthropic` (Claude / OAuth MAX) | **no** | `present` |
| 2 | `openai` (Codex) | sí | `present` |
| 3 | `elevenlabs` (TTS) | sí | `placeholder` |
| 4 | `gemini-google` | sí | `present` |
| 5 | `cerebras` | sí | `absent` |
| 6 | `nvidia-nim` | sí | `error` (degradado) |

> Nota de fidelidad: los criterios del PO mencionan también "Groq" como provider managed. Hoy `MANAGED_KEYS` en `secrets-rw.js` no incluye Groq (la lista canónica es `anthropic / openai / elevenlabs / gemini-google / cerebras / nvidia-nim`). El mockup honra lo que está en código. Si el dev agrega Groq al lib antes de implementar, la card se replica automáticamente con la misma estructura. Si no, queda fuera de esta ventana hasta que se agregue.

#### Anatomía de una card

Cada card tiene 4 zonas verticales:

1. **`provider-head`**: nombre + dot semántico + status badge.
2. **`provider-meta`**: grilla key:value mono con `Masked` / `Fingerprint` / `Path` / `Editable UI` (o `Detalle` cuando hay error).
3. **`provider-actions`** (al fondo): botones `Reload`, `Cómo rotar`, `Reintentar` según el estado.
4. **Rail lateral 3px** (`::before`) — codifica el provider en color del token `--provider-*` para que el operador identifique de un vistazo qué card es cuál sin leer (dual-encoding).

**Por qué el rail con `--provider-*`:** Anthropic en naranja terroso (`--provider-anthropic`), Codex en verde Anthropic-success, ElevenLabs en `--rest-mode` indigo (familia TTS), Gemini en azul Google, Cerebras en ámbar, NVIDIA NIM en verde NVIDIA. Los tokens ya existen en `design-tokens.css:143..223`. Cualquier dev que mire la grilla sabe inmediatamente qué provider está mirando — no necesita leer el `<h>`.

**Por qué los 4 status:**

- **`present`** (verde): la fuente de la verdad (`secrets-rw.listKeys()`) devolvió status `present`. La card muestra masked + fingerprint reales. Esto es operacionalmente "todo está bien acá".
- **`placeholder`** (ámbar): la key está pero es texto demo (`REVOKED` / `PLACEHOLDER` / `EXAMPLE` / `MOVED` / `REPLACE` / `CHANGE_ME`). Status separado de `absent` porque el operador **debe saber** que hay algo escrito ahí pero no sirve — confundir uno con otro lleva a pensar que se rotó cuando no se rotó.
- **`absent`** (gris): no hay nada en el slot. La card muestra `—` en todos los campos y un solo CTA "Cómo configurar".
- **`error`** (rojo): falla la lectura de `credentials.json` (JSON inválido, archivo sin permisos, etc.). El detalle es **sanitizado server-side**: muestra `credentials.json no es JSON válido (línea 12)`, no la ruta absoluta `C:\Users\Administrator\.claude\secrets\credentials.json`. Esto es coherente con CA-PRV-9 (SEC-5) y con la práctica del split de Costos.

**Por qué Anthropic tiene un Rotate distinto**: la card de Anthropic muestra `Editable UI: no — OAuth / MAX` y el botón `Rotate (n/a)` deshabilitado con `aria-disabled="true"` + `title` explicativo. Esta es la realidad documentada en `MANAGED_KEYS[0].reason`: rotar la key de Anthropic acá puede confundir el child env de Claude Code porque la auth real pasa por el login del CLI. Mostrarlo deshabilitado (no esconderlo) **explica** la asimetría — si lo escondiéramos, el operador buscaría el botón y se confundiría.

**Por qué tooltips en cada metric:** cada campo de `provider-meta` tiene `title=` + `aria-label=`. Ejemplos:

- `Masked` → "Preview sk-•••••<last4>. Solo los primeros 6 y los últimos 4 chars son visibles."
- `Fingerprint` → "SHA-256(api_key) truncado a 16 chars hex. Sirve para comparar entre máquinas/backups sin exponer la key."
- `Path` (no necesita tooltip — el texto explica solo).
- `Editable UI` → tooltip dinámico según el provider.

Esto cierra CA-PRV-12 (tooltips obligatorios) sin que se sienta ruidoso visualmente — los tooltips solo aparecen en hover/focus.

### 4. Ops row — Reload global + Modal "Cómo rotar"

Bloque inferior con 2 columnas:

**Izquierda: Reload global.** Un solo botón `↻ Reload todo` que hace `POST /api/providers/reload` sin body, sin key. El helper text bajo el botón dice explícitamente:

> SEC-3 · solo acepta requests con `Origin === http://localhost:3200`. Cualquier origin cross-site → `403`.

Esto educa al operador (si alguna vez ve un 403 inesperado, ya sabe por qué) y documenta la defensa CSRF al mismo tiempo. La línea cierra CA-PRV-7.

**Derecha: Modal instructional "Cómo rotar / setear una key".** Read-only, paso a paso:

1. Abrir terminal Windows (no Telegram).
2. Editar `credentials.json` (`notepad %USERPROFILE%\.claude\secrets\credentials.json`).
3. Modificar el path canónico del provider, con un snippet de JSON de ejemplo.
4. Guardar y clickear `Reload` para re-hidratar.

El cierre del modal es el call-out `SEC-2 inquebrantable · este modal es read-only. No hay <input type="password"> que postee la key al backend.` Y cita la memoria `feedback_api-keys-terminal-only` con su contexto (post-incidente Groq 2026-05-17).

**Por qué embebido como `<aside>` y no en un `<dialog>`:** el mockup lo muestra siempre visible para que el reviewer entienda qué hay adentro. En la implementación SSR, el dev puede:

- Renderizarlo siempre visible (más educativo para nuevos operadores).
- O envolverlo en `<details>` nativo (accesible por teclado, sin JS) que arranca colapsado.

Cualquiera de las dos formas cumple CA-PRV-6 (SEC-2). Lo que NO se acepta es un overlay JS que capture la key — eso es lo que dispara el rechazo automático del CA.

### 5. Audit callout (SEC-5/SEC-6)

Línea sobria con borde dashed que explica qué se loguea en el audit trail:

> SEC-5/SEC-6 · cada Reload escribe una entrada en `lib/audit-log` con timestamp, provider, masked preview, fingerprint resultante y PID del requester. Los logs server-side **jamás** contienen la API key real — solo el masked.

Esto **garantiza al operador** (y al security reviewer) que las acciones quedan trazables sin riesgo de leak. Cierra CA-PRV-9 y CA-PRV-10.

### 6. Footer (canales redundantes)

Igual que el resto del épico, recordatorio operativo:

> Tip: si esta ventana se cae, también podés pedir el listado por Telegram con `/providers`. Para rotar una key, siempre terminal Windows — *nunca* Telegram (regla post-incidente Groq 2026-05-17).

Refuerza la regla y recuerda que hay redundancia operativa (Telegram + dashboard) para *lectura*, pero NO para escritura.

### 7. Variante fallback inerte (CA-A3 / CA-PRV-14)

Separada por un divider visual (`hr` + label "Variante fallback inerte"). Se renderiza cuando `require('./views/dashboard/providers')` arroja en `dashboard.js`:

- Icono warning amarillo + título "Ventana Providers no disponible".
- Subtítulo explicando que el módulo falló y que hay logs.
- Línea mono con el formato exacto del `log()` emitido (`log("providers view unavailable: " + e.message)`).
- **Tip de recovery**: link explícito a `/dashboard?view=multi-provider` como alternativa de consulta. Esto es la cruz operativa con el split #3733 — si Providers cae, el operador no queda ciego porque la consola avanzada también muestra el estado de las keys (con el mismo masking via `secrets-rw.js`).

Esta variante es **obligatoria** por CA-F1 (mockup incluye estado normal + estado degradado + fallback) y por CA-A3 del épico (nunca string vacío silencioso).

## Decisiones cerradas en este mockup

| ID | Decisión | Cierra |
|---|---|---|
| D-UX-1 | UN solo HTML con todos los estados | Coherencia con 29-matriz / 30-kpis |
| D-UX-2 | Vista nueva — sin pieza heredada | D1 del PO (#3737) |
| D-UX-3 | Status badges con dual-encoding (color + icono + texto) | CA-PRV-19 (WCAG AA) |
| D-UX-4 | Rotate no captura key — modal instructional read-only | CA-PRV-6 (SEC-2) |
| D-UX-5 | Reload global sin body + advertencia Origin guard visible | CA-PRV-7 (SEC-3) |
| D-UX-6 | Anti-leak callout en leyenda (prominente, rojo) | CA-PRV-5 (SEC-1) visibilidad |
| D-UX-7 | Tooltips en cada metric + cada acción | CA-PRV-12, CA-PRV-8 (SEC-4) |
| D-UX-8 | Audit callout visible al operador | CA-PRV-10 (SEC-6) transparencia |
| D-UX-9 | Fallback inerte con link a `/multi-provider` como recovery | CA-PRV-14 (CA-A3) |
| D-UX-10 | KPIs de proveedor NO migran a esta ventana en este split | D2 del PO (queda para #3729) |

## Lo que NO entra en este mockup (out-of-scope explícito)

| Pieza | Por qué no |
|---|---|
| `<input type="password">` para rotar | CA-PRV-6 / SEC-2 inquebrantable. Memoria `feedback_api-keys-terminal-only`. |
| Edición de bindings agente↔provider | Scope de `/dashboard?view=multi-provider` (#3733). |
| Catálogo de modelos por provider | Idem #3733. |
| Permission overrides | Idem #3733. |
| Health checks históricos | Idem #3733 / `multi-provider/health-*`. |
| KPIs de tokens/latencia/cost por provider | Decisión D2 del PO — queda para #3729 KPIs. |
| Wizard de set inicial guiado | Decisión D3 del PO — sub-historia de "wizards" del épico. |
| Filtros / búsqueda de providers | El listado es corto (6) — no se justifica la complejidad. |

## Tokens y assets requeridos

- **Tokens (`design-tokens.css`)** — todos ya existen, no se agregan:
  - `--provider-anthropic`, `--provider-anthropic-dim`, `--provider-anthropic-bg`
  - `--provider-gemini`, `--provider-gemini-dim`, `--provider-gemini-bg`
  - `--provider-groq`, `--provider-groq-dim`, `--provider-groq-bg`
  - `--provider-cerebras`, `--provider-cerebras-dim`, `--provider-cerebras-bg`
  - `--provider-nvidia-nim`, `--provider-nvidia-nim-dim`, `--provider-nvidia-nim-bg`
  - `--success`, `--success-bg`, `--warning`, `--warning-bg`, `--danger`, `--danger-bg`, `--info`, `--info-bg`, `--rest-mode`
  - `--surface-0..3`, `--border`, `--border-strong`, `--text-primary`, `--text-secondary`, `--text-dim`
  - `--brand-cyan`, `--purple`, `--teal`, `--teal-bg`, `--teal-dim`
- **Sprite (`icons/sprite.svg`)** — el mockup usa fallback emoji unicode (🔑/↻/🗝/✓/⚠/✕/—/⚙/📖/📝/🔒/←/→). En la integración SSR, el dev puede sustituir cada `<span aria-hidden="true">…</span>` por `<svg><use href="../icons/sprite.svg#ic-..."/></svg>` si los íconos correspondientes existen. Si no, mantener el unicode (es accesible cuando se acompaña de `aria-hidden="true"` + label textual).

## Verificación visual (CA-F2)

Para generar el screenshot real que se adjunta en el PR de dev:

```bash
# Renderizar el mockup
node .pipeline/scripts/screenshot-mockup.js \
  --input .pipeline/assets/mockups/33-providers-v3.html \
  --output .pipeline/assets/mockups/screenshots/33-providers-v3.png \
  --width 1080 --height 1920

# Renderizar la vista real una vez implementada
curl -s 'http://127.0.0.1:3200/dashboard?view=providers' > /tmp/providers-rendered.html
# (luego screenshot del render real para comparación side-by-side)
```

El PR de dev incluye `screenshot-mockup.png` vs `screenshot-real.png` para validación visual del reviewer.

## Coherencia con el resto del épico

Esta ventana mantiene la **identidad visual del épico V3** definida por las hermanas mergeadas:

- **Header**: mismo formato (título + V3 badge teal + acciones a la derecha).
- **Leyenda**: misma posición (debajo del header), mismo formato chip + dot + texto.
- **Cards en grilla**: rail lateral 3px del color del subject (igual que Costos por skill, Historial por estado).
- **Tooltips**: misma estética (texto en castellano, hardcoded server-side).
- **Footer note**: misma posición y tono ("Tip: si esta ventana se cae...").
- **Fallback inerte**: mismo formato (icono warning + título + subtítulo + línea mono del log).

Un operador que aprendió a leer Matriz/KPIs/Costos puede leer Providers de un vistazo sin retrabajo cognitivo.
