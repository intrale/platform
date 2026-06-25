# Narrativa — Rediseño Home V3 "Sala de Control" (#4172)

**Mockup:** `41-home-redesign-v3.html`
**Target canónico:** home V3 (`/v3`) — kiosk vertical 1080×1920. El home legacy `/` queda fuera de scope (deuda #2801).
**Fase:** definición / criterios · agente `ux`.

---

## 1. La visión: una narrativa de conciencia operativa

El problema de la home actual no es que "los bloques estén mal puestos": es que **no
cuenta una historia**. El operador la mira y no sabe a dónde mirar primero. El rediseño
parte de una pregunta de diseño, no de maquetación: *¿qué necesita saber el operador,
en qué orden, cuando levanta la vista hacia el kiosko?*

La respuesta son **tres actos** con urgencia decreciente, leídos de arriba hacia abajo:

| # | Banda | Pregunta que responde | Peso |
|---|-------|----------------------|------|
| 01 | **PULSO** (Salud) | ¿Cómo está el sistema *ahora mismo*? | 22% |
| 02 | **AHORA** (Ejecución) | ¿Qué está corriendo *en este instante*? | 48% |
| 03 | **FLUJO** (Contexto) | ¿Qué *viene* y qué *pasó*? | 30% |

No es un reacomodo: es una **jerarquía intencional**. El pulso arriba (lo que dispara
una acción inmediata), la ejecución en el centro como protagonista visual (lo que da
sensación de "vivo"), y el flujo temporal abajo como contexto que no urge.

---

## 2. El sistema visual que aporta la "visión propia y fluida"

Lo que vuelve esto integral y no cosmético son cuatro decisiones de sistema, todas
construidas **sobre `design-tokens.css`** (cero HEX libres, cero espaciados mágicos):

1. **Riel de estado (border-left 3px) en TODAS las tarjetas.**
   El estado se lee por *posición + icono + texto*, nunca solo por color (WCAG AA).
   Da una gramática visual común a paneles que hoy se ven como islas sueltas.

2. **Eyebrow de banda** (`01 ·  [chip]  PULSO  ───────  meta`).
   Una etiqueta-índice numerada + icono-chip + título + regla horizontal. Marca el
   ritmo de lectura vertical y orienta sin recargar. Es lo que da "fluidez".

3. **El héroe del pulso.**
   El semáforo deja de ser una tarjeta más: se eleva a HÉROE con disco grande (64px),
   veredicto tipográfico grande, y el **único** acento de gradiente de marca
   (cyan→blue) de toda la pantalla. Esa es la decisión que dirige la mirada al dato
   más importante. El resto de la home es deliberadamente sobrio para que el héroe gane.

4. **Tarjeta canónica única.**
   `surface-1` + `border-subtle` + `radius-lg` + `shadow-sm` + padding `--space-4`.
   Una sola receta reusada en todas las bandas → coherencia inmediata, look moderno.

Ritmo de espaciado: `--space-3/4/5/6` exclusivamente. Tipografía: escala de la
identidad (`--font-sans` / `--font-mono` para datos). Acento de marca: reservado al
héroe. Estados: paleta semántica de tokens (success/warning/danger/info/retry/purple).

---

## 3. Mapeo 1:1 con las funciones de render (extender, no reescribir)

El mockup respeta la arquitectura de `home.js` documentada por guru y el arquitecto.
Cada zona del mockup corresponde a una sub-función pura existente:

- **PULSO** → `renderHealthBand` = `renderSemaforo` (→ héroe) + `renderSystemCard` +
  `renderInfraHealth` + `renderAlertTray`. Los 3 KPIs faro son los `kpi-quota*` +
  `kpi-prs-value` ya presentes.
- **AHORA** → `renderNowBand` = `_activeSectionHtml` dentro de `mission-now-scroll`
  (carrusel horizontal de agentes activos).
- **FLUJO** → `renderFlowBand` = `_olaEtaSectionHtml` (SLA/ETA) + `_queueSectionHtml`
  /`_wavePanelHtml` (cola/próximas olas) + `_recentSectionHtml` (últimos ejecutados).

El cambio vive en el **markup/CSS dentro de esas funciones y el `<style>` embebido**,
no en el composer `renderHomeHTML` ni en `collectHomeState()`.

---

## 4. IDs invariantes preservados (anti-flicker)

El refresh hace DOM-morphing por id. El mockup conserva **todos** los ids invariantes
(anotados con `data-id` para trazabilidad):

`mission-grid`, `mission-now-scroll`, `kpi-quota-session-pct`, `kpi-quota-session-eta`,
`kpi-quota-week-pct`, `kpi-quota-week-eta`, `kpi-prs-value`, `ola-eta-section`,
`ola-eta-subtitle`, `ola-eta-p50/-p75/-p90`.

> El dev NO debe renombrar ni eliminar estos ids. Romperlos rompe el CA "se
> re-renderiza sin romper el layout".

---

## 5. Único cambio estructural: proporción del grid

Se propone ajustar `grid-template-rows` de **`20fr 50fr 30fr`** a **`22fr 48fr 30fr`**:
el PULSO gana 2 puntos de aire para sostener el héroe; AHORA sigue siendo la banda
protagonista. Es un ajuste fino, no una reescritura.

> ⚠️ **Acción obligatoria para el dev:** si adopta esta proporción, debe actualizar el
> assert **CA-1** en `home.test.js:246` (espera `grid-template-rows: 20fr 50fr 30fr`)
> **en el mismo commit**. El snapshot de IDs (`home.test.js:214`) debe seguir verde sin
> cambios, porque no se renombra ningún id. Nunca borrar asserts para pasar.
>
> Alternativa conservadora válida: mantener `20fr 50fr 30fr` y no tocar el test. La
> jerarquía del rediseño funciona con ambas proporciones; el 22/48/30 es la recomendada.

---

## 6. Datos: se mantienen las fuentes

Este mockup **no agrega ni quita información**: reorganiza y re-estiliza exactamente
los mismos paneles que hoy expone `collectHomeState()`. `collectHomeState` y los
endpoints `/api/dash/*` quedan **intactos** (CA-6). No se introduce ningún dato
sensible nuevo (sin secrets, tokens, paths absolutos, hostname, cwd).

El "slot libre" de la banda AHORA es presentación derivada de datos ya existentes
(agentes activos vs. límite de concurrencia), no una fuente nueva.

---

## 7. Seguridad (requisitos de la fase análisis)

- **Escape obligatorio**: todo string atacante-controlable (branch/commit de git,
  títulos de issue, nombres de skill) pasa por `escapeHtmlText` (body) o
  `escapeHtmlAttr` (atributos `title=`/`aria-label=`). El mockup no introduce ningún
  sink nuevo: usa `<use href="#ic-*">` para iconos (sin SVG inline crudo) y cero
  `innerHTML` con datos crudos.
- **Sin librerías nuevas**: HTML/CSS puro sobre tokens. No agrega dependencias.

---

## 8. Checklist de validación para el dev (fase desarrollo)

- [ ] Implementar el markup/CSS del mockup dentro de `render*Band` + `<style>` embebido.
- [ ] Consumir `design-tokens.css` (sin paleta/espaciado ad-hoc).
- [ ] Preservar todos los ids invariantes listados en §4.
- [ ] Si adopta 22/48/30, actualizar `home.test.js:246` en el mismo commit.
- [ ] `node --test .pipeline/views/dashboard/__tests__/home.test.js` verde (grid,
      snapshot de IDs, XSS body/atributo, no-leak de secrets/paths).
- [ ] Restart del dashboard (`node .pipeline/restart.js`) + validación en vivo:
      `curl localhost:3200/v3` + grep de ids invariantes + inspección visual.
- [ ] Mantener consistencia con sub-pantallas de Ola 7 (#3962/#3963/#3964/#3965) por
      reuso del mismo sistema de tokens.

---

*Narrativa firmada por el agente `ux` en fase definición/criterios del issue #4172.
Mockup HTML generado con la herramienta de diseño integrada (HTML auto-contenido sobre
`design-tokens.css`), sin servicios externos.*
