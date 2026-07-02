# Contrato: API de gestión de olas (waves-api)

> Contrato **estable y agnóstico** para gestionar el roadmap de olas desde una
> aplicación operadora. Expone **recursos lógicos** (`wave`, `issue-association`,
> `priority/order`, `roadmap-status`) — nunca estructura interna del pipeline.
> Cualquier cliente (UI operadora, CLI, script) puede construirse sobre esta
> superficie sin conocer detalles de implementación ni rutas internas.
>
> Issue: **#4372** (Ola 8.3). La implementación de referencia vive en el servidor
> del pipeline (módulo `waves-api`) sobre el dominio transaccional de olas.

## Versión del contrato

- **v1** — recursos: `wave`, `issue-association`, `priority/order`, `roadmap-status`.

## Modelo de recursos

### `wave`
Una ola del roadmap. Campos display-ready (listos para renderizar, sin derivación
en el cliente — UX-1):

| Campo             | Tipo                         | Descripción                                   |
|-------------------|------------------------------|-----------------------------------------------|
| `number`          | integer > 0                  | Identificador estable de la ola.              |
| `name`            | string \| null               | Nombre humano.                                |
| `goal`            | string \| null               | Objetivo de la ola.                           |
| `state`           | enum `planned\|active\|done` | Estado explícito (nunca flags sueltos).       |
| `window_minutes`  | integer \| null              | Ventana de ejecución en minutos.              |
| `concurrency_max` | integer \| null              | Máximo de agentes concurrentes.               |
| `issue_count`     | integer                      | Cantidad de issues asociados.                 |
| `issues`          | array de `issue-association` | Issues asociados.                             |

### `issue-association`
| Campo    | Tipo        | Descripción                              |
|----------|-------------|------------------------------------------|
| `number` | integer > 0 | Número del issue.                        |
| `status` | string      | Estado del issue dentro de la ola.       |

### `roadmap-status`
| Campo       | Tipo               | Descripción                                        |
|-------------|--------------------|----------------------------------------------------|
| `horizon`   | array de `wave`    | Ola activa + próximas planificadas.                |
| `allowlist` | array de integer   | Issues vigentes (habilitados) de la ola activa.    |

## Versionado optimista (ETag / If-Match)

Toda respuesta de **lectura** incluye el campo `version` (string) y el header
`ETag: "<version>"`. Representa la versión actual del estado.

Las **mutaciones sobre recursos existentes** (editar ola, asociar/quitar issue,
reordenar) **exigen** el header `If-Match: <version>`:

- Sin `If-Match` → **`428 Precondition Required`**.
- `If-Match` no coincide con la versión vigente → **`409 Conflict`**, devolviendo
  la `version` actual en el cuerpo (para un flujo *"el estado cambió — refrescá y
  reintentá"*, UX-3). No se escribe nada.

> La **creación** de una ola (`POST /waves`) NO requiere `If-Match`: es un recurso
> nuevo, no hay lost-update posible. Su seguridad frente a reintentos se cubre con
> el nombre único + `Idempotency-Key`.

## Idempotencia

Las mutaciones aceptan el header **`Idempotency-Key: <opaco>`**. Un reintento con
la misma key dentro de la ventana de retención devuelve el resultado original sin
volver a aplicar el efecto. Además, asociar/quitar un issue es idempotente por
naturaleza (semántica de conjunto): asociar uno ya asociado o quitar uno ausente
retorna un resultado consistente (no error).

## Autenticación y autorización

- **Lecturas**: rol lectura (menor privilegio).
- **Mutaciones**: rol **operador**.
  - Sin credencial → **`401 Unauthorized`**.
  - Con credencial pero sin rol operador / credencial inválida → **`403 Forbidden`**.

> **Nota de implementación de referencia (Node).** El servidor del pipeline no
> tiene Cognito hoy. La credencial de operador se modela con el **token CSRF** del
> dashboard (double-submit: header `X-CSRF-Token` + cookie), emitido por
> `GET /api/kill-agent/csrf-token`. Las mutaciones se aceptan sólo desde
> `localhost` (loopback) y con `Sec-Fetch-Site: same-origin` (defensa CSRF).
> **Si el contrato migra al backend Ktor**, la autenticación pasa a `SecuredFunction`
> (JWT vía Cognito) + roles, sin cambiar la forma del contrato.

## Rate limiting

Los endpoints de mutación aplican rate limiting. Al exceder el límite →
**`429 Too Many Requests`** (con header `Retry-After`).

## Formato de errores

Todo error devuelve un cuerpo estructurado y presentable (UX-2):

```json
{ "code": "invalid_input", "message": "Mensaje en español", "field": "name" }
```

- `message` está en español y es apto para mostrarse tal cual en un UI.
- `field` (opcional) indica el campo culpable en errores de validación `400`.
- Nunca se filtran stack traces, rutas internas ni datos sensibles.

| `code`                  | HTTP | Significado                                             |
|-------------------------|------|--------------------------------------------------------|
| `invalid_input`         | 400  | Datos inválidos (ver `field`).                         |
| `out_of_bounds`         | 400  | Valor fuera de rango permitido (ver `field`).          |
| `invalid_id`            | 400  | Identificador de recurso no numérico.                  |
| `unauthorized`          | 401  | Falta credencial de operador.                          |
| `forbidden`             | 403  | Credencial inválida / sin rol / origen no permitido.   |
| `not_found`             | 404  | La ola/recurso no existe.                              |
| `method_not_allowed`    | 405  | Método no soportado para el recurso.                   |
| `version_conflict`      | 409  | `If-Match` desactualizado (trae `version` vigente).    |
| `duplicate_name`        | 409  | Ya existe una ola con ese nombre.                      |
| `duplicate_issue`       | 409  | El issue ya está asociado a otra ola.                  |
| `unsupported_media_type`| 415  | `Content-Type` distinto de `application/json`.         |
| `precondition_required` | 428  | Falta el header `If-Match`.                            |
| `payload_too_large`     | 413  | Cuerpo del pedido demasiado grande.                    |
| `rate_limited`          | 429  | Se excedió el límite de operaciones.                   |
| `module_unavailable`    | 503  | Dependencia del servidor no disponible.                |
| `internal_error`        | 500  | Error interno.                                         |

## Endpoints

### Lecturas (rol lectura)

#### `GET /api/waves`
Lista el roadmap completo (activa + planificadas + archivadas).

```json
// 200 OK  ·  ETag: "2026-07-02T05:10:00.000Z"
{
  "version": "2026-07-02T05:10:00.000Z",
  "waves": [
    { "number": 8, "name": "Ola 8.3", "goal": "API operadora", "state": "planned",
      "window_minutes": 60, "concurrency_max": 3, "issue_count": 2,
      "issues": [ { "number": 4372, "status": "pending" }, { "number": 4381, "status": "pending" } ] }
  ]
}
```

#### `GET /api/waves/{n}`
Detalle de una ola con sus issues. `404 not_found` si no existe.

#### `GET /api/waves/active`
Ola activa, o estado explícito si no hay ninguna (nunca `500`):

```json
// 200 OK
{ "version": "...", "active": null }
```

#### `GET /api/roadmap/status`
Estado agregado del roadmap:

```json
// 200 OK
{ "version": "...", "horizon": [ /* waves */ ], "allowlist": [4372, 4381] }
```

### Mutaciones (rol operador)

#### `POST /api/waves`
Crea una ola planificada. **No** requiere `If-Match`.

```json
// Request  ·  Content-Type: application/json
{ "name": "Ola 8.4", "goal": "…", "issues": [4400, 4401], "concurrency_max": 3, "window_minutes": 60 }
// 201 Created
{ "version": "…", "wave": { "number": 9, "name": "Ola 8.4", "state": "planned", "...": "..." } }
```

Validaciones: `name` (1..80 chars), `issues` (array no vacío de enteros>0 únicos),
`concurrency_max` (1..techo de config), `window_minutes` (5..1440).

#### `PATCH /api/waves/{n}`
Edita metadata de una ola **planificada** (`name`, `goal`, `window_minutes`,
`concurrency_max`). Requiere `If-Match`.

```json
// Request  ·  If-Match: "<version>"
{ "window_minutes": 90 }
// 200 OK
{ "version": "<nueva>", "wave": { "number": 9, "window_minutes": 90, "...": "..." } }
```

#### `POST /api/waves/{n}/issues`
Asocia un issue a la ola. Requiere `If-Match`. Idempotente.

```json
// Request
{ "issue": 4402 }
// 200 OK
{ "version": "<nueva>", "wave": 9, "issue": 4402, "added": true }
```

#### `DELETE /api/waves/{n}/issues/{issue}`
Quita un issue de la ola. Requiere `If-Match`. Idempotente (quitar uno ausente →
`removed: false`, `200`). Sin cuerpo.

```json
// 200 OK
{ "version": "<nueva>", "wave": 9, "issue": 4402, "removed": true }
```

#### `PUT /api/waves/{n}/order`
Reordena las prioridades de los issues **dentro de la ola**. Requiere `If-Match`.
Devuelve el orden resultante (UX-4). Rechaza (`400`) cualquier id no numérico o
que no pertenezca a la ola (A03).

```json
// Request
{ "order": [4402, 4400, 4401] }
// 200 OK
{ "version": "…", "wave": 9, "order": [4402, 4400, 4401] }
```

## Auditoría

Cada mutación deja una entrada de auditoría encadenada (hash-chain) verificable —
quién, qué, cuándo — como corresponde a un plano de control operativo (A09).

## Seguridad — resumen de invariantes

- **A01** — ninguna mutación es anónima; lecturas con menor privilegio.
- **A03** — el contrato expone SOLO enteros (número de ola, id de issue). Se
  valida `^\d+$` y se rechaza cualquier campo que sea path/nombre de archivo. El
  input del cliente **nunca** se traduce a rutas internas.
- **A04** — concurrencia optimista (`If-Match`/ETag) + escritura serializada y
  atómica evitan lost-updates y corrupción.
- **A05** — las respuestas no filtran paths, tokens, credenciales ni motivos
  internos.
- **A09** — auditoría encadenada de toda mutación.

## Alcance

- Fuera de scope de v1: promoción de olas (`promote`) y transiciones de estado se
  gestionan por los canales operativos existentes; podrán sumarse al contrato en
  una versión futura sin romper compatibilidad.
- La app operadora que consuma este contrato es un desarrollo futuro (fuera del
  alcance de #4372). Este contrato la **habilita** exponiendo estados explícitos y
  errores presentables.
