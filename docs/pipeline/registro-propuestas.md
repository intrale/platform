# Registro único de propuestas al operador

> Historia madre #6807. Parte 1 (#7514): clave `propuestas` en el sustrato. **Parte 2 (#7515, este
> documento): contrato + publicación.** Parte 3 (#7516): decisión del operador (`decidir()`).

## Qué es

Un solo lugar donde **todos los productores de sugerencias del pipeline** publican, con **un solo
contrato**, para que el operador reciba un único canal con un único formato. El registro **guarda y
deduplica**; no prioriza, no entrega, no habla con el operador. Los motores de entrega (#5528, #6810)
lo leen como única fuente.

| Pieza | Path |
|---|---|
| Contrato (JSON Schema draft-07, `additionalProperties:false`) | `.pipeline/contracts/propuesta.schema.json` |
| Módulo | `.pipeline/lib/propuestas-registry.js` |
| Tests | `.pipeline/lib/__tests__/propuestas-registry.test.js` |
| Estado (modo FS) | `.pipeline/.propuestas.json` (gitignored; clave `propuestas` del estado operativo) |
| Config | `config.yaml` → `propuestas:` (`cuota_diaria_por_productor`, `max_vivas`, `autores_permitidos`) |

## API pública (parte 2)

```js
const registro = require('.pipeline/lib/propuestas-registry');

registro.publicar(payload, ctx)        // → { ok:true, id, item } | { ok:true, duplicada:true, id, item } | { ok:false, motivo, detalle }
registro.listarPendientes(filtro)      // → { ok:true, items } | { ok:false, motivo }
registro.claveDedup(payloadCanonico, productor)   // → id (sha256 hex, 24 chars)
// Puras para tests de contrato: canonicalizar(), forzarSensible(), textosDe()
// Enums: PRODUCTORES, TIPOS, ESTADOS, MOTIVOS_RECHAZO; constante CAMPOS_HASH.
// Previstos para la parte 3 (vacíos): DECISIONES, CANALES.
```

### `ctx`

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

## Forma persistida (ítem único bajo la clave `propuestas`)

```json
{
  "meta":    { "schema_version": 1, "updated_at": "<ISO>" },
  "vivas":   [ { "id", "productor", "titulo", "tipo", "accion", "evidencia": {…}, "beneficio",
                 "costo": {…}, "riesgo": {…}, "sensible", "agente?", "issue_origen?", "categoria?",
                 "referencia?", "estado": "pendiente", "creada_en" } ],
  "memoria": [ { "id", "clave_dedup", "estado_final", "decidido_en", "productor", "creada_en" } ]
}
```

`memoria` la escribe la parte 3. Lleva `productor` y `creada_en` (CA-PO-3) para que la cuota diaria
sea contable aunque se decida rápido. `meta.updated_at` se sella en cada `escribir()`: es la versión
que `isoVersionOf` devuelve en modo FS y la que el CAS durable compara.

## Garantías del sustrato

- **Modo FS (vigente):** `writeKey` no hace CAS, no valida ni redacta (SEC-J). Por eso el ciclo
  `leer → evaluar → escribir` corre entero dentro de `withLockSync(backend.fileFor(KEYS.PROPUESTAS))`,
  y el registro llama `validateRemoteValue` y redacta **antes** de escribir, en ambos modos.
- **Modo durable:** el CAS por `expectedVersion` excluye entre hosts; el registro reintenta hasta 3
  veces releyendo y re-evaluando dedup/memoria/cuota/tope.
- **Fail-soft:** store ilegible ⇒ `listarPendientes()` devuelve `{ok:false, motivo:'store_degradado'}`
  sin throw y `publicar()` no escribe. La alerta la emite `backend.setDegradationSink` (ya existe); el
  registro no agrega un emisor propio.
- **Nunca se siembra:** sin registro, `leer()` devuelve la forma vacía en memoria;
  `existsKey('propuestas')` sigue `false` hasta la primera publicación válida.
- **Agnóstico de canal:** cero `gh`, cero red, cero Telegram, cero tokens de presentación en el
  schema ni en las entradas. Cómo se muestra una propuesta lo decide cada canal a partir de los enums.

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
