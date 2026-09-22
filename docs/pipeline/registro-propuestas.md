# Registro único de propuestas al operador

> Historia madre #6807. Parte 1 (#7514): clave `propuestas` en el sustrato. Parte 2 (#7515): contrato +
> publicación. **Parte 3 (#7516): decisión del operador (`decidir()`) + log encadenado de decisiones.**
> Con la parte 3 el registro queda cerrado: este documento es el contrato completo para sus
> consumidores (#5528, #6810, #7361).

## Qué es

Un solo lugar donde **todos los productores de sugerencias del pipeline** publican, con **un solo
contrato**, para que el operador reciba un único canal con un único formato. El registro **guarda,
deduplica y registra la decisión**; no prioriza, no entrega, no habla con el operador y **no autentica
a nadie**. Los motores de entrega (#5528, #6810) lo leen como única fuente.

| Pieza | Path |
|---|---|
| Contrato (JSON Schema draft-07, `additionalProperties:false`) | `.pipeline/contracts/propuesta.schema.json` |
| Módulo | `.pipeline/lib/propuestas-registry.js` |
| Tests | `.pipeline/lib/__tests__/propuestas-registry.test.js` |
| Estado (modo FS) | `.pipeline/.propuestas.json` (gitignored; clave `propuestas` del estado operativo) |
| Log de decisiones | `<stateDir>/audit/propuestas-decisiones.jsonl` (gitignored por `.gitignore:398` → `.pipeline/audit/`) |
| Config | `config.yaml` → `propuestas:` (`cuota_diaria_por_productor`, `max_vivas`, `autores_permitidos`) |

## API pública

```js
const registro = require('.pipeline/lib/propuestas-registry');

// Parte 2 — publicación
registro.publicar(payload, ctx)        // → { ok:true, id, item } | { ok:true, duplicada:true, id, item } | { ok:false, motivo, detalle }
registro.listarPendientes(filtro)      // → { ok:true, items } | { ok:false, motivo }
registro.claveDedup(payloadCanonico, productor)   // → id (sha256 hex, 24 chars)

// Parte 3 — decisión
registro.decidir({ id, decision, authorizedBy, canal, agregado })
registro.verificarCadenaDecisiones()   // → { ok, entriesChecked, motivo, brokenAt?, reason? }
registro.logDecisiones()               // → path del JSONL (FUNCIÓN: depende del entorno del proceso)

// Puras para tests de contrato: canonicalizar(), forzarSensible(), textosDe()
// Enums: PRODUCTORES, TIPOS, ESTADOS, DECISIONES, CANALES, AUTHORIZED_BY, MOTIVOS_RECHAZO
// Constantes: CAMPOS_HASH, ESTADO_FINAL_DE
```

**Ninguna de las dos superficies tira.** Todas devuelven `{ok:true, …}` o `{ok:false, motivo, detalle}`,
incluso con el sustrato caído, el lock tomado o el log inaccesible.

### `ctx` (sólo `publicar`)

| Campo | Quién lo pone | Para qué |
|---|---|---|
| `productor` | el módulo integrador (crons) — si falta, `process.env.PIPELINE_SKILL` | identidad del productor, **enum cerrado** `PRODUCTORES`. Nunca sale del payload (S2). |
| `procedencia` | el cosechador de comentarios (#7361) | `{ author, authorAssociation }` del comentario de origen. Sólo la exige `recomendacion-agente`. **Nunca se toma del payload** (SEC-7515-1) ni se persiste. |
| `config` | tests / inyección por firma | cortocircuita la lectura de `config.yaml`. |
| `ahora` | tests | ISO fijo para `creada_en`. |

### Contrato del payload

Obligatorios: `titulo` (12–90, una línea, sin `*`/`_`/URL/emoji/controles — presentación, **fuera del
hash**), `tipo` (`mejora-de-proceso | cambio-de-configuracion | correccion | riesgo | ticket-nuevo`),
`accion`, `evidencia {tipo, referencia, resumen}`, `beneficio` (≤300), `costo` y `riesgo`
(`{nivel: bajo|medio|alto, detalle? ≤300}`), `sensible`. Opcionales: `agente`, `issue_origen`,
`categoria`, `referencia`.

**No** se declaran (caen por `additionalProperties:false`): `productor`, `id`, `estado`, `clave_dedup`,
`creada_en`, `procedencia`. Los pone el registro o viajan por `ctx`.

### Qué pone el productor y qué pone el registro

| Campo | Lo pone |
|---|---|
| `titulo`, `tipo`, `accion`, `evidencia`, `beneficio`, `costo`, `riesgo`, `sensible`, opcionales | el **productor**, en el payload |
| `productor` | el **registro**, desde `ctx.productor` / `PIPELINE_SKILL` (S2) |
| `id`, `clave_dedup` | el **registro**, derivados por hash de `CAMPOS_HASH` (S3) |
| `estado`, `creada_en` | el **registro**, en `publicar()` |
| `sensible` forzado a `true` | el **registro**, cuando `tipo=riesgo` o (`recomendacion-agente` ∧ `agente=security`). **Nunca lo rebaja** (S5) |
| `estado_final`, `decidido_en` | el **registro**, en `decidir()` |

## Pipeline de `publicar()` — cada paso corta sin escribir

| # | Paso | Motivo de rechazo |
|---|---|---|
| 0 | Payload es objeto; crudo ≤ 64 KB **antes de cualquier regex** (SEC-7515-4); ninguna clave `__proto__` / `constructor` / `prototype` en ningún nivel (SEC-7515-V1: una clave propia `__proto__` cambiaría el prototipo de la copia canónica y Ajv daría `required` por cumplido con campos heredados) | `schema_invalido` (`payload_excesivo` · `clave_prohibida`) |
| 1 | `productor` desde `ctx`/`PIPELINE_SKILL` ∈ `PRODUCTORES`; `payload.productor` distinto; `payload.procedencia` presente | `productor_desconocido` · `productor_no_coincide` · `procedencia_invalida` |
| 2 | `canonicalizar()` (NFKC, strip `\p{Cf}`/controles, espacios colapsados) y `detectInjection` sobre todos los strings (dos variantes de Cf: eliminado y como espacio) | `inyeccion_detectada` (se loguea sólo el patrón) |
| 3 | `evidencia` ausente o string; Ajv (`allErrors`, `strict:true`, `ownProperties:true`, sin `verbose`) | `evidencia_requerida` · `schema_invalido` (campo + regla; un **nombre de clave** del payload sólo se cita si cumple `^[a-z0-9_.-]{1,64}$`, si no sale `(clave no admitida)`; el `detalle` se acota a 256 chars — SEC-7515-V2) |
| 4 | `redactObject` (secretos, emails, URLs) y **recién después** caps: ≤2048 bytes por string, ≤8192 el payload | `schema_invalido` |
| 5 | `forzarSensible()`: `tipo=riesgo` o (`recomendacion-agente` ∧ `agente=security`) ⇒ `sensible=true`; corrige y loguea | — |
| 6 | Sólo `recomendacion-agente`: `ctx.procedencia.authorAssociation ∈ {OWNER, MEMBER}` y autor ∈ `propuestas.autores_permitidos` | `procedencia_invalida` |
| 7 | `id = claveDedup(payload redactado, productor)` | — |
| 8 | Bajo `withLockSync`: `id` en `vivas` ⇒ `{duplicada:true}`; en `memoria` ⇒ `rechazada_previamente` / `ya_decidida` | (no es rechazo nuevo) |
| 9 | Cuota diaria por productor (día UTC, `vivas`+`memoria`); tope de vivas | `cuota_excedida` · `registro_lleno` |
| 10 | Push `{…, estado:'pendiente', creada_en}` → `validateRemoteValue` → `writeKey` (retry por `conflict` ≤3, releyendo) | `escritura_rechazada` · `store_degradado` |

### Hash / dedup (`CAMPOS_HASH`)

`sha256(canonicalJson({ productor, tipo, accion normalizada, evidencia.tipo, evidencia.referencia }))`
truncado a 24 hex. `accion normalizada` = canonicalizada + lowercase + espacios colapsados. **Excluye**
`titulo`, `evidencia.resumen`, `beneficio`, `costo`, `riesgo`, timestamps. Se calcula sobre el payload
**ya redactado** (SEC-7515-7): republicar el mismo payload da el mismo id y un secreto en `accion` no
participa. Un ZWSP o un homoglifo compatible no cambian el id (SEC-7515-2).

## API de decisión (parte 3)

```js
registro.decidir({
  id,            // 24 hex — el que devolvió publicar() o el que trae listarPendientes()
  decision,      // 'aceptar' | 'aceptar-con-agregado' | 'rechazar'
  authorizedBy,  // 'operador:telegram' | 'operador:dashboard' | 'operador:cli'
  canal,         // 'telegram' | 'dashboard' | 'cli' — debe coincidir con el sufijo de authorizedBy
  agregado,      // texto libre (≤2048 bytes). OBLIGATORIO si decision === 'aceptar-con-agregado'; opcional en el resto
});
// ok   → { ok:true, id, estado_final, decidido_en, sensible, agregado, hash_self }
// fail → { ok:false, motivo, detalle, … }
```

`decidir()` es la **única** superficie que escribe `estado_final` y mueve una propuesta de `vivas` a
`memoria`. `publicar()` no puede hacerlo: `estado` no está declarado en el schema y un payload con
`estado:'aceptada'` cae por `additionalProperties` con `schema_invalido`.

### `authorizedBy` es autodeclarado — el registro NO autentica

> **Autenticar al operador es obligación del caller.** `AUTHORIZED_BY` es un enum cerrado de
> **identidades**, no de roles del pipeline, y el registro lo acepta tal como se lo declaran. Cualquier
> módulo in-process puede firmar una decisión como `operador:telegram`. El gate real vive aguas arriba,
> igual que en `partial-pause-audit.js` (donde el gate es `requireAuthorization()`): #6810 debe validar
> la identidad del canal antes de llamar a `decidir()` — identidad del remitente para
> `operador:telegram`, sesión autenticada para `operador:dashboard`.

Lo que el registro **sí** garantiza es que cada entry del log lleve un bloque `actor_proceso`
(`pid`, `projectId`, `skill`) que el caller **no puede falsificar**: sale del proceso y del contexto,
nunca de un argumento (SEC-7516-4). Si alguien firma `operador:telegram` desde un skill, el log lo
muestra.

### Vocabulario: decisión (verbo) vs estado (sustantivo)

| `decision` | `estado_final` persistido | Equivalente en el body original de #6807 |
|---|---|---|
| `aceptar` | `aceptada` | `aceptada tal cual` |
| `aceptar-con-agregado` | `aceptada-con-agregado` | `aceptada con modificacion` |
| `rechazar` | `rechazada` | `rechazada` |

El vocabulario vigente es el de **D4 del PO** (`pendiente | aceptada | aceptada-con-agregado |
rechazada`); el del body original de #6807 es su sinónimo histórico y **no** aparece en el código.
**No existe `postergar` / `postergada`** (ajuste del operador, 01/09/2026): no decidir deja la
propuesta en `pendiente`, que ya es toda la información que aportaba postergar.

## Pipeline de `decidir()` — orden estricto

El orden importa y es parte del contrato: **el log va antes que el store**. Una decisión que el store
no llegó a aplicar queda registrada; una que el log no registró no se aplica.

| # | Paso | Motivo de rechazo |
|---|---|---|
| a0 | Argumento es objeto; ninguna clave `__proto__`/`constructor`/`prototype`; sólo las claves `id`, `decision`, `authorizedBy`, `canal`, `agregado` | `schema_invalido` |
| a1 | `id` con forma `^[0-9a-f]{24}$` (SEC-7516-5); `decision` ∈ `DECISIONES`; `authorizedBy` ∈ `AUTHORIZED_BY`; `canal` ∈ `CANALES`; `canal` coherente con el sufijo de `authorizedBy`; `agregado` es texto; `aceptar-con-agregado` sin `agregado` | `id_invalido` · `decision_invalida` · `authorized_by_invalido` · `canal_invalido` · `agregado_requerido` · `schema_invalido` |
| a2 | `agregado`: canonicalizar → `detectInjection` (dos variantes de Cf) → cap de 2048 bytes → `redactObject` | `inyeccion_detectada` · `schema_invalido` |
| b0 | **Bajo `withLockSync(propuestas)`**: precondición contra el estado REAL — `id` ∈ `vivas`, `id` ∉ `memoria` | `propuesta_inexistente` · `ya_decidida` · `store_degradado` |
| b | `auditLog.appendChained({ file: logDecisiones(), entry })`. Es fail-closed: si no toma su lock, tira; se captura y se traduce | `store_degradado` |
| c | Mover de `vivas` a `memoria` con `escribir(nuevo, version)`, re-validando la precondición en cada reintento (≤3) | `decision_no_aplicada` · `ya_decidida` |

**Sobre el reintento de (c)**: el CA original decía "reintentar sólo (c)". Correcto, pero el reintento
**re-valida la precondición**, no re-aplica a ciegas: al releer, otro proceso pudo haber movido el mismo
`id` a `memoria`, y aplicar la mutación duplicaría la entrada o pisaría el `estado_final` del ganador.
Si eso pasa, se aborta **sin re-appendear la decisión** y se appendea una entry de compensación.

**Decisión registrada pero no aplicada.** Cuando (b) salió bien y (c) no, el resultado es
distinguible: `{ ok:false, motivo, decision_registrada: true, hash_self }`. El caller sabe que la
intención del operador quedó en el log auditable aunque el estado no se movió, y puede reintentar sin
perder la trazabilidad.

**Orden de locks: siempre `propuestas` → log de decisiones, nunca al revés.** Ningún camino toma el
lock del JSONL primero. `withLockSync` libera en `finally`, así que un throw de `appendChained` no deja
colgado el lock del registro.

## Log encadenado de decisiones

`<stateDir>/audit/propuestas-decisiones.jsonl` — append-only con hash chain SHA-256 (`lib/audit-log.js`,
el mismo mecanismo de `partial-pause-audit.js`). El path se resuelve **en cada llamada**
(`logDecisiones()` es una función, no una constante de módulo): `stateDir()` depende del namespace de
proyecto y del entorno del proceso.

### Forma de una entry de decisión

```json
{
  "timestamp": "<ISO>",
  "seq": 1,
  "id": "<24 hex>",
  "decision": "rechazar",
  "estado_final": "rechazada",
  "authorized_by": "operador:telegram",
  "canal": "telegram",
  "actor_proceso": { "pid": 1234, "projectId": null, "skill": "commander-proactivo" },
  "agregado": null,
  "productor": "auditor-modelos",
  "sensible": false,
  "created_at": 1790094793292, "hash_prev": "GENESIS", "hash_self": "<sha256>"
}
```

Y la entry de compensación, cuando la decisión no se pudo aplicar:

```json
{ "timestamp": "<ISO>", "seq": 2, "tipo": "decision_no_aplicada",
  "ref_hash": "<hash_self de la decisión>", "motivo": "ya_decidida", "id": "<24 hex>", … }
```

### `verificarCadenaDecisiones()` no es un alias de `verifyChain`

El hash chain detecta **alteración** pero **no truncación por la cola**: al releer, la cadena re-ancla
desde la última línea sobreviviente y queda coherente con decisiones desaparecidas. Se cierra con dos
señales extra, **sin tocar `audit-log.js`**:

1. **`seq` contiguo desde 1** — cada entry (decisión o compensación) consume un número.
2. **Ancla cruzada** — `meta.ultimo_hash_decision` del store tiene que estar presente en el log.

| Resultado | Qué significa |
|---|---|
| `{ ok:true, entriesChecked:n, motivo:null }` | cadena íntegra y completa |
| `{ ok:false, motivo:'alterado', brokenAt, reason }` | una línea fue modificada (hash o `hash_prev` no cierra) |
| `{ ok:false, motivo:'truncado', reason }` | falta al menos una línea (hueco en `seq`, o el store ancla un hash ausente) |

### El secreto que entra al log es para siempre

El log es append-only encadenado: borrar una línea rompe la cadena de **todo lo posterior**. Por eso el
`agregado` se canonicaliza, se capea a 2048 bytes y **se redacta con `redactObject` antes del append**
(SEC-7516-1). Ni la línea del log ni el retorno de `decidir()` llevan nunca el valor crudo. Un
`agregado` con un patrón de inyección se rechaza antes de escribir nada, en las dos variantes de
canonicalización de caracteres de formato (SEC-7516-2).

El `agregado` **no** se persiste en `memoria`: vive en el log y viaja al caller por el retorno.

## Forma persistida (ítem único bajo la clave `propuestas`)

```json
{
  "meta":    { "schema_version": 1, "updated_at": "<ISO>", "ultimo_hash_decision": "<sha256|ausente>" },
  "vivas":   [ { "id", "productor", "titulo", "tipo", "accion", "evidencia": {…}, "beneficio",
                 "costo": {…}, "riesgo": {…}, "sensible", "agente?", "issue_origen?", "categoria?",
                 "referencia?", "estado": "pendiente", "creada_en" } ],
  "memoria": [ { "id", "clave_dedup", "estado_final", "decidido_en",
                 "productor", "creada_en", "sensible" } ]
}
```

`memoria` la escribe `decidir()`. El criterio es **"ningún campo del cuerpo sobrevive"**: desaparecen
`titulo`, `tipo`, `accion`, `evidencia`, `beneficio`, `costo`, `riesgo`, `agente`, `issue_origen`,
`categoria`, `referencia`, `estado` y el `agregado`. Los tres campos que **no** son cuerpo y sí quedan:

| Campo | Por qué queda |
|---|---|
| `productor` + `creada_en` | son de la **cuota**: `contarDelDia()` cuenta `vivas` + `memoria` por productor y día UTC. Sin ellos, decidir rápido resetearía la cuota diaria — el agujero que cerró SEC-7515-8. |
| `sensible` | es un bit de **política**, no contenido (SEC-7516-7). Sin él, una recomendación de `security` queda indistinguible en `memoria` y un consumidor podría materializarla en un issue de un repositorio público. |

`meta.updated_at` se sella en cada `escribir()`: es la versión que `isoVersionOf` devuelve en modo FS y
la que el CAS durable compara. `meta.ultimo_hash_decision` es el ancla cruzada store↔log.

## Motivos de rechazo

Todos viven en un solo enum exportado, `MOTIVOS_RECHAZO`. Los cuatro últimos de `publicar()` los
comparte `decidir()`.

### De `publicar()`

| Motivo | Significado |
|---|---|
| `productor_desconocido` | ni `ctx.productor` ni `PIPELINE_SKILL` pertenecen a `PRODUCTORES` |
| `productor_no_coincide` | el payload declara un `productor` distinto del contexto (S2) |
| `procedencia_invalida` | procedencia autodeclarada en el payload, o `recomendacion-agente` sin autor OWNER/MEMBER en la allowlist |
| `inyeccion_detectada` | un string del payload matchea un patrón de inyección |
| `evidencia_requerida` | falta `evidencia` o no es objeto: una propuesta sin hecho verificable no entra |
| `schema_invalido` | Ajv, caps de bytes, payload no serializable o clave prohibida |
| `rechazada_previamente` | la misma propuesta (mismo hash) ya fue rechazada por el operador: no reincide (S6) |
| `ya_decidida` | la misma propuesta ya fue aceptada (con o sin agregado) |
| `cuota_excedida` | el productor alcanzó `cuota_diaria_por_productor` en el día UTC |
| `registro_lleno` | `vivas` alcanzó `max_vivas` |
| `store_degradado` | el sustrato no se pudo leer, o el lock no se pudo tomar |
| `escritura_rechazada` | el write falló o el CAS no cerró tras 3 reintentos |

### De `decidir()`

| Motivo | Significado |
|---|---|
| `id_invalido` | el `id` no tiene forma `^[0-9a-f]{24}$` |
| `decision_invalida` | `decision` fuera de `DECISIONES` |
| `authorized_by_invalido` | `authorizedBy` fuera de `AUTHORIZED_BY` |
| `canal_invalido` | `canal` fuera de `CANALES`, o incoherente con el sufijo de `authorizedBy` |
| `agregado_requerido` | `aceptar-con-agregado` sin `agregado` |
| `propuesta_inexistente` | no hay ninguna propuesta viva con ese `id` |
| `decision_no_aplicada` | la decisión quedó en el log pero el store no la aceptó (viene con `decision_registrada:true`) |

## Garantías del registro

| Garantía | Qué asegura |
|---|---|
| **Persistencia** | el registro sobrevive a un reinicio: vive en la clave `propuestas` del estado operativo, nunca en memoria de proceso. |
| **Exclusión** | el ciclo `leer → evaluar → escribir` corre entero bajo `withLockSync(fileFor(PROPUESTAS))`, que excluye entre procesos del mismo host. |
| **CAS** | en modo durable el `expectedVersion` excluye entre hosts; se reintenta ≤3 veces releyendo y re-evaluando la precondición. Registro inexistente ⇒ `version: 0` (create-once, `attribute_not_exists`). |
| **Idempotencia** | republicar el mismo contenido devuelve `{duplicada:true}` con el mismo `id`; decidir dos veces el mismo `id` da `ya_decidida` sin escribir. |
| **Memoria de rechazos** | una propuesta rechazada no reincide: queda en `memoria` y toda republicación del mismo hash da `rechazada_previamente` (S6). |
| **Auditabilidad** | toda decisión queda en un log append-only encadenado, verificable contra alteración **y** contra truncación. |
| **Fail-soft** | store ilegible ⇒ `listarPendientes()` devuelve `{ok:false, motivo:'store_degradado'}` sin throw, y ni `publicar()` ni `decidir()` escriben. La alerta la emite `backend.setDegradationSink`. |
| **Nunca se siembra** | sin registro, `leer()` devuelve la forma vacía en memoria; `existsKey('propuestas')` sigue `false` hasta la primera publicación válida. |
| **Agnóstico de canal** | cero `gh`, cero red, cero shell, cero tokens de presentación en el schema, en el módulo, en las entradas persistidas ni en las líneas del log. |

### Modo FS vs modo durable

- **Modo FS (vigente):** `writeKey` no hace CAS, no valida ni redacta (SEC-J). Por eso el registro llama
  `validateRemoteValue` y redacta **antes** de escribir, en ambos modos, y el lock es el que da la
  exclusión.
- **Modo durable:** el CAS por `expectedVersion` excluye entre hosts. Cubierto por la sección "durable"
  de `propuestas-registry.test.js` con el driver fake de DynamoDB.

## Qué NO garantiza el registro

Esto es tan parte del contrato como lo de arriba. Un consumidor que asuma cualquiera de estos puntos
está construyendo sobre arena:

- **No autentica al operador.** `authorizedBy` es autodeclarado (ver arriba). El registro asume caller
  confiable.
- **No entrega.** No manda mensajes, no abre issues, no escribe en ningún canal. Quién y cómo se le
  muestra una propuesta al operador es decisión del motor de entrega.
- **No prioriza ni ordena por importancia.** `listarPendientes()` ordena por `creada_en` ascendente y
  nada más.
- **No expira propuestas vivas.** Una `pendiente` se queda ahí hasta que alguien la decida o hasta que
  `max_vivas` frene nuevas publicaciones.
- **No acota `memoria`.** `validateRemoteValue` cota `vivas` a 500 pero no `memoria`, y el value entero
  está capado en 256 KB. El horizonte de poda/rotación de `memoria` queda en **#7605**.
- **No deduplica entre productores distintos.** El `productor` entra al hash: la misma acción propuesta
  por dos productores son dos propuestas.
- **No versiona el contenido de una propuesta.** No hay edición: republicar con contenido distinto
  produce otro `id`.
- **No reconcilia el log con el store.** `verificarCadenaDecisiones()` **detecta** la divergencia; no la
  repara. Reparar es decisión humana.

## Cómo agregar un canal nuevo sin tocar el registro

El registro es agnóstico de canal por diseño, y el test CA-12 lo cementa: escanea el schema, el módulo
entero (comentarios incluidos), una entrada persistida y una línea del log contra un set de términos de
presentación, y falla si aparece alguno. Para sumar una superficie nueva:

1. **Agregá el valor al enum `CANALES`** y su identidad a `AUTHORIZED_BY` con la forma
   `operador:<canal>` — el chequeo de coherencia entre ambos es por el sufijo, así que la forma importa.
2. **No toques nada más del módulo.** Ni el schema, ni `publicar()`, ni la forma persistida.
3. **Escribí el adaptador afuera**, en su propio módulo: lee con `listarPendientes()`, renderiza como
   quiera esa superficie, y llama a `decidir()` con su `canal` y su `authorizedBy`.
4. **Autenticá al operador en el adaptador**, antes de llamar a `decidir()`. El registro no lo va a
   hacer por vos.
5. **Respetá `sensible`**: si el ítem lo trae en `true`, ese canal no puede ser público.

Todo lo que es presentación —formato, longitud máxima de un mensaje, controles interactivos, emojis—
vive en el adaptador. El registro sólo conoce valores.

## Obligaciones de los consumidores

### #5528 y #6810 — entrega y decisión

- **Contenido mínimo por canal privado para `sensible: true`:** sólo `titulo` + `id`. El cuerpo
  (`accion`, `evidencia`, `riesgo`, `beneficio`) **no sale** por un canal no privado. Si el canal no
  puede garantizar privacidad, la propuesta no se muestra: se referencia por `id`.
- **Autenticación antes de `decidir()`:** identidad del remitente para `operador:telegram`, sesión
  autenticada para `operador:dashboard`. Sin eso, `authorizedBy` no vale nada.
- **`decision_registrada: true` no es un error del operador:** significa que su decisión quedó
  auditada aunque el estado no se movió. El reintento es responsabilidad del caller y debe volver a
  llamar a `decidir()`, no inventar una mutación directa del store.
- **Nunca escribir el store a mano.** `publicar()` y `decidir()` son las dos únicas superficies.

### #7361 — cosecha de recomendaciones de agentes

- Publica con `productor: 'recomendacion-agente'` y **debe** pasar `ctx.procedencia` con el
  `author` / `authorAssociation` reales del comentario de origen. Sin allowlist configurada, nada entra
  (fail-closed).
- Proyecta las recomendaciones históricas a los campos opcionales del contrato:

  | Dato histórico | Campo del contrato |
  |---|---|
  | issue donde apareció la recomendación | `issue_origen` (entero ≥ 1) |
  | skill que la emitió | `agente` (`^[a-z0-9][a-z0-9-]*$`, ≤40) |
  | agrupación temática | `categoria` (≤60) |
  | link o referencia libre al origen | `referencia` (≤300) |

- Una recomendación de `security` sale siempre con `sensible: true`: el registro lo fuerza y `decidir()`
  lo conserva en `memoria`. El consumidor no puede rebajarlo.

## Config (`config.yaml`)

```yaml
propuestas:
  cuota_diaria_por_productor: 50   # ≥1
  max_vivas: 500                   # 1..500 (= MAX_PROPUESTAS_VIVAS del sustrato)
  autores_permitidos:              # lado AUTORIDAD (AUTHORITY_PREFIXES): nunca por entorno ni manifiesto
    - leitolarreta
```

Config ausente o ilegible ⇒ defaults 50/500 y allowlist **vacía** (fail-closed: ningún
`recomendacion-agente` entra sin allowlist).
