# Ola Puente — Kernel multi-producto, ejecución paralela y gestión por interfaz

> **Naturaleza:** documento de **diseño/definición** (no implementación). Formaliza la conversación
> de diseño con Leo (2026-07-13) que **amplía** el alcance de la Ola 9: de "migrar el motor a un repo
> propio" a "convertir el motor en un **kernel multi-producto** operable desde interfaz". Este
> documento **no re-litiga** lo ya cerrado (Ola 8 + sub-ola 9.1); parte de esas conclusiones y
> resuelve la **delta** nueva.
> **Estado:** propuesta de diseño para revisión de Leo antes de formalizar en issues (`/planner`).
> **Autor:** Commander (a pedido de Leo — "documentá todo, formalizá todo, diseñálo").
>
> **Prior art del que parte (no lo redefine):**
> - [`kernel-repo-design.md`](kernel-repo-design.md) — estructura del repo del kernel, consumo por paquete versionado, `capabilities/` como plugins, `dashboard/` multi-tenant por `projectId`, `fixtures/` self-hosting.
> - [`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) — frontera kernel↔adaptador, puertos, `config.schema.json`, manifiesto `pipeline.config.json`.
> - [`kernel-migration-plan.md`](kernel-migration-plan.md) — qué sale de `.pipeline/` y dónde cae la frontera.
> - [`ola9-sub-olas-migracion.md`](ola9-sub-olas-migracion.md) — división en sub-olas 9.1–9.5 (9.1 ya cerrada).
> - [`persistencia-data-operativa-analisis.md`](persistencia-data-operativa-analisis.md) (#3898) — clases de dato C1/C2/C3, descarte de BD remota **para el problema local**.
> - [`externalizacion-estado-operativo-remoto.md`](externalizacion-estado-operativo-remoto.md) (#4398) — proyección remota para la app móvil operadora; segmentar por "quién necesita el dato".
> - [`gates-firma-operador.md`](gates-firma-operador.md) — GATE 2, firma de aceptación, fail-closed.

---

## 1. Resumen ejecutivo — el salto conceptual

Hasta la Ola 9.1 el objetivo era **físico**: sacar el motor (`.pipeline/` + skills + hooks) del repo
del producto y ponerlo en un repo propio (`intrale/kernel`), sin cambiar comportamiento. Eso ya está
hecho y en `main`.

La conversación del 2026-07-13 introduce un **salto de alcance** que cambia la naturaleza del
proyecto: el kernel deja de ser "el motor de *este* producto" y pasa a ser **una plataforma que
orquesta N productos en paralelo**, cada uno con su(s) repositorio(s), su tablero, sus variables y
sus skills, gestionable **desde interfaz** (dashboard hoy, app móvil y Telegram Commander), con su
información viviendo en un **medio persistente de verdad** (no un JSON local).

Le pusimos nombre: **Ola Puente** — porque transiciona del modelo actual (1 kernel → 1 producto,
hardcodeado, file-first) a un modelo **ampliado** (1 kernel → N productos, declarado por descriptor,
con estado durable y superficie de gestión propia).

**Las 8 piezas nuevas** (detalle en §4), en orden de dependencia lógica:

1. **Paso 0 — Self-hosting real:** habilitar el pipeline para trabajar el propio repo del kernel (intake + worktrees + publish/pin/bump del paquete). Hoy el Pulpo sólo sabe mirar y construir sobre `Intrale/platform`.
2. **Rol "dev genérico" en el kernel:** hoy sólo existe `pipeline-dev` (toca el motor). Falta la figura del dev de producto genérico (backend/frontend) que el kernel provee como interfaz y el adaptador implementa.
3. **Descriptor de proyecto:** el manifiesto que le dice al kernel qué es un producto (repo/s, tablero, env, skills, autoridad de firma). Evolución formal del `pipeline.config.json`.
4. **Kernel multi-producto:** supervisor de instancias — el kernel gestiona varios productos aislados entre sí.
5. **Ejecución paralela multi-producto:** varios pipelines vivos a la vez, con concurrencia de dos niveles (por producto + global).
6. **Persistencia del descriptor + estado:** mover del JSON local a un medio durable y consultable.
7. **Gestión desde interfaz (first-class):** todo lo del kernel se opera desde dashboard / app móvil / Telegram, no editando archivos a mano.
8. **Autoridad y firma por producto:** quién puede firmar/aprobar qué producto (hoy `leitolarreta` global).

**Qué NO cambia (invariantes):** el modelo de gates (QA→Tester→PO + GATE 2 firma, fail-closed), la
frontera kernel/adaptador de la Ola 8, el consumo del kernel como paquete versionado y pineado, y el
principio de "cada capacidad nace con su superficie de gestión y su auditoría".

---

## 2. Nombre y alcance de la Ola Puente

- **Nombre conceptual:** *Ola Puente*. Es la etiqueta de esta transición ampliada. En el
  tablero/pipeline la ola activa figura formalmente como parte de la **Ola 9** (sub-olas 9.2+); "Ola
  Puente" es el paraguas conceptual que agrupa el salto multi-producto. Se registra su alcance formal
  cuando se corra `/planner` (§9).
- **Alcance:** todo lo de §4. **Fuera de alcance** de la Ola Puente (quedan como olas siguientes): la
  app móvil operadora completa (esta ola deja el *backend* y el *contrato* listos para que se
  construya), y el onboarding de un segundo producto real distinto de Intrale (esta ola deja la
  *capacidad*, no obliga a estrenar un producto nuevo).

---

## 3. De dónde venimos y qué cambia

| Dimensión | Modelo actual (post-9.1) | Modelo Puente (objetivo) |
|-----------|--------------------------|---------------------------|
| Productos gestionados | 1 (Intrale), hardcodeado | N, declarados por descriptor |
| Repositorios | El motor conoce `Intrale/platform` | El motor no conoce ningún repo; lo lee del descriptor |
| Tableros | 1 Project V2 fijo | 1 por producto, declarado |
| Ejecución | Un Pulpo, una cola, un cap de concurrencia | Supervisor de N instancias, concurrencia 2 niveles |
| Estado del descriptor | Config en archivos (JSON/YAML) locales | Medio persistente durable + consultable |
| Gestión | Editar archivos a mano | Dashboard / app móvil / Telegram |
| Rol de dev | `android-dev`, `backend-dev`… atados al stack Intrale | Interfaz de "dev genérico" en kernel + implementación por adaptador |
| Autoridad de firma | `leitolarreta` global | Por producto (con respaldo designable) |

El diseño de la Ola 8 **ya anticipó** varias de estas piezas en forma de semilla: `dashboard/`
multi-tenant por `projectId`, `capabilities/` como plugins de stack, `config.schema.json` por
producto, `fixtures/` para self-hosting. La Ola Puente **activa y completa** esas semillas y suma lo
que faltaba (supervisor paralelo, descriptor formal, persistencia durable, gestión por UI, autoridad
por producto).

---

## 4. Las 8 piezas de diseño

### 4.1 Paso 0 — Self-hosting real (el pipeline trabaja el repo del kernel)

**Problema (verificado en conversación).** El Pulpo hoy sólo hace intake de issues de
`Intrale/platform` y sólo arma worktrees sobre este repo. No sabe crear ramas ni correr el ciclo
dev→build→QA→delivery contra `intrale/kernel`, ni existe el publish del paquete + pin/bump de la
versión que la plataforma consume. **Consecuencia:** si hoy splitteamos una ola del kernel, los
agentes terminarían tocando el repo viejo — el único que el pipeline conoce.

**Por qué es el paso 0.** Cualquier ola que toque skills del motor (9.2+) **debe** correrse sobre
`intrale/kernel`. Sin self-hosting, "el cambio del kernel va al repo nuevo" es un proceso manual y
frágil. Con self-hosting, es automático.

**Qué hay que habilitar:**
- **Intake multi-repo:** el Pulpo toma issues apuntados al repo del kernel (no sólo a la plataforma).
- **Worktrees/ramas sobre el repo destino** que indique el descriptor del proyecto.
- **Publish + pin/bump:** publicar el paquete versionado del kernel (npm/GitHub Packages, semver,
  pineado — decisión de [`kernel-repo-design.md` §2-§3](kernel-repo-design.md)) y subir la versión
  pineada en el adaptador del producto que lo consume.
- **Fixtures como red de seguridad:** `fixtures/` (repo dummy de prueba del propio kernel) permite
  testear el motor sin un producto real — es la base del self-hosting.

**Sizing:** Grande. Es la precondición dura de todo lo demás.

### 4.2 Rol "dev genérico" en el kernel

**Problema (planteado por Leo).** El kernel tiene `pipeline-dev` (el rol que ajusta al propio
kernel). Pero la figura de un **dev de producto genérico** —uno o varios, eventualmente partido en
backend/frontend— **debe existir como rol del kernel**, porque un producto cualquiera (no Intrale)
necesita que alguien implemente sus issues, y el kernel no puede depender de que ese producto traiga
`android-dev`/`backend-dev` con nombres Intrale.

**Cómo se resuelve (apoyado en el contrato Ola 8).** El mecanismo ya está diseñado: los skills de
stack son **capabilities** (plugins) — el kernel define la **interfaz** (`build`, `test`, `e2e`,
`package`, `deploy`, el rol dev y sus fases), el adaptador provee la **implementación** concreta
(android/backend/web con el stack del producto). Ver [`kernel-repo-design.md` §1 (`capabilities/`)](kernel-repo-design.md)
y [`contrato-kernel-adaptador.md` §4](contrato-kernel-adaptador.md).

**La delta de la Ola Puente:** formalizar explícitamente un **rol dev de producto en el kernel** con:
- Una **interfaz de dev** agnóstica (recibe un issue, produce un cambio + handoff), independiente del stack.
- Un **contrato de partición** backend/frontend (uno o varios devs genéricos) que el adaptador puede
  mapear a sus skills concretos (`backend-dev`→interfaz backend, `android-dev`+`web-dev`→interfaz frontend).
- Un **fallback genérico** para productos que no traen capability de stack propia (dev genérico de
  texto/código sin toolchain específico), para no bloquear un producto recién onboardeado.

**Sizing:** Medio.

### 4.3 Descriptor de proyecto (el corazón del modelo)

**Qué es.** Un manifiesto que le dice al kernel **todo lo que necesita saber de un producto** para
orquestarlo, sin hardcodear nada. Es la evolución formal del `pipeline.config.json` del adaptador
([`contrato-kernel-adaptador.md` §6](contrato-kernel-adaptador.md)), elevado a "descriptor de proyecto".

**Contenido mínimo (draft de esquema en §6):**
- **Identidad:** `projectId`, nombre, descripción.
- **Repositorios:** uno o más repos que el producto abarca (el motor puede orquestar multi-repo por producto).
- **Tablero:** qué Project V2 / board usa; labels de admisión; tabla de ruteo `label→skill/capability`.
- **Variables de entorno / secretos:** referencias (no valores) a las credenciales del producto,
  aisladas de las de otros productos (ver §5, aislamiento de blast radius).
- **Capabilities/skills asignados:** qué implementaciones de stack trae y cómo mapean a las interfaces del kernel.
- **Autoridad de firma:** quién puede firmar/aprobar (GATE 2) para este producto; aprobador de respaldo.
- **Umbrales y ventanas:** concurrencia, priority-windows, cuotas de provider asignadas al producto.
- **Gates activos:** flags de gate 0/2/visual por producto (permite dry-run/enforce independiente).

**Inicialización (bootstrap de proyecto nuevo).** Necesitamos un flujo de **"crear proyecto"** que:
1. Tome el descriptor (por wizard de UI, no editando JSON).
2. Valide contra el JSON Schema (patrón A08: validar al leer, fallar cerrado con mensaje accionable).
3. Verifique acceso al/los repo/s y al tablero.
4. Haga un **dry-run** (descubre trabajo sin ejecutar) para confirmar que el cableado anda.
5. Registre el producto como inactivo hasta OK humano.

**Sizing:** Grande (es la pieza central).

### 4.4 Kernel multi-producto (supervisor de instancias)

**Problema (planteado por Leo).** El kernel va a tener que gestionar **múltiples productos**, cada
uno con su(s) repo/s y su tablero. Hoy el Pulpo es *un* loop sobre *un* repo.

**Diseño.** Aparece una capa nueva — **supervisor de instancias** — que:
- Mantiene el **registro de productos** (desde los descriptores).
- Instancia y supervisa **un pipeline por producto activo**, aislado del resto.
- Enruta issues/eventos al pipeline del producto correcto (por `projectId`/repo/tablero).
- Expone estado **por producto** al dashboard/API.

El aislamiento **Modelo B** ya está previsto en el plan de cutover ([`ola9-sub-olas-migracion.md` §2, sub-ola 9.5](ola9-sub-olas-migracion.md)):
un kernel, estado namespaceado por `projectId`. La Ola Puente lo lleva de "un producto con estado
namespaceado" a "N productos activos con supervisor".

**Sizing:** Grande.

### 4.5 Ejecución paralela multi-producto

**Problema (planteado por Leo).** No alcanza con *definir* N productos: el kernel tiene que
**ejecutarlos en simultáneo**.

**Diseño — concurrencia de dos niveles:**
- **Cap por producto:** cada producto con su propia cola, sus worktrees, su estado, su cap de agentes
  (hoy "máx 3 agentes" pasa a ser "máx N por producto").
- **Cap global:** los recursos de la máquina son finitos y compartidos. Un scheduler global reparte
  slots entre productos (fairness + prioridad), respetando el techo de RAM/CPU (memoria
  `project_resource-thresholds-recalibrated`).
- **Aislamiento de fallos:** un producto que rebota o satura recursos **no puede** tumbar ni frenar a
  otro (circuit-breaker por producto, no global).
- **Ventanas y cuotas:** las ventanas autoexcluyentes (QA>Build>Dev) y el reparto de cuota de
  providers (Anthropic/Codex pagos, resto free) pasan a ser **por producto** dentro del techo global.

**Sizing:** Grande.

### 4.6 Persistencia del descriptor + estado durable

**Problema (planteado por Leo).** El descriptor y el estado hoy vivirían en JSON local, y eso es
**endeble** para el volumen y la criticidad que vamos a manejar. Leo pide un **medio persistente de
verdad** — base de datos — consistente, conservado y consultable desde donde haga falta.

**Cómo encaja con el prior art (sin contradecirlo).** No es "tirar todo a una BD". Es aplicar la
segmentación ya decidida:
- **#3898** clasificó el dato en C1 (declarativa durable), C2 (efímero), C3 (coordinación) y descartó
  BD remota **para el problema local** (durabilidad frente a `reset --hard`).
- **#4398** introdujo la delta multi-host (app móvil): el subconjunto **observable/operable desde
  afuera** necesita salir de la máquina vía una **proyección remota**.
- **La Ola Puente agrega una segunda delta:** el **descriptor de proyecto** es dato **maestro,
  multi-producto, consultable y de alta criticidad** — es exactamente el perfil que **sí** justifica
  un store durable/consultable, distinto del estado efímero de coordinación.

**Decisión de Leo (2026-07-13): BD gestionada.** El requisito de **ejecución distribuida** (§4.9 —
múltiples instancias del kernel, posiblemente en cloud, sin depender de la máquina local) **descarta
SQLite embebido** como store del descriptor/coordinación: un archivo embebido asume un único host y
no es multi-writer entre instancias distribuidas. La fuente de verdad maestra pasa a **BD gestionada,
accesible por red**.

**Recomendación concreta: DynamoDB.** Es la mejor relación costo-beneficio para *nuestro* caso:
- **Cero vendor nuevo, cero costo nuevo:** ya está en el stack (AWS SDK, Cognito, Lambda) y reusa las
  credenciales AWS ya cargadas (`credentials.js`). No sumamos proveedor ni expertise.
- **Impacto de budget ≈ $0:** serverless pay-per-request + **free tier permanente** (25 GB + 25
  RCU/WCU siempre gratis). El catálogo de productos + descriptores + firmas es de orden KB–MB → cae
  entero en el free tier. Sin server idle que pagar. Justo la restricción que puso Leo.
- **Nativo para distribuido/cloud:** managed y accesible por red desde cualquier instancia del kernel
  (local o en nube) → habilita directamente §4.9 sin re-arquitectura.
- **Coordinación multi-instancia gratis:** los *conditional writes* (concurrencia optimista) dan
  locking distribuido / leader-election / dedup de worktrees entre instancias — pieza clave para
  multi-kernel.
- **Modelo de ítem = JSON:** el descriptor encaja sin impedancia; el acceso es por clave
  (`get by projectId`, `list products`) → el sweet spot de DynamoDB.

**Trade-off honesto:** DynamoDB es flojo para queries relacionales/analíticas ad-hoc. No nos pega:
el acceso al catálogo es por clave; para analítica/dashboards se agrega una proyección o DynamoDB
Streams más adelante. Alternativas evaluadas y descartadas por costo-beneficio: **Postgres gestionado**
(Neon/Supabase — más potente de lo necesario para un catálogo key-based, suma vendor, free tiers con
pausado/límites); **MongoDB Atlas M0** (buen fit documental pero vendor nuevo, cap 512 MB, duplica lo
que DynamoDB ya nos da in-stack); **Turso/libSQL** (elegante pero vendor nuevo y story multi-writer
más verde).

**Segmentación resultante:**
- **Descriptores + catálogo de productos + autoridad/firmas** → **DynamoDB** (durable, consultable,
  multi-host), con audit-log append-only (A09) y validación de schema al leer (A08).
- **Estado de coordinación de alto write** (colas, waves, blocked, health por producto) → DynamoDB
  namespaceado por `projectId` (los conditional writes lo hacen seguro entre instancias).
- **Estado efímero** (cooldowns, offsets, circuit-breaker) → volátil/local por instancia, como hoy.
- **Proyección remota** para lo que la app móvil lee/opera → según [`externalizacion-estado-operativo-remoto.md`](externalizacion-estado-operativo-remoto.md).

> **Pendiente de revisión:** guru/arquitecto/security validan el modelo de particiones (PK/SK),
> el plan de migración desde JSON (§5.5) y el aislamiento de credenciales por producto (§5.1) antes
> de comprometer el schema en `contracts/`.

**Sizing:** Medio–Grande.

### 4.7 Gestión desde interfaz (requisito de primera clase)

**Regla que fijamos con Leo.** Todo lo que el kernel habilita **se gestiona desde interfaz, no
editando archivos**. Cada capacidad nueva **nace con su superficie de gestión**. Las tres superficies:

- **Dashboard (hoy):** alta/onboarding de un producto nuevo (wizard del descriptor), ver/editar
  descriptor (repos/tablero/env/skills/autoridad), switchear entre productos, estado por producto,
  panel de firma (GATE 2, ya construido — `esperando-firma.js`), arranque/pausa por producto.
- **App móvil operadora (futuro cercano):** misma capacidad de bolsillo — firmar, aprobar/rechazar,
  alta de proyecto, ver estado por producto. La Ola Puente deja el **backend + contrato** listos
  (endpoints, proyección remota, buzón de comandos — #4398).
- **Telegram Commander (hoy):** operar por lenguaje natural — estado por producto, aprobar/rechazar,
  disparar acciones. Se extiende para ser **product-aware** (hoy asume un único producto).

**Sizing:** Grande (transversal — toca dashboard, backend de gestión y contrato de la app móvil).

### 4.8 Autoridad y firma por producto

**Delta.** Hoy la autoridad de firma (GATE 2) es `leitolarreta` global. Con multi-producto, **cada
producto declara su(s) firmante(s) autorizado(s)** y su aprobador de respaldo, en el descriptor. Se
mantienen los invariantes de [`gates-firma-operador.md`](gates-firma-operador.md): fail-closed, no
auto-aprobación por timeout, firma no repudiable atada al commit, coexistencia con `qa:passed`/`qa:skipped`.

**Sizing:** Medio.

### 4.9 Ejecución distribuida del kernel (cloud-ready)

**Problema (planteado por Leo, 2026-07-13).** Hoy el kernel/pipeline se ejecuta **desde una única
máquina local**. Si extraemos el motor y distribuimos información y responsabilidad, la **ejecución
del propio kernel** también debería poder distribuirse: **múltiples instancias del kernel corriendo
en distintos lugares** — y en principio la posibilidad de que el kernel **corra en la nube**, para no
depender de la máquina local.

**Por qué esto reordena el diseño.** Es la premisa que fuerza dos decisiones ya tomadas:
- El estado maestro **no puede vivir en archivos locales** → BD gestionada accesible por red (§4.6,
  DynamoDB). Un archivo embebido ataría el kernel a un host.
- La coordinación entre instancias necesita **primitivas distribuidas** (locking, leader-election,
  dedup de worktrees) → conditional writes de la BD, no locks de filesystem.

**Diseño — instancia de kernel como unidad desplegable:**
- **Instancia stateless respecto al estado maestro:** cada instancia lee/escribe la BD gestionada;
  su disco local es sólo caché/worktrees efímeros. Una instancia puede morir y otra retoma.
- **Topologías soportadas:** (a) 1 instancia local (hoy); (b) N instancias locales/varias máquinas;
  (c) instancia(s) en cloud (contenedor/VM) sin máquina local. La misma binario, distinto deploy.
- **Reparto de trabajo entre instancias:** un producto (o una fase) se **claimea** vía conditional
  write; sólo una instancia lo ejecuta a la vez. Sin claim, no toca. Evita doble ejecución.
- **Ancla de recursos:** los caps de RAM/CPU y el reparto de cuota de providers pasan de "techo de una
  máquina" a "techo por instancia + techo global lógico" (la cuota de Anthropic/Codex es **una sola y
  compartida** aunque haya N instancias — hay que contabilizarla central, no por host).
- **Portabilidad del entorno:** las credenciales, el toolchain (gh/claude/gradle/JDK) y los binarios
  que hoy asume la máquina local deben quedar declarados para poder reproducir una instancia en cloud.

**Relación con lo anterior.** §4.5 (paralelismo multi-producto) es *concurrencia dentro de una
instancia*; §4.9 es *concurrencia entre instancias*. Se componen: N instancias, cada una corriendo M
productos, coordinadas por la BD.

**Sizing:** Grande. **Nota de alcance:** para el **primer entregable** (Intrale único producto, ver
§9) alcanza con dejar el diseño **cloud-ready** —estado en BD gestionada + claim por conditional
write— sin desplegar todavía instancias en nube. El deploy distribuido real es una fase posterior;
lo importante ahora es **no clavar supuestos de host único** que después haya que reescribir.

#### Cierre de la Ola Puente — P7 (#4692): diseño cloud-ready **cerrado, deploy diferido (§9.5)**

Con P7 el diseño cloud-ready de §4.9 queda **anclado como cerrado**: las cuatro piezas ya tienen
cimiento en código y no requieren obra nueva de infraestructura en esta ola. **No se despliegan
instancias en nube** (deploy diferido, §9.5) — el alcance es dejar la *capacidad* lista, sin supuestos
de host único.

| Pieza de diseño (§4.9) | Estado | Anclaje en código |
|------------------------|--------|-------------------|
| **Instancia stateless respecto al estado maestro** | cerrado | `lib/kernel-coordination-store.js` — estado namespaceado por `projectId` en BD gestionada; disco local sólo caché/worktrees efímeros. |
| **Claim de producto/fase por conditional write (CAS)** | cerrado | `compareAndSet(key, value, expectedVersion)` + `claim()`/`release()` con `ConditionExpression` atómica; `expectedVersion` desactualizado ⇒ rechazo (anti split-brain); `instanceId` validado por `isSafeId`. |
| **Cuota Anthropic/Codex única y compartida (central, no por host)** | cerrado (contabilización central) | `debitPaid(key, delta)` debita un contador central único con reintento por conflicto de versión (nunca last-write-wins). El techo lógico es **global y compartido**: se contabiliza central, **no** por instancia. `thresholds.providerBudget`/`providerQuotas` reparten ese techo por producto (Σ ≤ 100%), no lo multiplican por host. |
| **Portabilidad del entorno** | documentado | credenciales por producto vía `credentials.resolveScopedRefs` (brokering namespaceado); toolchain (gh/claude/gradle/JDK) declarado para reproducir una instancia. |

**Invariante de cuota central (a preservar cuando se despliegue multi-host):** aunque haya N
instancias, el techo de Anthropic/Codex es **uno solo**. La contabilización vive en el contador central
del coordination store (`debitPaid`), nunca sumando cuotas por host. Una instancia *rogue* no debe poder
ignorar ese techo — el débito es atómico y compartido.

---

## 5. Lo que no estábamos viendo (riesgos y piezas faltantes)

Leo pidió explícitamente pensar "algo que no estemos viendo". Piezas que **no** salieron en la
conversación y que el diseño necesita:

1. **Aislamiento de secretos por producto (blast radius).** Multi-producto = credenciales de varios
   productos en la misma máquina. El descriptor debe referenciar secretos **por producto** vía el
   cargador unificado (`credentials.js`), con **aislamiento estricto**: un fallo/leak de un producto
   no puede exponer los secretos de otro. Requisito de security (A01/A02).
2. **Reparto de cuota de providers entre productos.** La cuota Anthropic/Codex (pagos) es **global y
   escasa**. Con N productos activos hay que decidir política de reparto (fairness, prioridad por
   producto, presupuesto por producto) — sino un producto se come toda la cuota y frena al resto.
3. **Versionado del kernel por producto.** Cada producto pinea su versión del kernel. Rollout
   escalonado: un producto puede ir a la versión N+1 mientras otro sigue en N. Hay que definir la
   política de bump/compatibilidad y un canario.
4. **Observabilidad/costos segmentados por producto.** Métricas, tokens, tiempos, TTS — todo tiene
   que poder verse **por producto** (hoy es agregado). Ata con la instrumentación V3 obligatoria
   (memoria `feedback_v3-bundled-instrumentation`).
5. **Migración de datos sin pérdida.** Pasar del JSON local al store durable necesita un plan de
   migración con backup, verificación de integridad y rollback (no perder historia de waves/labels/firmas).
6. **Versionado del propio esquema del descriptor.** El descriptor va a evolucionar. Necesita
   `schemaVersion` y migraciones de descriptor (un producto viejo debe seguir arrancando).
7. **Testing multi-producto.** Cómo se prueba el kernel con >1 producto sin productos reales:
   extender `fixtures/` a **múltiples repos dummy** y un test de aislamiento (producto A no pisa a B).
8. **Modo degradado / límite de productos.** Qué pasa cuando la máquina no da abasto para N productos
   activos: política de encolado de productos, no sólo de issues.
9. **Onboarding reversible.** Dar de baja/archivar un producto sin dejar estado huérfano ni worktrees zombis.

### 5.5 Plan de migración JSON→DynamoDB (backup · verificación · rollback)

Implementado en `.pipeline/lib/kernel-store-migrate.js` (#4745, split de #4688). Migra el estado de
coordinación local (`waves.json`, `blocked-issues.json`, `blocked-by-infra.json`, `infra-health.json`)
al store durable **a través del coordination store** (`kernel-coordination-store.js`, #4744) — nunca
directo al driver DynamoDB. Espeja el estilo fail-closed / errores-como-dato de
`project-descriptor-migrations.js`.

**Mapeo de fuentes → claves de coordinación.** Cada una de las 4 fuentes migra a su propia clave
determinística (`coord#<key>`), preservando su estructura heterogénea sin colapsarlas. El módulo
extiende la allowlist del coordination store (`MIGRATION_KNOWN_KEYS`) con `blocked-by-infra`:

| Clave de coordinación | Fuente JSON |
|---|---|
| `waves` | `waves.json` |
| `blocked` | `blocked-issues.json` |
| `blocked-by-infra` | `blocked-by-infra.json` |
| `health` | `infra-health.json` |

**Modos de operación.**

```bash
# 1) Dry-run (DEFAULT, seguro): genera backup + reporte proyectado, NO escribe al store.
node .pipeline/lib/kernel-store-migrate.js

# 2) Aplicar: escribe idempotente al store, verifica integridad fail-closed, reporta.
node .pipeline/lib/kernel-store-migrate.js --apply     # (--commit es alias)

# 3) Rollback: restaura los JSON desde un backup VERIFICADO por checksum.
node .pipeline/lib/kernel-store-migrate.js --rollback --from .pipeline/backup/<timestamp>
```

**Secuencia (paso a paso).**

1. **Backup previo** — antes de cualquier escritura, copia el contenido de las fuentes presentes a
   `.pipeline/backup/<timestamp>/` (el `<timestamp>` se genera **internamente** en formato ISO compacto,
   nunca de input externo → anti path-traversal A01). Dir/archivos con permisos restrictivos
   (`0700`/`0600`; en Windows el equivalente best-effort, no world-readable). Escribe un `manifest.json`
   con checksum sha256 canónico y conteo de registros por archivo, indexado por **nombre de archivo
   relativo** (sin paths absolutos que filtren el usuario, A02). El dir `.pipeline/backup/` está
   gitignoreado — los backups nunca se versionan.
2. **Escritura idempotente** — por clave determinística `coord#<key>` vía `initState` / `compareAndSet`
   del coordination store. Si el contenido ya está y su checksum canónico coincide, **no reescribe**
   (re-run no duplica ni sube versión; `action:'noop'`).
3. **Verificación de integridad fail-closed** — checksum canónico (sha256 sobre serialización con
   claves ordenadas) + conteo de registros por clave, **antes** (fuente) **vs después** (readback del
   store). Cualquier discrepancia (clave faltante, drift de checksum, conteo distinto) ⇒
   `{ ok:false, code:'integrity_mismatch' }` que **detiene** la migración; el reporte imprime la línea
   de rollback. Las firmas GATE 2 **no viven en los 4 JSON** y este módulo **nunca las toca**: usa SKs
   `coord#*`, disjuntos de los `signature#*` append-only del store durable (#4744). Por construcción la
   migración es aditiva/no-destructiva respecto de las firmas — verificado por el test dedicado
   `no pierde historia de waves/labels/firmas`.

**Procedimiento de rollback (verificado).**

El rollback restaura los JSON locales desde un backup. Verifica **primero** el checksum sha256 de cada
archivo del backup contra el `manifest.json` (A05: no reintroducir estado corrupto); si algún checksum
no coincide, aborta con `code:'backup_corrupt'` sin tocar el estado local. También valida que el
`--from` resuelva **dentro** de `.pipeline/backup/` (anti path-traversal). Verificación manual del
backup antes de restaurar:

```bash
# Comparar el checksum del backup contra el registrado en el manifest. El módulo
# reusa `canonicalize` de project-descriptor.js (claves ordenadas) para el sha256:
node -e "const fs=require('fs'),{canonicalize}=require('./.pipeline/lib/project-descriptor'),\
c=require('crypto'),p='.pipeline/backup/<timestamp>';\
const m=JSON.parse(fs.readFileSync(p+'/manifest.json','utf8'));\
for(const [name,meta] of Object.entries(m.files)){if(!meta.present)continue;\
const v=JSON.parse(fs.readFileSync(p+'/'+name,'utf8'));\
const h=c.createHash('sha256').update(canonicalize(v)).digest('hex');\
console.log((h===meta.checksum?'[OK]  ':'[FALLA] ')+name);}"

# Restaurar (idempotente; sólo escribe si todos los checksums verifican):
node .pipeline/lib/kernel-store-migrate.js --rollback --from .pipeline/backup/<timestamp>
```

**Observabilidad.** Toda corrida imprime secciones `BACKUP → MIGRACIÓN → VERIFICACIÓN → RESULTADO` con
prefijos ASCII (`[OK]`/`[FALLA]`/`[DRY-RUN]`/`[ROLLBACK]`), tabla alineada (clave · conteo · acción ·
checksum antes · después) y la **línea de rollback siempre visible**. La salida se redacta contra
patrones de secreto (AWS keys, JWT) y los errores del SDK se sanitizan (sin RequestId/ARN) antes de
emitirse. Tests: `.pipeline/lib/__tests__/kernel-store-migrate.test.js`.

---

## 6. Modelo de datos — esquema del descriptor (draft)

Borrador conceptual (el schema formal se define en `contracts/` del kernel, versionado con
`schemaVersion`). No es contrato cerrado: es punto de partida para guru/arquitecto.

```jsonc
{
  "schemaVersion": "1.0",
  "projectId": "intrale-platform",           // identidad estable, namespacea todo el estado
  "name": "Intrale Platform",
  "status": "active",                         // active | paused | onboarding | archived
  "repositories": [                            // uno o más repos por producto
    { "id": "platform", "url": "github.com/Intrale/platform", "role": "product" }
  ],
  "board": {
    "provider": "github-projects-v2",
    "ref": "…",
    "admissionLabels": ["needs-definition", "Ready"],
    "routing": [ { "label": "area:backend", "capability": "backend" } ]
  },
  "credentials": {                             // REFERENCIAS, nunca valores; aisladas por producto
    "ref": "~/.claude/secrets/credentials.json#intrale",
    "scopes": ["github", "aws"]
  },
  "capabilities": [                            // implementaciones de stack que mapean a interfaces del kernel
    { "interface": "backend", "skill": "backend-dev" },
    { "interface": "frontend", "skills": ["android-dev", "web-dev"] }
  ],
  "authority": {                               // GATE 2 por producto
    "signers": ["leitolarreta"],
    "backup": null,
    "gates": { "gate0": "off", "gate2": "dry-run", "visual": "off" }
  },
  "execution": {                               // concurrencia y cuota por producto, dentro del techo global
    "agentCap": 3,
    "priorityWindows": true,
    "providerBudget": { "anthropic": 0.5, "codex": 0.5 }
  }
}
```

---

## 7. Arquitectura objetivo (vista textual)

```
                         ┌───────────────────────────────────────────────┐
   Superficies de        │  Dashboard V3   ·   App móvil   ·   Telegram   │  (§4.7 — gestión first-class)
   gestión (UI)          └───────────────┬───────────────────────────────┘
                                         │  API de gestión + proyección remota (#4398)
                         ┌───────────────▼───────────────────────────────┐
   KERNEL                │            SUPERVISOR DE INSTANCIAS            │  (§4.4)
   (repo intrale/kernel, │   registro de productos · scheduler global    │
    paquete versionado)  │   cap global · reparto de cuota · aislamiento  │  (§4.5, §5.2)
                         └───┬───────────────┬───────────────┬───────────┘
                             │               │               │
                     ┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼────────┐
                     │ Pipeline P1  │ │ Pipeline P2  │ │ Pipeline Pn  │  (una instancia por producto)
                     │ cola·worktree│ │ cola·worktree│ │ cola·worktree│
                     │ estado(P1)   │ │ estado(P2)   │ │ estado(Pn)   │  (namespaceado por projectId)
                     └───────┬──────┘ └──────────────┘ └──────────────┘
                             │ interfaces del kernel (dev genérico, build/test/e2e/package/deploy)
                     ┌───────▼──────────────────────────────────────────┐
   ADAPTADORES       │  capabilities de stack por producto (plugins)     │  (§4.2 — kernel-repo-design §1)
   (repos producto)  │  P1: android/backend/web Intrale · P2: …          │
                     └───────────────────────────────────────────────────┘
                             ▲
                     ┌───────┴──────────────────────────────────────────┐
   PERSISTENCIA      │  Store durable: descriptores · catálogo · firmas  │  (§4.6)
                     │  Coordinación (por projectId) · efímero (volátil) │
                     └───────────────────────────────────────────────────┘
```

---

## 8. Plan de olas propuesto (para `/planner`)

Orden por dependencia dura. Cada fase deja el sistema funcionando y termina con OK humano (política
fail-closed de operador ausente).

| # | Fase | Alcance | Depende de | Sizing |
|---|------|---------|-----------|--------|
| **P0** | Self-hosting del kernel | Intake multi-repo + worktrees sobre repo destino + publish/pin/bump del paquete (§4.1) | 9.1 (hecho) | Grande |
| **P1** | Rol dev genérico | Interfaz de dev en kernel + partición backend/frontend + fallback genérico (§4.2) | P0 | Medio |
| **P2** | Descriptor de proyecto | Schema versionado + bootstrap/onboarding + validación + dry-run (§4.3, §6) | P0 | Grande |
| **P3** | Persistencia durable | Store del descriptor/catálogo/firmas + migración + audit-log (§4.6) | P2 | Medio–Grande |
| **P4** | Supervisor multi-producto | Registro + instanciación + ruteo + aislamiento por producto (§4.4) | P2, P3 | Grande |
| **P5** | Ejecución paralela | Concurrencia 2 niveles + reparto de cuota + circuit-breaker por producto (§4.5, §5.2) | P4 | Grande |
| **P6** | Gestión por interfaz | Dashboard product-aware + API de gestión + contrato app móvil + Telegram product-aware (§4.7) | P4 | Grande |
| **P7** | Autoridad por producto | Firma/aprobación por descriptor + respaldo (§4.8) | P2, P6 | Medio |

> **Decisión de Leo (§9.2): 9.2 y 9.3 quedan relegadas.** No se cierran como pre-requisito formal
> antes de arrancar. Las sub-olas 9.2–9.5 ([`ola9-sub-olas-migracion.md`](ola9-sub-olas-migracion.md))
> se **absorben** dentro de P0–P7 y se ejecutan **sólo a medida que cada fase las necesite** (ej.:
> el rol dev genérico de P1 traccciona parte de 9.2). El foco es el primer entregable con Intrale como
> único producto, no completar el catálogo de skills primero.

---

## 9. Decisiones tomadas (Leo, 2026-07-13)

1. **Persistencia → BD gestionada, `DynamoDB`.** Descartado SQLite embebido por el requisito de
   ejecución distribuida (§4.9). Elegida por costo-beneficio: in-stack, free tier permanente (impacto
   de budget ≈ $0), cloud-ready y con coordinación multi-instancia por conditional writes (§4.6).
   Pendiente sólo la validación de guru/arquitecto/security sobre el modelo de particiones y la
   migración.
2. **Secuencia → arrancamos por P0 (self-hosting).** **9.2 y 9.3 quedan relegadas**: no se cierran
   antes como pre-requisito formal; se absorben dentro del plan P0–P7 a medida que hagan falta. El
   foco es el primer entregable, no completar el catálogo de skills primero.
3. **Alcance del primer entregable → Intrale como único producto real.** La Ola Puente entrega la
   **capacidad** multi-producto/distribuida (diseño cloud-ready, estado en BD, claim por instancia),
   pero **operando un solo producto real (Intrale)** para minimizar riesgo. El segundo producto llega
   después, sin re-arquitectura.
4. **App móvil → más adelante.** La Ola Puente deja **sólo backend + contrato** (endpoints, proyección
   remota, buzón de comandos). El MVP de la app operadora se hace cuando todo esto esté definido, no
   en esta ola.
5. **Ejecución distribuida (nuevo, §4.9) → requisito de primera clase, deploy diferido.** Se diseña
   cloud-ready desde ahora (estado en BD, sin supuestos de host único), pero el deploy real de
   instancias en nube es una fase posterior al primer entregable.

---

## 10. Próximos pasos

1. **Revisión de Leo** de este documento y cierre de las decisiones abiertas (§9).
2. **`/planner`** para formalizar la Ola Puente: crear el épico paraguas y hacer el split en P0–P7
   con la cadena de dependencias declarada.
3. **Revisión guru/arquitecto/security** de las piezas de mayor riesgo: persistencia (§4.6),
   aislamiento de secretos (§5.1), reparto de cuota (§5.2).
4. Recién con P0 (self-hosting) habilitado, arrancar el resto sobre `intrale/kernel`.

---

*Documento de diseño de la Ola Puente. Sintetiza la conversación de diseño con Leo (2026-07-13).
Parte del prior art de las Olas 8 y 9.1 sin re-litigarlo; resuelve la delta multi-producto. Pendiente
de revisión humana y de guru/arquitecto/security antes de formalizar en issues.*
