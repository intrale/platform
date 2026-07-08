# Roadmap de olas — modelo operativo

> **Propósito:** roadmap oficial hacia adelante de las olas del modelo operativo (pipeline / Commander / kernel / dashboard / app operadora).
> **Estado vivo:** `.pipeline/waves.json` (`active_wave` + `planned_waves`).
> **Baseline histórico:** `docs/auditoria-2026-06/creacion-epicas-y-roadmap.md` (auditoría 2026-06, olas 1–7).
> **Última actualización:** 2026-07-08.

Todas las olas de este roadmap son **modelo operativo**; ninguna toca el producto Intrale (app/backend de negocio). Sin fechas: el esfuerzo se expresa como **Simple / Medio / Grande**.

---

## Baseline ya cerrado

| Ola | Objetivo | Estado |
|-----|----------|--------|
| Auditoría 2026-06 · Olas 1–7 | Dashboard operativo, observabilidad, memoria, Sherlock, entregables núcleo (51 issues #3915–3965) | ✅ |
| Ola 8 · Investigación desacople kernel↔adaptador | Contrato, skills-as-capabilities, repo aparte, wizard, coexistencia (EP-OLA8-A..F, #4009–4014) | ✅ |
| Ola 8.2 · Entregables por fase/agente | Épica #4255 | ✅ |
| Ola 8.3 · Pacing / proporcionalidad de cuota | Paraguas #3791 | ✅ |
| Ola 8.4 · Spike de externalización del estado operativo | Doc #4398 (`externalizacion-estado-operativo-remoto.md`) | ✅ (solo doc) |

---

## Roadmap hacia adelante

| # | Ola | Objetivo | Estado | Tamaño |
|---|-----|----------|--------|--------|
| **0** | **Ola actual — "seed #1"** (`waves.json` #1) | Cerrar: pulido del dashboard + enforcement de entregables + reaperturas del 2026-07-08 (#4531 / #4500 / #4532) | 🔄 en curso | Medio |
| **1** | **Gates de firma del operador** (`waves.json` #2, épico #4570) | Firma humana en definición y aceptación + GATE 0 (veredicto honesto) + GATE 3 (gobernanza de acciones autónomas del kernel) + índice de confiabilidad. Diseño: `gates-firma-operador.md` | 📋 planificada · **committed** · 12 issues (#4571–4582) | Grande |
| **2** | **Ola 9 — Migración física kernel↔adaptador** (`waves.json` #3) | Mover el modelo operativo a su repo (kernel) + implementar el store de estado remoto (del spike #4398). Diseño: `kernel-migration-plan.md`, `contrato-kernel-adaptador.md` | 🎯 diseñada · **sin issues aún** · tentative | Grande |
| **3** | **App operadora móvil** (`waves.json` #4) | Consola móvil para operar el modelo remotamente (firmar gates, ver estado). Fase 1 arranca en Ola 9; app completa después. Groundwork: API de olas #4372, spike #4398 | 💭 dirección · **sin épico** · tentative | Grande |
| **4** | **EP-9 — Deuda operativa y quick wins** (`waves.json` #5) | Gaps G-1..G-10 del plan de auditoría; slot flexible | 💭 futuro · tentative | Medio |

---

## Dependencias que fijan el orden

- **Gates antes de Ola 9.** El issue #4571 (enmienda al contrato kernel↔adaptador: veredicto `requires-operator` + estado `waiting-operator`) debe aterrizar **antes** de la migración, para que Ola 9 se lleve los gates al kernel sin reajuste.
- **Ola 9 antes de la app móvil.** La app necesita el **estado operativo externalizado a remoto** (se implementa en Ola 9). Sin eso no hay app.
- **Superficies del operador (gates) mobile-ready.** Los issues #4579 (Telegram) y #4580 (bandeja) deben exponer aprobar/rechazar **por la API operadora** (patrón de #4372), no Telegram-only, y su estado `waiting-operator` debe ser parte del estado externalizado — sino la ola de la app los re-abstrae.
- **EP-9 es flexible.** Puede intercalarse cuando haya holgura; no bloquea a nadie.

---

## Mapeo de numeración (operativa vs estratégica)

Conviven dos numeraciones y **no coinciden** — este mapeo evita la confusión:

| `waves.json` (operativa) | Estratégica |
|--------------------------|-------------|
| #1 "seed #1" (activa) | cola del track 8.x + pulido dashboard |
| #2 "Gates de firma del operador" | ola intermedia previa a Ola 9 |
| #3 "Migración kernel↔adaptador" | **Ola 9** |
| #4 "App operadora móvil" | post-Ola 9 |
| #5 "Deuda operativa" | **EP-9** |

> Pendiente de higiene: alinear ambas numeraciones o mantener este mapeo como fuente única.

---

## Higiene pendiente

- **Umbrellas huérfanas:** las épicas EP-1..EP-8 (#3915, #3920, #3933, #3937, #3942, #3947, #3952) siguen **abiertas** aunque sus olas (historias) están cerradas. Cerrarlas para que el panorama de épicos abiertos no engañe.
