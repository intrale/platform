# Narrativa UX — #4433 · "Nueva ola" + Componer/asociar issues en el Roadmap

> Especificación de UX/UI para el issue **#4433** (fase criterios). Cablea al
> dashboard (`.pipeline/dashboard.js`, ventana Roadmap) las acciones que hoy solo
> viven en `planner-waves-cli.js`: **crear ola** y **componer/asociar/desasociar
> issues** sobre olas planificadas.
>
> **Base visual reusada (no se reinventa nada):**
> - `design-tokens.css` — paleta, tipografía, espaciado, radios, sombras, WCAG AA.
> - `39-wave-roadmap-management.svg` + `narrativa-wave-roadmap-management.md` —
>   consola de gestión del roadmap de olas (crear / asociar / desasociar /
>   reordenar / promover / archivar). Mockup madre del sistema de gestión.
> - `40-roadmap-olas-v3.svg` — vista consolidada read-only del roadmap.
> - Ícono `ic-wave-add` (ya en `sprite.svg`), `ic-remove-circle`, `ic-info`,
>   `ic-shield-lock`.
>
> Este documento **acota** ese sistema al alcance real de #4433 y **reconcilia**
> el formulario con la decisión PO/UX de "camino (b)" (defaults server-side).
> **NO** cubre reordenar/archivar (ya cableados) ni promover (delegado a #4435).

---

## 1. Alcance UX de este issue

| Acción | Endpoint | Superficie UI | CA |
|--------|----------|---------------|-----|
| Crear ola planificada | `POST /api/waves` | Botón "Nueva ola" + form | CA-1, CA-2 |
| Asociar issue | `POST /api/waves/:num/issues` | Acción "Componer" sobre planificada | CA-3, CA-4 |
| Desasociar issue | `POST /api/waves/:num/issues/:issue/remove` | Chip con `ic-remove-circle` | CA-5 |
| (No re-hacer) reordenar/archivar | — | ya existen | CA-9 |
| (No implementar) promover | — | referenciar #4435 | CA-9 |

**Regla de encuadre A04 (heredada del mockup 39):** crear/componer/desasociar se
ofrecen **solo sobre olas planificadas**. La ola **activa** NO expone estas
acciones; el backend además rechaza con `EWAVES_ACTIVE_LOCKED` (CA-6).

---

## 2. Formulario "Nueva ola" — reconciliación con camino (b) — CA-1, CA-2

> **Divergencia detectada vs mockup 39 (§3):** el mockup madre dibuja un form de
> **5 campos** (`número`, `nombre`, `objetivo`, `concurrency_max`, `window_minutes`).
> El PO cerró el gap con **camino (b)**: el operador NO piensa en concurrency/window
> al crear. Este issue implementa el **form reducido** de abajo, no el de 5 campos.

### Campos que ve el operador

| Campo | Obligatorio | Control | Hint bajo el campo |
|-------|-------------|---------|--------------------|
| **Nombre** | ✅ | input texto (length-bound `WAVE_NAME_MAX_LEN`) | "Nombre corto y descriptivo de la ola." |
| **Objetivo** | opcional | textarea 1–2 líneas (`WAVE_GOAL_MAX_LEN`) | "Opcional. Qué busca lograr la ola." |
| **Issues iniciales** | ✅ (≥1) | input `#123 #456` (chips al confirmar) | "Al menos un issue. Formato `#123 #456`, sin duplicados." |

**NO se muestran** `concurrency` ni `window`: los completa el endpoint con
defaults server-side (`readWaveMaxConcurrency()` y el techo de ventana desde
`config.yaml`). Comunicar esto con una **nota fija** bajo el form:

> *ic-info* — "Concurrencia y ventana se asignan automáticamente con los valores
> por defecto del pipeline. Se crea en planificadas; la ola activa no se altera."

### Nota técnica para el dev (bloqueante de coherencia con camino b)

`validateCreateInput()` (`lib/wave-create-input.js:196-215`) **hoy exige**
`concurrency` y `window` (devuelve `{ok:false, field:'concurrency'|'window'}` si
faltan) y el arquitecto pidió **no tocar esa lib**. Por lo tanto el handler
`POST /api/waves` DEBE **inyectar los defaults server-side en el payload ANTES**
de llamar a `validateCreateInput`:

```js
// defaults server-side (NUNCA inferidos de input del usuario) — REQ-SEC-5
if (payload.concurrency == null || payload.concurrency === '')
  payload.concurrency = String(wavesLib.readWaveMaxConcurrency());
if (payload.window == null || payload.window === '')
  payload.window = String(wavesLib.WAVE_WINDOW_MAX_MINUTES); // o el default de config.yaml
const v = wci.validateCreateInput(payload);
```

Así el form manda solo `{name, goal, issues}` y la validación canónica sigue
intacta. Si el dev prefiere agregar defaults dentro de la lib, eso sería un cambio
de dominio fuera del encuadre del arquitecto → coordinar antes.

### Estados del form (todos con color + ícono + texto — WCAG AA)

- **Éxito (CA-1):** banner `--success-bg` + `ic-check` + "Ola «{nombre}» creada
  en planificadas." → cerrar form + refrescar las 3 secciones.
- **Error de campo (CA-2):** el campo faltante/ inválido se marca en
  `--danger-bg` + borde `--danger-dim`, con el `msg` accionable que devuelve
  el backend (`field` + `msg`). Sin nombre → "Falta el nombre de la ola." Sin
  issues → "Indicá al menos un issue inicial." **No se crea nada** (el state no
  se toca).
- **Error de dominio (duplicado / bounds):** banner rojo con el `msg` del `code`
  (`EWAVES_DUPLICATE_*`, `EWAVES_BOUNDS`…). Copy: "No se pudo crear la ola:
  {msg}. No se modificó waves.json."

**Presentación:** panel/form no-modal a la derecha de la sección planificadas
(coherente con mockup 39 §3), o modal ligero — a criterio del dev, pero botón
primario **"Crear ola"** con acento de planificación `--purple`/`--purple-dim`
(lane-definición) y "Cancelar" neutro. Ícono del botón/header: `ic-wave-add`.

---

## 3. Componer / asociar / desasociar — CA-3, CA-4, CA-5

### Asociar (CA-3)
- Sobre cada ola **planificada**: input "Asociar issue" (`#123`) + botón
  "Asociar". Al confirmar → `POST /api/waves/:num/issues` con `{number}`.
- Éxito: el issue aparece como **chip** `#123` en la ola, feedback
  `--success` breve, refresh de la sección.
- El chip reusa el estilo de chips del mockup 39 §4 (id + pill de estado).

### Asociar inválido (CA-4 — escenario Gherkin del body)
- Número no numérico / ≤0 / mal formado → el backend responde 4xx
  (`EWAVES_SHAPE` vía `addIssueToWave`/`normalizeIssue`). La UI muestra
  mensaje de error claro (`--danger` + `ic-alert` + texto) y **la ola NO se
  modifica**. Copy: "Número de issue inválido — usá un entero positivo (`#123`)."
- **Prohibido** parsear el número a mano en el cliente para "adivinar": se manda
  crudo y se confía en la normalización de dominio (REQ-SEC-2).

### Desasociar (CA-5)
- Cada chip de issue en una ola **planificada** lleva un botón
  `ic-remove-circle` (touch target ≥ 32px real, `aria-label="Desasociar #123"`).
- Confirmación ligera in-place (o directa) → `POST /api/waves/:num/issues/:issue/remove`.
- Éxito → el chip desaparece, feedback + refresh.
- Sobre la **ola activa** estos controles **no se renderizan**; si aun así
  llegara la petición, el backend devuelve `EWAVES_ACTIVE_LOCKED` 4xx (CA-6) y
  la UI muestra "Esta operación no está permitida sobre la ola activa."

---

## 4. Feedback y refresh coherente — CA-10

Toda acción (crear / asociar / desasociar) sigue el mismo contrato que el
`reorder` ya existente (`dashboard.js:~8877`, patrón `doPost` + reintento CSRF):

1. `fetch` al endpoint; si 403 → refrescar token CSRF y reintentar una vez.
2. Leer `{ok, msg, field?, code?}` del backend.
3. Pintar feedback (éxito verde / error rojo) **siempre con ícono + texto**.
4. Refrescar las **3 secciones** del Roadmap (activa / planificadas / archivadas)
   sin recarga manual de la página.

El feedback debe ser **legible en escala de grises** (no solo color).

---

## 5. Seguridad de render — CA-8 (BLOQUEANTE)

Todo `wave.name` y `wave.goal` (y cualquier título de issue) que se pinte en las
3 secciones o en el chip **DEBE** pasar por `escapeHtml(...)`
(`dashboard.js:2083`) o `textContent`. `validateFreeText` bloquea
prompt-injection pero **NO** neutraliza HTML: un nombre `<img src=x onerror=…>` o
`<script>` pasa la validación de dominio y se guarda. Verificación QA (CA-8):
crear ola con nombre `<script>alert(1)</script>` → se muestra como **texto
literal**, no ejecuta.

---

## 6. Iconografía (todo ya en `sprite.svg`, cero íconos nuevos)

| Ícono | Uso en #4433 |
|-------|--------------|
| `ic-wave-add` | Botón/header "Nueva ola" |
| `ic-remove-circle` | Desasociar issue (chip) |
| `ic-info` | Nota de defaults concurrency/window |
| `ic-check` | Feedback de éxito |
| `ic-alert` / `ic-shield-lock` | Feedback de error / bloqueo A04 |

El dev **no inventa** iconografía ni paleta: todo está en `design-tokens.css` y
en este documento. Los mockups madre (39, 40) siguen siendo la referencia visual.

---

## 7. Accesibilidad (WCAG AA — heredada de los tokens)

- Nunca información solo por color: estados = color + ícono + texto.
- Contrastes de los tokens verificados (primary 14.8:1, secondary 9.7:1,
  danger/purple sobre superficies oscuras ≥ AA Large).
- Touch targets de crear / asociar / desasociar ≥ 32px reales.
- Errores de validación combinan rojo + ícono + texto (legibles en grises).
- Inputs del form con `<label>` asociado y `aria-describedby` al hint.

---

## 8. Mapa CA → superficie UX

| CA | Cubierto por |
|----|--------------|
| CA-1 crear happy path | §2 form + estado éxito + refresh |
| CA-2 validación campos obligatorios | §2 estados de error de campo |
| CA-3 asociar | §3 asociar |
| CA-4 asociar inválido | §3 asociar inválido |
| CA-5 desasociar | §3 desasociar |
| CA-6 no sobre activa | §1 encuadre A04 + §3 |
| CA-7 CSRF | §4 (contrato reorder, no UI visible) |
| CA-8 sin XSS | §5 escapeHtml |
| CA-9 no duplicar/romper | §1 fuera de alcance reorder/archivar/promover |
| CA-10 feedback + refresh | §4 |
