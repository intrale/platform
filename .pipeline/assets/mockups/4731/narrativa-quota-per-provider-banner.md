# UX — Rediseño del banner de cuota por proveedor (#4731)

> Entregable de UX en fase **criterios**. Guidelines visuales + spec de
> implementación + mockup (`quota-per-provider-banner.svg`) para que el dev
> (pipeline-dev) ubique el diseño sin improvisar. Coherente con el sistema de
> diseño existente (`.pipeline/assets/design-tokens.css`) — **no requiere
> tokens nuevos**.

## Problema de UX que resolvemos

El banner actual (`views/dashboard/home.js:4327`) hardcodea
`"Modo determinístico — cuota Anthropic agotada"` sin importar qué proveedor
disparó el flag, y trata cualquier flag como **"todo el pipeline detenido"**.
En el incidente 14–15/07 esto dejó ~30hs un banner amarillo mintiendo: Codex
disparó el flag, Anthropic/Cerebras seguían sanos, pero el operador veía "modo
determinístico global" e intervenía manualmente sin necesidad.

**Objetivo de experiencia:** que de un vistazo el operador distinga
"un proveedor flojo, el pipeline sigue" de "sin LLM, modo determinístico real".

## Principio de diseño (la decisión visual clave)

El **color comunica el scope**. Reasignamos el ámbar:

| Scope | Cuándo | Paleta | Tono |
|-------|--------|--------|------|
| **Puntual** (`partial`) | ≥1 proveedor LLM operativo | `--provider-<id>-*` del afectado, fondo `--surface-1` | calmo, informativo |
| **Global** (`global`) | 0 proveedores LLM operativos | `--quota-degraded-*` + glow | alarma controlada (ámbar) |

El ámbar `--quota-degraded-*` deja de ser "genérico de cuota" y pasa a significar
**exclusivamente "sin LLM disponible"**. Así el ámbar recupera su peso de alarma y
no se "quema" por degradaciones puntuales que no lo son.

## Anatomía del banner (los 3 estados del mockup)

Ver `quota-per-provider-banner.svg`. Reutiliza la estructura DOM actual
(icono · content · countdown) y **agrega**:

1. **Borde izquierdo = color del proveedor afectado** (no siempre ámbar).
   Con 2 afectados, borde bicolor (mitad/mitad).
2. **Chips por proveedor afectado** (`.quota-provider-chip[data-provider]`):
   dot + nombre en `--provider-<id>-fg` + motivo normalizado + reset. Uno por
   proveedor → habilita el CA plural.
3. **Health strip** (`.quota-health-strip`): `"N operativos:"` + dots
   `--success` con nombres. Es la **evidencia visible de "no global"** (CA-2).
4. **Countdown** teñido con el color del proveedor cuyo reset es más próximo.
5. En **global**, se conservan los paneles Det/LLM del banner actual (siguen
   siendo útiles cuando de verdad no hay LLM).

Header conserva el pill **RUNNING** verde: refuerza que el pipeline no está caído.

## Copy (reemplaza el string hardcodeado)

- **Partial · 1 afectado:** `Proveedor {name} degradado — {motivo}` · sub `{N} proveedores operativos`.
- **Partial · N afectados:** `{K} proveedores degradados — {N} operativos` (chip por proveedor).
- **Global · 0 LLM:** `Modo determinístico — sin proveedores LLM disponibles` (único copy que conserva "modo determinístico").

### Allowlist de motivos (`error_type` → label ES, CA-6 / A03)

| `error_type` | label |
|--------------|-------|
| `usage_limit_reached` | límite de uso del plan |
| `usage_limit_error` | cuota agotada |
| `rate_limit` | rate limit temporal |
| `schedule_rest` | reposo horario |
| *(fuera de allowlist)* | degradado |

`{name}` se resuelve por id contra un mapa fijo (`anthropic→Anthropic`,
`openai-codex→Codex`, `cerebras→Cerebras`, `gemini→Gemini`, `groq→Groq`). Todo
lo dinámico pasa por `escapeHtmlAttr`/`textContent` y el **color se elige por id
allowlisteado**, nunca inyectando el valor crudo en `style`/`class`.

## Regla de scope (para `dashboard-slices.js` + `getQuotaState`)

```
operationalProviders = proveedores LLM sanos (cruce con lib/provider-health)
scope = operationalProviders >= 1 ? "partial" : "global"
```

El banner lee `data-scope` para elegir paleta. `active = OR de slots con
resets_at futuro` (ya definido en la receta técnica del issue).

## CSS — clases nuevas sobre el sistema existente

Reutiliza las `--provider-*` ya presentes. Selección de color **por atributo**,
sin inline styles:

```css
/* Contenedor: default = puntual (calmo). Global = override ámbar. */
.quota-exhausted-banner { background: var(--surface-1); border: 1px solid var(--border);
  border-left: 4px solid var(--border-strong); box-shadow: none; }
.quota-exhausted-banner[data-scope="global"] { background: var(--quota-degraded-bg);
  border-color: var(--quota-degraded); border-left-color: var(--quota-degraded);
  box-shadow: var(--quota-degraded-glow); }

/* Borde/acento por proveedor afectado (scope puntual, 1 afectado) */
.quota-exhausted-banner[data-provider="openai-codex"] { border-left-color: var(--provider-openai-codex); }
.quota-exhausted-banner[data-provider="anthropic"]   { border-left-color: var(--provider-anthropic); }
.quota-exhausted-banner[data-provider="cerebras"]    { border-left-color: var(--provider-cerebras); }
.quota-exhausted-banner[data-provider="gemini"]      { border-left-color: var(--provider-gemini); }
.quota-exhausted-banner[data-provider="groq"]        { border-left-color: var(--provider-groq); }

/* Chip por proveedor */
.quota-provider-chip { display:inline-flex; align-items:center; gap:6px;
  border-radius:14px; padding:4px 12px; font-size:12px; font-weight:700; }
.quota-provider-chip[data-provider="openai-codex"] { color:var(--provider-openai-codex-fg);
  background:var(--provider-openai-codex-bg); border:1px solid var(--provider-openai-codex); }
/* ...idem por proveedor con sus tokens --provider-<id>-{fg,bg} */

/* Health strip */
.quota-health-strip { display:inline-flex; gap:12px; align-items:center;
  font-size:11px; color:var(--text-secondary); }
.quota-health-dot { width:8px; height:8px; border-radius:50%; background:var(--success); }
```

## Accesibilidad (verificado en el header del SVG)

- `text-primary` 14.8:1 · `text-secondary` 9.7:1 · `success` 5.4:1 (AA)
- `codex-fg/bg` 8.7:1 · `anthropic-fg/bg` 11.2:1 · `amber-fg` 13.5:1 (AAA)
- Mantener `role="status"`, `aria-live="polite"`, icono `aria-hidden`.
- El color **nunca** es el único canal: cada proveedor tiene nombre en texto
  (daltonismo-safe) + dot; el scope se distingue por copy además de tono.

## Contratos a preservar

- **CA-14 (#3077):** el texto del banner aparece en el HTML servido **solo con
  flag activo** (`data-active="true"`). El skeleton inactivo sigue sin nombres
  de proveedor ni "modo determinístico" → `curl / | grep` vacío sin flag.
- **IDs anti-flicker:** conservar `#quota-exhausted-banner/-title/-sub/-countdown`;
  los chips nuevos usan ids/data derivados por proveedor.
- **Backward-compat:** flag legacy sin `providers` → slot `anthropic`; el banner
  lo pinta como partial/global según health, sin romper.

## Validación esperada (CA-7)

1. Render real: `curl -s localhost:<port>/ | grep` del copy dinámico con flag activo.
2. Screenshot render-vs-mockup (este SVG) en QA visual.
3. `dashboard-quota-exhausted.test.js` verde (SSR/cliente, sanitización, scope).

## Assets entregados

- `.pipeline/assets/mockups/4731/quota-per-provider-banner.svg` — mockup de los 3 estados + spec.
- `.pipeline/assets/mockups/4731/narrativa-quota-per-provider-banner.md` — este documento.
