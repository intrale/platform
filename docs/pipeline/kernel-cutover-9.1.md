# Cutover de wiring al kernel migrado — Ola 9.1 · #4664

> **Alcance de #4664 (paso 3 de la cadena 9.1: #4662 → #4663 → #4664 → #4665):**
> reapuntar el **wiring de arranque** del pipeline para que el producto (adaptador
> Intrale) consuma el motor desde el **kernel migrado** (`@intrale/operating-kernel`,
> repo `Intrale/kernel`), **sin cambiar el comportamiento**. La paridad E2E la
> verifica #4665; el *freeze* del motor local es la sub-ola 9.5.
>
> **Frontera autoritativa:** [`../desacople-kernel/inventario-migrado-9.1.md`](../desacople-kernel/inventario-migrado-9.1.md)
> · [`kernel-repo-design.md`](kernel-repo-design.md) · [`contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md).

## 1. Qué hace este cutover

Antes, `.pipeline/restart.js` arrancaba el motor apuntando **directo** a los archivos
locales `.pipeline/pulpo.js` y `.pipeline/dashboard.js` (ubicación vieja del motor).
A partir de #4664, esos dos entrypoints —los únicos que migraron a `core/` del kernel
(inventario 9.1 §"Mapa de re-ubicación")— se resuelven a través de un punto único:

- **`.pipeline/lib/kernel-resolver.js`** — resuelve el entrypoint del motor por
  **nombre de paquete** (`@intrale/operating-kernel/core/pulpo` · `/core/dashboard`)
  desde `node_modules`, con validación de `contractVersion` previa a la carga
  (contrato §6.2). Nunca por `require()` de un path arbitrario ni derivado de
  entrada externa (contrato §6.1). Entrypoints = allowlist estática.
- **`pipeline.config.json`** (raíz del producto) — manifiesto declarativo del
  adaptador (contrato §6.1): `contractVersion`, `projectId`, `capabilities`,
  `extensionPoints` y el bloque `kernel` con el **pin inmutable** del kernel.

`restart.js` pasó a resolver `pulpo`/`dashboard` vía el resolver; el resto de
servicios (`listener-telegram`, `svc-*`) son del adaptador y siguen en `.pipeline/`.

## 2. Coexistencia — por qué el comportamiento NO cambia (CA-2/CA-3)

El **consumo del paquete está gateado OFF** por default (`pipeline.config.json` →
`kernel.consume: false`). Motivo: el kernel empaquetado todavía no tiene
externalizado su **estado** (`.pipeline/` state, `config.yaml` → sub-ola 9.4) ni
está consolidado el **freeze** del motor local (sub-ola 9.5). Hasta entonces:

- El resolver devuelve el **motor local** de `.pipeline/` (byte-idéntico al del
  kernel — verificado por el operador 2026-07-12). El pipeline arranca **idéntico**
  y sin errores de resolución.
- `.pipeline/` queda **intacto** (coexistencia), como fija el inventario 9.1.

Activación futura (con OK humano, post 9.4/9.5): `kernel.consume: true` (o
`PIPELINE_CONSUME_KERNEL=1`). Habilitado + kernel ausente/incompatible ⇒ **error
accionable (fail-closed)**: no se degrada en silencio a un motor local que el
operador cree retirado.

## 3. Pin del kernel (integridad de origen · security A08)

El pin vive declarado en `pipeline.config.json` → `kernel`:

```jsonc
"kernel": {
  "package": "@intrale/operating-kernel",
  "version": "0.1.0",
  "pinnedRef": "github:Intrale/kernel#704167b82c9a95115cf9d569b55ce135500e1366",
  "consume": false
}
```

Es un **pin inmutable por commit SHA** (no rama móvil). La declaración en
`package.json` (`dependencies`/`optionalDependencies`) + `package-lock.json` con
hashes + `npm ci` es la **activación del consumo** (paso gateado): se materializa
al consolidar el cutover (9.5), preferentemente migrando a un **release firmado
registry-semver** `@intrale/operating-kernel@0.1.0` (kernel-repo-design §2.3/§4).
Publicar ese release requiere acción humana (token `write:packages` + 2FA + firma):
es un gate fail-closed por diseño, fuera del alcance autónomo de #4664.

**Gate humano de CA-4:** la review de CODEOWNERS sobre el PR de este cutover
(`.pipeline/` está cubierto por CODEOWNERS → `@leitolarreta`).

## 4. Rollback

- Producto: tag `pre-ola9-migracion`.
- Kernel: rama/tag `import/motor-9.1` (motor con historia preservada).
- Revertir el wiring = volver `restart.js` a `path.join(PIPELINE, comp.script)` o,
  más simple, mantener `kernel.consume: false` (ya es el default: motor local).

## 5. Paridad E2E (#4665)

La verificación de paridad de comportamiento post-migración vive en
[`kernel-parity-9.1.md`](kernel-parity-9.1.md). Reproducible con
`node .pipeline/kernel-bootstrap/parity-e2e-9.1.js` (fail-closed) y
`node --test .pipeline/tests/kernel-parity-9.1.test.js`.
