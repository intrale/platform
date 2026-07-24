# Ola 9 — Migración física kernel ↔ producto · división en sub-olas

> **Estado:** plan operativo aprobado en conversación (Leo, 2026-07-12). División de la Ola 9
> en 5 sub-olas chicas y controladas, con OK humano entre cada una.
> **Naturaleza:** este documento **planifica la ejecución**; el **qué se mueve** ya está definido y
> firmado en la Ola 8. No redefine la frontera, sólo la secuencia de migración.
> **Inputs directos (Ola 8, todas CLOSED):**
> [`kernel-migration-plan.md`](kernel-migration-plan.md) (EP-OLA8-D, #4012 — qué sale de `.pipeline/`) ·
> [`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) (EP-OLA8-B, #4010 — dónde cae la frontera) ·
> [`kernel-repo-design.md`](kernel-repo-design.md) (estructura, versionado, seguridad, self-hosting) ·
> [`kernel-coexistencia.md`](kernel-coexistencia.md) / [`kernel-updates.md`](kernel-updates.md) (EP8-F, #4014).
> **Tags de rollback:** `pre-desacople-kernel-stable` y `pre-ola9-migracion` sobre main
> (`647a69e2d`) — punto de retorno del modelo operativo actual antes de mover un solo archivo.

---

## 1. Por qué se divide

La Ola 9 completa es un bloque grande y riesgoso: **nace un repo nuevo** y se mueven **~377 archivos
`.js`** del motor + **28 skills** + `config.yaml` (~1064 líneas) + 56 hooks. Ejecutarla de una sola
vez concentra todo el riesgo en un único cutover.

**Principio:** batch chico = menos riesgo y frenado posible. Cada sub-ola:

- Deja el producto **funcionando igual** al terminar (o revertible en minutos).
- Termina en un estado verificable y con **OK humano** antes de arrancar la siguiente.
- Puede pausarse entre una y otra sin dejar el pipeline a medias.

---

## 2. Las 5 sub-olas (orden de dependencia)

| Sub-ola | Alcance | Qué se mueve | Sale de Ola 8 |
|---------|---------|--------------|----------------|
| **9.1 · Repo del kernel** | Crear el repo nuevo y migrar **solo el motor**, sin tocar comportamiento del producto. | `core/` (pulpo/dashboard/scheduler/lifecycle/circuit-breaker/brazo), `lib/` (`credentials`, `handoff`, `redact`), hooks de orquestación/telemetría. **Precondición: escaneo de secretos (gitleaks + trufflehog) → cero hallazgos antes del commit 1.** | [#4012 §3](kernel-migration-plan.md) · [design §2](kernel-repo-design.md) |
| **9.2 · Skills de orquestación** | Mudar al kernel los skills genéricos de proceso. | `delivery`, `branch`, `cost`, `handoff`, `reset`, `ops`, `auth`, `monitor`, `ghostbusters`, `pipeline-dev`. Convenciones embebidas (assignee, formato de rama) → parametrizadas vía config del adaptador. | [#4012 §2.1](kernel-migration-plan.md) · [#4010 §2.2](contrato-kernel-adaptador.md) |
| **9.3 · Skills híbridos (partir)** | Partir a nivel de regla: mecanismo → kernel, contenido de producto → adaptador. | `qa`, `po`, `doc`, `review`, `guru`, `security`, `planner`, `historia`, `refinar`, `priorizar`. Plantilla/gates/secuencia → kernel; labels, reglas de strings/recursos, flujos de negocio, stack → adaptador. | [#4012 §2.1](kernel-migration-plan.md) · [skills-como-capabilities.md](skills-como-capabilities.md) |
| **9.4 · Config + estado** | Partir `config.yaml` y externalizar el estado del motor. | Mecanismo de ruteo/prioridad/umbrales → kernel (`config.schema.json` + `contracts/`); tabla `label→skill`, umbrales calibrados, `pipeline.config.json` instanciado → adaptador. Estado del motor namespaceado por `projectId`. | [#4012 §2.2](kernel-migration-plan.md) · [#4010 §5-§6](contrato-kernel-adaptador.md) · [externalizacion-estado-operativo-remoto.md](externalizacion-estado-operativo-remoto.md) |
| **9.5 · Cutover + coexistencia** | Congelar el `.pipeline/` del producto y adoptar el kernel pineado. | **Cutover con freeze** (no coexistencia indefinida). Aislamiento **Modelo B**: un kernel, estado por `projectId`, scheduler único de ventanas autoexcluyentes (QA>Build>Dev). Verificación de integridad del bootstrap (no auto-update silencioso). | [#4012 §4](kernel-migration-plan.md) · [#4010 §8](contrato-kernel-adaptador.md) · [kernel-coexistencia.md](kernel-coexistencia.md) |

---

## 3. Qué se mueve vs qué queda (resumen de frontera)

Tomado de [`kernel-migration-plan.md` §3.2](kernel-migration-plan.md) — no se redefine acá:

| Sale al **repo del kernel** | Queda en el **repo del producto** (adaptador) |
|------------------------------|-----------------------------------------------|
| Motor `pulpo.js`/`dashboard.js`/scheduler/lifecycle/circuit-breaker/brazo (`core/`). | Skills de stack: `android-dev`, `backend-dev`, `web-dev`, `builder`, `tester`, `perf`, `ux`. |
| Skills de orquestación (`delivery`, `branch`, `cost`, `handoff`, `reset`, `ops`, `auth`, `monitor`, `ghostbusters`, `pipeline-dev`). | `CLAUDE.md` (stack/comandos/arquitectura/strings/flavors). |
| `lib/credentials.js` (mecanismo), `lib/handoff.js`, `lib/redact.js`. | Nombres/scopes de credenciales + auth de producto (Cognito/JWT). |
| Hooks de orquestación/telemetría (parametrizados). | `apk-freshness.js` y hooks que conocen el artefacto del producto. |
| Tipos de artefacto QA genéricos; secuencia de gates; labels `qa:passed/skipped/pending`. | Tabla de ruteo `label→skill`; umbrales del emulador; ejecución QA (emulador/APK/edge-tts). |
| `config.schema.json` + contrato (`contracts/`). | `pipeline.config.json` instanciado para Intrale (manifiesto del adaptador). |

---

## 4. Gates entre sub-olas (fail-closed)

- **OK humano obligatorio** entre cada sub-ola. Ninguna arranca por silencio (política de operador
  ausente de la Ola 2 — fail-closed).
- **Tag antes de cada cutover** que mueva archivos entre repos, para rollback inmediato.
- **Escaneo de secretos** (gitleaks + trufflehog, cero hallazgos) es **precondición** del commit 1
  del repo del kernel (9.1), no post-check.
- Cada sub-ola deja el producto verificablemente funcionando antes de habilitar la siguiente.

---

## 5. Estado actual

- **Ola 2** (Gates de firma del operador) → cerrada 100%, 21/21 en main. Épico paraguas #4570 OPEN
  como tracking formal.
- **Ola 8** (Definición del desacople) → cerrada: épicas #4009–#4014, 6 documentos vivos de diseño.
- **Ola 9** → **arrancando por 9.1**. Sub-olas aún sin desglosar en issues de GitHub (pendiente:
  `/planner split` del épico de la Ola 9 en las 5 sub-olas cuando se confirme el arranque de cada una).

---

## 6. Próximo paso

Arrancar **9.1 (migrar solo el repositorio del kernel)**. Antes de crear issues, confirmar con el
operador el desglose de 9.1 en tareas concretas (crear repo, staging, escaneo de secretos, commit 1
del motor) vía `/planner`.
