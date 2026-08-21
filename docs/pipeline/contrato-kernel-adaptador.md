# Contrato kernel ↔ adaptador (Ola 8 · EP-OLA8-B)

> **Épica:** EP-OLA8-B · Contrato kernel↔adaptador (issue #4010)
> **Ola:** 8 — Definición del desacople kernel operativo ↔ producto
> **Naturaleza:** documento de **definición** (no implementación). Traza la frontera formal
> kernel↔adaptador y define la interfaz entre ambos. La Ola 8 **define**; la Ola 9 **implementa**.
> **Input directo:** [`docs/desacople-kernel/inventario-frontera.md`](../desacople-kernel/inventario-frontera.md) (EP-OLA8-A, #4009).
> **Estado:** documento vivo — se revisa al entrar a la Ola 9.
>
> **Versión del contrato:** `0.2.0` (semver) <!-- CA-1, CA-14 -->
>
> Historial de cambios: ver [Changelog](#changelog) al final del documento.

---

## Cómo leer este documento

El **kernel operativo** es el motor genérico que orquesta agentes sobre *cualquier* producto:
no sabe nada de un stack concreto. El **adaptador de producto** es la capa que enseña al kernel
cómo es el producto específico (su stack, sus labels de dominio, sus comandos de build, sus
gates). Este contrato define **qué vive de cada lado** (sección 2), **qué le pide el kernel al
adaptador** (secciones 3–4), **cómo el kernel descubre y carga un adaptador** (sección 6) y
**qué garantías de seguridad y multi-tenant** son obligatorias desde el día uno (secciones 7–8).

Mapeo sección ↔ criterios de aceptación (CA del PO en #4010):

| Sección | CA cubiertos |
|---------|--------------|
| 1. Propósito y alcance | CA-1 |
| 2. Frontera kernel ↔ adaptador | CA-2, CA-3 |
| 3. Interfaz / puertos (Ports & Adapters) | CA-4 |
| 4. Puntos de extensión (hooks/capabilities) | CA-5 |
| 5. Invariante de lifecycle | CA-6 |
| 6. Descubrimiento y carga del adaptador | CA-7, CA-8 |
| 7. Seguridad incorporada | CA-9 … CA-14 |
| 8. Multi-tenant | CA-15 |
| 9. Salida y trazabilidad | CA-16, CA-17 |

---

## 1. Propósito y alcance

<!-- CA-1 -->

**Propósito.** Establecer el contrato técnico que separa el **kernel operativo genérico** del
**adaptador de producto**, de modo que el mismo motor de orquestación pueda conducir el ciclo de
vida de agentes sobre productos de cualquier stack sin reescribir su lógica.

**Alcance (qué define este documento).**

- La **frontera ítem por ítem** sobre el inventario de #4009 (sección 2).
- Los **puertos** que el kernel pide al adaptador, con firma conceptual (sección 3).
- Los **puntos de extensión** (hooks/capabilities) que el adaptador puede implementar (sección 4).
- El **invariante de lifecycle** del estado en filesystem (sección 5).
- El **mecanismo de descubrimiento y carga** declarativo del adaptador y su validación previa (sección 6).
- Los **requisitos de seguridad** de la frontera, con mapeo OWASP (sección 7).
- El **modelo multi-tenant** por `projectId` y la decisión de aislamiento (sección 8).
- La **salida** (sub-issues de Ola 9) y la reafirmación de **cero riesgo** para el producto (sección 9).

**Fuera de alcance (qué NO define).**

- Implementación de código del kernel o del adaptador (eso es **Ola 9**).
- Migración o refactor de skills/`config.yaml`/hooks existentes (Ola 9).
- Comandos concretos de un stack particular (gradle, emulador, Lambda): aparecen sólo como
  **ejemplo** del adaptador, nunca como requisito del kernel.

**Naturaleza.** Diseño, no código. El único artefacto productivo de esta épica es este
documento (más, en Ola 9, las sub-issues que enumera la sección 9).

---

## 2. Frontera kernel ↔ adaptador

<!-- CA-2, CA-3 -->

La tabla siguiente traza la frontera **ítem por ítem** sobre el inventario de #4009. Cada ítem
del inventario aparece **exactamente una vez** con su lado asignado y una justificación de una
línea. Valores de la columna **Lado**:

- **kernel** — lógica genérica de orquestación; se muda al kernel sin conocer el producto.
- **producto** — conocimiento de producto (stack, dominio, build, auth); vive del lado adaptador.
- **autoridad** — decide *quién puede aprobar qué* (gates, firma del operador, circuit breaker,
  alta de productos/repos). Es un subconjunto duro del kernel: **nunca** es configurable desde
  el lado del producto. Ver §2.4.

> **Vocabulario (#5173, REQ-UX-6).** El vocabulario canónico es **kernel · producto ·
> autoridad**. Las tablas §2.1–§2.3 y §2.5+ son del inventario original de #4009 y todavía
> usan los nombres viejos: `adaptador` ≡ **producto**, y `a-decidir` significaba "híbrido, se
> parte más adelante". Para `config.yaml` esa categoría **ya no existe**: §2.4 clasifica las 59
> secciones sin ninguna indecisión, y los híbridos se resuelven partiéndolos por sub-path
> (columna *Nota*). El default es **fail-closed**: una clave sin lado declarado se trata como
> `kernel`, nunca como `producto`.

> **Invariante de frontera (CA-3):** ninguna fila marcada **kernel** referencia el producto por
> nombre. Verificable con `grep` (ver sección "Verificación"). Las filas que sí nombran el
> producto son, por construcción, **adaptador** o **a-decidir**.

### 2.1. Skills acoplados al producto — inventario §1.1

| Ítem (skill) | Lado | Justificación (1 línea) |
|--------------|------|-------------------------|
| `web-dev` | adaptador | Stack del producto (Wasm/PWA/Webpack); 47 matches de stack. |
| `android-dev` | adaptador | Stack del producto (Compose, flavors, Coil); 32 matches. |
| `backend-dev` | adaptador | Stack + auth del producto (Ktor, Lambda, DynamoDB, Cognito); 21 matches. |
| `tester` | adaptador | Cobertura sobre el stack del producto (Kover, kotlin-test, Gradle); 18 matches. |
| `perf` | adaptador | Performance de builds y módulos del stack del producto (Gradle); 18 matches. |
| `builder` | adaptador | Comandos de build del producto (gradlew, APK por flavor); 17 matches. |
| `ux` | adaptador | Produce assets visuales del producto (Compose, branding por flavor); 25 matches. |

### 2.2. Skills de orquestación e híbridos — inventario §1.2

| Ítem (skill) | Lado | Justificación (1 línea) |
|--------------|------|-------------------------|
| `delivery` | kernel | Commit + push + PR; mecanismo genérico, las convenciones de rama/assignee se parametrizan. |
| `branch` | kernel | Gestión de ramas y protección de la rama base; git puro, genérico. |
| `cost` | kernel | Token cost tracker por sesión/agente; métrica de orquestación agnóstica. |
| `handoff` | kernel | Postea payload de delivery en el issue; mecanismo genérico de traspaso. |
| `reset` | kernel | Hard reset de la infra de orquestación; opera sobre el motor, no sobre el producto. |
| `ops` | kernel | Validación/diagnóstico del entorno de ejecución; genérico. |
| `auth` | kernel | Permisos del harness (Claude Code); genérico, no es auth de producto. |
| `monitor` | kernel | Dashboard de semáforos multi-sesión; orquestación pura. |
| `ghostbusters` | kernel | Limpieza de procesos zombi/worktrees/locks; higiene del motor. |
| `pipeline-dev` | kernel | Desarrolla el orquestador mismo; es el dev del propio kernel. |
| `refinar` | a-decidir | Refinamiento de issues genérico; embebe labels y tablero del producto. |
| `po` | a-decidir | Plantilla de gates (kernel) con contenido de negocio del producto. |
| `priorizar` | a-decidir | Triaje masivo genérico; las categorías/labels son del producto. |
| `review` | a-decidir | Code review genérico; las reglas citadas (strings, recursos) son del producto. |
| `guru` | a-decidir | Investigación técnica genérica; el codebase investigado es el producto. |
| `security` | a-decidir | Marco OWASP genérico; las referencias de auth concretas son del producto. |
| `planner` | a-decidir | Planificación genérica; sprints/historias y stack referenciado son del producto. |
| `historia` | a-decidir | Plantilla de historias genérica; labels de admisión y stack embebido son del producto. |
| `doc` | a-decidir | Gestión de backlog genérica; labels/áreas del producto embebidas en el ruteo. |
| `qa` | a-decidir | Híbrido fuerte; se parte regla por regla en §2.6 (proceso=kernel, ejecución=adaptador). |

### 2.3. Contenedor `_frozen` — inventario §1.3

| Ítem (skill congelado) | Lado | Justificación (1 línea) |
|------------------------|------|-------------------------|
| `_frozen/desktop-dev` | adaptador | Stack del producto (Compose Desktop/JVM); congelado. |
| `_frozen/ios-dev` | adaptador | Stack del producto (Compose iOS); congelado. |
| `_frozen/scrum` | kernel | Proceso de orquestación (zombi V3); congelado, genérico. |

### 2.4. `config.yaml` — clasificación completa de las 61 secciones (#5173)

<!-- #5173 · Entrega B de #5111. Reemplaza la tabla parcial del inventario original,
     que clasificaba 6 de 57 secciones y dejaba 4 ítems sin decidir. -->

Las **60** secciones top-level de `.pipeline/config.yaml`, una por una, con su forma real y su
lado. Es la expresión legible de `SIDE_MAP` en `.pipeline/lib/config-schema.js`: **si esta tabla
y ese mapa divergen, falla el test** `#5173 toda sección top-level de config.yaml está declarada
en el schema y tiene lado` **en el PR**, no en el arranque.

Reparto: **39 kernel · 12 autoridad · 9 producto**.

> **Regla operativa (CA-1).** La raíz del schema está **cerrada**
> (`additionalProperties: false`). Agregar una sección nueva a `config.yaml` exige declararla en
> `config-schema.js` **en el mismo commit**; si no, `loadConfig` la ve como clave desconocida,
> dispara `haltOnConfigCorruption` y el pipeline arranca pausado.

> **Formas que NO son objeto.** 3 secciones son arrays (`dev_routing_priority`,
> `pipeline_scope_keywords`, `prioridad_labels`) y 5 son escalares (las 4 de `sherlock_*` y
> `telegram_burst_window_ms`). Tiparlas como `object` rompe el arranque.

| # | Sección (línea) | Forma | Lado | Nota |
|---|-----------------|-------|------|------|
| 1 | `pipelines` (4) | obj | kernel | Split: el grafo de fases es mecanismo; `pipelines.*.skills_por_fase` nombra skills del producto. |
| 2 | `concurrencia` (26) | obj | kernel | Throttling por rol: mecanismo de orquestación. |
| 3 | `routing` (64) | obj | kernel | Ruteo de archivos de trabajo entre fases; mecanismo puro. |
| 4 | `intake` (68) | obj | kernel | Admisión de issues desde GitHub; mecanismo. Los labels concretos los parte #5174. |
| 5 | `admission_gate` (98) | obj | **autoridad** | Gobierna qué entra al pipeline; decide autonomía. |
| 6 | `e2e_evidence` (124) | obj | **autoridad** | Gobierna la evidencia exigida por el gate de QA. |
| 7 | `dev_skill_mapping` (130) | obj | producto | Mapea labels de dominio del producto a skills de stack. |
| 8 | `dev_skill_partitions` (145) | obj | producto | Partición de skills por área del producto. |
| 9 | `dev_routing_priority` (157) | **array** | producto | Lista concreta de labels del producto. |
| 10 | `pipeline_scope_keywords` (170) | **array** | producto | Keywords de override del producto. |
| 11 | `prioridad_labels` (186) | **array** | producto | Labels de prioridad del tablero del producto. |
| 12 | `feature_priority` (194) | obj | producto | Política de priorización de features del producto. |
| 13 | `resource_limits` (213) | obj | kernel | Los umbrales de presión son mecanismo; la calibración fina la parte #5174. |
| 14 | `timeouts` (270) | obj | kernel | Timeouts de orquestación; mecanismo puro. |
| 15 | `desync` (296) | obj | kernel | Detección/resolución de desync de estado; mecanismo. |
| 16 | `build` (304) | obj | producto | Contiene `java_home_allowlist` con paths de JDK de esta máquina. |
| 17 | `circuit_breaker` (315) | obj | **autoridad** | Corta la autonomía del pipeline ante rebotes; decide autonomía. |
| 18 | `precheck` (353) | obj | kernel | Chequeos previos al dispatch; mecanismo. |
| 19 | `anomaly_detector` (372) | obj | kernel | Detección de anomalías del motor; mecanismo. |
| 19b | `human_block_reminder` (291) | obj | kernel | Cadencia con que el motor insiste ante un bloqueo humano sin responder (#5337); mecanismo, no política de producto. |
| 20 | `cost_anomaly_alert` (395) | obj | kernel | Alerta de anomalía de costo del motor; mecanismo. |
| 21 | `ghostbusters_cron` (411) | obj | kernel | Higiene programada del motor; mecanismo. |
| 22 | `rest_mode` (434) | obj | kernel | Modo descanso del motor; mecanismo. |
| 23 | `staleness` (447) | obj | kernel | Detección de trabajo stale; mecanismo. |
| 24 | `watchdog` (461) | obj | kernel | Vigilancia de agentes; mecanismo. |
| 25 | `wave_watchdog` (489) | obj | kernel | Vigilancia de avance de ola; mecanismo. |
| 26 | `dashboard` (498) | obj | kernel | Superficie de observabilidad del motor; mecanismo. |
| 27 | `quota_detector` (534) | obj | kernel | Detección de cuota de providers; mecanismo. |
| 28 | `multi_provider` (599) | obj | kernel | Split: el enum de providers es kernel; `multi_provider.order` es política de producto. |
| 29 | `pacing` (652) | obj | kernel | Cadencia de dispatch; mecanismo. |
| 30 | `handoff` (702) | obj | **autoridad** | Tiene `kill_switch`: gobierna el traspaso de contexto entre agentes. |
| 30b | `model_propagation_rollout` | obj | **autoridad** | Gobierna el encendido y rollback fail-closed de modelos por actor/proveedor. |
| 31 | `reduced_mode` (739) | obj | kernel | Modo reducido del motor; mecanismo. |
| 32 | `firma_operador` (783) | obj | **autoridad** | Auto-aprobación de la firma del operador; núcleo de la autoridad. |
| 33 | `wave_coherence_gate` (831) | obj | kernel | Coherencia de ola; mecanismo de orquestación. |
| 34 | `historico` (847) | obj | kernel | Frontera activo/histórico; mecanismo. |
| 35 | `logs_history` (876) | obj | kernel | Retención de logs del motor; mecanismo. |
| 36 | `rewind` (905) | obj | kernel | Rebobinado de fases; mecanismo. |
| 37 | `pipeline` (940) | obj | kernel | Parámetros generales del loop; mecanismo. |
| 38 | `inflight_fallback` (994) | obj | kernel | Fallback de trabajo in-flight; mecanismo. |
| 39 | `sherlock_enabled` (1029) | **bool** | kernel | Escalar top-level; diagnóstico del motor. |
| 40 | `sherlock_provider_budget_ms` (1037) | **num** | kernel | Escalar top-level; presupuesto del diagnóstico del motor. |
| 41 | `sherlock_max_reelaboraciones` (1038) | **num** | kernel | Escalar top-level; límite del diagnóstico del motor. |
| 42 | `sherlock_wait_budget_ms` (1045) | **num** | kernel | Escalar top-level; espera del diagnóstico del motor. |
| 43 | `telegram_burst_window_ms` (1062) | **num** | kernel | Escalar top-level; anti-burst del canal de salida. |
| 44 | `telegram_outbound` (1083) | obj | kernel | Transporte de salida del motor; mecanismo. |
| 45 | `audio_policy` (1163) | obj | producto | Política de audio narrado hacia el operador del producto. |
| 46 | `deliverable_notifications` (1174) | obj | kernel | Split: el mecanismo de notificación es kernel; `.skills` y `.attachments_per_skill` son del producto. |
| 47 | `cua` (1321) | obj | kernel | Automatización de UI del motor; mecanismo. |
| 48 | `kernel` (1416) | obj | kernel | Configuración del propio kernel; mecanismo. |
| 49 | `cross_repo_delivery` (1475) | obj | **autoridad** | Declara a qué repos externos puede pushear el pipeline; es una frontera de permiso. |
| 50 | `architect` (1509) | obj | kernel | Split: `.enabled`/`.gate_mode`/`.go_live_date` son autoridad; `.poll_cap_min`/`.poll_interval_seconds`/`.bot_login` son calibración. |
| 51 | `operator_signoff` (1580) | obj | **autoridad** | Gate de sign-off humano; decide quién aprueba. |
| 52 | `operator_signature` (1633) | obj | **autoridad** | Gate de firma; `nonce_ttl_seconds` acota el replay de una firma. |
| 53 | `deliverable_gate` (1667) | obj | **autoridad** | Gate de entregables; decide qué se considera entregado. |
| 54 | `gates` (1697) | obj | **autoridad** | Política de gate3 y de ausencia del operador; decide quién aprueba. |
| 55 | `waves` (1759) | obj | kernel | Modelo de olas del motor; mecanismo. |
| 56 | `wave_auto_transition` (1782) | obj | **autoridad** | Transición automática de ola sin humano; decide autonomía. |
| 57 | `telegram` (1800) | obj | producto | Verificado: en HEAD sólo `bot_username`, sin escalación. |
| 58 | `commander_products` (1823) | obj | **autoridad** | D-2: incluye `default_product` y el alta de productos con sus operadores. |
| 59 | `vault` (1318) | obj | kernel | #5352: direcciona secretos de infraestructura por host (`prefix`/`projectId`/`hostId`); es mecanismo, se muda al kernel sin conocer el producto. Reutiliza `kernel.region`. |
| 60 | `worktree_provenance` | obj | kernel | Allowlist de identidades para verificar procedencia de ramas en auto-recovery; mecanismo de seguridad del motor. |
| 61 | `telegram_voice_outbound` | obj | kernel | #5573: política de reenvío de las PARTES DE AUDIO, separada de `telegram_outbound` (texto) porque la latencia real de un `.ogg` es ~62-74s contra los 5s del texto. Es transporte de salida del motor; mecanismo. |

#### 2.4.1. Matriz de precedencia

Cuando más de una regla aplica al mismo path, gana en este orden:

| Prioridad | Regla | Efecto | Dónde vive |
|---|---|---|---|
| 1 | Prefijo de autoridad | La **sección entera** es `autoridad`, incluidas sus sub-claves | `AUTHORITY_PREFIXES` (congelada en código) |
| 2 | Match más específico de `SIDE_MAP` | Gana el patrón con más segmentos; a igual longitud, gana el que no usa comodín | `SIDE_MAP` (congelado en código) |
| 3 | Default fail-closed | Sin lado declarado ⇒ `kernel`. **Nunca** `producto` | `resolveSide()` |

Por eso `pipelines` es `kernel` pero `pipelines.*.skills_por_fase` es `producto` (regla 2 contra
regla 2, gana la más específica), y `architect.enabled` es `autoridad` aunque `architect` sea
`kernel` (regla 1 sobre regla 2).

#### 2.4.2. Por qué la lista de autoridad va congelada en código

`AUTHORITY_PREFIXES` vive en `config-schema.js` con `Object.freeze`, **nunca** en YAML/JSON. Si
fuera configurable sería auto-referencial: quien puede editar la configuración podría sacarse de
encima el control que la configuración declara, y la defensa entera se anula. Es el mismo patrón
que ya usan `PROVIDER_ENUM` y los CAPs hardcodeados de `config.yaml` (declarados ahí mismo como
defensa contra una configuración maliciosa).

Se declara **por prefijo de sección, no por sub-clave suelta**. Enumerar sub-claves dejaría
editables justo las que importan: `firma_operador.modo`, `operator_signature.nonce_ttl_seconds`,
`gates.gate3.timeout_ms`. La única excepción es `architect`, partido a propósito porque su
cadencia de polling es calibración, no autoridad.

#### 2.4.3. Alcance de la Entrega B (#5173)

En #5173 **no se movió ninguna clave de archivo**: las 58 secciones seguían en `config.yaml`. El
chequeo de lado era **opt-in** vía `validateConfig(obj, { origin: 'producto' })`, y
`pulpo.loadConfig` llamaba `validateConfig(raw)` sin segundo argumento ⇒ cero cambio de
comportamiento. La Entrega C (#5174) es la que parte el archivo y activa `origin`; su estado
vigente se describe en §2.4.4.

`repos.*` no entra en `SIDE_MAP`: verificado que no existe en `config.yaml` (vive en
`pipeline.config.json`). Se documenta acá como **autoridad** por D-1. La sección
`cross_repo_delivery` sí existe en `config.yaml` y se clasifica **autoridad** por el mismo
criterio: declara a qué repos externos puede pushear el pipeline.

**Estado del enforcement de `repos.*` tras #5174** (corrige lo que esta sección afirmaba antes:
*«su enforcement es de #5174»*, sin decir con qué alcance). `repos.*` sigue viviendo en
`pipeline.config.json` — el lado de **menor** confianza — por una **excepción de migración
enumerada y acotada**, no porque haya dejado de ser autoridad. Lo que #5174 sí cierra:

| Aspecto | Estado |
|---|---|
| Top-level del manifiesto | **Forma cerrada.** Toda clave fuera de `MANIFEST_KEYS` (`lib/config-resolver.js`) rompe el arranque nombrando clave y archivo destino. Una clave de autoridad (`firma_operador`, …) puesta ahí ya no pasa. |
| Alcance de la excepción | **Enumerada** en `REPOS_GRANDFATHERED_SUBKEYS` (`primary`, `allowlist`, `intake`, `default_base_ref`, `note`). Una sub-clave nueva bajo `repos` ⇒ fail-closed. |
| Coherencia del bloque | Verificada en el arranque: `intake ⊆ allowlist` y `primary ∈ allowlist`. |
| Visibilidad | **Nunca silenciosa**: traza de nivel `alerta` en cada arranque, nombrando la excepción y el issue que la cierra. |
| Contenido de `allowlist` | **NO enforzable por config.** Ningún chequeo puede distinguir un repo legítimo de uno hostil; agregar un repo es una decisión y su control es la revisión del cambio. |

Por qué no se mudó al kernel el día 1: `repo-target.js` y `kernel-resolver.js` lo leen de
`pipeline.config.json` desde #4693, **por fuera del resolver**, y moverlo rompería la paridad
clave por clave del CA-2 sin ganar frontera — `.github/CODEOWNERS` **no** cubre `.pipeline/`
(auto-merge habilitado), así que hoy los dos archivos están bajo el mismo control de revisión.
El cierre de la excepción (mudar el bloque al kernel) es de **#4694**, que ya es la dependencia
declarada del propio `note` del bloque. Fijado por `lib/__tests__/config-manifest-side.test.js`,
incluido el test que documenta el límite.

**Reversión (CA-14):** poner `additionalProperties: true` en la raíz de `config-schema.js`. Una
línea. Deja el `SIDE_MAP` inerte y devuelve el comportamiento al de #3941.

#### 2.4.4. Precedencia en tiempo de ejecución tras la partición (#5174)

Desde #5174 la configuración vive **partida en dos archivos**: `.pipeline/config.yaml` (kernel) y
`pipeline.config.json` → `productConfig` (producto). `lib/config-resolver.js` es el **único** punto
que lee los dos y los une.

La matriz de §2.4.1 responde *"¿de qué lado es esta clave?"*. La de acá responde *"si dos fuentes
la aportan, ¿cuál gana?"*:

| Categoría | Precedencia | Qué pasa si aparece del lado equivocado |
|---|---|---|
| Autoridad (lista congelada) | **kernel gana siempre** | Presencia del lado producto **o** en una env var ⇒ **falla el arranque**, nombrando la clave y el lado correcto |
| Calibración / política de producto | `env > producto > kernel` | — |
| Mecanismo del kernel | kernel | Clave de producto declarada del lado kernel ⇒ falla el arranque |
| `PIPELINE_DIR_OVERRIDE` | reubica **ambos** archivos o ninguno | Reubicación parcial ⇒ falla el arranque |

Cuatro propiedades que no son obvias desde la tabla:

1. **Para autoridad, "kernel gana" NO es precedencia de merge: es fail-closed.** Si fuera
   precedencia, un manifiesto de producto podría declarar `firma_operador.enabled: false` y el
   resolver lo descartaría en silencio — y desde el log, *"lo ignoré"* es indistinguible de *"el
   ataque no ocurrió"*. Por eso la **presencia sola** rompe el arranque.
2. **El fallo es TOTAL, nunca un merge parcial.** Que cualquiera de los dos archivos esté ausente,
   no parsee o venga vacío se trata como corrupción de la configuración entera y reusa
   `haltOnConfigCorruption`. El auto-recovery de #4832 exige que **ambos** vuelvan a parsear OK
   antes de levantar la pausa.
3. **Los dos lados son disjuntos**, así que el merge es una **unión** y la paridad clave por clave
   es demostrable (`config-partition-parity.test.js` la verifica contra un golden redactado del
   estado pre-partición).
4. **No existe un canal genérico `env → config`.** `PIPELINE_CFG_*` / `PIPELINE_CONFIG_SET_*` están
   prohibidos enteros y rompen el arranque: `build-child-env.js` reenvía todo `PIPELINE_*` a cada
   agente hijo, así que un patrón genérico volvería la configuración no auditable. La única
   superficie de override por entorno es la allowlist cerrada y enumerada de `ENV_OVERRIDES`, que
   por regla sólo admite claves de lado producto (con dos excepciones de autoridad ya auditadas y
   enumeradas en `ENV_AUTHORITY_GRANDFATHERED`).

La ubicación del archivo de producto se **deriva de la raíz del kernel** y se resuelve con
`realpath`, rechazando `..` y symlinks que escapen. El kernel **nunca** toma esa ubicación desde el
propio archivo de producto: no existe ningún `product_config_path:`.

**Reversión (CA-12):** `PARTITION_ENABLED = false` en `lib/config-resolver.js` — una línea — más
revertir el movimiento de claves en `config.yaml`. Con el flag apagado no se lee el manifiesto, no
corre el chequeo de lado y no hay merge: el comportamiento vuelve al de #5172. Está **ejercitado**
por `config-partition-rollback.test.js`, incluido el caso de que una clave migrada ausente tras el
rollback **rompa** en vez de caer a un default permisivo.

### 2.5. `CLAUDE.md` y `.pipeline/*.js` + hooks — inventario §2.2 y §2.3

| Ítem | Lado | Justificación (1 línea) |
|------|------|-------------------------|
| `CLAUDE.md`: Stack y versiones | adaptador | Stack del producto; 100% adaptador. |
| `CLAUDE.md`: Comandos de build | adaptador | Comandos del build del producto (gradle/flavor/shadowJar). |
| `CLAUDE.md`: Arquitectura App/Backend | adaptador | Patrones de código del producto. |
| `CLAUDE.md`: Reglas de strings/recursos | adaptador | Regla de implementación del producto (KSP, resString, fallback ASCII). |
| `CLAUDE.md`: Product Flavors | adaptador | Dominio del producto (variantes de app). |
| `CLAUDE.md`: Ramas y PRs | a-decidir | Convención de ramas genérica; nombres/bases concretos se parametrizan. |
| `CLAUDE.md`: Gate de QA obligatorio | a-decidir | Secuencia de gates y labels de proceso son genéricos; el criterio por tipo cita el stack. |
| `CLAUDE.md`: Protocolo de tareas / concurrencia | kernel | Mecanismo de orquestación (tasks, hooks, límite de agentes); genérico. |
| `CLAUDE.md`: Lanzamiento de agentes (Pulpo, worktrees, circuit breaker) | kernel | Descripción del motor operativo; genérico salvo paths del repo. |
| `.pipeline/pulpo.js`/`dashboard.js`/libs — lógica de orquestación | kernel | Motor del pipeline (intake, colas, lifecycle, routing); genérico. |
| Convención de rama `agent/*` hardcodeada en JS | a-decidir | Mecanismo de ramas genérico; el patrón concreto debe ser config. |
| Worktrees aislados (`worktree-guard.js`, `cleanup-worktrees.js`) | a-decidir | Aislamiento genérico; asume hoy que el repo orquestado **es** el repo del motor. |
| `.pipeline/` embebido dentro del repo del producto | adaptador | Acoplamiento estructural: el estado del motor vive en el repo orquestado (crítico #2). |
| `agent-concurrency-check.js`/`agent-registry.js`/`activity-logger.js` | kernel | Hooks de orquestación/telemetría; genéricos. |
| `apk-freshness.js` (hook) | adaptador | Conoce el artefacto empaquetado del producto. |

### 2.6. Frontera de secretos y auth — inventario §3

| Ítem | Lado | Justificación (1 línea) |
|------|------|-------------------------|
| Mecanismo de carga de credenciales (`lib/credentials.js`) | kernel | Cargador unificado (precedencia env > json > legacy); mecanismo genérico. |
| Nombres / scopes de credenciales concretos | adaptador | Los *qué* credenciales y sus scopes son del entorno del producto. |
| Auth del producto (JWT / Cognito / `SecuredFunction`) | adaptador | Patrones de autenticación del producto; no suben al kernel. |
| Redacción de secretos en handoff (`lib/handoff.js` + `lib/redact.js`) | kernel | Higiene genérica (redacta keys/JWT/passwords + anti prompt-injection). |

### 2.7. Gates de QA — inventario §4

| Ítem (regla) | Lado | Justificación (1 línea) |
|--------------|------|-------------------------|
| `qa`: "feature con UI → E2E con video obligatorio" | kernel | Regla de proceso genérica; aplica a cualquier producto con UI. |
| `qa`: secuencia "QA E2E → Tester → PO acceptance" | kernel | Flujo de validación genérico. |
| `qa`: labels de proceso `qa:passed/skipped/pending` | kernel | Semántica de estado de proceso; reutilizable. |
| `qa`: criterio "infra/docs sin label de app → skip E2E" | a-decidir | El principio es genérico; los labels que lo disparan son del producto. |
| `qa`: ejecución con emulador del stack móvil | adaptador | Stack de ejecución específico del producto. |
| `qa`: artefacto empaquetado por variante (APK por flavor) | adaptador | Build del producto. |
| `qa`: narración TTS / Lambda / auth en entorno QA remoto | adaptador | Infra/stack del producto. |
| `config.yaml`: umbrales `qa_env_max_*`, `qa:1`, duración ventana QA | a-decidir | El throttling es genérico; los valores calibrados al stack son del producto. |

### 2.8. Acoplamientos críticos (top-3 del inventario §6 → drivers del contrato)

Estos tres tienen tratamiento explícito en las secciones de interfaz/descubrimiento:

1. **Ruteo `label→skill`** → el kernel expone el **puerto de descubrimiento de trabajo** y la
   tabla de ruteo la **inyecta el adaptador** vía manifiesto (sección 3 y 6). No se hardcodea.
2. **`.pipeline/` embebido en el repo orquestado** → la sección 5 (lifecycle) y la sección 8
   (multi-tenant) definen el estado del motor como **propiedad del kernel**, namespaceado por
   `projectId`, separable del repo orquestado.
3. **Conocimiento de stack en skills dev/qa/ux** → la sección 4 define la **interfaz de
   capabilities** que el kernel espera de un "skill de desarrollo/QA/UX" para enchufar adaptadores
   de otros stacks.

---

## 3. Interfaz / puertos (Ports & Adapters)

<!-- CA-4 -->

El kernel define **puertos** (interfaces que necesita); el adaptador los **implementa** con su
stack. La firma es **conceptual** (entradas/salidas/errores), no una API de un lenguaje concreto.
Ningún ejemplo de implementación (build de un stack, emulador, despliegue a un cloud) es parte
del puerto: son ejemplo del adaptador.

> **Convención de firma.** Cada puerto recibe un **contexto de invocación** (`projectId`,
> `workItemRef`, handles de capacidad acotados — ver sección 4 y 7) y devuelve un **resultado
> estructurado** con `status` (`ok|failed|skipped`), `artifacts[]` y `diagnostics[]`. Los errores
> se modelan como datos en el resultado (`status: failed` + `diagnostics`), no como excepciones
> de stack que crucen la frontera.

| Puerto | Entradas (conceptuales) | Salidas | Errores | Oblig/Opc |
|--------|-------------------------|---------|---------|-----------|
| `discoverWork` | fuente de trabajo + filtros declarativos (labels/criterios de admisión del adaptador) | lista de `workItemRef` normalizados (id, tipo, prioridad) | fuente inalcanzable; filtro inválido | **Obligatorio** |
| `route` | `workItemRef` + tabla de ruteo del adaptador | `skill/capability` destino | sin regla aplicable → fallback declarado | **Obligatorio** |
| `build` | `workItemRef` + workspace | `status` + artefactos de build + logs | compilación fallida (como dato) | **Obligatorio** |
| `test` | `workItemRef` + workspace | `status` + reporte de cobertura/resultados | tests fallidos; entorno no preparado | **Obligatorio** |
| `e2e` | `workItemRef` + artefacto empaquetado + entorno objetivo | `status` + evidencia (video/doc) | entorno no disponible; fallo de escenario | Opcional (según capability del adaptador) |
| `package` | artefactos de build + perfil/variante | artefacto empaquetado (referencia, no bytes en banda) | empaquetado fallido | Opcional |
| `deploy` | artefacto empaquetado + destino | `status` + referencia de despliegue | destino inalcanzable; credencial insuficiente | Opcional |
| `gates` | `workItemRef` + estado de validación acumulado | veredicto de gate (`pass/fail/skip/requires-operator`) + razón | criterio **no evaluable automáticamente** → veredicto `requires-operator` (rutea a firma humana, **no** es error) | **Obligatorio** |

**Notas de diseño.**

- Los **7 puertos mínimos** que exige CA-4 son: `build`, `test`, `e2e`, `package`, `deploy`,
  `discoverWork` (descubrimiento de trabajo) y `gates`. `route` se agrega por ser el punto crítico #1
  del inventario; es obligatorio porque sin él el kernel no sabe a qué capability mandar el trabajo.
- Un adaptador declara en su manifiesto **qué puertos opcionales implementa** (capabilities). El
  kernel sólo invoca puertos declarados; los no implementados se resuelven como `skipped` con razón.
- Las firmas evitan a propósito cualquier tipo concreto de stack: no hay "task de gradle", "AVD"
  ni "función Lambda" en el puerto — esos son detalles del adaptador.
- El veredicto **`requires-operator`** cubre el caso "criterio **no evaluable automáticamente**":
  en vez de fallar, el gate delega la decisión a una **firma humana** (ver estado `waiting-operator`,
  sección 5). **No es un atajo para saltear un `fail`:** un criterio *evaluable* que da negativo
  sigue siendo `fail`; sólo el criterio que el adaptador **no puede** evaluar rutea a firma. Este
  veredicto se define de forma **idéntica** en §3 (puerto `gates`) y §4 (`evaluateGate`) — ambos
  deben permanecer sincronizados.

---

## 4. Puntos de extensión (hooks / capabilities)

<!-- CA-5 -->

Más allá de los puertos, el adaptador puede implementar **hooks** que el kernel invoca en momentos
definidos del ciclo. Cada hook declara: **cuándo** lo invoca el kernel, el **contrato de datos** de
ida y vuelta, y si es **obligatorio u opcional**. El kernel pasa a cada hook **sólo los handles de
capacidad necesarios** (capability-based, ver sección 7), nunca el entorno entero.

| Hook / capability | Cuándo lo invoca el kernel | Datos de ida → vuelta | Oblig/Opc |
|-------------------|----------------------------|------------------------|-----------|
| `onWorkDiscovered` | tras `discoverWork`, antes de encolar | `workItemRef[]` → `workItemRef[]` normalizados/filtrados | Opcional |
| `resolveRouting` | al rutear un ítem | `workItemRef` + tabla de ruteo declarativa → `capabilityId` | **Obligatorio** |
| `prepareWorkspace` | antes de `build`/`test` | `workItemRef` + ref de workspace acotado → `status` | Opcional |
| `provideCapability(id)` | al necesitar un puerto opcional | `invocationContext` acotado → `result` del puerto | Opcional (según capabilities declaradas) |
| `evaluateGate(id)` | en cada gate del flujo | estado de validación → veredicto `pass/fail/skip/requires-operator` + razón (sincronizado con el puerto `gates` de §3) | **Obligatorio** |
| `brokerSecret(scope)` | cuando un puerto necesita un secreto | `scope` puntual → secreto de scope acotado (brokereado por el kernel) | Opcional |
| `decorateArtifact` | al publicar un artefacto/reporte | `artifactRef` → metadata adicional (sin mutar el lifecycle) | Opcional |
| `describeProject` | al iniciar el contexto de un `projectId` | — → metadata de proyecto (nombre visible, etiquetas de UI) | Opcional |

**Reglas de los hooks.**

- **Contrato de datos explícito y validado:** cada hook tiene un esquema de ida/vuelta. El kernel
  valida la respuesta contra el esquema; una respuesta fuera de contrato se trata como fallo del
  adaptador (no se ejecuta a ciegas).
- **Sin acceso al lifecycle:** ningún hook puede mover archivos de estado entre carpetas (ver
  sección 5). `decorateArtifact` agrega metadata, no promueve estado.
- **Capacidad mínima:** el handle que recibe un hook expone sólo lo que su contrato declara
  (p. ej. `brokerSecret` recibe la capacidad de *pedir* un secreto puntual, no de leer el store).

---

## 5. Invariante de lifecycle

<!-- CA-6 -->

El ciclo de vida del estado en filesystem —

```
pendiente/ → trabajando/ → listo/ → procesado/
                              │
                              └─(gate ⇒ requires-operator)→ waiting-operator/ ──┬─(firma: aprobado)→ procesado/
                                                                                └─(firma: rechazado)→ pendiente/  (re-definición o dev)
```

— es **propiedad exclusiva del kernel**. Es el mismo invariante que rige hoy ("el Pulpo es el
único dueño del lifecycle del archivo"). El contrato lo eleva a regla formal de la frontera:

- **El adaptador pide; el kernel ejecuta.** El adaptador puede *solicitar* trabajo, *reportar*
  resultados (vía el `result` de los puertos) y *decorar* artefactos, pero **nunca** mueve un
  archivo de estado entre carpetas ni escribe directamente en las colas del kernel.
- **El estado FS está fuera del alcance de escritura del adaptador** (alineado con CA-10). El
  adaptador opera sobre su **workspace** (acotado, ver sección 7), no sobre `pendiente/` /
  `trabajando/` / `listo/` / `procesado/`.
- **Transiciones atómicas.** Las promociones de estado las realiza el kernel con `rename`
  atómico, de forma idempotente. El adaptador que intente cortocircuitar esto produce una
  condición de carrera — por eso el contrato lo prohíbe explícitamente.
- **Un solo dueño por transición.** No hay escritura concurrente kernel↔adaptador sobre el mismo
  archivo de estado: el adaptador devuelve datos; el kernel decide la transición.

Este invariante es lo que permite que el motor sea genérico: el lifecycle no depende de qué hace
el adaptador, sólo de los `result` que devuelve.

### 5.1. Estado `waiting-operator` (firma humana de gates)

<!-- CA-3, CA-4, CA-5, CA-6, CA-7 de #4571 -->

Cuando un gate devuelve el veredicto **`requires-operator`** (criterio no evaluable
automáticamente, ver §3 y §4), el kernel no puede resolver la transición por sí solo: el ítem
requiere una **firma humana**. Para eso el lifecycle incorpora el estado **`waiting-operator`**,
un estado de **espera de firma del operador** gestionado **exclusivamente por el kernel** (mismo
invariante "el adaptador pide, el kernel ejecuta"). Su semántica:

- **Entrada.** Un gate devuelve `requires-operator` → el kernel mueve el ítem de `listo/` a
  `waiting-operator/`. El adaptador **nunca** promueve un ítem a este estado: sólo reporta el
  veredicto vía el `result` del puerto `gates`; la transición la ejecuta el kernel.
- **Salida.** El operador **firma** el ítem en `waiting-operator/`:
  - *aprobado* → el kernel promueve a `procesado/` (equivale a un `pass` autorizado por humano).
  - *rechazado* → el kernel devuelve el ítem a `pendiente/` para **re-definición o dev** según el
    gate (equivale a un `fail` autorizado por humano, con motivo).
  Sólo el **kernel** ejecuta esta transición, y **sólo** tras registrar una firma válida.
- **Timeout — política fail-closed (SEGURIDAD, A04 Insecure Design).** Si el ítem expira en
  `waiting-operator/` sin firma, el default es **NO aprobado** (**fail-closed**): el kernel
  **escala o rechaza**, **nunca** auto-aprueba. Un gate que no se pudo evaluar y expira sin firma
  humana **falla cerrado**. Queda **prohibido** cualquier default a auto-aprobado en timeout.
- **Dueño único de la transición (SEGURIDAD, A01 Broken Access Control).** La transición
  `waiting-operator → aprobado/rechazado` sólo puede ejecutarla el **kernel** tras firma del
  operador. El invariante **prohíbe** que el adaptador (o un agente de fase) se auto-promueva
  fuera de `waiting-operator/` salteando la firma: eso sería una escalada de privilegio que
  saltea el control humano. Refuerza el invariante existente "el adaptador pide; el kernel ejecuta".
- **No-repudio / audit trail (SEGURIDAD, A09 Logging Failures).** La resolución de un
  `requires-operator` debe registrar, en **traza append-only** auditable, **quién** firmó,
  **cuándo** y el **veredicto** (aprobado/rechazado + motivo). Sin esa traza la firma no es
  verificable a posteriori. La traza se alinea con los gates de firma de
  [`docs/pipeline/gates-firma-operador.md`](gates-firma-operador.md).
- **`requires-operator` ≠ `fail`.** Reafirmado desde §3: un criterio **evaluable** que da negativo
  sigue siendo `fail` y **no** entra a `waiting-operator/`; sólo el criterio *no evaluable* rutea a
  firma. Esto evita que un adaptador degrade `fail` legítimos a "pedime firma" para forzar
  aprobaciones (defensa en profundidad).

---

## 6. Descubrimiento y carga del adaptador

<!-- CA-7, CA-8 -->

### 6.1. Descubrimiento declarativo (CA-7)

El kernel descubre y carga un adaptador a través de un **manifiesto declarativo**
`pipeline.config.json`, no mediante `require()`/`import` dinámico de paths arbitrarios.

```jsonc
// pipeline.config.json (forma conceptual)
{
  "contractVersion": "0.2.0",        // semver del contrato que el adaptador implementa
  "projectId": "acme-store",         // identidad multi-tenant (sección 8)
  "displayName": "ACME Store",       // metadata para UI del operador
  "capabilities": {                   // qué puertos opcionales implementa
    "e2e": true,
    "package": true,
    "deploy": false
  },
  "routing": [                        // tabla de ruteo inyectada (crítico #1)
    { "match": { "label": "area:api" }, "capability": "backend" },
    { "match": { "label": "area:web" }, "capability": "web" }
  ],
  "extensionPoints": ["resolveRouting", "evaluateGate", "prepareWorkspace"],
  "integrity": {                      // ver 6.2
    "algorithm": "sha256",
    "checksum": "<hash del manifiesto/bundle>"
  }
}
```

**Prohibiciones explícitas (CA-7).**

- **PROHIBIDO** `require()`/`import` dinámico de paths arbitrarios o controlados por entrada externa.
- **PROHIBIDO** que el path del adaptador provenga de entrada no validada (issue body, labels,
  mensajes de chat). El kernel resuelve el adaptador desde una **ubicación registrada** (allowlist
  de proyectos), no desde datos en banda.
- Las capabilities y puntos de extensión que el kernel invoca son **únicamente** los declarados en
  el manifiesto; cualquier otro se ignora.

### 6.2. Validación previa a la carga (CA-8)

Antes de cargar un adaptador, el kernel valida —en este orden, abortando al primer fallo:

1. **Compatibilidad de versión de contrato.** `contractVersion` del manifiesto debe ser
   compatible con la versión del kernel según semver (ver sección 7, CA-14). Mismatch
   incompatible → **rechazo de carga** con error accionable (versión soportada vs encontrada).
2. **Integridad del manifiesto/bundle.** Verificación por **checksum / firma / allowlist** según
   el `integrity` declarado. El adaptador se trata como **dependencia supply-chain**: un manifiesto
   cuyo checksum no coincide con el registrado no se carga.
3. **Validación de esquema del manifiesto.** El manifiesto valida contra un **JSON Schema**
   publicado del contrato (DX: errores accionables, ver sección 6.3). Campos requeridos:
   `contractVersion`, `projectId`, `capabilities`, `extensionPoints`.
4. **Sanitización de la config declarativa** (labels, ramas, comandos de gate, paths) — ver
   CA-12. Los paths se validan contra path traversal **antes** de usarse como base de workspace.

El ciclo descubrir → validar → cargar expone **estados observables** (`descubierto` /
`validando` / `rechazado` / `cargado`) para el operador (DX, sección 6.3).

### 6.3. Consideraciones de UX/DX del operador

> Guidelines del agente `ux` (fase definición) — refuerzan legibilidad y observabilidad; se
> propagan como criterios a las sub-issues de Ola 9 (sección 9), no son nuevos requisitos
> funcionales.

- **Manifiesto autodescriptivo y validable:** publicar un **JSON Schema** referenciable del
  `pipeline.config.json` para que el integrador tenga autocompletado/validación en su editor.
- **Errores de validación accionables:** ante manifiesto inválido o mismatch de versión, el kernel
  responde *qué* campo falló, *valor esperado* y *cómo corregir*; nunca fallo silencioso ni stack
  trace crudo. El rechazo por versión nombra la versión soportada y la encontrada.
- **Carga con estados observables:** el operador ve `descubierto/validando/rechazado/cargado`, no
  un binario "anda / no anda".

---

## 7. Seguridad incorporada

<!-- CA-9 .. CA-14 -->

Los seis requisitos del agente `security` (fase definición) son **requisitos de diseño de la
frontera**, no defectos. Cada uno se mapea a OWASP y se propaga como criterio a las sub-issues de
Ola 9 (sección 9).

### CA-9 · Límite de confianza en la carga (OWASP A08 Software & Data Integrity, A06 Vulnerable Components)

Cargar un adaptador = ejecutar código de terceros con los privilegios del kernel. El contrato lo
trata como **límite de confianza explícito**: descubrimiento por manifiesto (6.1) + validación
previa de versión e integridad (6.2). Sin manifiesto válido y verificado, no hay carga.

### CA-10 · Capability-based, mínimo privilegio (OWASP A01 Broken Access Control, A04 Insecure Design)

El kernel pasa al adaptador **sólo los handles que necesita** (broker de secretos, workspace
acotado), nunca el entorno entero (filesystem completo, token de la forja, red abierta). El estado
FS del kernel (`pendiente/`/`trabajando/`/`listo/`/`procesado/`) queda **fuera del alcance de
escritura** del adaptador (invariante de la sección 5). Cada hook recibe una capacidad acotada a
su contrato (sección 4).

### CA-11 · Brokering de secretos (OWASP A02 Cryptographic Failures, A01)

El adaptador **no** lee el store de credenciales del operador ni inyecta secretos por su cuenta. El
kernel actúa de **broker**: resuelve y entrega **el secreto puntual** necesario para una operación,
con **scope acotado** y vida limitada a esa operación (hook `brokerSecret`, sección 4). Los
*nombres y scopes* de credenciales son del adaptador (sección 2.6); el *mecanismo* de brokering es
del kernel.

### CA-12 · Sanitización de config declarativa (OWASP A03 Injection + path traversal)

Labels, nombres de rama, comandos de gate y rutas que el adaptador aporta como config terminan
usándose en operaciones de forja, git y shell. El contrato exige tratarlos como **datos**
(parametrizados/escapados), **nunca** interpolados en shell. Los **paths** del adaptador se validan
contra **path traversal** antes de usarse como base de estado/escritura (refuerza 6.2 paso 4).

### CA-13 · Integridad anti prompt-injection del canal (OWASP A03, alineado con #2993)

Todo dato que cruce kernel↔adaptador y termine en un **prompt de agente** (config, descripciones,
capabilities, secciones de handoff) pasa por las **mismas defensas anti prompt-injection y
redacción de secretos** del módulo de handoff (`lib/redact.js`, ver sección 2.6, lado kernel). El
contrato declara este saneo como **obligación de la frontera**, no opcional.

### CA-14 · Versionado del contrato (OWASP A04, A08)

El contrato declara un campo de **versión semver** (`contractVersion`, hoy `0.2.0`). Ante
**mismatch incompatible** el kernel **rechaza la carga** del adaptador (no asume garantías que ya
no da). Política de cambios:

- **PATCH** (`0.1.x`): aclaraciones, sin cambio de contrato observable.
- **MINOR** (`0.x.0`): puertos/hooks/veredictos/estados **nuevos opcionales**; retrocompatible.
- **MAJOR** (`x.0.0`): cambio incompatible (puerto/hook obligatorio nuevo o firma cambiada); el
  kernel rechaza adaptadores con MAJOR distinto.

> El bump `0.1.0 → 0.2.0` (veredicto `requires-operator` + estado `waiting-operator`) es un
> **MINOR**: agrega un veredicto/estado **nuevo, opcional y retrocompatible** — no cambia ninguna
> firma existente ni vuelve obligatorio un puerto nuevo. Ver [Changelog](#changelog).

---

## 8. Multi-tenant

<!-- CA-15 -->

El multi-tenant es **dimensión de primera línea**, no fase 2. El contrato namespacea estado y
recursos por **`projectId`** desde el día uno.

**Recursos namespaceados por `projectId`:** cola de trabajo, olas, worktrees, métricas, locks y
canal de chat del operador. El `projectId` proviene del manifiesto (sección 6.1) y acompaña el
`invocationContext` de todo puerto/hook.

### 8.1. Decisión de aislamiento anclada

Dos modelos posibles:

| Modelo | Cómo aísla | Costo | Riesgo |
|--------|-----------|-------|--------|
| **A · Nivel proceso** (N pipelines) | un proceso kernel por proyecto | alto en RAM (la máquina ya aprieta con 2 pipelines) | bajo (aislamiento físico) |
| **B · Nivel datos** (1 kernel multiplexa) | un kernel con estado namespaceado por `projectId` + scheduler único que reparte turnos | bajo en RAM | medio (requiere disciplina de namespacing y aislamiento lógico estricto) |

**Recomendación (anclada, no diferida): Modelo B.** Estado por-proyecto + **scheduler único** que
reparte turnos reusando el patrón de ventanas autoexcluyentes (QA > Build > Dev). Razón: la máquina
no soporta N procesos kernel completos en paralelo; el multiplexado con estado namespaceado da el
aislamiento necesario a un costo de RAM sostenible. El aislamiento lógico se apoya en: claves de
estado prefijadas por `projectId`, locks por `projectId`, y separación de contexto en el chat del
operador.

### 8.2. Desambiguación multi-tenant en superficies del operador

> Guidelines del agente `ux` — el mayor riesgo de UX multi-tenant es **actuar sobre el proyecto
> equivocado**. Se propagan a Ola 9 (sección 9).

- **`projectId` visible y consistente** en toda superficie operador-facing (dashboard, banners,
  mensajes de chat, reportes). No basta namespacear por dentro: el operador tiene que *ver* en qué
  proyecto está parado.
- **Acciones destructivas/halt confirman el `projectId` afectado** en el mensaje (mismo espíritu
  que la allowlist actual).
- Con multiplexado (Modelo B), el chat del operador **distingue contexto por proyecto** para evitar
  cross-talk.

---

## 9. Salida y trazabilidad

<!-- CA-16, CA-17 -->

### 9.1. Sub-issues de Ola 9 (CA-16)

La salida de esta épica de **definición** son las sub-issues de **implementación** (Ola 9), cada
una con los criterios de seguridad **CA-9..CA-14 ya volcados como criterios de aceptación propios**
(no como parche posterior). Lista propuesta (se crean al aprobar este contrato, con OK humano):

| Sub-issue (Ola 9) | Alcance | Criterios de seguridad embebidos |
|-------------------|---------|----------------------------------|
| **O9-1 · Loader de adaptador por manifiesto** | Implementar descubrimiento declarativo `pipeline.config.json` + JSON Schema publicado (secciones 6.1, 6.3) | CA-9, CA-12, CA-13 |
| **O9-2 · Validación previa a la carga** | Compatibilidad de versión + integridad (checksum/firma/allowlist) + sanitización (sección 6.2) | CA-8→CA-9, CA-12, CA-14 |
| **O9-3 · Puertos del kernel (Ports & Adapters)** | Definir/implementar los 8 puertos con firma conceptual (sección 3) | CA-10, CA-13 |
| **O9-4 · Capability handles + broker de secretos** | Hooks con capacidad mínima + `brokerSecret` (secciones 4, 7) | CA-10, CA-11, CA-13 |
| **O9-5 · Invariante de lifecycle aislado del adaptador** | Garantizar que el adaptador no escribe el estado FS (sección 5) | CA-10 |
| **O9-6 · Multi-tenant por `projectId`** | Namespacing de estado/recursos + scheduler único (Modelo B) + visibilidad de `projectId` (sección 8) | CA-10, CA-12, CA-13 |
| **O9-7 · Tabla de ruteo inyectable** | Mover `label→skill` del kernel a la config del adaptador (crítico #1) | CA-12, CA-13 |

Cada sub-issue nace con: criterios de seguridad listados arriba como CA propios, referencia a la
sección correspondiente de este contrato, y la versión de contrato (`contractVersion`) que asume.

### 9.2. Cero riesgo para el producto (CA-17)

- El kernel operativo se construye **al lado, en un repo nuevo**. El `.pipeline/` actual del
  producto **no se toca** en esta ola.
- Este entregable es **diseño** (un documento bajo `docs/`), no código. Cualquier edición fuera de
  `docs/` en esta épica es **scope leak** y motivo de rechazo.
- Verificable: el PR de esta épica sólo toca `docs/pipeline/contrato-kernel-adaptador.md` y el
  índice de `docs/desacople-kernel/README.md` (link de navegación). Cero archivos bajo `.pipeline/`.

---

## Verificación (inspección estructural)

Al ser un entregable documental, la verificación es por inspección. Comandos de referencia:

```bash
# CA-1, CA-14 — el documento existe y declara versión semver
test -f docs/pipeline/contrato-kernel-adaptador.md && grep -n "Versión del contrato" docs/pipeline/contrato-kernel-adaptador.md

# CA-3 — ninguna fila marcada kernel nombra el producto:
#   las filas kernel de la sección 2 no contienen "Intrale".
grep -nE '\| kernel \|' docs/pipeline/contrato-kernel-adaptador.md | grep -i "intrale"   # esperado: 0 resultados

# CA-4 — los 7 puertos mínimos presentes
grep -nE '`(build|test|e2e|package|deploy|discoverWork|gates)`' docs/pipeline/contrato-kernel-adaptador.md

# CA-2 — cobertura: cada bloque del inventario tiene su sub-tabla en la sección 2
grep -nE '^### 2\.' docs/pipeline/contrato-kernel-adaptador.md
```

**DoD (checklist final del PO, se valida en aprobación):**

- [ ] Documento de contrato en `docs/` revisado y aprobado.
- [ ] Frontera completa contra el inventario de #4009 (sin ítems huérfanos).
- [ ] Los 6 requisitos de security reflejados (CA-9..CA-14) y propagados a las sub-issues de Ola 9.
- [ ] Decisión de aislamiento multi-tenant anclada con recomendación (Modelo B).
- [ ] Campo de versión del contrato y política de mismatch definidos (CA-14).

---

## Changelog

Historial de versiones del contrato (semver, ver política en §7 · CA-14). Entrada más reciente
arriba.

### 0.2.0 — Enmienda gates de firma humana (issue #4571)

- **Añadido** el veredicto **`requires-operator`** al puerto `gates` (§3) y al hook `evaluateGate`
  (§4), sincronizados: cubre el caso "criterio no evaluable automáticamente", que rutea a firma
  humana en vez de a error.
- **Añadido** el estado de lifecycle **`waiting-operator`** (§5.1): estado de espera de firma del
  operador, gestionado exclusivamente por el kernel. Documenta entrada (gate `requires-operator`),
  salida (firma → aprobado/rechazado), **timeout fail-closed** (sin firma → NO aprobado, nunca
  auto-aprobación), dueño único de la transición (kernel, tras firma) y **no-repudio** (traza
  append-only con quién/cuándo/veredicto).
- **Aclarado** que `requires-operator` **≠ `fail`**: un criterio evaluable negativo sigue siendo
  `fail`; sólo el no evaluable rutea a firma (defensa en profundidad).
- **Versión** bumpeada `0.1.0 → 0.2.0` (**MINOR**: veredicto/estado nuevo, opcional y
  retrocompatible). Ejemplo de manifiesto §6.1 (`contractVersion`) actualizado a `0.2.0`.
- Habilita los gates de firma de Ola 9 sin reajuste posterior del contrato. Sin cambios de código
  de producto (CA-17).

### 0.1.0 — Contrato inicial (Ola 8 · EP-OLA8-B · issue #4010)

- Versión inaugural del contrato kernel↔adaptador: frontera ítem por ítem (§2), puertos (§3),
  hooks/capabilities (§4), invariante de lifecycle (§5), descubrimiento y carga (§6), seguridad
  incorporada (§7 · CA-9..CA-14), multi-tenant (§8) y salida/trazabilidad (§9).
