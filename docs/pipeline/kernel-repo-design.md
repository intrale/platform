# Diseño del repo del kernel operativo (Ola 8 · EP-OLA8-D)

> **Épica:** EP-OLA8-D · Repo aparte para el modelo operativo (issue #4012)
> **Ola:** 8 — Definición del desacople kernel operativo ↔ producto
> **Naturaleza:** documento de **definición** (no implementación). Define cómo el modelo
> operativo vive en un **repositorio separado** del producto: estructura del repo, cómo lo
> consume un producto, cómo se versiona y qué garantías de seguridad de cadena de suministro
> son obligatorias. La Ola 8 **define**; la Ola 9 **implementa**.
> **Inputs directos:**
> [`docs/desacople-kernel/inventario-frontera.md`](../desacople-kernel/inventario-frontera.md) (EP-OLA8-A, #4009) ·
> [`docs/pipeline/contrato-kernel-adaptador.md`](contrato-kernel-adaptador.md) (EP-OLA8-B, #4010).
> **Estado:** documento vivo — se revisa al entrar a la Ola 9.

---

## Cómo leer este documento

Hoy el modelo operativo (`.pipeline/` + skills + hooks) vive **dentro** del repo del producto
Intrale. Es el acoplamiento más físico de todos: el motor de orquestación no puede correr otro
producto sin antes salir de este repo (crítico #2 del inventario, §6 de #4009). Esta épica
define cómo se separa ese motor en un **repo propio del kernel**, que nace vacío y al lado, sin
tocar el `.pipeline/` actual de Intrale.

Este documento cubre la **mecánica del repo separado**: estructura (sección 1), mecanismo por el
que un producto consume el kernel (sección 2), versionado independiente (sección 3) y seguridad
de cadena de suministro (sección 4). El **plan de migración conceptual** —qué sale de `.pipeline/`
y dónde cae la frontera ítem por ítem— vive en su documento hermano
[`kernel-migration-plan.md`](kernel-migration-plan.md).

Mapeo sección ↔ criterios de aceptación (CA del PO en #4012):

| Sección de este documento | CA cubiertos | Estado |
|---------------------------|--------------|--------|
| 1. Estructura del repo del kernel | CA-1 | **Cerrado** |
| 2. Mecanismo de consumo decidido | CA-2 | **Cerrado** |
| 3. Versionado independiente | CA-3 | **Cerrado** |
| 4. Seguridad de cadena de suministro | CA-4 | **Cerrado** |
| (frontera kernel/producto) | CA-5 | → [`kernel-migration-plan.md` §2](kernel-migration-plan.md) |
| (inventario de qué sale de `.pipeline/`) | CA-6 | → [`kernel-migration-plan.md` §3](kernel-migration-plan.md) |
| (riesgos de coexistencia) | CA-7 | → [`kernel-migration-plan.md` §4](kernel-migration-plan.md) |
| (cero riesgo + dependencia) | CA-8, CA-9 | sección 5 de este documento |

> **Nota de dependencia (CA-9).** Las dependencias #4009 (inventario) y #4010 (contrato) están
> **CLOSED** (verificado 2026-06-29: el `brazoDesbloqueo` reingresó este issue al cerrarlas). Por
> eso las secciones núcleo (CA-5/CA-6) ya **no** quedan stubeadas: se redactan apoyadas en esos
> dos documentos, en [`kernel-migration-plan.md`](kernel-migration-plan.md). Este documento no
> contiene secciones `pendiente de #4009/#4010`.

---

## 1. Estructura del repo del kernel

<!-- CA-1 -->

El repo del kernel **nace vacío**, en una organización/ubicación propia, sin historia heredada del
repo del producto (ver el paso de escaneo de secretos antes del commit 1 en
[`kernel-migration-plan.md` §3.3](kernel-migration-plan.md)). Su layout top-level:

| Carpeta / archivo | Responsabilidad | Agnóstico vs producto |
|-------------------|-----------------|-----------------------|
| `core/` | Motor de orquestación: Pulpo (intake/outtake), scheduler, lifecycle de fases (`pendiente/`→`trabajando/`→`listo/`→`procesado/`), circuit breaker, brazo de desbloqueo, routing engine. | **Agnóstico** — no conoce ningún stack. |
| `skills/` | Skills de orquestación genéricos: `delivery`, `branch`, `review`, `monitor`, `ops`, `cost`, `ghostbusters`, `handoff`, `reset`, `auth`, `pipeline-dev`. | **Agnóstico** — proceso, no stack. |
| `capabilities/` | Skills de stack como **plugins** (contrato de capability de [#4010 §4](contrato-kernel-adaptador.md)). El kernel define la **interfaz**; cada adaptador provee la implementación (android, backend, web, …). | **Interfaz agnóstica**, implementaciones específicas viven en el adaptador. |
| `contracts/` | La interfaz kernel↔adaptador: puertos (`discoverWork`, `route`, `build`, `test`, `e2e`, `package`, `deploy`, `gates`), hooks/extension points y el **JSON Schema** publicado del manifiesto `pipeline.config.json`. Fuente: [#4010 §3, §4, §6](contrato-kernel-adaptador.md). | **Agnóstico** — el contrato. |
| `config.schema.json` | Esquema validable del `pipeline.config` por producto (routing, capabilities, extensionPoints, integrity). DX: autocompletado/validación en editor ([#4010 §6.3](contrato-kernel-adaptador.md)). | **Agnóstico**. |
| `lib/` | Utilidades transversales del motor: `credentials.js` (mecanismo de carga, **sin** nombres/scopes concretos), `redact.js` + `handoff.js` (redacción de secretos + defensas anti prompt-injection, #2993), helpers de FS/git. | **Agnóstico** — mecanismos, no datos. |
| `hooks/` | Hooks de orquestación/telemetría genéricos: `agent-concurrency-check`, `agent-registry`, `activity-logger`, `branch-guard`, `worktree-guard` (con el patrón de rama **parametrizado**, no hardcodeado). | **Agnóstico** salvo parámetros (que el adaptador inyecta). |
| `dashboard/` | Dashboard V3 del operador, multi-tenant por `projectId` ([#4010 §8](contrato-kernel-adaptador.md)). | **Agnóstico** — UI de orquestación. |
| `fixtures/` | Repo dummy de prueba para tests del **propio kernel** (self-hosting / bootstrap, punto K del desacople). Permite testear el motor sin un producto real. | **Agnóstico**. |
| `docs/` | Documentación del kernel: contrato, este diseño, plan de migración, runbooks de operación. | **Agnóstico**. |
| `package.json` / `package-lock.json` | Manifiesto del paquete del kernel (Node.js puro) + lockfile con hashes. Habilita el consumo como **paquete versionado** (sección 2). | **Agnóstico**. |

**Lo que NO vive en el repo del kernel** (queda del lado del **adaptador de producto**, repo
Intrale): los skills de stack (`android-dev`, `backend-dev`, `web-dev`, `builder`, `tester`,
`perf`, `ux`), `CLAUDE.md`, la tabla de ruteo `label→skill` concreta, los comandos de build
(gradlew/flavors), los nombres/scopes de credenciales y los patrones de auth del producto
(Cognito/JWT). La clasificación ítem por ítem está en
[`kernel-migration-plan.md` §2](kernel-migration-plan.md), apoyada en el contrato de #4010.

---

## 2. Mecanismo de consumo decidido

<!-- CA-2 -->

> **Decisión (una frase):** el producto consume el kernel como **paquete versionado** (npm /
> GitHub Packages, semver), declarado en su manifiesto de dependencia y pineado por versión con
> lockfile de hashes — **no** como submódulo ni subtree de git.

### 2.1. Tabla de trade-offs

Matriz reusada del análisis de `guru` (#4012) y reforzada por `security`:

| Mecanismo | Pro | Contra | Encaje Intrale |
|-----------|-----|--------|----------------|
| **Git submodule** | Pin por commit/tag explícito; el producto ve el código fuente. | Workflow frágil (detached HEAD, doble commit, devs olvidan `--recurse-submodules`). DX pobre en Windows + worktrees `agent/*` ya complejos. | El kernel es Node.js puro: encaja, pero el riesgo de DX sobre el flujo de worktrees actual lo hace **descartado**. |
| **Git subtree** | Sin tooling extra; historia embebida en el producto. | Updates bidireccionales confusas; difícil rastrear "qué versión" estás corriendo. Pierde el versionado independiente, que es el objetivo de la épica. | **Descartado**: anula el objetivo (versionado independiente). |
| **Paquete versionado (npm / GitHub Packages)** | Semver nativo; `package.json` declara la versión; update = bump + `npm ci`; lockfile con hashes; rollback al tag estable. | Requiere publicar a un registry; el kernel debe ser instalable (entrypoints/bin definidos). | **RECOMENDADO**: el kernel ya es Node.js; el registry da semver + lockfile + integridad + rollback nativos. |
| **Template + sync tool** | Setup inicial simple (el wizard EP8-E clona el template del adaptador). | "Drift" entre instancias; updates manuales del propio template. | **Complementa**, no reemplaza: el wizard genera el *adaptador* desde template; el *kernel* se consume como dependencia versionada. |

### 2.2. Justificación de la decisión

1. **Encaje nativo.** El kernel ya es Node.js puro (≈377 `.js` + libs). Empaquetarlo como módulo
   npm/GitHub Packages no requiere cambiar de tecnología: `package.json` + `bin`/entrypoints.
2. **Versionado independiente real.** El semver del paquete (sección 3) desacopla la evolución del
   kernel de la del producto, que es el objetivo declarado de la épica. Submodule/subtree no lo dan
   limpio.
3. **Integridad de cadena de suministro.** El consumo por paquete habilita `package-lock.json` con
   hashes SRI + `npm ci` (instalación reproducible y verificada), base de la sección 4. Submodule
   pinea por commit pero no verifica integridad de contenido del mismo modo.
4. **Rollback ya practicado.** El patrón "pin a un tag estable verificado" ya existe en este repo
   (`pre-ola-n+3-stable`). El paquete versionado lo formaliza: pin → bump → rollback al tag estable
   firmado.
5. **Auto-actualización / self-hosting (punto K).** Desarrollar el kernel-N+1 con una instancia
   *pineada* del kernel-N es directo con un paquete versionado: el repo del kernel declara una
   `devDependency` al kernel estable anterior.

### 2.3. Forma del consumo (conceptual)

El producto (adaptador Intrale) declara la dependencia y la pinea:

```jsonc
// package.json del producto (adaptador) — forma conceptual
{
  "dependencies": {
    "@intrale/operating-kernel": "1.4.2"   // versión exacta, NO rango abierto (^/~)
  }
}
```

- Instalación reproducible y verificada: `npm ci` (usa `package-lock.json` con hashes, no
  `npm install` libre).
- El kernel se descubre y carga vía el manifiesto declarativo `pipeline.config.json` del adaptador
  ([#4010 §6](contrato-kernel-adaptador.md)), no por `require()` de paths arbitrarios.
- Update = bump explícito de la versión + `npm ci` + verificación de firma (sección 4).

---

## 3. Versionado independiente

<!-- CA-3 -->

El kernel se versiona con **semver propio**, independiente del producto, **referido al contrato
kernel↔adaptador** (`contractVersion`, hoy `0.1.0` en [#4010 §7 CA-14](contrato-kernel-adaptador.md)).
La versión del *paquete* del kernel y la versión del *contrato* evolucionan alineadas: un cambio
MAJOR del contrato implica MAJOR del kernel.

### 3.1. Qué constituye cada nivel

| Nivel | Qué cambia | Ejemplo concreto |
|-------|-----------|------------------|
| **MAJOR** (`x.0.0`) | Rompe el **contrato** kernel↔adaptador (#4010): puerto/hook obligatorio nuevo, firma de puerto cambiada, o cualquier cambio que invalide adaptadores existentes. | Se agrega `gates` como puerto **obligatorio** con nueva firma → todo adaptador que no lo implemente deja de cargar. El kernel **rechaza** adaptadores con `contractVersion` MAJOR distinto. |
| **MINOR** (`0.x.0`) | Nueva capability/skill o puerto/hook **opcional**, retrocompatible. Nuevo stack en el catálogo de capabilities. | Se agrega el puerto opcional `deploy` o una capability `ios`. Adaptadores viejos siguen cargando (ignoran lo nuevo). |
| **PATCH** (`0.0.x`) | Fix de hooks/scripts/bugs del motor sin cambiar el contrato observable. Aclaraciones de doc. | Fix en el scheduler de ventanas o en `redact.js`; sin cambio de interfaz. |

Esta política es **idéntica** a la del `contractVersion` definida en
[#4010 §7 CA-14](contrato-kernel-adaptador.md) — el documento de diseño la hereda para que la
versión del paquete y la del contrato no diverjan.

### 3.2. Pin del producto

- El producto pinea una **versión exacta** del kernel (no rango `^`/`~`): `"1.4.2"` en su
  `package.json`, con el hash correspondiente en `package-lock.json` (sección 4).
- El pin convive con la **validación previa a la carga** del adaptador
  ([#4010 §6.2](contrato-kernel-adaptador.md)): el kernel verifica que el `contractVersion` del
  manifiesto del adaptador sea compatible con su propia versión antes de cargar; mismatch
  incompatible → rechazo con error accionable (versión soportada vs encontrada).

### 3.3. Rollback a tag estable

- Cada release del kernel que pasa su smoke test mueve un tag estable (patrón ya practicado:
  `pre-ola-n+3-stable`, `pipeline-stable`).
- Rollback = re-pinear el producto al **último tag estable verificado por firma** (sección 4) +
  `npm ci`. Es un **comando único y documentado**, no un procedimiento manual de varios pasos
  (guideline DX de `ux`, #4012).
- **Happy path** (update): bump → `npm ci` → verifica firma → smoke test → ok.
  **Recovery path** (rollback): re-pin al tag estable → `npm ci` → verifica firma → smoke test → ok.
  Ambos se documentan lado a lado en el runbook del kernel.

### 3.4. Contrato de error de versión (DX)

Cuando falla el pin, el lockfile de hashes o la verificación de firma, el mensaje al developer es
**accionable y en español**, no un stack trace crudo de npm (guideline DX de `ux`, cruza CA-4):

```
✗ Kernel 1.4.2: la firma del release no coincide con el hash esperado.
  Qué pasó:  el paquete descargado no verifica contra el tag firmado.
  Por qué:   posible release no firmado, registry comprometido o caché corrupta.
  Cómo seguir: corré el rollback al último tag estable (1.4.1) y reportá el incidente.
```

El contrato de error mínimo declara siempre: **qué pasó · por qué · cómo resolver**.

---

## 4. Seguridad de cadena de suministro

<!-- CA-4 -->

Separar el kernel en un repo aparte y consumirlo como dependencia **aumenta** la superficie de
supply-chain que hoy no existe (hoy `.pipeline/` vive en el mismo repo, sin intermediario). El
kernel **ejecuta código arbitrario en las máquinas de dev** (Pulpo, hooks, spawns, scripts): una
versión maliciosa = RCE sobre todo el entorno. El diseño incorpora el checklist de `security`
(#4012) punto por punto, alineado con las garantías ya formalizadas en
[#4010 §7](contrato-kernel-adaptador.md):

| # | Requisito | Cómo lo cumple este diseño | OWASP |
|---|-----------|----------------------------|-------|
| 1 | **Consumo por versión pineada + lockfile con hashes** (no rango semver abierto). | Sección 2.3 / 3.2: versión exacta en `package.json` + `package-lock.json` con hashes SRI + `npm ci` (no `npm install`). | A08 Software & Data Integrity |
| 2 | **Firma de releases del kernel + verificación en el producto.** | Tags firmados (GPG/sigstore) en cada release; el producto verifica la firma antes de actualizar (sección 3.3). Habilita el rollback seguro al tag estable. | A08 |
| 3 | **Frontera de secretos.** | El kernel **nace sin secretos**: `lib/credentials.js` es el *mecanismo* (kernel), los nombres/scopes son del adaptador. El kernel los lee por **brokering** del adaptador/host ([#4010 §7 CA-11](contrato-kernel-adaptador.md)), nunca hardcodeados ni en el repo del kernel. Escaneo de secretos antes del commit 1 → [`kernel-migration-plan.md` §3.3](kernel-migration-plan.md). | A05/A07 |
| 4 | **Control de acceso de publicación.** | Branch protection en `main` del kernel + **2FA obligatorio** en el registry + gate de publicación (no auto-publish desde CI sin aprobación humana). Quién publica una versión es un punto único de compromiso (publica para todos los productos). | A01 Broken Access Control |
| 5 | **Validación de input en el contrato.** | Config/payloads que el producto pasa al kernel (manifiesto, routing, paths) se validan contra `config.schema.json` (Konform/JSON-Schema) **antes** de consumirse; paths validados contra path traversal ([#4010 §7 CA-12](contrato-kernel-adaptador.md)). Todo dato que cruza la frontera es input no confiable. | A03 Injection |
| 6 | **Defensas anti-injection del handoff preservadas y ubicadas en el kernel.** | `lib/redact.js` + `lib/handoff.js` viven del lado kernel (`lib/`, sección 1) y se aplican en la frontera del contrato: redactan AWS keys/JWT/API keys/passwords + truncan patrones de prompt-injection (#2993, [#4010 §7 CA-13](contrato-kernel-adaptador.md)). | A03 |
| 7 | **Bootstrap / self-hosting verifica integridad.** | Desarrollar el kernel-N+1 con una instancia pineada del kernel-N: el bootstrap **también** verifica firma (no auto-update silencioso), para evitar un loop de envenenamiento (punto K). | A08 |
| 8 | **Token de registry (si es privado).** | Tokens de lectura del producto **scoped y rotables**; un token filtrado expone el kernel. Definir el modelo de tokens al elegir registry (Ola 9). | A01 |

> **Checklist de cierre (CA-4), verificable contra este documento:**
> - [x] Consumo por versión pineada + lockfile con hashes (§2.3, §3.2).
> - [x] Firma de releases + verificación en el producto (§3.3, tabla #2).
> - [x] Frontera de secretos: kernel sin secretos, lectura por inyección/brokering (tabla #3).
> - [x] Control de acceso de publicación: branch protection + 2FA + gate de release (tabla #4).
> - [x] Validación de input del contrato (tabla #5).
> - [x] Defensas anti-injection del handoff en el kernel (tabla #6, sección 1 `lib/`).
> - [x] Rollback seguro a tag estable verificado por firma (§3.3).

---

## 5. Definition of Done y secuenciamiento

<!-- CA-8, CA-9 -->

### 5.1. Cero riesgo para Intrale (CA-8)

Esta épica **no ejecuta** migración: el `.pipeline/` actual de Intrale **no se toca** y el repo del
kernel **nace vacío**. El entregable es exclusivamente documental (dos `.md` bajo `docs/pipeline/`).

- *Verificable:* ningún archivo de `.pipeline/` se mueve/borra/edita como parte de esta épica; no se
  crea código del kernel. El único delta del PR son los `.md` nuevos en `docs/`.

```bash
# El delta del PR no toca .pipeline/ (esperado: 0 resultados)
git diff --name-only main | grep '^.pipeline/'

# El delta del PR son solo docs nuevos
git diff --name-only main   # esperado: docs/pipeline/kernel-repo-design.md + kernel-migration-plan.md
```

### 5.2. Dependencia respetada (CA-9)

Las secciones núcleo (frontera CA-5, plan de migración CA-6) dependían del cierre de **#4009**
(inventario) y **#4010** (contrato). Ambas cerraron (verificado 2026-06-29; el `brazoDesbloqueo`
reingresó este issue). Por eso:

- Las secciones de **mecánica, versionado y seguridad** (CA-1..CA-4, este documento) están cerradas.
- Las secciones **núcleo** (CA-5, CA-6, CA-7) están cerradas en
  [`kernel-migration-plan.md`](kernel-migration-plan.md), apoyadas explícitamente en los documentos
  de #4009 y #4010 — sin marcadores `pendiente de`.
- Este documento **no** contiene ninguna sección stubeada: la condición de CA-9 (adelantar mecánica,
  bloquear núcleo) se resolvió porque las dependencias ya están cerradas al momento de redactar.

---

## Verificación (inspección estructural)

Al ser un entregable documental, la verificación es por inspección:

```bash
# CA-1 — estructura del repo: tabla de carpetas top-level con responsabilidad
grep -nE '^\| `(core|skills|capabilities|contracts)/`' docs/pipeline/kernel-repo-design.md

# CA-2 — decisión de consumo en una frase + tabla de trade-offs
grep -n "Decisión (una frase)" docs/pipeline/kernel-repo-design.md
grep -nE 'submodule|subtree|Paquete versionado|Template' docs/pipeline/kernel-repo-design.md

# CA-3 — tabla MAJOR/MINOR/PATCH + pin + rollback
grep -nE 'MAJOR|MINOR|PATCH' docs/pipeline/kernel-repo-design.md

# CA-4 — checklist de seguridad supply-chain punto por punto
grep -nE 'lockfile|Firma de releases|Frontera de secretos|branch protection' docs/pipeline/kernel-repo-design.md
```

**DoD (checklist final del PO, se valida en aprobación):**

- [ ] Documento de diseño en `docs/pipeline/` revisado y aprobado.
- [ ] Estructura del repo del kernel con responsabilidad por carpeta (CA-1).
- [ ] Mecanismo de consumo decidido en una frase + tabla de trade-offs (CA-2).
- [ ] Versionado semver con tabla MAJOR/MINOR/PATCH + pin + rollback (CA-3).
- [ ] Checklist de seguridad de cadena de suministro incorporado punto por punto (CA-4).
- [ ] Frontera y plan de migración cerrados en el documento hermano (CA-5/CA-6 → `kernel-migration-plan.md`).
