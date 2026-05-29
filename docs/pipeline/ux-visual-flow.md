# Workflow visual UX — Screenshots & Mockups por LLM

> **Issue origen:** [#3381](https://github.com/intrale/platform/issues/3381).
> **Estado:** rollout gradual, default **OFF** (`SCREENSHOTS_MOCKUPS_GATE_ENABLED=1` para activar el gate).
> **Audiencia:** `/ux`, `/po`, `/qa`, devs de Android (`/android-dev`) y de pipeline (`/pipeline-dev`).
>
> ⚠️ **Tecnología real (clarificación 2026-05-29 · issue #3647):** los mockups se generan con **Anthropic SDK + HTML/CSS + Puppeteer**. **NO se usa Claude Design** (claude.ai/design). Claude Design vive en el bucket Max separado y no tiene endpoint programable que el pipeline pueda integrar — se evaluó en la definición original del #3381 y se descartó. Si una memoria/documentación menciona "Claude Design" como fuente del flujo, está desactualizada respecto a la implementación real entregada.

## Por qué existe

La **Ola N+7** mostró un patrón claro: rediseños visuales (#3356 encabezado del dashboard, #3357 KPIs) se mergearon con cambios de código y la interfaz no mostró mejora visible en producción. El agente codeaba a ciegas: leía el código, asumía cómo se veía, escribía "mejoras", pero **sin referencia visual objetiva** no había forma de validar si el cambio se reflejaba.

Este workflow cierra ese gap forzando dos artefactos visuales adjuntos al issue **antes** de pasar a Ready:

1. **Estado actual** — screenshot de cómo se ve hoy.
2. **Estado esperado** — mockup PNG renderizado a partir de HTML/CSS que devuelve el LLM (Anthropic SDK).

Los devs codean contra un mockup concreto y el PO/QA validan en aprobación con un checklist comparativo (no "se ve bien" subjetivo).

## Cuándo aplica el gate

| Condición | En scope |
|---|---|
| Issue con label `app:client`, `app:business` o `app:delivery` | ✅ Sí (Caso B Android) |
| Issue con label `area:pipeline` que toca `dashboard-v2.js`, `.pipeline/dashboard.js` o `.pipeline/public/` | ✅ Sí (Caso A Dashboard) |
| Issue con label `area:pipeline` sin tocar archivos del dashboard (ej. hooks, scripts sin UI) | ❌ No (exento) |
| Issue con label `ux:no-visual` aplicado por el dev | ❌ No (opt-out justificado) |
| Issue sin labels app/pipeline | ❌ No |

El gate **no bloquea** si `SCREENSHOTS_MOCKUPS_GATE_ENABLED` no está en `1` — el rollout es gradual.

## Los dos casos

### Caso A — Dashboard del Pulpo

El dashboard ya corre 24×7 en `http://localhost:3200`. Capturarlo es trivial:

| Aspecto | Implementación |
|---|---|
| **Estado actual** | `screenshot-capture.capture()` lanza Puppeteer headless, hace `goto('http://localhost:3200')` + `screenshot({ fullPage: true })`. Viewport default 1440×900. |
| **Estado esperado** | `ux-mockup-generator.generate()` arma prompt → Anthropic SDK (Opus 4.7 default, Sonnet 4.6 fallback) → extrae HTML/CSS de la respuesta → `screenshot-capture.renderHtmlToPng()` exporta PNG. |
| **Persistencia** | Ambos PNGs se adjuntan al issue como comments con `gh issue comment --file`. El body gana sección `## Screenshots & Mockups` con links a los comments. |

### Caso B — Apps Android

| Aspecto | Implementación |
|---|---|
| **Estado actual** | **NO levantar emulador.** El agente `/ux` busca la captura más reciente de la pantalla afectada en `qa/evidence/<issue>/` (109 subcarpetas a la fecha) o `docs/app-screenshots-reference/`. Si no hay baseline, documenta "sin baseline visual — primera implementación" en el comentario y sigue con solo el esperado. |
| **Estado esperado** | Mismo flujo LLM, pero el prompt incluye flavor (`client`/`business`/`delivery`) y viewport Android mdpi (411×891). |

## Herramientas que componen el flujo

### `.pipeline/lib/screenshot-capture.js`

Wrapper Puppeteer headless con guardrails:

- **URL hardcodeada** (`http://localhost:3200`) — anti-SSRF (CA-15).
- **Allowlist de paths** (`/`, `/v3`, `/dashboard`) — bloquea `/ops` y paneles internos con secrets (CA-19).
- **Sanitización de filename**: `path.resolve` + prefix-check + regex `[a-z0-9_-]` (CA-16).
- **Fail-soft**: si Puppeteer no está instalado o el dashboard no responde, devuelve `{ ok:false, reason:'dashboard-down' }` en lugar de tirar (CA-2).
- Función `renderHtmlToPng()` reusa la misma maquinaria para exportar HTML del LLM a PNG.

### `.pipeline/lib/ux-mockup-generator.js`

Helper LLM + render:

1. Carga `docs/design-system/tokens.json` (paleta, tipografía, spacing, radii). Si no existe → defaults Material 3 + warning.
2. Construye prompt con **template fijo** (CA-UX-10): contexto del producto + tokens + reglas inquebrantables + descripción del cambio + formato de salida.
3. Llama Anthropic SDK con `temperature: 0.3` (CA-UX-11). Modelo default `claude-opus-4-7`, fallback `claude-sonnet-4-6`.
4. Extrae HTML del fence ```` ```html ... ``` ```` de la respuesta.
5. Renderiza con `renderHtmlToPng()` al viewport correspondiente.

**Reglas inquebrantables del prompt** (CA-UX-1/2/3):

- WCAG AA (contraste 4.5:1 normal, 3:1 ≥18pt).
- Android: touch targets ≥48dp, separación ≥8dp.
- Usar tokens del sistema de diseño; prohibido HEX arbitrarios.
- Tipografía: escala Material 3 (no `font-size` libre).
- HTML self-contained, sin fetch externo, sin scripts.
- Salida: SOLO un fence ```html```.

### `.pipeline/hooks/screenshots-mockup-gate.js`

Linter del body del issue. Recibe `{labels, body}` y devuelve `{gate: 'ok'|'block'|'opted-out'|'out-of-scope'|'disabled', missing?}`.

- **Anti-ReDoS** (CA-10/17): parsing line-by-line con `split`, regex con cuantificadores acotados (`[\s\S]{0,500}`), bound defensivo de 80k bytes en el body. Tests sintéticos de 65k chars terminan en **<100 ms**.
- Sin I/O ni efectos: decisión pura. El integrador (reconciler) decide si alertar o aplicar comment.

### Integración en `servicio-reconciler.js`

Sweep cada 5 min (mismo intervalo que el admission gate). Lista issues `Ready`, evalúa cada uno con el hook y enviá una alerta Telegram con la lista de issues bloqueados. **No revierte labels automáticamente** — solo señaliza para triaje humano + invocación de `/ux`.

Activación: `SCREENSHOTS_MOCKUPS_GATE_ENABLED=1` en el entorno del pipeline. Default OFF.

## Seguridad

Esta sección consolida los requisitos del análisis security (CA-15..19, CA-UX-8).

| # | Riesgo | Mitigación |
|---|---|---|
| 1 | **SSRF** vía URL parametrizada (atacante dirige browser a 169.254.169.254 o servicios internos) | `screenshot-capture.js` usa URL **hardcodeada** (`http://localhost:3200`). El path está restringido a `ALLOWED_PATHS = ['/', '/v3', '/dashboard']`. El helper NO acepta URL del agente bajo ninguna circunstancia. |
| 2 | **Path traversal** en filename (`../etc/passwd`) | `resolveSafeOutputPath` hace `path.resolve` + prefix-check contra `allowedRoot`, valida el basename contra `/[^a-z0-9_-]/`. Tira `Error` si detecta traversal o chars inválidos. |
| 3 | **PII/secrets exfiltrados** en screenshots adjuntos a issues públicos (tokens, costos, logs sensibles) | Política operativa **inquebrantable**: screenshots NUNCA con datos productivos. Usar entornos QA o datos sintéticos. Si el dashboard expone (ahora o a futuro) paneles internos con secrets, capturar SOLO `/v3` o rutas sanitizadas — nunca `/ops`. |
| 4 | **ReDoS** en el hook que parsea bodies de hasta 65k chars | Parsing line-by-line (`split(/\r?\n/)`), regex con cuantificadores acotados, bound de 500 chars por línea. Test sintético de 65k chars valida `<100 ms`. |
| 5 | **CVEs Puppeteer/Chromium** (superficie V8/Blink) | Reusar la versión instalada en `docs/qa/`. `npm audit` periódico (deuda menor, no bloquea este issue). |
| 6 | **Inyección por prompt** desde el body del issue (atacante mete instrucciones tipo "ignore previous") | El prompt al LLM tiene template fijo con reglas inquebrantables al inicio. El body del issue va al final como "descripción del cambio". Modelos Claude resisten razonablemente este vector cuando las reglas tienen prioridad sintáctica clara. |

**Tres recomendaciones futuras** (independientes, requieren aprobación humana — ya creadas):

- [#3394](https://github.com/intrale/platform/issues/3394) — Sanitizar screenshots antes de adjuntar (detección PII/secrets).
- [#3395](https://github.com/intrale/platform/issues/3395) — Allowlist anti-SSRF más estricta + post-validación.
- [#3397](https://github.com/intrale/platform/issues/3397) — Política formal "screenshots NUNCA con datos productivos".

## Abort conditions del agente `/ux`

| Condición | Comportamiento |
|---|---|
| Falta `ANTHROPIC_API_KEY` (`~/.claude/secrets/credentials.json` → `providers.anthropic.api_key`) | `{ok:false, reason:'missing-credentials'}`. El agente aborta + alerta Telegram pidiendo cargarla (regla `feedback_api-keys-terminal-only`). |
| `@anthropic-ai/sdk` no instalado | `{ok:false, reason:'sdk-missing'}`. Abort con instrucción `npm install @anthropic-ai/sdk` en `.pipeline/`. |
| `puppeteer` no instalado | `{ok:false, reason:'puppeteer-missing'}`. Abort con instrucción `npm install puppeteer` en `.pipeline/`. |
| Dashboard no responde (Caso A) | `{ok:false, reason:'dashboard-down'}`. NO aborta el flujo: el agente registra warning en el comentario y continúa con solo el mockup esperado (CA-2). |
| Sin baseline visual (Caso B) | El agente documenta "sin baseline — primera implementación" en el comentario y sigue con solo el esperado (CA-4). |

## Checklist de comparación visual del PO (en aprobación)

Reemplaza el "matchea visualmente" vago de CA-13 (PO) con ejes verificables (CA-UX-9):

- [ ] **Paleta**: colores principales del entregado coinciden con tokens del mockup.
- [ ] **Tipografía**: jerarquía y tamaños relativos respetados.
- [ ] **Espaciados**: márgenes y paddings consistentes (variación admisible ±4dp).
- [ ] **Jerarquía visual**: elementos importantes en el mockup son los más prominentes en el entregado.
- [ ] **Accesibilidad observable**: contraste y tamaños no degradaron respecto al mockup.

Si todos ☑ → matchea. Si ≥1 ☒ → rebote a dev con el eje específico señalado.

## Convención de filenames

| Caso | Pattern |
|---|---|
| Caso A actual | `dashboard-actual-<YYYYMMDD-HHMM>.png` |
| Caso A esperado | `dashboard-esperado-<YYYYMMDD-HHMM>.png` |
| Caso B actual | `<screen-slug>-<flavor>-actual.png` (ej. `login-client-actual.png`) |
| Caso B esperado | `<screen-slug>-<flavor>-esperado-<state>.png` (ej. `login-client-esperado-base.png`, `login-client-esperado-error.png`) |

Solo caracteres `[a-z0-9_-]`. El helper sanitiza automáticamente (CA-16).

## Rollout

| Fase | Cuándo | Acción |
|---|---|---|
| **Default OFF** | Primer merge de este workflow | `SCREENSHOTS_MOCKUPS_GATE_ENABLED` ausente → gate `disabled`. Los helpers están listos para invocación manual del `/ux` pero el sweep del reconciler no alerta. |
| **Soft ON** | Tras 1 semana de rodaje + 2-3 issues piloto | `SCREENSHOTS_MOCKUPS_GATE_ENABLED=1`. Sweep alerta por Telegram cuando hay issues `Ready` en scope sin sección. NO revierte labels. |
| **Hard ON** (opcional, issue separado) | Si la alerta no es suficiente | Acción adicional: workflow GitHub Actions que bloquea el merge si el PR cierra un issue en scope sin sección. |

## Tests

- `.pipeline/lib/__tests__/screenshot-capture.test.js` — 22 tests.
- `.pipeline/lib/__tests__/ux-mockup-generator.test.js` — 16 tests con fakes del SDK.
- `.pipeline/hooks/__tests__/screenshots-mockup-gate.test.js` — 19 tests, incluido ReDoS sintético.

```bash
node --test .pipeline/lib/__tests__/screenshot-capture.test.js \
            .pipeline/lib/__tests__/ux-mockup-generator.test.js \
            .pipeline/hooks/__tests__/screenshots-mockup-gate.test.js
```

## Issues relacionados

- [#3356](https://github.com/intrale/platform/issues/3356) — Encabezado dashboard (caso testigo Ola N+7).
- [#3357](https://github.com/intrale/platform/issues/3357) — KPIs dashboard (caso testigo Ola N+7).
- [#3382](https://github.com/intrale/platform/issues/3382) — Librería formalizada `docs/app-screenshots-reference/`.
- [#3386](https://github.com/intrale/platform/issues/3386) — Indexar `qa/evidence/` por nombre de pantalla.
- [#3387](https://github.com/intrale/platform/issues/3387) — Comparación visual automatizada con pixelmatch.
- [#3388](https://github.com/intrale/platform/issues/3388) — Extraer `screenshot-capture.js` a `.pipeline/lib/` compartido entre UX y QA.
- [#3401](https://github.com/intrale/platform/issues/3401) — Inyectar design-system persistido al prompt LLM.
- [#3402](https://github.com/intrale/platform/issues/3402) — Panel Visual Diff Browser en dashboard.

## Idioma

Doc operativa en español; identificadores de código, labels GitHub y env vars en inglés (mismo criterio que el resto del proyecto).
