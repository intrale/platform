# Contrato — API de gestión del kernel multi-producto + proyección remota + buzón asíncrono

> Issue #4779 · Split de #4691 · Ola Puente (P6) — Superficie B de 3.
> Diseño base: `docs/pipeline/ola-puente-kernel-multiproducto.md` (§4.7/§9.4) y
> `docs/pipeline/externalizacion-estado-operativo-remoto.md` (#4398).
> **Alcance:** backend + contrato. **NO se construye la app** en esta ola (§9.4).

Este documento versiona el contrato que la futura app móvil operadora consumirá.
Todo el backend vive en Kotlin/Ktor (`backend/` + `users/`, paquete
`ar.com.intrale.kernel`). No se toca `app/composeApp`.

## 0. Nomenclatura (hallazgo guru #2)

- **`kernelProductId`** — identificador del *producto operativo / instancia del
  modelo* del kernel. Es el scope multi-tenant de esta superficie.
- **NO confundir** con `productId`, que en `BusinessProducts`/`ProductRepository`
  es el **SKU de catálogo ecommerce**. Semánticas distintas; nunca se reutiliza el
  nombre `productId` para el scope del kernel.
- Formato válido de `kernelProductId`: `^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$`.

## 1. Autenticación y autorización

- **Auth (SEC-3):** JWT vía Cognito, heredando `SecuredFunction`. Sin token o
  token inválido ⇒ **401** (cubierto por la clase base + `BackendRouteIntegrationTest`).
- **Authz por producto (SEC-1 / OWASP A01):** el scope se deriva **de la identidad
  del JWT**, nunca de un `kernelProductId` provisto por el cliente. La fuente de
  verdad es la tabla de mapeo operador→productos (`OperatorProductAuthz`,
  DynamoDB `kernel_operator_products`, PK=`subject`, SK=`kernelProductId`).
  - Una identidad autorizada para el producto `A` que intenta operar el producto
    `B` recibe **403** (`code=CROSS_PRODUCT_FORBIDDEN`). Sin mutación.
- **Distinción 401 vs 403 (guideline UX):** 401 = sin sesión → re-login;
  403 = autenticado pero sin permiso sobre ese producto → copy "no tenés permiso
  sobre este producto". Los `code` estables permiten i18n consistente dashboard↔app.

## 2. Endpoints de gestión (`SecuredFunction`, tag Kodein por acción)

Ruta: `POST /{business}/{tag}` (el `functionKey` son los 2 primeros segmentos).

| Acción | Tag Kodein | Método | Cuerpo | Éxito |
|--------|-----------|--------|--------|-------|
| Estado por producto | `kernel/product-status` | GET | — (query `kernelProductId` opcional) | 200 |
| Aprobar | `kernel/approve` | POST | `KernelCommandRequest` | 200 |
| Rechazar | `kernel/reject` | POST | `KernelCommandRequest` | 200 |
| Firmar | `kernel/sign` | POST | `KernelCommandRequest` | 200 |
| Alta de proyecto | `kernel/project-create` | POST | `KernelProjectCreateRequest` | 201 |

### Payloads (validados con Konform)

```jsonc
// KernelCommandRequest (approve / reject / sign)
{
  "kernelProductId": "kp-alpha",      // requerido, formato validado
  "idempotencyKey": "op-uuid-...",    // requerido, minLength 8 (anti-replay)
  "reason": "texto opcional"          // sanitizado en el audit (redact + CRLF)
}

// KernelProjectCreateRequest (project-create)
{
  "kernelProductId": "kp-nuevo",
  "label": "Nombre visible",          // requerido, minLength 2
  "idempotencyKey": "op-uuid-..."
}
```

### Respuesta de reconocimiento (`KernelCommandAckResponse`)

```jsonc
{
  "idempotencyKey": "op-uuid-...",
  "kernelProductId": "kp-alpha",
  "commandStatus": "CONFIRMED",       // ciclo de vida del buzón
  "action": "approve",
  "newState": "APPROVED",
  "replayed": false,                  // true si vino de un anti-replay
  "code": "OK",
  "statusCode": 200
}
```

## 3. Buzón de comandos asíncrono (SEC-3 / OWASP A07/A08)

- **Anti-replay atómico:** cada comando de mutación exige `idempotencyKey`. La
  reserva es un **check-and-set atómico** (`ConcurrentHashMap.putIfAbsent`, que en
  DynamoDB es `putItem` con `conditionExpression(attribute_not_exists(idempotencyKey))`).
  **No** hay read-then-write ⇒ sin TOCTOU (guru #4).
- **Replay:** reenviar el mismo `idempotencyKey` devuelve la **respuesta original**
  (`replayed=true`) **sin re-ejecutar** la mutación.
- **Origen e integridad:** el origen es autenticado (JWT del emisor); el input se
  valida con Konform antes de tocar el store.
- **Ciclo de vida:** `ENQUEUED → PROCESSING → CONFIRMED | REJECTED`. La
  `idempotencyKey` funciona además como **handle de polling de estado** del comando
  (`KernelCommandMailbox.get(idempotencyKey)`), para que la app comunique
  "encolado / procesando / confirmado / rechazado" sin inventar UX.
- **Retención del nonce:** in-memory por vida del proceso; al portar a DynamoDB se
  recomienda TTL configurable (p. ej. 24–72 h) documentado por operación.

## 4. Proyección remota read-model (SEC-4 / SEC-5 / OWASP A02)

- Módulo `kernel/projection`. Expone **solo** una allowlist de campos, pensada para
  render móvil (paridad de bolsillo), **sin N+1**:

```jsonc
// KernelProductProjection (allowlist EXPLÍCITA)
{
  "kernelProductId": "kp-alpha",
  "state": "APPROVED",
  "label": "Alpha",
  "availableActions": ["sign", "reject"],   // según estado + authz del operador
  "lastActionAt": "2026-07-18T12:00:00Z"
}
```

- **Minimización:** la proyección NUNCA incluye secretos, env ni internals de
  autoridad (`internalNote`, `actor`, hashes de audit, etc. quedan fuera —
  verificado en `KernelProjectionTest`).
- **TLS obligatorio (SEC-5):** la proyección viaja exclusivamente sobre TLS
  extremo a extremo. No se sirve en claro.
- **Vocabulario dashboard↔app:** las acciones (`approve/reject/sign/status`) y los
  estados (`DRAFT/PENDING/APPROVED/REJECTED/SIGNED`) son los mismos que el dashboard V3.

## 5. Audit trail inmutable (SEC-7 / OWASP A09)

- `KernelActionsAudit` (Kotlin) reimplementa el patrón conceptual de
  `.pipeline/lib/kernel-actions-audit.js` (Node.js del pipeline, **no importable** —
  guru #3): hash-chain SHA-256 append-only, **log-ANTES-de-mutar**.
- Cada entrada registra `actor + kernelProductId + action + timestamp + origin`.
- El `reason`/campos libres se **sanitizan**: redact de secrets (AWS/JWT/API keys/
  tokens) + escape de CRLF (anti log-forging) + truncado a 500 chars.

## 6. No-regresión y alcance (CA-5.1 / CA-D2)

- **Default a producto único:** la API vigente no cambia su comportamiento de authz;
  los endpoints nuevos son aditivos (nuevos tags Kodein). `BackendRouteIntegrationTest`
  sigue verde.
- **App NO construida:** no se agregan pantallas ni módulos en `app/composeApp`.

## 7. Notas no bloqueantes

- **Rate-limit por identidad (OWASP A04):** el buzón como cola de mutaciones de
  autoridad conviene acotarlo (tamaño de payload + rate por `subject`). Recomendado
  al construir la app / exponer a red pública. No bloqueante en esta ola.
- **Bootstrap de alta (`project-create`):** solo permite crear un `kernelProductId`
  inexistente y no reclamado; el creador queda como owner. Evita takeover
  cross-product sin necesitar un rol plataforma en esta fase.
