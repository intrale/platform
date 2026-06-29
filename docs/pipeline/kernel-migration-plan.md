# Plan de migración conceptual kernel ↔ producto (Ola 8 · EP-OLA8-D)

> **Épica:** EP-OLA8-D · Repo aparte para el modelo operativo (issue #4012)
> **Ola:** 8 — Definición del desacople kernel operativo ↔ producto
> **Naturaleza:** documento de **definición** (no implementación). Plan de migración
> **conceptual** (sin ejecutar): dónde cae la frontera kernel vs producto y qué saldría hoy de
> `.pipeline/` hacia el repo del kernel. La Ola 8 **define**; la Ola 9 **ejecuta** la migración con
> OK humano.
> **Inputs directos (dependencias CLOSED):**
> [`docs/desacople-kernel/inventario-frontera.md`](../desacople-kernel/inventario-frontera.md) (EP-OLA8-A, #4009) ·
> [`docs/pipeline/contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) (EP-OLA8-B, #4010).
> **Documento hermano:** [`kernel-repo-design.md`](kernel-repo-design.md) (estructura, consumo,
> versionado, seguridad).
> **Estado:** documento vivo — se revisa al entrar a la Ola 9.

---

## Cómo leer este documento

Este es el **corazón del entregable** de #4012: decide **qué se mueve al repo del kernel y qué
queda en el repo del producto**, y enumera **qué saldría hoy de `.pipeline/`**. Cada decisión se
apoya en una fuente verificable —el **contrato** de #4010 o el **inventario** de #4009— y no en
intuición.

Las dependencias #4009 y #4010 están **CLOSED** (verificado 2026-06-29; el `brazoDesbloqueo`
reingresó este issue al cerrarlas). Por eso este documento ya **no** tiene secciones stubeadas
`pendiente de #4009/#4010`: se redacta apoyado en esos dos documentos.

Mapeo sección ↔ criterios de aceptación (CA del PO en #4012):

| Sección | CA cubiertos | Estado |
|---------|--------------|--------|
| 1. Convención de migración | — | Cerrado |
| 2. Frontera kernel vs producto (apoyada en el contrato) | CA-5 | **Cerrado** |
| 3. Inventario de qué saldría de `.pipeline/` + escaneo de secretos | CA-6 | **Cerrado** |
| 4. Riesgos de coexistencia | CA-7 | **Cerrado** |

> **Nada se ejecuta en esta épica (CA-8).** Este plan es conceptual: ningún archivo de `.pipeline/`
> se mueve. La migración física es trabajo de la Ola 9, con OK humano.

---

## 1. Convención de migración

Reusamos el vocabulario del inventario (#4009 §0) y del contrato (#4010 §2):

| Destino | Significado | Repo final |
|---------|-------------|-----------|
| **kernel** | Lógica genérica de orquestación. Se muda al **repo del kernel** sin conocer el producto. | Repo nuevo del kernel. |
| **producto (adaptador)** | Conocimiento de producto (stack, dominio, build, auth). **Queda** en el repo Intrale como adaptador. | Repo del producto (Intrale). |
| **a-decidir → se parte** | Híbrido: el *mecanismo* va al kernel; el *contenido/parámetros* quedan como config del adaptador. Se parte a nivel de regla/sección en la Ola 9. | Ambos (mecanismo→kernel, parámetros→producto). |

**Principio rector** (del contrato #4010 §2): *los mecanismos* van al kernel; *los nombres, scopes,
labels, comandos y patrones concretos del producto* quedan en el adaptador. Ninguna pieza marcada
`kernel` nombra a Intrale.

---

## 2. Frontera kernel vs producto

<!-- CA-5 -->

La frontera ítem por ítem ya fue trazada formalmente en el **contrato** (#4010 §2), apoyado en el
**inventario** (#4009). Esta sección la traduce a una **decisión de migración**: a qué repo va cada
ítem. **Cada fila cita su fuente** (contrato/inventario) — sin especular.

### 2.1. Skills — qué repo

| Ítem (skill) | Destino | Fuente | Decisión de migración |
|--------------|---------|--------|-----------------------|
| `delivery`, `branch`, `cost`, `handoff`, `reset`, `ops`, `auth`, `monitor`, `ghostbusters`, `pipeline-dev` | **kernel** | [#4010 §2.2](contrato-kernel-adaptador.md) · [#4009 §1.2](../desacople-kernel/inventario-frontera.md) | Mudan a `skills/` del repo del kernel. Las convenciones embebidas (assignee, formato de rama) se **parametrizan** vía config del adaptador. |
| `android-dev`, `backend-dev`, `web-dev`, `builder`, `tester`, `perf`, `ux` | **producto** | [#4010 §2.1](contrato-kernel-adaptador.md) · [#4009 §1.1](../desacople-kernel/inventario-frontera.md) | Quedan en el repo Intrale. **Son** el adaptador de producto: implementan las capabilities (`build`/`test`/`e2e`/`package`) que el kernel define como interfaz ([#4010 §3, §4](contrato-kernel-adaptador.md)). |
| `_frozen/desktop-dev`, `_frozen/ios-dev` | **producto** | [#4010 §2.3](contrato-kernel-adaptador.md) · [#4009 §1.3](../desacople-kernel/inventario-frontera.md) | Stack del producto (congelados). Quedan en el adaptador. |
| `_frozen/scrum` | **kernel** | [#4010 §2.3](contrato-kernel-adaptador.md) | Proceso de orquestación (zombi V3). Muda al kernel (o se descarta vía #3219). |
| `refinar`, `po`, `priorizar`, `review`, `guru`, `security`, `planner`, `historia`, `doc` | **a-decidir → se parte** | [#4010 §2.2](contrato-kernel-adaptador.md) · [#4009 §1.2](../desacople-kernel/inventario-frontera.md) | La **plantilla/proceso** (gates, triaje, code-review, investigación) va al kernel; el **contenido** (labels del producto, reglas de strings/recursos, flujos de negocio, stack referenciado) queda como config/conocimiento del adaptador. |
| `qa` | **a-decidir → se parte** | [#4010 §2.7](contrato-kernel-adaptador.md) · [#4009 §4](../desacople-kernel/inventario-frontera.md) | Híbrido fuerte: regla "feature con UI → E2E con video" + secuencia "QA→Tester→PO" + labels `qa:passed/skipped/pending` → **kernel**; emulador Android + APK por flavor + edge-tts/Lambda → **producto** (capability `e2e`). |

### 2.2. `config.yaml` — qué repo

| Ítem (sección/regla) | Destino | Fuente | Decisión de migración |
|----------------------|---------|--------|-----------------------|
| `dev_skill_mapping` (ruteo `label→skill`) | **a-decidir → se parte** (crítico #1) | [#4010 §2.4, §2.8](contrato-kernel-adaptador.md) · [#4009 §6](../desacople-kernel/inventario-frontera.md) | El **mecanismo** de ruteo (`route`/`resolveRouting`) va al kernel; la **tabla concreta** `app:client→android-dev`, `area:backend→backend-dev` la **inyecta el adaptador** vía `pipeline.config.json` ([#4010 §6.1](contrato-kernel-adaptador.md)). No se hardcodea en el kernel. |
| `dev_routing_priority` | **a-decidir → se parte** | [#4010 §2.4](contrato-kernel-adaptador.md) | El mecanismo de prioridad → kernel; la **lista de labels** → adaptador. |
| `pipeline_scope_keywords` | **a-decidir → se parte** | [#4010 §2.4](contrato-kernel-adaptador.md) | Mecanismo de override → kernel; keywords (`pulpo.js` vs producto) → config del adaptador. |
| `dev_skill_mapping.default` (fallback) | **producto** | [#4010 §2.4](contrato-kernel-adaptador.md) | Asume un área por defecto del stack del producto → adaptador. |
| Límites de concurrencia / umbrales `qa_env_max_*`, `qa:1` | **a-decidir → se parte** | [#4010 §2.4, §2.7](contrato-kernel-adaptador.md) | El throttling → kernel; los **valores** calibrados al hardware/emulador → adaptador. |
| Artefactos QA (`types/formats`) | **kernel** | [#4010 §2.4](contrato-kernel-adaptador.md) | Tipos genéricos (video/document). Mudan al kernel. |

### 2.3. `CLAUDE.md`, `.pipeline/*.js` + hooks — qué repo

| Ítem | Destino | Fuente | Decisión de migración |
|------|---------|--------|-----------------------|
| `CLAUDE.md`: Stack/Comandos build/Arquitectura/Strings/Flavors | **producto** | [#4010 §2.5](contrato-kernel-adaptador.md) · [#4009 §2.2](../desacople-kernel/inventario-frontera.md) | Conocimiento del producto. Queda en el repo Intrale (adaptador). |
| `CLAUDE.md`: Ramas y PRs / Gate de QA | **a-decidir → se parte** | [#4010 §2.5](contrato-kernel-adaptador.md) | Convención/secuencia de gates → kernel; nombres/bases/labels concretos → adaptador. |
| `CLAUDE.md`: Protocolo de tareas / concurrencia / Lanzamiento de agentes (Pulpo, worktrees, circuit breaker) | **kernel** | [#4010 §2.5](contrato-kernel-adaptador.md) | Descripción del motor. Muda al kernel (salvo paths del repo, que se parametrizan). |
| `.pipeline/pulpo.js`, `dashboard.js`, libs (intake/colas/lifecycle/routing) | **kernel** | [#4010 §2.5](contrato-kernel-adaptador.md) · [#4009 §2.3](../desacople-kernel/inventario-frontera.md) | Motor del pipeline. Núcleo de `core/` del repo del kernel. |
| Convención rama `agent/*` + worktrees hardcodeados en JS | **a-decidir → se parte** | [#4010 §2.5](contrato-kernel-adaptador.md) | Mecanismo de ramas/aislamiento → kernel; el **patrón concreto** `agent/*` + base `origin/main` → config del adaptador. |
| `.pipeline/` embebido dentro del repo del producto | **producto** (acoplamiento estructural a resolver) | [#4010 §2.5, §2.8](contrato-kernel-adaptador.md) · [#4009 §6 crítico #2](../desacople-kernel/inventario-frontera.md) | Es **el** acoplamiento estructural. La separación lo resuelve: el estado del motor pasa a ser propiedad del kernel, namespaceado por `projectId` ([#4010 §5, §8](contrato-kernel-adaptador.md)), separable del repo orquestado. |
| `agent-concurrency-check.js`, `agent-registry.js`, `activity-logger.js` | **kernel** | [#4010 §2.5](contrato-kernel-adaptador.md) | Hooks de orquestación/telemetría. Mudan a `hooks/` del kernel. |
| `apk-freshness.js` | **producto** | [#4010 §2.5](contrato-kernel-adaptador.md) | Conoce el artefacto APK del producto → adaptador. |

### 2.4. Frontera de secretos y auth — qué repo

| Ítem | Destino | Fuente | Decisión de migración |
|------|---------|--------|-----------------------|
| Mecanismo de carga de credenciales (`lib/credentials.js`) | **kernel** | [#4010 §2.6](contrato-kernel-adaptador.md) · [#4009 §3](../desacople-kernel/inventario-frontera.md) | Cargador unificado (precedencia env > json > legacy). Mecanismo → `lib/` del kernel. |
| Nombres / scopes de credenciales concretos (`telegram.bot_token`, `providers.*`, AWS Intrale) | **producto** | [#4010 §2.6](contrato-kernel-adaptador.md) | Los *qué* credenciales y scopes → adaptador. El kernel los recibe por **brokering** ([#4010 §7 CA-11](contrato-kernel-adaptador.md)). |
| Auth de producto (JWT / Cognito / `SecuredFunction`) | **producto** | [#4010 §2.6](contrato-kernel-adaptador.md) | Patrones de auth del producto → adaptador. **No** suben al kernel. |
| Redacción de secretos en handoff (`lib/handoff.js` + `lib/redact.js`, #2993) | **kernel** | [#4010 §2.6, §7 CA-13](contrato-kernel-adaptador.md) | Higiene genérica + anti prompt-injection. Muda a `lib/` del kernel para proteger cualquier producto. |

---

## 3. Inventario de qué saldría de `.pipeline/`

<!-- CA-6 -->

### 3.1. Magnitud física (medida en #4009)

Lo que hoy vive en `.pipeline/` + `.claude/`, sobre la magnitud verificada por `guru`:

| Conjunto | Magnitud (medida #4009) | Destino predominante |
|----------|-------------------------|----------------------|
| `.pipeline/*.js` (motor, libs, hooks internos) | **~377 archivos `.js`** | mayormente **kernel** (`core/`, `lib/`, `dashboard/`) |
| `.pipeline/config.yaml` | **1 archivo, ~1064 líneas** | **se parte**: mecanismo→kernel, tabla de ruteo/umbrales→adaptador (§2.2) |
| `.claude/skills/*` | **28 entradas** (27 activos + `_frozen`) | **se parte**: 11 kernel, 9 producto, 9 a-decidir (§2.1) |
| `.claude/hooks/*.js` | **56 archivos** (25 con refs a `agent/`/`worktree`) | mayormente **kernel**, con patrones de rama parametrizados |
| `CLAUDE.md` | **1 archivo, ~292 líneas, 38 matches de stack** | mayormente **producto** (queda como adaptador) |

### 3.2. Lo que sale al kernel vs lo que queda — resumen

| Sale al **repo del kernel** | Queda en el **repo del producto** (adaptador) |
|------------------------------|-----------------------------------------------|
| Motor `pulpo.js`/`dashboard.js`/scheduler/lifecycle/circuit-breaker/brazo de desbloqueo (`core/`). | Skills de stack: `android-dev`, `backend-dev`, `web-dev`, `builder`, `tester`, `perf`, `ux`. |
| Skills de orquestación: `delivery`, `branch`, `cost`, `handoff`, `reset`, `ops`, `auth`, `monitor`, `ghostbusters`, `pipeline-dev`. | `CLAUDE.md` (stack/comandos/arquitectura/strings/flavors). |
| `lib/credentials.js` (mecanismo), `lib/handoff.js`, `lib/redact.js` (#2993). | Nombres/scopes de credenciales + auth de producto (Cognito/JWT). |
| Hooks de orquestación/telemetría (`agent-concurrency-check`, `agent-registry`, `activity-logger`, `branch-guard`, `worktree-guard` parametrizados). | `apk-freshness.js` y hooks que conocen el artefacto del producto. |
| Tipos de artefacto QA genéricos; secuencia de gates; labels de proceso `qa:passed/skipped/pending`. | Tabla de ruteo `label→skill` concreta; umbrales calibrados al emulador; ejecución QA (emulador/APK/edge-tts). |
| Esquema `config.schema.json` + contrato (`contracts/`). | El `pipeline.config.json` **instanciado** para Intrale (manifiesto del adaptador). |

### 3.3. Paso obligatorio — escaneo de secretos antes del primer commit

> Requisito de **Security** (#4012, CA-6). Un repo nuevo arranca con historia limpia: **si algo
> sensible entra en el commit 1, queda en la historia para siempre.**

**Precondición del commit 1 del repo del kernel** (orden estricto):

1. **Escaneo de secretos** con `gitleaks` **y** `trufflehog` sobre **todo** lo que migre desde
   `.pipeline/`/`.claude/` hacia el repo del kernel, **antes** del primer commit.
   ```bash
   # Conceptual — se ejecuta en la Ola 9 sobre el staging del repo del kernel, NO ahora
   gitleaks detect --source <staging-kernel> --no-git --redact
   trufflehog filesystem <staging-kernel> --only-verified
   ```
2. **Cero hallazgos** es condición de avance. Cualquier match (AWS key, JWT, bot token, API key de
   provider, password) **bloquea** el commit hasta sanear.
3. **Frontera de secretos confirmada:** el kernel **nace sin secretos**. Las credenciales NO están
   hoy en `.pipeline/` (viven en `~/.claude/secrets/credentials.json`, cargadas por
   `lib/credentials.js`) — el plan **preserva** esa frontera: el kernel lee por **brokering** del
   adaptador/host ([#4010 §7 CA-11](contrato-kernel-adaptador.md)), nunca por valores embebidos.
4. Sólo tras 1–3 en verde → **commit 1** del repo del kernel.

Este paso es **precondición**, no post-check: se corre sobre el staging antes de que exista historia
git en el repo nuevo.

---

## 4. Riesgos de coexistencia

<!-- CA-7 -->

Correr kernel y producto en paralelo durante la transición introduce riesgos que el documento debe
contemplar, cruzándolos con **EP8-F (#4014)** donde corresponde:

| Riesgo | Descripción | Mitigación | Cruce |
|--------|-------------|-----------|-------|
| **Divergencia / cutover** | Kernel y `.pipeline/` evolucionando en paralelo durante la coexistencia → drift entre ambos. | **Cutover con freeze**: punto de corte donde se congela el `.pipeline/` del producto y se adopta el kernel pineado. No coexistencia indefinida. | **EP8-F (#4014)** |
| **Recursos** | Correr pipeline-Intrale + pipeline-kernel en la **misma máquina** (ya al límite de RAM, ver umbrales recalibrados). Dos motores completos no entran. | Decisión de aislamiento **Modelo B** ([#4010 §8.1](contrato-kernel-adaptador.md)): **un** kernel con estado namespaceado por `projectId` + scheduler único de ventanas autoexcluyentes (QA>Build>Dev), **no** N procesos kernel. | **EP8-F (#4014)** · [#4010 §8](contrato-kernel-adaptador.md) |
| **Bootstrap / self-hosting (punto K)** | ¿Con qué versión del kernel se desarrolla el **propio** kernel? Riesgo de loop de envenenamiento si el kernel se auto-actualiza solo. | El kernel-N+1 se desarrolla con una instancia **pineada y firmada** del kernel-N ([`kernel-repo-design.md` §2.2, §4 tabla #7](kernel-repo-design.md)); el bootstrap **verifica integridad** (no auto-update silencioso). | [`kernel-repo-design.md` §3.3](kernel-repo-design.md) |
| **Cross-talk multi-tenant** | Con el Modelo B, el operador puede actuar sobre el proyecto equivocado. | `projectId` **visible** en toda superficie operador-facing; acciones destructivas confirman el `projectId` afectado ([#4010 §8.2](contrato-kernel-adaptador.md)). | [#4010 §8](contrato-kernel-adaptador.md) |

---

## 5. Notas de alcance

- **Cero ejecución (CA-8).** Este documento es **conceptual**: ningún archivo de `.pipeline/` se
  mueve, borra o edita. La migración física es Ola 9, con OK humano. Verificable:
  `git diff --name-only main` del PR de esta épica = sólo `docs/pipeline/*.md`.
- **Documento vivo.** Se revisa al entrar a la Ola 9. La clasificación `a-decidir → se parte`
  marca lo que requiere diseño explícito (partir a nivel de regla), no indecisión.
- **Trazabilidad.** Cada decisión de migración cita su fuente (#4009 inventario / #4010 contrato).
  No hay decisiones por intuición (CA-5).
- **Anti scope-creep.** El entregable es frontera + inventario de migración. Mover/refactorizar el
  código real es Ola 9.

---

## Verificación (inspección estructural)

```bash
# CA-5 — cada ítem de frontera cita su fuente (contrato/inventario)
grep -nE 'contrato-kernel-adaptador|inventario-frontera' docs/pipeline/kernel-migration-plan.md

# CA-6 — inventario de qué sale + paso de escaneo de secretos antes del commit 1
grep -nE 'gitleaks|trufflehog|antes del.*commit' docs/pipeline/kernel-migration-plan.md

# CA-7 — riesgos de coexistencia (divergencia/recursos/bootstrap) + cruce con #4014
grep -nE 'cutover|Modelo B|self-hosting|#4014' docs/pipeline/kernel-migration-plan.md

# CA-8 — el plan no ejecuta migración (cero cambios en .pipeline/)
git diff --name-only main | grep '^.pipeline/'   # esperado: 0 resultados
```

**DoD (checklist final del PO):**

- [ ] Frontera kernel/producto con **cada ítem citando su fuente** (CA-5).
- [ ] Inventario de qué sale de `.pipeline/` sobre la magnitud medida (~377 `.js` + `config.yaml` + 28 skills) (CA-6).
- [ ] Paso explícito de escaneo de secretos (gitleaks/trufflehog) como precondición del commit 1 (CA-6).
- [ ] Riesgos de coexistencia (divergencia/cutover, recursos, bootstrap) con cruce a #4014 (CA-7).
- [ ] Cero ejecución de migración: `.pipeline/` intacto (CA-8).
