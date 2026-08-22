# Ejecutor `provisioner_infra` (Ola Puente · H2 · #4718)

> **Historia:** #4718 — Implementar ejecutor genérico para provisionar recursos (caso base de datos).
> **Parent:** #4716 (Abstracción de tareas genéricas) · **Depende de:** #4717 (contrato H1).
> **Implementación:** [`.pipeline/lib/provisioner-infra.js`](../../.pipeline/lib/provisioner-infra.js)
> + tests en `.pipeline/lib/__tests__/provisioner-infra.test.js`.

Este documento describe el **primer ejecutor de tipo distinto a `codigo`** del pipeline: el
`provisioner_infra`, que materializa el modelo del
[contrato de tarea genérico](contrato-tarea-generico.md) para el `tipo_entregable:
recurso_provisionado` (§2.1 del contrato). El caso base es **crear una tabla DynamoDB**.

## Qué hace

Dado un contrato con `tipo_entregable = recurso_provisionado`, el ejecutor:

1. **Provisiona** el recurso descripto (una tabla con el schema pedido).
2. **Genera evidencia** `describe_table_round_trip` (contrato §2.3):
   - el `describe-table` del recurso (prueba que existe con el schema pedido), y
   - un **smoke test de round-trip**: escribe un ítem → lo lee y verifica → lo borra → confirma
     que ya no está. Prueba que el recurso *responde*, no sólo que existe.

El resultado sigue la convención de puerto del
[contrato kernel↔adaptador](contrato-kernel-adaptador.md) §3: `status` (`ok|failed|skipped`),
`artifacts[]`, `diagnostics[]`. Los errores se modelan como **datos** (`status: failed` +
`diagnostics`), nunca como excepciones que crucen la frontera.

## Forma del contrato que consume

El contrato genérico H1 define los cuatro campos mínimos; H2 concreta la sub-sección `recurso`
que el provisioner lee:

```yaml
contrato_tarea:
  version: "0.1.0"
  tipo_entregable: recurso_provisionado
  definicion_de_listo:
    - "La tabla existe con el schema pedido y responde a un round-trip"
  evidencia_requerida:
    tipo: describe_table_round_trip
    detalle: "describe-table + escribo/leo/borro un ítem"
  ejecutor:
    tipo: provisioner_infra          # opcional: se deriva de tipo_entregable si falta
  recurso:                           # <-- sub-sección que consume H2
    tipo: dynamodb_table             # único tipo soportado en el caso base
    nombre: MiTabla                  # 3–255 chars de [A-Za-z0-9_.-]
    schema:
      hashKey:  { nombre: pk, tipo: S }   # tipo ∈ { S, N, B }
      rangeKey: { nombre: sk, tipo: S }   # opcional
```

## Retrocompatibilidad (CA-3)

El registro de ejecutores es **aditivo**: agrega `provisioner_infra` **sin tocar** el camino de
los ejecutores de código.

- `resolveExecutorType(contract)` devuelve `dev_codigo` para cualquier contrato **ausente**,
  vacío o con `tipo_entregable: codigo` — exactamente el lifecycle cableado de hoy
  (rama → diff → build → QA → PR).
- Sólo `tipo_entregable: recurso_provisionado` (o un `ejecutor.tipo` explícito) enruta al nuevo
  ejecutor.
- El handler de `dev_codigo` es un **passthrough declarado** (`status: skipped`,
  `handledByCodeLifecycle: true`): existe para completar el catálogo, no ejecuta lógica nueva.

El wiring de las **fases** para leer el contrato (parsers, cambios en el Pulpo) es **H3 (#4719)**;
este módulo entrega el ejecutor y su registro, listos para que H3 los enchufe.

## Drivers (Ports & Adapters)

El corazón es un `ResourceDriver` port (`createTable` / `describeTable` / `putItem` / `getItem` /
`deleteItem`). Dos adapters:

| Driver | Uso | Detalle |
|--------|-----|---------|
| `createInMemoryDynamoDriver()` | tests, smoke offline | determinístico, sin red. |
| `createAwsCliDynamoDriver({ run })` | real | delega en `aws dynamodb …` vía un runner `run(args)` inyectable. `run` usa `spawn` con **args** (nunca shell string ⇒ sin inyección de comandos). |

Los nombres de tabla/atributo se validan contra una allowlist de caracteres antes de usarse, así
que ningún dato crudo del issue se interpola en la CLI.
