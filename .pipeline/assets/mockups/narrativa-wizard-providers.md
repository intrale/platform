# Narrativa UX — Wizard "Configurar / rotar proveedor" (#3740)

> Sistema visual del wizard de 4 steps embebido en el dashboard interno V3
> (`localhost:3200`). Acompaña al mockup
> [`25-wizard-providers-rotate.svg`](25-wizard-providers-rotate.svg) y soporta
> los criterios CA-1..CA-16 del comentario PO en
> [#3740](https://github.com/intrale/platform/issues/3740#issuecomment-4583986058).

Este **NO** es un wizard del producto cliente final (Compose Multiplatform).
Vive en HTML/CSS/JS vanilla porque está embebido en el dashboard del pipeline
bajo `.pipeline/dashboard.js`. La identidad visual sigue los tokens existentes
(`.pipeline/assets/design-tokens.css`) y el sprite real
(`.pipeline/assets/icons/sprite.svg`).

> **Numeración:** este mockup toma el slot **25**. El último publicado fue
> `24-multi-provider-coverage-widget.svg` (#3681). El próximo hijo del split
> #3715 debe usar el slot 26 hacia arriba.

---

## Filosofía del wizard

El operador del dashboard llega acá cuando una API key cumplió ciclo: hace 5,
12 o 21 días que está activa, hay un proveedor con anomalía de consumo, o
simplemente toca rotarla por higiene. La operación crítica — **escribir una
key nueva en `~/.claude/secrets/credentials.json`** — pasa históricamente por
una sesión de terminal Windows, archivo abierto manualmente, riesgo de pegar
en el lugar equivocado.

Este wizard mueve **la rotación y la auditoría** al dashboard, pero respeta
la política `feedback_api-keys-terminal-only`: **el set inicial de una key
nueva sigue siendo terminal-only**. Si nunca hubo key para Gemini, Gemini sigue
fuera del wizard hasta que aparezca por terminal. Esa restricción no es
limitación técnica — es **principio de diseño**: el dashboard no acepta secretos
desde un canal sin contrato previo.

A primera vista el operador tiene que poder responder tres cosas:

1. **¿Qué key estoy tocando?** — provider explícito en cada step, last4 visible.
2. **¿Qué le va a pasar?** — diff antes → después, masking idéntico en ambos lados.
3. **¿Es reversible?** — ESC y botón "Atrás" en todos los steps; sólo el botón
   final del step 4 produce escritura en disco + audit entry.

Y tiene que **negarse** a comunicar dos cosas:

- **La key completa.** Ni en HTML, ni en `data-*`, ni en `value`, ni en
  respuestas JSON 2xx/4xx/5xx. Solo el patrón `sk-•••••<last4>`.
- **Una sensación de canal alternativo.** El banner "Set inicial → terminal
  Windows" aparece en step 1 y step 2, no como nota al pie, como recordatorio
  con el mismo peso visual que el resto de la decisión.

---

## Paleta y mapeo de estados

Todos los colores vienen de `design-tokens.css`. **Cero hardcoding fuera de
tokens** — si hay que sumar un color, primero se suma al token.

### Identidad por provider (CA-1)

Reusa la familia `3.c` y `3.d` de design tokens (multi-provider). Cada item
del step 1 lleva un acento lateral de 3px con el color identitario:

| Provider          | Token                    | Acento (3px)   | Glyph SVG (`<defs>`)   |
|-------------------|--------------------------|----------------|------------------------|
| Anthropic         | `--provider-anthropic`   | copper #E5946B | `w-prov-anthropic`     |
| OpenAI            | `--provider-openai`      | emerald #34D399| `w-prov-openai`        |
| OpenAI · Codex    | `--provider-openai-codex`| emerald #10B981| `w-prov-codex`         |
| Gemini            | `--provider-gemini`      | blue #8AB4F8   | `w-prov-gemini`        |
| Cerebras          | `--provider-cerebras`    | amber #FFD166  | `w-prov-cerebras`      |

Los glyphs no son los logos oficiales — son **abstracciones tipográficas**
para evitar conflicto de marca (Anthropic = A estilizada; OpenAI = hexágono
concéntrico; Codex = paréntesis angulares; Gemini = chispa de cuatro puntas;
Cerebras = matriz wafer 3×3). El logo oficial sólo aparece en `/about`,
nunca en flujos transaccionales.

### Estados de key (badge derecho del step 1)

Cada item del step 1 lleva un badge con el estado vigente:

| Estado          | Token bg                 | Texto         | Cuándo                                       |
|-----------------|--------------------------|---------------|----------------------------------------------|
| Key configurada | `--success-bg`           | `sk-•••••XXXX`| Existe entry en `credentials.json`            |
| Sin key         | `--warning-bg`           | `sin key — usar terminal` | Provider en `ENV_MAPPING` pero campo `null` |

Decisión de diseño: el badge **no** dice "rotar" ni "configurar" — sólo
**comunica estado**. La acción se decide en el step 2 una vez que el operador
confirmó qué provider toca. Esto evita que el step 1 mezcle estado con
acción.

### Acción del step 2 (CA-2)

Tres tarjetas grandes de 200×200 px (touch target generoso). La tarjeta
"Rotar key" lleva borde activo `--retry` (#F59E0B) porque es **la acción
recomendada en este wizard** — coincide con la razón principal de venir acá.
"Ver metadata" y "Desactivar" tienen borde neutro `--border`.

| Acción         | Acento del icono   | Borde de tarjeta      |
|----------------|--------------------|-----------------------|
| Ver metadata   | `--info` (#58A6FF) | `--border` neutral    |
| Rotar key      | `--retry` (#F59E0B)| `--retry` activo 1.5px|
| Desactivar     | `--danger`(#F85149)| `--border` neutral    |

El recordatorio terminal-only se renderiza como banner inferior, no como
tarjeta, para que no aparezca como "una cuarta opción" del wizard. **Es
explícitamente una opción que no existe en el wizard.**

### Input del step 3 (CA-3)

El input es `type="password"` con `autocomplete="off"` y `spellcheck="false"`.
El borde es `--info` (#58A6FF) — el operador está en una zona de tipeo
sensible, el color cyan refuerza eso sin gritar peligro (no es destructivo,
es introducción de dato).

El **toggle del ojo es press-to-view**: mientras el mouse mantiene el botón
presionado (`mousedown` → `mouseup`), el `type` del input cambia a `text`; al
soltar vuelve a `password`. Esto evita el patrón clásico "click toggle =
exposición persistente" donde una captura de pantalla espontánea filtra la
key.

Debajo del input, el bloque de "validación regex contextual" muestra las
cuatro regex conocidas (`anthropic`, `openai`, `gemini`, `cerebras`). Sólo la
del provider activo se muestra como `[match]`; las otras como `[N/A]`. Esta
visualización es **educativa**, no operativa: hace explícito que el backend
valida por regex sin loguear input, y le dice al operador qué formato espera.

### Diff del step 4 (CA-5 · CA-10)

El step 4 es el clímax visual del wizard. Dos badges grandes, lado a lado:

- **— ANTES** sobre `--danger-bg` (#F85149 con alpha 0.08).
- **+ DESPUÉS** sobre `--success-bg` (#3FB950 con alpha 0.10).

Ambos badges muestran el patrón `sk-•••••XXXX` con el mismo estilo
tipográfico (`--font-mono`). La asimetría visual sólo viene del color del
borde. Decisión de diseño: **el último4 nuevo nunca aparece en otro tamaño,
tipografía, o destacado distinto del último4 viejo**. Si lo hacés, el operador
inconscientemente lo lee como "más importante" y baja la guardia con el
diff. Aquí, ambos pesan visualmente lo mismo — el diff es lo que importa.

Debajo del diff, el bloque de **audit log preview** muestra exactamente la
entry que va a quedar en el JSONL (`{"ts","actor","action","provider",
"last4_old","last4_new","outcome"}`). El operador ve **antes** de confirmar
lo que va a quedar registrado. No hay sorpresa.

### Defense-in-depth pills (CA-6 a CA-9)

Cuatro chips horizontales debajo del audit preview:

- `file-lock mutex` — confirma que la escritura usa `lib/file-lock.js`.
- `no-store + no-cache` — confirma los headers HTTP.
- `CSRF + Sec-Fetch` — confirma que el POST viene del wizard-base (#3724).
- `SHA-256 audit chain` — confirma que el JSONL queda tamper-evident.

Todos sobre `--success-bg`. Decisión: estos chips **no son interactivos**.
Son afirmación visual de las garantías del backend para el operador (cumplen
CA-14 "operable sin docs externos"). No links, no tooltips obligatorios; un
operador entrenado los reconoce.

---

## Reglas operativas no negociables (recopilación)

Estas reglas no son sugerencias del UX — son requisitos derivados de los
CA aprobados por el PO en este issue (#3740) y por los CA padre del épico
(#3715). Se documentan acá para que el dev las tenga en una sola página
cuando arranque la implementación.

### Layout y navegación

- **4 steps lineales** bajo `/dashboard?view=providers&wizard=rotate&step=N`.
  `N ∈ {1,2,3,4}`. La ruta `screenshot-capture.js#ALLOWED_PATHS` sigue
  intacta — el wizard vive bajo `/dashboard` que ya está en la allowlist.
  No agregar paths nuevos.
- **Step 1 → step 2** auto-avanza al click sobre un provider. **Step 2 → step 3
  o step 4** auto-avanza al click sobre una acción. **Step 3 → step 4** es
  manual (botón "Continuar"). **Step 4 → escritura** requiere segundo click
  explícito sobre "Confirmar rotación".
- **ESC siempre cancela** el wizard sin escribir. **"Atrás" siempre vuelve
  al step anterior** sin perder datos del step posterior (idempotencia del
  wizard-base #3724).
- **Backdrop dimmed** (`rgba(0,0,0,0.65)`) sobre la vista del dashboard. Click
  fuera del wizard NO cierra (anti-cierre accidental).
- **Timeout 15 min de wizard-base #3724**: si el operador queda inactivo
  > 15 min en cualquier step, el siguiente submit recibe `419 wizard_session_expired`
  y debe arrancar desde step 1. NO se aplica la rotación.

### Tipografía y espaciado

| Elemento                       | Token tipográfico | Token espacio |
|--------------------------------|-------------------|---------------|
| Título de step ("Paso N de 4") | `--fs-xs` + `--ls-wide` | `--space-3` |
| H1 de step                     | `--fs-2xl` + `--fw-semibold` + `--lh-tight` | `--space-6` |
| Párrafo de ayuda inline        | `--fs-sm` + `--lh-normal` | `--space-4` |
| Mono (last4 + audit JSON)      | `--font-mono` + `--fs-sm` | n/a          |
| Botón primario                 | `--fs-sm` + `--fw-semibold`, padding `--space-3 --space-5` | `--space-4` entre botones |
| Touch target mínimo            | 40 px (botones), 200 px (tarjetas de acción del step 2) | n/a |

### Accesibilidad (CA-14)

- **Foco entra al primer control accionable** de cada step (provider en step
  1, acción en step 2, input en step 3, botón "Confirmar" en step 4).
- **Tab navega en orden lógico**, Shift+Tab vuelve. **Enter selecciona** el
  control con foco en steps 1 y 2; en step 3 NO submitea (evita doble-enter
  accidental al pegar key); en step 4 confirma.
- **Focus-ring** = `--focus-ring` (2 px brand-cyan offset). WCAG 2.1 1.4.11.
- **prefers-reduced-motion**: transiciones entre steps usan `opacity` 200 ms;
  si está activo, salto directo sin animación.
- **prefers-contrast: more**: el borde activo del step 3 sube a 2 px, el
  badge "Sin key" del step 1 cambia a `--warning` plano (sin alpha).
- **aria-label** en cada provider del step 1: `"<Provider>, last4 <XXXX> o sin
  key"`. El badge mockup ya muestra el patrón — el aria duplica para
  lectores de pantalla.

### Security (defense-in-depth) (CA-3..CA-10)

- Input `type="password" autocomplete="off" spellcheck="false"` sin `value`
  precargado.
- Toggle eye-off = `mousedown` → cambia a `text` / `mouseup` → vuelve a
  `password`. NUNCA persistente. Si el operador suelta el mouse fuera del
  botón, también revierte (`mouseleave` cuenta como `mouseup`).
- **localStorage / sessionStorage prohibidos** — test puppeteer en CI valida.
- **Cache-Control** completo en TODAS las respuestas del wizard:
  `Cache-Control: no-store, no-cache, must-revalidate, private`,
  `Pragma: no-cache`, `Expires: 0`, `Vary: Cookie`.
- **Validación regex server-side** por provider, sin loguear input crudo.
  Si falla → `400 format_invalid` con `{provider, ok: false}` (sin echo).
- **Allowlist de provider** contra `ENV_MAPPING` de `lib/credentials.js`. Si
  el body trae un provider fuera de la allowlist → `400` sin tocar disco
  (anti path traversal sobre el JSON de credentials).
- **`file-lock.js`** obligatorio para abrir/cerrar `credentials.json`. TTL
  5–10 s, retry corto.
- **Audit log**: `lib/audit-log.js` con SHA-256 chain. La entry se escribe
  DESPUÉS de la escritura exitosa del JSON (no antes — evita falso positivo
  si la escritura falla).
- **CSRF + Sec-Fetch-Site** validado server-side. CSRF token mono-temporal
  consumido en step 4 (provisto por wizard-base #3724).
- **Render del last4** pasa por `escapeHtml()` de #3722 antes de inyectar
  en DOM. Defensa en profundidad — aunque el regex deje pasar sólo
  `[A-Za-z0-9_-]`, sanitizamos igual.

### Política terminal-only enforced (CA-2)

- Step 2 muestra **exactamente tres tarjetas**: Ver metadata, Rotar, Desactivar.
- El DOM del step 2 **no debe contener** formularios con `action="crear"`,
  `action="nueva"`, ni botones "Crear nueva key" — el test E2E lo verifica
  buscando esos strings y fallando si aparecen.
- El banner inline obligatorio dice literalmente:
  > Para configurar un proveedor por primera vez, ejecutá
  > `setx <PROVIDER>_API_KEY ...` en la terminal de Windows.
  >
  > Este wizard NO crea keys nuevas — sólo opera sobre keys preexistentes.

### Audit log canónico

```json
{
  "ts": "2026-05-30T19:42:08Z",
  "actor": "leitolarreta",
  "action": "rotate_provider",
  "provider": "openai",
  "last4_old": "pM9X",
  "last4_new": "K9pM",
  "outcome": "success",
  "reason": null
}
```

Para acción `deactivate_provider`, `last4_new` es `null`. Para fallos,
`outcome: "fail"` y `reason: "format_invalid" | "lock_timeout" | "csrf_invalid"`
sin incluir nunca la key cruda.

---

## Contraste WCAG AA (todos los tokens del mockup)

Verificado con WebAIM Contrast Checker contra `--surface-0` (#0D1117).

| Token                        | Hex      | Uso en mockup                       | Ratio  | WCAG          |
|------------------------------|----------|--------------------------------------|--------|---------------|
| `--brand-cyan`               | #00D6FF  | Banner terminal-only                 | 11.4:1 | AAA           |
| `--teal`                     | #2DD4BF  | Títulos de step ("STEP N / 4")        | 10.4:1 | AAA           |
| `--provider-anthropic`       | #E5946B  | Acento Anthropic + glyph              | 7.4:1  | AA Normal     |
| `--provider-openai`          | #34D399  | Acento OpenAI + check verde           | 8.9:1  | AA Normal+    |
| `--provider-openai-codex`    | #10B981  | Acento Codex                          | 5.8:1  | AA Normal     |
| `--provider-gemini`          | #8AB4F8  | Acento Gemini                         | 9.2:1  | AAA Normal    |
| `--provider-cerebras`        | #FFD166  | Acento Cerebras                       | 12.3:1 | AAA           |
| `--retry`                    | #F59E0B  | Acción "Rotar key" + borde            | 8.9:1  | AA Normal+    |
| `--danger`                   | #F85149  | Acción "Desactivar" + diff "Antes"     | 5.6:1  | AA Normal     |
| `--success`                  | #3FB950  | Diff "Después" + chips defense        | 7.3:1  | AA+ AAA Large |
| `--warning`                  | #D29922  | Badge "sin key — usar terminal"        | 7.0:1  | AA Normal     |
| `--info`                     | #58A6FF  | Acción "Ver metadata" + borde input    | 7.1:1  | AA Normal+    |
| `--text-secondary`           | #B1BAC4  | Body 12 px                            | 9.7:1  | AAA           |
| `--text-dim`                 | #8B949E  | Labels 11 px (`PASO N DE 4`)          | 5.3:1  | AA Normal     |

Cero tokens en zona AA Large-only para texto crítico. Estados nunca
comunicados solo por color — siempre color + glyph + texto.

---

## Entregables para la fase de delivery

Cuando las dependencias hard se desbloqueen (#3722, #3723, #3724 mergeados
a `main`), el dev del wizard debe:

1. Consumir `lib/escape-html.js` (de #3722) para todo render dinámico.
2. Montar el wizard bajo `?view=providers&wizard=rotate&step=N` consumiendo
   el router de #3723.
3. Usar `lib/wizards/base.js` (de #3724) para CSRF + audit + idempotencia +
   timeout de 15 min.
4. Iterar `ENV_MAPPING` de `lib/credentials.js` para listar providers (sin
   hardcoding).
5. Aplicar los tokens de design-tokens.css listados arriba.
6. Implementar los 16 CA del PO con los tests obligatorios del CA-15.
7. Adjuntar screenshots reales al PR usando `screenshot-capture.js` sobre
   `/dashboard` (la query string no requiere extender `ALLOWED_PATHS`).

### Lo que NO entrega este mockup

- **CSS final del wizard.** El mockup es SVG conceptual; el dev escribe el
  CSS real consumiendo los design tokens.
- **HTML del wizard.** El dev integra con el router de #3723 y el wizard-base
  de #3724 — el HTML emerge de esa integración, no se entrega aquí.
- **Logos oficiales de proveedores.** Decisión deliberada: glyphs abstractos
  para evitar conflicto de marca en herramienta interna. Si en el futuro se
  quiere reemplazar por logos oficiales, se requiere revisión legal.

---

## Decisiones cerradas (para handoff)

- **Layout 4 steps en columna** confirmado — NO se considera "todo en una
  pantalla" (el operador necesita el paso a paso para detenerse y leer el
  diff). Confirmado contra patrón de #3177 (Modal A "Rotar API Key"
  2-step) pero ampliado a 4 steps por requisito CA-1..CA-4 del PO.
- **Acción "Crear nueva key" intencionalmente ausente.** Política
  `feedback_api-keys-terminal-only`. NO es un olvido — el test E2E del
  CA-2 valida que el DOM no contenga formularios con esa acción.
- **Toggle press-to-view en step 3** sobre toggle persistente. La asimetría
  con patrones de "show password" comunes es deliberada: el operador puede
  llegar al wizard con la pantalla compartida en una llamada.
- **Diff con ambos last4 al mismo peso visual** en step 4. NO destacar el
  nuevo más que el viejo — el operador tiene que verificar ambos.
- **4 chips defense-in-depth** debajo del audit preview son **afirmación**,
  no controles. Si en el futuro se vuelven tooltipeables o linkeables a
  docs, se considera nueva sub-tarea.

---

> Este mockup acompaña al issue [#3740](https://github.com/intrale/platform/issues/3740)
> en la fase `criterios` del pipeline de definición. La implementación queda
> bloqueada hasta que #3722, #3723 y #3724 cierren con merge en `main`. El
> brazo de desbloqueo del pipeline destrabará automáticamente cuando los tres
> queden cerrados. Documentación operativa del brazo en
> `docs/pipeline/brazo-desbloqueo.md`.
