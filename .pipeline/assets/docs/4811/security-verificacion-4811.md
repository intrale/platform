## Reporte de auditoría de seguridad — issue #4811

**Veredicto:** sin hallazgos (aprobado)

**Alcance auditado:** commit `35472b76f` — 6 archivos:
`.pipeline/lib/kernel-store.js` (fix CAS `addToCatalog`), `.pipeline/contracts/kernel-store.schema.json` (campo `version`), 3 suites `node --test` (`product-isolation-4811.test.js` nuevo, `kernel-store.test.js`, `credentials-isolation.test.js` extendidos) y `.pipeline/scripts/verify-isolation-4811.sh`. Historia de verificación de aislamiento multi-producto (multi-tenancy sobre el mismo host/tabla).

### Verificación empírica de los vectores OWANP / CA de seguridad

- **A01 — Aislamiento de tenant (CA-3).** Verificado en vivo: desde el contexto del producto nuevo (`contextProjectId=producto-nuevo`) no se alcanza la partición del monorepo. `putProduct({productId:'intrale-platform'})` desde ese contexto cayó en PK=`producto-nuevo` (SK=product#intrale-platform); el catálogo del monorepo quedó intacto (`MONO catalog=['intrale-platform']`). Anti-IDOR `item.projectId === contextProjectId` en `kernel-store.js:239`. 52/52 tests verdes.

- **A03 — Path traversal por `productId` (CA-5, BLOQUEANTE).** `isSafeId` (`project-descriptor.js:100`) rechaza `../intrale-platform`, `intrale-platform/../otro`, `/abs`, `C:\x`, `a\b`, `..`, `~` **antes** de materializar SK o path FS. Verificado: `putProduct` con esos ids lanza `KernelStoreValidationError` sin ninguna mutación (spyDriver = 0 escrituras) y con snapshot del monorepo idéntico (hash md5 estable). Sin hallazgos.

- **A08 — Integridad del `catalog#index` (CA-6, BLOQUEANTE).** El fix convierte el read-modify-write en CAS optimista por `version` con reintento acotado (`kernel-store.js:471-540`). **Confirmado que NO es falso verde:** el driver in-memory evalúa realmente la condición anidada `#b.#v = :ev` (`provisioner-infra.js:287-316`); probé dos escritores en versión stale → el segundo recibe `ConditionalCheckFailedError` y reintenta, sin pérdida de entradas. Altas concurrentes (`Promise.all`, N=10) conservan todas las entradas + la del monorepo.

- **Aislamiento de secretos (CA-7).** Refs namespaceadas (`<path>#<namespace>`); un descriptor cuya credencial apunta al namespace ajeno se rechaza (stage `ref`); la forma redactada (env/logs/handoff) nunca incluye valores de otro tenant; ref sin namespace rechazada por `parseSecretRef`. Sin fuga cross-tenant.

- **Higiene del diff.** El commit contiene sólo tests + el fix justificado por CA-9 + script de evidencia. Sin archivos espurios, sin secrets hardcodeados. Script `verify-isolation-4811.sh` con `set -euo pipefail` y variables citadas — sin superficie de inyección.

### Hallazgos
Sin hallazgos bloqueantes ni vulnerabilidades explotables.

### Observación (defensa en profundidad, NO bloqueante)
- [Baja][A01] `kernel-store.js:459` (`sanitizeProduct`) / `kernel-supervisor.js:253` (`resolveProjectId`) — el id reservado `intrale-platform` no se rechaza explícitamente (`isSafeId('intrale-platform')===true`).
  - **Vector (criollo):** hoy NO es explotable — la partición se elige out-of-band por credencial y el anti-IDOR bloquea el cruce (verificado). Es un gap latente: si a futuro un supervisor booteara instancias desde un catálogo escribible por un tenant, un registro `intrale-platform` ligaría una instancia a la partición del monorepo.
  - **Remediación:** allowlist de reservados fail-closed en `sanitizeProduct()`/`resolveProjectId()`. Registrado como recomendación **#4816** (`needs-human`, priority:low). No bloquea #4811.
