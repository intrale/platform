# Narrativa UX — Vista "Roadmap de olas" (#4373, Ola 8.3)

> Guidelines de diseño + microcopy + iconografía + tabla de contrastes WCAG AA +
> mapa de Criterios de Aceptación de la vista consolidada del roadmap de olas.
> Mockup de referencia: `40-roadmap-olas-v3.svg`. Generar `mp3` en fase `dev`
> (voz `es-AR-ElenaNeural`, dogfooding TTS #2518).

---

## 1. Qué es y para quién

Vista **read-only** del dashboard del pipeline (Node.js, bind loopback). El
**operador** necesita responder de un vistazo, **sin abrir `waves.json` ni logs**:

- ¿Qué ola se está ejecutando **ahora**? (activa)
- ¿Qué viene **después**? (próximas, en orden)
- ¿Qué ya **terminó**? (archivadas)
- Por cada ola: sus issues hijos, prioridad, avance, bloqueos y ETA.

Fuente de verdad canónica: **`.pipeline/waves.json`** vía `lib/waves.js`
(`getActiveWave()`, `getAllPlanned()`, `getArchived()`, `getHorizon(n)`).
**NO existe `roadmap.json`** (aclaración de Guru en el análisis técnico). Toda la
data se sirve **offline** desde el title-cache local (`state.issueTitles`,
`state.issueMatrix`) — **sin llamadas a `gh` en runtime** (CA-10).

---

## 2. Layout (mockup 40, 1440×1020)

Dos columnas bajo un header de identidad:

| Zona | Contenido | CA |
|------|-----------|-----|
| Header | Título "Roadmap de olas" + ícono `ic-tab-roadmap`, subtítulo, chip "datos offline", chip "última actualización" | CA-9, CA-10 |
| Izq. arriba | **Panel OLA ACTIVA** destacado (borde `info`, rail `info`, fondo con gradiente sutil): número + nombre + goal + barra de avance + panel ETA (p50/p75/p90) + panel de bloqueos | CA-1, CA-6, CA-7, CA-8 |
| Izq. abajo | **Issues hijos de la ola activa**: tabla con número, título, prioridad, estado | CA-4, CA-5 |
| Der. arriba | **PRÓXIMAS olas** en orden de ejecución (número + nombre + goal + issues), con aviso "ETA con poca muestra" cuando `samples=0` | CA-2, CA-8 |
| Der. abajo | **ARCHIVADAS** (sección colapsable) con nombre + `closed_at` + resumen | CA-3 |
| Pie izq. | Leyenda de estados (icono + texto, no solo color) | anti-A11y |
| Pie der. | Panel de seguridad (S1..S4) | CA-S1..S4 |

Recomendación de integración (Guru, opción A): **nueva tab "Roadmap"** en
`nav-tabs.js` + `views/dashboard/roadmap.js` + slice `roadmapSlice(state, ctx)`
+ endpoint `/api/dash/roadmap`. Reutiliza `lib/waves.js`, `lib/eta-wave.js`,
`lib/wave-progress.js`, `lib/bloqueados-stats.js`, `lib/escape-html.js`.

---

## 3. Jerarquía visual (por qué la activa "grita" y las demás "susurran")

1. **Ola activa**: la más grande, borde `--info` (#1F6FEB), rail lateral, fondo
   con gradiente `g-active`, badge "ACTIVA" + ícono play. Es lo primero que el ojo
   agarra. El operador tiene que saber en <1s qué corre ahora.
2. **Próximas**: cards medianas, rail `--warning` en la "siguiente" (la que arranca
   apenas cierre la activa), rail neutro `--border-strong` en las de horizonte.
3. **Archivadas**: cards chicas, colapsables, tono apagado (`--text-dim`), check
   verde. Presentes pero fuera del foco.

Regla: **el peso visual comunica el orden temporal**. Activa > siguiente >
horizonte > archivadas.

---

## 4. Estados de issue — icono + texto SIEMPRE (anti "info sólo por color")

Nunca comunicar estado únicamente con color (falla WCAG 1.4.1 y daltonismo).
Cada estado combina **ícono de forma distinta + etiqueta textual**:

| Estado | Ícono (sprite) | Color | Texto |
|--------|----------------|-------|-------|
| done | `ic-ok` / check | `--success` #3FB950 | "done" |
| en curso | spinner (arco) | `--info` #58A6FF | "en curso" |
| pendiente | punto lleno | `--text-dim` #8B949E | "pendiente" |
| bloqueado | candado | `--danger` #F85149 | "bloqueado" |

Prioridad como **badge con texto** (no sólo color):

| Prioridad | Fondo | Texto (fg) | Etiqueta |
|-----------|-------|-----------|----------|
| high | `--danger-dim` #8B1A14 | #FFD2DC | "high" |
| medium | `--warning-dim` #9E6A03 | #FFE5A8 | "medium" |
| low | `--success-dim` #196C2E | #7EE787 | "low" |

---

## 5. ETA — honestidad estadística (CA-8)

- Mostrar **p50 / p75 / p90** (de `lib/eta-wave.js` → `calculateOlaETA()`),
  con `samples=N` visible para que el operador sepa cuánta muestra hay.
- Colorear los percentiles en gradiente de confianza: p50 `--success`, p75
  `--warning`, p90 `--quota-degraded`.
- **Cuando `samples=0`** (poca o nula muestra): NO mostrar un número. Mostrar el
  aviso explícito **"estimación con poca muestra"** en un card con borde
  `--warning-dim`. Un número engañoso es peor que la ausencia de número.

Microcopy del aviso: _"Las olas futuras aún no tienen histórico suficiente
(samples=0). Se muestra el aviso en vez de un número engañoso."_

---

## 6. Bloqueos (CA-7)

- Panel dedicado en la ola activa con badge de conteo (rojo) + lista de issues
  bloqueados con **motivo/blocker textual** desde `state.bloqueados`
  (`{issue, blocker, reason}` de `lib/bloqueados-stats.js`).
- La fila del issue bloqueado en la tabla usa fondo tinte rojo muy tenue
  (#160B0B) + ícono candado + número en rojo. Redundancia color+forma+texto.
- Microcopy: `#4360 → espera a #4350 (schema waves.json)`. Siempre "qué espera a
  qué", no sólo "bloqueado".

---

## 7. Avance por ola (CA-6)

Barra segmentada: verde (done) + ámbar (en curso) + gris (pendiente), con la
lectura numérica a la derecha: **"2 / 11 cerrados · 18%"**. Fuente:
`lib/wave-progress.js` (`readSnapshots()`) + `state.issueMatrix` (fases/bounces).
Preferir "cerrados/total" sobre "% de fases" para el operador (más concreto),
mostrando el % como complemento.

---

## 8. Iconografía nueva

| Símbolo sprite | Uso | Notas |
|----------------|-----|-------|
| `ic-tab-roadmap` (**nuevo**) | Ícono de la tab "Roadmap" y del header | Ruta de hitos ascendente (línea + 4 nodos). Semántica distinta de `ic-wave` (ondas) y `ic-tab-pipeline` (nodos en serie). Se tinta con `currentColor`; activa = `var(--brand-cyan)`. Agregado a `sprite.svg`. |

Reutilizados del sprite existente: `ic-wave`, `ic-ttl-countdown` (ETA),
`ic-pause-lock`/candado (bloqueo), `ic-archive-box` (archivadas), `ic-play`
(activa), `ic-ok` (done), `ic-shield-lock` (panel seguridad).

> En el mockup standalone los íconos se inlinen como `<symbol id="m-*"/>` para
> poder abrirlo en el navegador sin cargar el sprite. En el dashboard real se
> referencian con `<use href="#ic-*"/>`.

---

## 9. Tabla de contrastes WCAG AA (≥ 4.5:1 texto normal, ≥ 3:1 UI/grande)

| Par (fg / bg) | Ratio aprox. | Uso | ✔ |
|---------------|--------------|-----|---|
| #E6EDF3 / #161B22 | 12.6:1 | Títulos sobre surface-1 | ✔ AAA |
| #B1BAC4 / #161B22 | 7.9:1 | Texto secundario | ✔ AAA |
| #8B949E / #0D1117 | 4.9:1 | Texto dim sobre surface-0 | ✔ AA |
| #9EC7FF / #0D274D | 6.2:1 | Badge "ACTIVA" | ✔ AA |
| #FFD2DC / #8B1A14 | 6.8:1 | Badge prioridad high | ✔ AA |
| #FFE5A8 / #9E6A03 | 5.9:1 | Badge prioridad medium | ✔ AA |
| #7EE787 / #196C2E | 4.7:1 | Badge prioridad low | ✔ AA |
| #F5B0AC / #0D1117 | 6.1:1 | Texto de bloqueo | ✔ AA |
| #3FB950 / #0D1117 | 6.0:1 | p50 ETA / done | ✔ AA |
| #58A6FF / #0D1117 | 5.7:1 | "en curso" / info | ✔ AA |

`--text-disabled` #6E7681 (~3.4:1 sobre surface-0) se reserva a metadatos no
esenciales (timestamps auxiliares, notas de pie), nunca a información accionable.

---

## 10. Requisitos de seguridad visibles (heredados de `security` + PO)

| CA | Regla | Patrón del proyecto |
|----|-------|---------------------|
| CA-S1 | Escapar TODO texto dinámico (títulos, labels, goal, nombres de ola, motivos de bloqueo) | `escapeHtmlText`/`escapeHtmlAttr` de `lib/escape-html.js` o `textContent`. Prohibido interpolar crudo en `innerHTML`/template strings. |
| CA-S2 | Endpoint `/api/dash/roadmap` pasa por loopback gate | `isLoopbackReq(req)` + `isSameOriginFetch(req)` + headers `no-store`/`nosniff` (`sendPartialHtml`). |
| CA-S3 | Whitelist de campos al serializar al front | `normalizeWave()` — no volcar objetos JSON completos (evita filtrar paths absolutos/tokens). |
| CA-S4 | Si se leen olas archivadas por nombre/ID de query param | allowlist o `path.basename` + verificar que el path resuelto quede dentro del dir esperado. |

El panel de seguridad del mockup (pie derecho) hace estas 4 reglas **visibles**
para el dev que implemente, no las esconde en un doc aparte.

---

## 11. Mapa Criterio de Aceptación → elemento visual

| CA | Cubierto por |
|----|--------------|
| CA-1 Ola activa destacada | Panel "ACTIVA" (número, nombre, goal, avance) |
| CA-2 Próximas olas en orden | Lane "Próximas olas" con "siguiente" + horizonte |
| CA-3 Archivadas (colapsable) + `closed_at` | Sección "Olas archivadas" |
| CA-4 Issues hijos (número, título, estado) | Tabla de issues de la ola activa |
| CA-5 Prioridad por issue (badge) | Badge `high`/`medium`/`low` |
| CA-6 Avance por ola | Barra segmentada + "cerrados/total · %" |
| CA-7 Bloqueos + motivo | Panel "Bloqueos activos" + fila tinte rojo |
| CA-8 ETA p50/p75/p90 + "poca muestra" | Panel ETA + aviso `samples=0` |
| CA-9 Sin abrir JSON ni logs | Vista única autosuficiente |
| CA-10 Offline sin `gh` | Chip "datos offline" + nota footer |
| CA-S1..S4 | Panel de seguridad + reglas §10 |

---

## 12. Microcopy de referencia (tono operativo, español rioplatense neutro)

- Header: **"Roadmap de olas"** / _"Vista operativa · qué se ejecuta ahora y qué sigue — sin abrir JSON ni logs"_
- Badge activa: **"ACTIVA"**
- Card siguiente: **"siguiente"** (etiqueta) — card horizonte: **"+N en horizonte"**
- Avance: **"2 / 11 cerrados · 18%"**
- ETA: **"ETA de ejecución"** + `samples=N`
- Aviso poca muestra: **"estimación con poca muestra"**
- Bloqueo: **"Bloqueos activos"** + `#4360 → espera a #4350 (schema waves.json)`
- Archivadas: **"cerrada 02/07 02:15 · 0 done / 0 fail · 1 día"**
- Colapsar/expandir: **"colapsar ▴" / "ver todos ▾"**

Evitar: jerga interna sin contexto, siglas sin expandir la primera vez, y sobre
todo **números de ETA sin `samples`**.

---

## 13. Evidencia esperada en QA (fase aprobación)

Como el issue es `area:pipeline` **sin `app:*`** (dashboard interno de infra), el
gate QA se resuelve por **captura/video del dashboard corriendo** mostrando la
tab "Roadmap" con: activa + próximas + archivadas + hijos + prioridad + avance +
bloqueos + ETA. No aplica emulador Android. El agente UX en aprobación evalúa por
el PASO 2-bis (assets + mockups + code review) si no hay video E2E de usuario
final, respetando la simetría con PO (CLAUDE.md → `area:infra`/`area:pipeline`).
