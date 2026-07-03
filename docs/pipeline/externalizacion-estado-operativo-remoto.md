# Externalización del estado operativo del pipeline a una fuente de datos remota

> **Naturaleza:** spike documental (issue #4398, `area:pipeline`, `size:medium`). El único
> entregable es **este documento de decisión**. NO se implementa store remoto, API ni migración
> en este issue — todo eso es Ola 9.
> **Ola:** 8.4 — habilita la Ola 9 (desacople del modelo operativo + primer paso de la app móvil operadora).
> **Anclaje:** cada afirmación sobre el estado actual cita `path:línea` real o un comando de
> verificación ejecutado sobre el HEAD de `agent/4398-pipeline-dev`.
>
> **Prior art del que parte:** [`docs/pipeline/persistencia-data-operativa-analisis.md`](persistencia-data-operativa-analisis.md) (spike #3898).
> **Frontera kernel/producto que ancla:** [`docs/pipeline/contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) (EP-OLA8-B, #4010).

---

## Cómo leer este documento

Las 9 secciones están mapeadas 1:1 a los criterios de aceptación del issue (CA-1..CA-10), al
checklist vinculante del agente `security` y a las guidelines del agente `ux`. Al final, la tabla
de trazabilidad muestra dónde se resuelve cada criterio.

Este documento **no re-litiga** lo cerrado en #3898: parte de sus conclusiones y resuelve solo la
**delta** que introduce el requisito nuevo — la app móvil operadora, ausente cuando se escribió #3898.

---

## 1. Punto de partida y delta vs #3898 → **CA-7**

El spike #3898 (`docs/pipeline/persistencia-data-operativa-analisis.md`) ya analizó la persistencia
del estado operativo del pipeline y **descartó una BD remota**. Su argumento textual de descarte es:

> **"Por qué no una BD remota:** ninguna necesidad funcional actual (queries complejas, multi-host,
> concurrencia masiva) la justifica. Una BD remota agrega credenciales al runtime Node del pipeline
> —que hoy **no las tiene**—, latencia de red en cada lectura de intake, un servicio always-on
> (punto de falla + target de ataque permanente) y rompe el modelo filesystem-first del proyecto"
> — `persistencia-data-operativa-analisis.md:34`

Ese descarte **sigue siendo correcto para el problema que #3898 resolvía** (durabilidad + auditoría
de config local frente a `git reset --hard`). No se invalida: la solución híbrida file-first/git +
SQLite embebido de #3898 se mantiene como recomendación para *ese* problema.

**Qué cambió — la delta:** #3898 descartó lo remoto porque _"ninguna necesidad funcional actual…
multi-host … la justifica"_. **#4398 introduce exactamente esa necesidad funcional que en #3898 no
existía: la app móvil operadora.** Un celular **no puede leer el filesystem** de la máquina del
Pulpo → aparece por primera vez el requisito **multi-host / acceso remoto** que #3898 declaró ausente.

**Conclusión:** la respuesta correcta no es "todo a remoto" (contradiría a #3898 y metería el hot
path en la red) ni "nada a remoto" (imposibilita la app móvil). Es **segmentar por quién necesita el
dato**: solo el subconjunto observable/operable desde afuera sale de la máquina, vía una proyección
remota; el resto queda local. El resto del documento desarrolla ese segmentado.

---

## 2. Clasificación del estado: qué sale y qué NO → **CA-6** (aislamiento, security A05)

Se reutiliza la clasificación de #3898 (`persistencia-data-operativa-analisis.md:50-52`) cruzada con
la pregunta nueva: **¿la app móvil operadora lo lee o lo opera?**

| Clase (#3898) | Ejemplos reales (con ancla) | ¿La app móvil lo lee/opera? | Destino |
|---|---|---|---|
| **C1 — declarativa durable** | `.partial-pause.json` (allowlist, `.gitignore:125`), `waves.json` (parte declarativa), ready-flags, `priority-windows.json` | **SÍ** — observar + operar | **Proyección remota** (lectura) + **buzón de comandos** (operar) |
| **C3 — coordinación** | `waves.json` (estado), `blocked-issues.json` (`.gitignore:127`), métricas, infra-health | **SÍ (observar)**, operar parcial | **Proyección remota** (write-through desde FS) |
| **C2 — transiente/efímero** | `cooldowns.json` (`.gitignore:128`), `listener-offset.json` (`.gitignore:130`), `circuit-breaker-infra.json` (`.gitignore:134`), locks efímeros | **NO** | **Queda local/volátil** — no sale de la máquina |

**Por qué C2 NO sale (justificación explícita):** el estado C2 es deliberadamente efímero y
regenerable — "se pierde" es el comportamiento *correcto* (`persistencia-data-operativa-analisis.md:31`).
La app móvil no lo lee ni lo opera. Externalizarlo agregaría **superficie de ataque sin ningún
beneficio** (security A05): un `listener-offset.json` o un lock efímero en un store remoto es más
riesgo (más credenciales, más red, más blast radius IAM) a cambio de cero valor para el operador.
Los locks efímeros, además, dependen de latencia de µs y perderían su semántica si se movieran a la red.

**Regla de aislamiento:** solo **C1 + C3** cruzan el perímetro de la máquina, y solo como
**proyección** (ver §4). C2 permanece en el filesystem local, exactamente como hoy.

---

## 3. Fuente de datos recomendada: **DynamoDB** → **CA-1** (security A02, A05, A08)

Se recomienda **DynamoDB** como store remoto de la proyección C1+C3, con esta justificación:

- **Ya está en el stack del producto.** El backend Kotlin usa AWS SDK Java 2.25.28 (`CLAUDE.md`,
  sección AWS). Cero tecnología nueva a introducir en infra — solo una tabla nueva bajo una cuenta/rol
  distinto (§6).
- **Serverless / pay-per-request.** Costo ~$0 a la escala de writes del pipeline; **sin servicio
  always-on** que mantener. Esto ataca directamente el motivo por el que #3898 descartó Redis/Postgres
  self-hosted: eran un "servicio always-on (punto de falla + target de ataque permanente)"
  (`persistencia-data-operativa-analisis.md:34`, y matriz `:64` para Redis).
- **Conditional writes / optimistic locking nativos.** Resuelven el requisito de **atomicidad de
  locks y ready-flags** que exige security (A08). Una condición de carrera sobre allowlist/ready-flags
  duplica trabajo o corrompe olas; los conditional writes de DynamoDB dan la garantía sin lógica ad-hoc.
- **Cifrado at-rest por default + TLS en tránsito.** Cubre A02 sin trabajo extra.

### Alternativas descartadas

| Alternativa | Motivo de descarte |
|---|---|
| **Postgres self-hosted** | Servicio always-on = punto de falla permanente + superficie de ataque persistente. Requiere operar/parchear un servidor. #3898 ya lo descartó por A05 y por el modelo filesystem-first. No aporta nada que DynamoDB no dé serverless. |
| **Redis self-hosted** | Pensado para dato volátil (RDB/AOF), no para C1 durable. **A05: sin AUTH/TLS = exposición total** de la config de control (`persistencia-data-operativa-analisis.md:64`). Always-on = target permanente. Descarte fuerte. |
| **KV nuevo (LevelDB/RocksDB) o motor nuevo** | Introducir tecnología que el proyecto no usa, sin gestión, sin cifrado de red nativo, sin historial. Contradice el criterio "cero tecnología nueva". |
| **SQLite / repo git (recomendados por #3898)** | Siguen siendo válidos para el problema de #3898 (durabilidad local), pero son **single-host**: no resuelven el acceso multi-host que introduce la app móvil. Se mantienen como fuente de verdad *local* (§4), no como store remoto. |

**Matiz crítico de latencia (el gran riesgo, ver §7):** el Pulpo lee `waves.json`/allowlist en cada
ciclo de intake a latencia de µs (archivo local). **Poner DynamoDB en el hot path degradaría el
throughput y acoplaría la red al spawn de agentes.** Por eso DynamoDB **no reemplaza** al filesystem:
es una **proyección** (§4), no la fuente de verdad operativa.

---

## 4. Modelo de acceso remoto: CQRS-lite (proyección + buzón de comandos) → **CA-2** (security A01, A07)

El estado operativo del Pulpo **sigue viviendo en el filesystem local** (fuente de verdad, hot path en
µs intacto). DynamoDB es la **proyección remota + buzón de comandos**. La app móvil nunca toca la DB
directo.

```
App móvil ──JWT (Cognito)──► API intermedia (Ktor, SecuredFunction, /{business}/{function}) ──► DynamoDB (tabla kernel)
                                          │
   El Pulpo mantiene el FS como store operativo local (µs, hot path intacto):
     • PROYECTA estado (waves/allowlist/blocked/metrics) → DynamoDB      (write-through async, unidireccional FS→remoto)
     • CONSUME una tabla de COMANDOS del operador (unblock / pausar / mover ola) y los aplica en su ciclo
```

- **Acceso directo cliente→DB DESCARTADO explícitamente (security A01).** La app móvil **nunca**
  porta credenciales de infraestructura ni escribe la DB. Toda operación pasa por la API intermedia
  con **autorización server-side por operación y por recurso**. Credenciales embebidas en un APK son
  extraíbles trivialmente → prohibido.
- **Autenticación = JWT vía Cognito (security A07).** Se reutiliza el patrón existente del proyecto:
  `SecuredFunction` valida el JWT emitido por Cognito. **Nunca API keys estáticas** en el APK.
  - **Expiración:** access token de vida corta (p. ej. 1 h, valor exacto a fijar en Ola 9).
  - **Refresh:** refresh token gestionado por el SDK de Cognito en el cliente.
  - **Revocación:** revocación de refresh token vía Cognito (global sign-out / admin disable) para
    cortar un dispositivo comprometido.
- **El FS sigue siendo la fuente de verdad operativa del Pulpo.** DynamoDB es proyección + buzón. Así
  el hot path de intake queda en µs y la app móvil obtiene lectura/operación sin acoplar red al spawn.
- **CQRS-lite:** lectura (query) = proyección remota; escritura (command) = fila en la tabla de
  comandos que el Pulpo consume en su ciclo. Las operaciones son **eventualmente consistentes** (ver
  guidelines UX, §9).

---

## 5. Estrategia de migración por fases sin downtime → **CA-3**

El Pulpo **no se frena en ningún momento**. La proyección es **write-through unidireccional
FS→remoto** para el estado, y **comando→FS** para las operaciones; **nunca bidireccional simétrico**
(evita el desync, ver §7).

| Fase | Qué pasa | Fuente de verdad | Riesgo controlado |
|---|---|---|---|
| **(a) Doble escritura** | El Pulpo sigue leyendo/escribiendo FS como hoy y, además, **espeja** el estado C1+C3 a DynamoDB (write-through async, best-effort). Si el espejo falla, el pipeline sigue: FS es autoritativo. | **FS** (remoto es espejo) | Un fallo de red **no** afecta al pipeline. |
| **(b) Validación de consistencia** | Job que compara periódicamente FS ↔ proyección remota y reporta divergencias (reutiliza el espíritu del detector de desync ya existente en `pulpo.js`). No se habilita escritura remota hasta que la proyección sea consistente. | **FS** | Se detecta drift antes de exponer datos rancios a la app. |
| **(c) App solo-lectura** | La app móvil lee la proyección remota (olas, cola, allowlist, bloqueados, métricas). **Ninguna operación de escritura habilitada aún.** | **FS** | La app no puede corromper estado: solo observa. |
| **(d) Habilitar comandos de escritura** | Se habilita la tabla de comandos: la app encola `unblock`/`pausar`/`mover ola`; el Pulpo los consume y aplica sobre el **FS** (que sigue autoritativo), luego re-proyecta. | **FS** (comando→FS) | Autz por operación + audit trail + conditional writes evitan carreras. |

En ninguna fase el estado remoto se vuelve autoritativo sobre el FS. La proyección es
**unidireccional FS→remoto**; los comandos **entran** por la tabla remota pero **se aplican sobre el
FS**. Nunca hay escritura remota que el Pulpo tenga que "creerle" ciegamente al remoto.

---

## 6. Separación kernel operativo vs estado de producto → **CA-4** (security A01, A05)

Esta frontera **ya está definida formalmente** en
[`docs/pipeline/contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) (EP-OLA8-B, #4010) y
`docs/desacople-kernel/`. Este documento **ancla a ese contrato y no inventa frontera nueva**.

- **Tabla / namespace distintos.** El estado del **kernel operativo** vive en una tabla DynamoDB
  (o namespace de tabla) **separada** de la DynamoDB de negocio Intrale. Cero mezcla en el mismo
  bucket de acceso (security A05 + A01).
- **Cuenta / rol IAM distintos.** El rol IAM que accede a la tabla del kernel es **distinto** del rol
  del backend de producto. Blast radius acotado: comprometer el operador móvil no da acceso al negocio,
  y viceversa.
- **Credenciales distintas por actor:**
  - **Pulpo** (backend del kernel): credencial least-privilege **read/write** sobre la tabla del
    kernel, sin acceso a datos de negocio.
  - **Operador móvil**: **token Cognito con autz por operación**, sin secretos de infra, sin acceso
    directo a ninguna tabla. Solo puede invocar las `SecuredFunction` que la API expone.
- La frontera se lee de `contrato-kernel-adaptador.md` (sección 2: "qué vive de cada lado"). El estado
  operativo pertenece al **kernel**; los datos de negocio Intrale al **adaptador de producto**. La
  externalización respeta esa línea: solo el estado del kernel se proyecta a la tabla kernel.

---

## 7. Inventario de componentes a modificar → **CA-5**

**Volumen real de call-sites (verificado empíricamente en este HEAD):**

```
$ grep -rl "waves.json"    .pipeline --include=*.js | wc -l   →  56
$ grep -rl "partial-pause" .pipeline --include=*.js | wc -l   →  64
$ ls .pipeline/package.json                                    →  No such file or directory
$ ls .pipeline/lib/credentials.js                              →  existe
```

> Nota: el estimado "~20" de guru era conservador y la receta del arquitecto midió 65/70; mi medición
> sobre este HEAD da **56 / 64**. Cualquiera de los tres números confirma la misma conclusión: tocar
> los call-sites uno a uno es inviable → **el wrapper es imprescindible**.

| Componente | Estado | Cambio requerido |
|---|---|---|
| **Wrapper `state-store.js`** | **NO existe aún** | Nuevo. Hoy lee/escribe FS; mañana además proyecta a remoto. Los ~56/64 call-sites pasan a través de él en vez de tocar el JSON directo. Es el patrón `config-store.js` ya propuesto en #3898. **Imprescindible** dado el volumen de call-sites. |
| **Pulpo** (`.pipeline/pulpo.js`) | Existe | Agregar (a) ciclo de proyección write-through FS→remoto, (b) consumo de la tabla de comandos del operador y su aplicación sobre el FS. |
| **Dashboard V3** | Existe | Decisión abierta: puede leer de la proyección remota o seguir leyendo FS local. No bloqueante del spike. |
| **API intermedia (Ktor)** | Parcial (stack existe) | Nuevas `SecuredFunction` para operaciones del operador (leer estado, unblock, pausa parcial, mover ola), con **validación Konform** de input (security A03). La allowlist se valida contra **schema estricto de issue numbers**, no payload arbitrario. |

**Dónde corre la proyección a DynamoDB (decisión de impacto):** `.pipeline/` **NO tiene
`package.json` ni AWS SDK** (verificado arriba). Meter el AWS SDK + credenciales AWS en el runtime
Node del pipeline sumaría dependencia + superficie de secretos. **Alternativa preferible:** que la
**proyección la haga la API Ktor** (que ya tiene AWS SDK Java 2.25.28) y el **Pulpo le hable por HTTP
local**. Así:

- El runtime Node del pipeline **no** carga credenciales AWS ni SDK.
- La única pieza con credenciales AWS es la API Ktor (que ya las tiene para el negocio, pero con rol
  separado para el kernel, §6).
- Los secretos de conexión se gestionan por la convención del proyecto: `~/.claude/secrets/credentials.json`
  + cargador `.pipeline/lib/credentials.js` (#3311). Cero credenciales en el repo o en el APK.

---

## 8. Checklist de seguridad vinculante cubierto → **CA-8**

Mapeo de cada requisito vinculante del comment de `security` a dónde este documento lo resuelve:

| Ítem security | Requisito | Dónde se resuelve |
|---|---|---|
| **A01 Broken Access Control** | API intermedia con autz server-side; acceso directo cliente→DB descartado | §4 (CQRS-lite, descarte explícito) + §6 (roles distintos) |
| **A07 Auth Failures** | JWT vía Cognito, nunca API keys en APK; expiración/refresh/revocación | §4 (Cognito/JWT, TTL, refresh, revocación) |
| **A02 Cryptographic Failures** | Cifrado en tránsito (TLS) y en reposo | §3 (DynamoDB cifrado at-rest default + TLS) |
| **A05 Security Misconfiguration** | DB no expuesta públicamente; least-privilege; scoping distinto Pulpo vs móvil | §3 (serverless, no always-on) + §6 (roles/credenciales distintas) + §2 (C2 no sale) |
| **A03 Injection** | Validación Konform; allowlist contra schema estricto de issue numbers | §7 (SecuredFunction con Konform, allowlist = schema de issue numbers) |
| **A08 Data Integrity Failures** | Atomicidad/concurrencia de locks y ready-flags | §3 (conditional writes / optimistic locking nativo) + §5 (comando→FS, no bidireccional) |
| **Gestión de secretos** | Convención `~/.claude/secrets/credentials.json` + `.pipeline/lib/credentials.js`; cero credenciales en repo/APK | §7 (proyección en Ktor, secretos vía credentials.js; app sin secretos de infra) |
| **Audit trail** | Logging de operaciones sensibles (quién desbloqueó/frenó qué) | §6 (autz por operación) + §9 guideline 2 (ciclo de vida del comando como materia prima de audit) + §5 fase (d) |
| **Separación kernel vs producto** | Estado del pipeline no mezclado con negocio; fronteras de autz distintas | §6 (tabla/rol/credencial distintos, anclado a #4010) |

---

## 9. Guidelines UX para Ola 9 → **CA-9**

No bloqueantes de este spike, **vinculantes para el diseño de la app operadora (Ola 9)**. Se registran
acá porque las decisiones de datos/acceso de arriba las condicionan y después no se revierten sin
re-arquitectura.

1. **Eventual-consistency + optimistic UI.** El modelo CQRS-lite (§4) implica que un comando del
   operador (unblock / pausar / mover ola) **no se aplica instantáneamente**: pasa por la API, se
   encola y el Pulpo lo consume en su próximo ciclo. La app debe comunicar el estado intermedio con
   claridad (optimistic UI + estado "pendiente de aplicar" + confirmación cuando el Pulpo lo ejecuta).
   Sin esto, el operador presiona dos veces, duplica comandos o cree que la acción falló. Queda
   registrado que **las operaciones son eventualmente consistentes** para que el diseño lo asuma desde
   el día 1.
2. **Ciclo de vida legible del comando.** El audit trail que exige security es también **materia prima
   de UX**. El modelo de datos de la proyección debe incluir, por comando, un **estado de ciclo de
   vida legible**: `recibido → aplicado / rechazado / expirado`. Permite renderizar al operador el
   historial de sus propias acciones y su resultado.
3. **Mecanismo de refresco (observabilidad casi en tiempo real).** La app operadora es
   fundamentalmente una pantalla de monitoreo (olas, cola, allowlist, bloqueados, métricas). El diseño
   debe definir el **mecanismo de refresco** de la proyección: **polling con intervalo vs push/websocket**.
   Una proyección que se actualiza cada varios minutos genera UX de datos rancios. (Recomendación:
   evaluar polling corto para MVP, push para v2.)
4. **Resiliencia offline / degradada.** Un celular pierde conectividad. La app debe degradar con
   gracia: **último estado conocido cacheado + indicador de "desactualizado"**, nunca pantalla en
   blanco ni error crudo. El modelo de acceso elegido (proyección leíble/cacheable) **no cierra esta
   puerta**: la última proyección se puede cachear localmente.
5. **Consistencia con el sistema visual Intrale.** Cuando Ola 9 llegue a implementación, la app
   operadora debe usar el **stack único Kotlin + Compose Multiplatform + Material3** y el tema Intrale
   (`ui/th/`), **NO un dashboard HTML/CSS pelado**. Queda anotado para que la futura app nazca dentro
   del sistema de diseño del producto.

---

## 10. Trazabilidad de criterios de aceptación

| CA | Criterio | Sección |
|---|---|---|
| **CA-1** | Fuente de datos recomendada + justificación + alternativas descartadas | §3 |
| **CA-2** | Modelo de acceso remoto + autenticación móvil (Cognito/JWT, descarte directo) | §4 |
| **CA-3** | Plan de migración por fases sin downtime (unidireccional FS→remoto) | §5 |
| **CA-4** | Separación kernel operativo vs estado de producto (anclada a #4010) | §6 |
| **CA-5** | Inventario de componentes (wrapper, Pulpo, Dashboard, SecuredFunction) | §7 |
| **CA-6** | Clasificación C1/C3/C2 vs "¿lo opera la app móvil?" | §2 |
| **CA-7** | Anclaje a #3898 (cita textual + resolver solo la delta) | §1 |
| **CA-8** | Checklist security vinculante cubierto (A01/A02/A03/A05/A07/A08 + secretos + audit) | §8 |
| **CA-9** | 5 guidelines UX para Ola 9 | §9 |
| **CA-10** | Higiene del diff (solo este `.md` nuevo, sin tocar docs referenciados) | Verificado en PR |

---

## Riesgos y mitigaciones (resumen)

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Latencia del store remoto en el hot path de intake | **Alto** | NO externalizar el hot path: FS autoritativo, remoto es proyección async (§4). **El error a evitar.** |
| Doble fuente de verdad / desync (ya hay detector `waves.json ↔ .partial-pause.json` en `pulpo.js`) | Medio | Write-through **unidireccional** FS→remoto; comando→FS; **nunca bidireccional simétrico** (§5). |
| Credenciales AWS en runtime Node (no hay SDK ni `package.json` en `.pipeline/`) | Medio | Proyección delegada a la API Ktor por HTTP local (§7). |
| Externalizar C2 efímero (superficie de ataque sin beneficio) | Medio | La clasificación C1/C3/C2 justifica que C2 **no sale** de la máquina (§2, security A05). |
| Re-litigar #3898 desde cero (desperdicio + contradicción) | Bajo | Partir del doc existente y resolver solo la delta móvil (§1). |
| Concurrencia de comandos del operador | Medio | Conditional writes de DynamoDB + audit trail (§3, §8; security A08). |

---

## Referencias

- [`docs/pipeline/persistencia-data-operativa-analisis.md`](persistencia-data-operativa-analisis.md) — spike #3898, prior art (clasificación C1/C3/C2, descarte remoto). **No se modifica.**
- [`docs/pipeline/contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) — EP-OLA8-B #4010, frontera kernel↔producto. **No se modifica.**
- Issue #4398 — este spike. Comments vinculantes de `security`, `guru`, `ux` y `po`.
- Convención de secretos: `.pipeline/lib/credentials.js` (#3311), `~/.claude/secrets/credentials.json`.
