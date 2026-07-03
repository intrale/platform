# Narrativa UX — Editor de allowlist en la ventana Roadmap (#4437)

> Guidelines de experiencia + microcopy + iconografía + contrastes WCAG AA +
> mapa de Criterios de Aceptación para la superficie de **edición** de la
> allowlist de la ola (mockup `41-allowlist-editor-roadmap.svg`).
> Generar `.mp3` con `edge-tts` (voz `es-AR-ElenaNeural`) en fase `dev`.

## 1. Contexto y encuadre

La "allowlist" (que Leo llama coloquialmente **la lista de bailes**) es el
conjunto de issues habilitados a ejecutar cuando el pipeline está en **pausa
parcial** (`.partial-pause.json`). Hasta hoy editarla implicaba abrir el JSON a
mano — riesgoso, porque olvidar un hijo o una dependencia **traba el pipeline**
(un padre queda en la lista sin sus hijos y nunca avanza).

Esta historia mueve esa edición al dashboard, dentro de la ventana **Roadmap**,
como panel hermano de la vista read-only de olas (#4373) y del sync status
(#4375). El principio rector de UX:

> **El operador nunca debe descubrir un efecto después de guardar.**
> Todo arrastre recursivo y toda inconsistencia se muestran **antes** de
> persistir, y las inconsistencias graves **bloquean** el guardado.

## 2. Jerarquía visual (3 zonas)

| Zona | Ubicación | Propósito |
|------|-----------|-----------|
| **Allowlist actual + agregar** | columna izquierda (rail teal→blue) | ver y editar la lista (CA-1, CA-3) |
| **Vista previa (dry-run)** | derecha arriba (borde info azul) | qué se arrastra recursivamente, sin persistir (CA-2) |
| **Inconsistencias** | derecha medio (borde danger rojo) | avisos bloqueantes antes de guardar (CA-4, CA-5) |
| **Seguridad + audit** | derecha abajo | requisitos gate S1..S5 + trazabilidad (CA-7) |

El rail izquierdo con gradiente `teal→blue` (`--teal` → `--brand-blue`) marca la
allowlist como una superficie *editable de la ola*, coherente con el mockup 20
(wave-panel) y 40 (roadmap-olas).

## 3. Microcopy (español operador, tono directo)

| Elemento | Texto | Regla |
|----------|-------|-------|
| Título panel | "Allowlist de la ola 8.3" | número de ola dinámico |
| Subtítulo | "Issues habilitados a bailar · fuente: .partial-pause.json (misma que consume el Pulpo)" | reforzar sin fuente paralela (CA-1) |
| Botón agregar | "Agregar (arrastra 3)" | el `N` refleja el conteo del preview — nunca "Agregar" a secas |
| Botón preview | "Ver vista previa" | acción explícita, no automática al teclear |
| Guardar bloqueado | "Guardar (bloqueado: revisar avisos)" | el motivo va en el propio botón, no en tooltip oculto |
| Banner preview | "Vista previa (dry-run) — no persiste" + "`.partial-pause.json` intacto" | promesa de no-escritura visible |
| Truncado | "Grafo truncado · Razón: `max_nodes` (200)" + "Puede haber dependencias no mostradas" | honestidad sobre completitud (A05) |
| Warning padre | "Quitar #4433 dejaría a #4255 con hijos fuera de la lista." | nombra issues concretos, no genérico |
| Warning dep | "#4437 depende de #4372, que no está en la selección candidata." | idem |
| Confirmación | "Entiendo las inconsistencias y quiero continuar igual." | opt-in explícito, checkbox desmarcado por default |

**Prohibido**: mensajes genéricos tipo "hay errores" o "revisá la lista". Cada
aviso nombra el/los issue(s) y la causa (padre-sin-hijos / dependencia faltante).

## 4. Iconografía (todos ya en `sprite.svg` — sin assets nuevos)

| Símbolo mockup | Icono sprite | Uso |
|----------------|--------------|-----|
| `m-roadmap` | `ic-tab-roadmap` | breadcrumb ventana |
| `m-allowlist` | `ic-allowlist-check` | header del panel + estado |
| `m-deps` | `ic-deps-graph` | arrastre recursivo / dependencia |
| `m-preview` | `ic-eye-on` | banner vista previa (dry-run) |
| `m-add` | `ic-wave-add` / `ic-issue-added` | agregar issue |
| `m-remove` | `ic-remove-circle` | quitar issue de la fila |
| `m-warn` | `ic-warn` | header de inconsistencias |
| `m-shield` | `ic-shield-lock` | panel de seguridad |
| `m-audit` | `ic-handoff` / `ic-transition-history` | línea de audit trail |
| `m-lock` | `ic-pause-lock` / `ic-estado-partial-pause` | estado pausa parcial + guardar bloqueado |
| `m-search` | `ic-search` | buscador de issue |
| `m-parent` | `ic-deps-graph` (variante jerárquica) | relación padre/hijo |
| `m-truncate` | `ic-overflow-more` | grafo truncado |
| `m-check` | `ic-ok` / `ic-cell-pass` | ítems cumplidos |

> **No se requieren íconos nuevos.** Si en implementación se quiere un ícono
> dedicado de "padre-sin-hijos", agregar `ic-orphan-parent` al sprite; de lo
> contrario reutilizar `ic-deps-graph` + texto (anti-info-solo-por-color).

## 5. Estados y anti-info-solo-por-color

Cada estado de issue combina **icono + texto + color**, nunca solo color:

- `abierto` → punto verde `--success` + texto "abierto"
- `en dev` → punto azul `--info` + texto "en dev"
- `cerrado` → check gris `--text-dim` + texto "cerrado"
- `padre de N hijos` → icono jerárquico `--purple` + texto
- `dependencia de #X` → icono deps `--teal` + texto

## 6. Contrastes WCAG AA (verificado sobre `--surface-1 #161B22`)

| Par | Ratio | Nivel |
|-----|-------|-------|
| `--text-primary #E6EDF3` / surface-1 | 13.2:1 | AAA |
| `--text-secondary #B1BAC4` / surface-1 | 8.6:1 | AAA |
| `--text-dim #8B949E` / surface-1 | 4.7:1 | AA |
| `--info #58A6FF` / surface-1 | 5.9:1 | AA (texto grande / iconos) |
| `--success #3FB950` / surface-1 | 5.3:1 | AA |
| `--danger #F85149` / surface-1 | 4.9:1 | AA |
| `--warning #D29922` / surface-1 | 5.6:1 | AA |
| `--teal #2DD4BF` / surface-1 | 8.1:1 | AAA |
| Texto en chips (fg semántico / bg alpha 0.14) | ≥ 4.8:1 | AA |

Los textos pequeños (`< 14px`) usan siempre `--text-secondary` o superior para
mantener AA de texto normal (≥ 4.5:1). Los colores semánticos se reservan para
labels de ≥ 11px en negrita o iconos (umbral AA large ≥ 3:1, cumplido con margen).

## 7. Reglas inquebrantables de UX (gate para verificacion / aprobacion)

1. **Guardar bloqueado por default** si hay cualquier inconsistencia; se
   habilita solo tras marcar la confirmación explícita (checkbox opt-in).
2. **Preview obligatorio antes de add**: el botón "Agregar" muestra el conteo de
   arrastre (`arrastra N`) que proviene del dry-run; nunca persiste sin que el
   operador haya visto qué entra.
3. **Truncado siempre honesto**: si el grafo se corta por caps, se muestra la
   razón (`max_depth | max_nodes | cycle`) y el aviso de "dependencias no
   mostradas". Prohibido ocultar el truncamiento.
4. **Whitelist de campos**: la lista muestra solo número, título, estado y
   parent. Nunca paths del filesystem ni timestamps internos (A05).
5. **Promesa de no-escritura visible** en el banner de preview
   (".partial-pause.json intacto").
6. **Separación de artefactos comunicada**: la UI deja claro (footer) que la
   edición toca solo `.partial-pause.json`, nunca `waves.json` (CA-6).

## 8. Mapa de Criterios de Aceptación (PO)

| CA | Cobertura en el mockup |
|----|------------------------|
| CA-1 | Panel izquierdo: lista enriquecida (num·título·estado·parent), whitelist de campos |
| CA-2 | Banner "Vista previa (dry-run)": chips de arrastre + aviso truncado, promesa no-persiste |
| CA-3 | Botón "Agregar (arrastra N)" + línea de audit `authorizedBy`/`justification` |
| CA-4 | Panel rojo: warning padre-sin-hijos (detectDesync) + checkbox de confirmación explícita |
| CA-5 | Guardar bloqueado + inconsistencias visibles ANTES de persistir |
| CA-6 | Footer: "solo toca .partial-pause.json — nunca waves.json" |
| CA-7 | Panel Seguridad S1..S5 (3 gates, same-origin en preview, IDs Number(), gate-only, idempotencia) |
| CA-8 | Footer: `node --test` verde + diff sin waves.json ni writes directos |

## 9. Evidencia visual en aprobacion (sin video de producto)

Por ser **infra pura del `.pipeline/`** (`area:infra`, sin `app:*`), esta
historia **no exige video E2E de producto** (simétrico con el PO, CLAUDE.md →
`area:infra` sin `app:*`). La evidencia visual válida en `aprobacion` es:

1. Este mockup (`41-allowlist-editor-roadmap.svg`) como intención de diseño.
2. Render/screenshot real del panel en el dashboard local.
3. QA structural aprobado (`modo: structural`) con conteo de tokens/iconos
   consumidos por `wave-roadmap.js`.
4. Code review visual acotado: paleta desde tokens, iconos desde sprite, sin
   colores hardcodeados en el área tocada.
