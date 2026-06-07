# Dashboard V3 — Inventario de migración

> Mapeo "qué existe hoy → dónde queda en el rediseño V3" (épico #3715).
> Esta tabla se completa progresivamente por cada sub-historia hija que
> extrae una ventana o componente. Sin pérdida de funcionalidad: si algo
> existe hoy, debe tener entrada en este inventario antes de cerrar el épico.

## Cómo llenar este inventario

Cada sub-historia hija que extrae una ventana o mueve un componente:

1. Agrega una fila por componente migrado.
2. Marca `Estado` con `pendiente` / `en-progreso` / `migrado` / `eliminado`.
3. Si el componente se elimina (no aporta valor en V3), justifica en `Notas`.
4. Si se mueve a otra ventana, refleja el destino real en `Ventana V3 destino`.
5. Si el origen no es un archivo sino una sección de `dashboard.js`, indica el
   rango aproximado de líneas (ej. `dashboard.js:1403-1410`) para que el
   próximo agente pueda anclarse rápido.

## Tabla

| Componente actual | Archivo origen | Ventana V3 destino | Estado | Notas |
|-------------------|----------------|--------------------|--------|-------|
| Ventana Equipo (header + grid de áreas + chips) | `dashboard.js` (bloque de render extraído) | Equipo (`views/dashboard/equipo.js`) | migrado | `#3727`. `renderEquipoSsr` es el entry point SSR puro. Los derivados `skillStats`/`skillsByCategory` se siguen calculando en `dashboard.js` y se pasan como input. Escape XSS vía `lib/escape-html` (CA-B3) + `safeColor`/`safeLogHref`. |
| `personaCard` / `skillHistoryStrip` | `dashboard.js` | Equipo (`views/dashboard/equipo.js`) | migrado | Helpers movidos al módulo (exportados y testeados). `personaCard` no se invoca desde el grid actual (usa chips), se preserva por CA-A1 (no perder funcionalidad). |
| Heatmap legacy (`heatmapHTML`) | `dashboard.js` | — | eliminado | Dead code: `let heatmapHTML = ''` nunca se renderizaba. Removido en la extracción de #3727. |
| Servicios (`SERVICE_GROUPS` + `STANDALONE_PROCESSES` + `serviceRow` + grid) | `dashboard.js` | Equipo (transitorio) → Ops (pendiente) | en-progreso | **Opción A** (default conservador): `svcCardsHTML` se sigue computando en `dashboard.js` y se pasa pre-renderizado a `renderEquipoSsr` para no perder funcionalidad. Migración a la ventana **Ops** queda pendiente para el split #3732. Acciones operativas heredadas: `ctlAction('<proc>','start'\|'stop')` y `qaComponentAction(...)` (dependen del binding loopback del dashboard). |
| CSS `.eq-*` / `.persona-*` | `dashboard.js` (`<style>` inline de la página principal) | Equipo | pendiente | **Deviación documentada**: el CSS NO se movió a `theme.css`. Verificación empírica (#3727): la página principal del dashboard (DOCTYPE en `dashboard.js`) usa un `<style>` inline y NO carga `theme.css` (sólo el log-viewer lo carga). Mover el CSS rompería el estilo (CA-A1). La migración del CSS se difiere a cuando la página principal adopte `theme.css`. |

### Datos del state consumidos por `equipo.js` (#3727)

`renderEquipoSsr(state)` consume: `skillsByCategory`, `recentBySkill`, `skillUsageCount`,
`skillStats`, `agentPersona` (= `AGENT_PERSONA`), `categoryMeta` (= `CATEGORY_META`),
`pendientes`, `activeStripHTML` (pre-renderizado), `svcCardsHTML` (pre-renderizado).

**Acciones operativas de la ventana**: la ventana Equipo es read-only salvo por las
acciones heredadas de Servicios (Opción A). Todas tienen tooltip (`title=`): chips,
popout, colapsar/expandir y resumen del header.
