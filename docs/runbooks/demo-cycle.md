# Runbook — Demo del ciclo del kernel (dev → build → QA → delivery)

> Issue: [intrale/platform#4700](https://github.com/intrale/platform/issues/4700)
> (Split de #4696 · Ola Puente P0 · CA-D2) ·
> Diseño: [`docs/pipeline/kernel-repo-design.md §1`](../pipeline/kernel-repo-design.md) ·
> Harness: [`fixtures/demo/run-cycle.js`](../../fixtures/demo/run-cycle.js)

## Propósito

Demostrar de forma **verificable y reproducible** un ciclo completo
**dev → build → QA → delivery** del motor del kernel apuntado **exclusivamente**
a un **target controlado** (copia local equivalente del fixture
`agent/4699-fixtures` de `intrale/kernel`), **sin depender** de que
`intrale/kernel@main` esté publicado y **sin ningún riesgo** de mutar
`intrale/platform`. Es la **evidencia de aceptación de P0** que destraba P1→P7.

La prueba **real** contra `intrale/kernel@main` publicado vive en
[#4706](https://github.com/intrale/platform/issues/4706); este mismo harness se
reutiliza cambiando el target (ver [Reuso por #4706](#reuso-por-4706)).

## Precondiciones

- Node.js ≥ 18 y npm ≥ 7 en el PATH (`node --version`, `npm --version`).
- El target controlado local está bundleado en `fixtures/demo/target/`
  (marker `.kernel-target.json`, `pipeline.config.json`, `package.json` +
  `package-lock.json` pineado, y el work file en
  `demo-pipeline/demo-phase/pendiente/`). No requiere red.
- **No** requiere que `intrale/kernel#1` esté mergeado ni que `fixtures/`
  exista en `intrale/kernel@main` (esa verificación es #4706).

## Pasos

```bash
# Desde el root de intrale/platform
node fixtures/demo/run-cycle.js
# o el wrapper equivalente:
bash fixtures/demo/run-cycle.sh
```

El ciclo:

1. **Copia** el target controlado a un **sandbox temporal** (`os.tmpdir`). Ninguna
   fase mutante toca el working tree de `intrale/platform`.
2. Corre las fases `dev → build → QA → delivery` sobre el sandbox, avanzando el
   work file por el lifecycle `pendiente → trabajando → listo → procesado`.
3. **Antes de cada fase mutante** (`build`, `qa`, `delivery`) verifica el target
   (`verifyTarget`) y emite la línea de evidencia
   `✔ target = kernel-fixtures (verificado)`.
4. Deja la evidencia por fase en el directorio de run (`phase-*.json`,
   `delivery-manifest.json`, `summary.json`).

## Evidencia esperada por fase

| Fase | Mutante | Evidencia en stdout | Artefacto |
|------|---------|---------------------|-----------|
| `dev` | no | `work file tomado (pendiente -> trabajando)` | `phase-dev.json` |
| `build` | **sí** | `✔ target = kernel-fixtures (verificado) [build]` + `bootstrap pineado (npm ci)` | `phase-build.json` |
| `qa` | **sí** | `✔ target = kernel-fixtures (verificado) [qa]` + `verificación estructural OK` | `phase-qa.json` |
| `delivery` | **sí** | `✔ target = kernel-fixtures (verificado) [delivery]` + `dry-run sin auto-merge, sin main, token scoped` | `phase-delivery.json`, `delivery-manifest.json` |

Cierre esperado:

```
Trail lifecycle: pendiente -> trabajando -> listo -> procesado
Fases mutantes con target verificado: build, qa, delivery
✔ Ciclo completo. Delivery en dry-run (sin auto-merge, sin main).
```

Exit code `0` = ciclo completo; `1` = abort (con contrato de error
qué pasó · por qué · cómo seguir). En cualquier abort, **ninguna fase mutó
`intrale/platform`**.

## Garantías de seguridad (mapa a criterios)

- **CA-D2.2 — blast radius (BLOQUEANTE):** `verifyTarget` corre antes de cada
  fase mutante y **aborta** si el target resuelve dentro de `intrale/platform`,
  si el marker declara `repo: intrale/platform`, si `projectId ≠ kernel-fixtures`,
  o si el remote git de un clon apunta al producto.
- **CA-D2.3 — delivery seguro:** `deliver` corre en **dry-run**; asevera
  `autoMerge=false`, `mergeToMain=false`, `sign=false` y `tokenScope` scoped al
  repo/rama del kernel (rechaza PAT org-wide). **No ejecuta** push ni `gh` real;
  deja `delivery-manifest.json` como evidencia de gate.
- **CA-D2.4 — supply chain:** `bootstrap` corre `npm ci` contra el lockfile
  pineado (lockfileVersion ≥ 2, hashes SRI), **rechaza rangos abiertos**
  (`^`/`~`/`latest`/`>=`) y **nunca** `npm install`. Sin auto-update silencioso.

## Reuso por #4706

El harness es **agnóstico del origen del target**. Para la prueba real contra el
kernel publicado, sin tocar el código:

```bash
KERNEL_TARGET_REMOTE=https://github.com/intrale/kernel \
KERNEL_TARGET_REF=main \
  node fixtures/demo/run-cycle.js
```

Clona esa rama (shallow) al sandbox y aplica **las mismas** verificaciones de
target y garantías de delivery/supply-chain. Mientras `main` no tenga
`fixtures/`, `KERNEL_TARGET_REF=agent/4699-fixtures` apunta al target integrable
disponible.

## Variables de entorno

| Variable | Default | Efecto |
|----------|---------|--------|
| `KERNEL_TARGET_REMOTE` | (vacío) | Si se define, clona ese remote en vez del bundled local. |
| `KERNEL_TARGET_REF` | `agent/4699-fixtures` | Rama/tag a clonar (reuso #4706 → `main`). |
| `KERNEL_DEMO_KEEP` | `0` | `1` conserva el sandbox y la evidencia (no los borra al cerrar). |

## Troubleshooting

| Síntoma | Causa probable | Acción |
|---------|----------------|--------|
| `ABORT [build]: rangos abiertos detectados` | El `package.json` del target usa `^`/`~`/`latest`. | Pineá cada dependencia a versión exacta y regenerá el lockfile. |
| `ABORT [<fase>]: el target resuelve DENTRO de intrale/platform` | El ciclo intentó operar en-place sobre el repo del producto. | Es el guard de blast radius funcionando: el ciclo debe correr sobre el sandbox; revisá `resolveTarget`. |
| `ABORT [<fase>]: falta el marker .kernel-target.json` | El target no es la copia del fixture del kernel. | Restaurá `fixtures/demo/target/` o apuntá a `intrale/kernel` con `KERNEL_TARGET_REMOTE`. |
| `npm ci` falla por lockfile desincronizado | `package.json` y `package-lock.json` divergen. | Regenerá el lockfile con `npm install --package-lock-only` en `fixtures/demo/target/`. |
| Clon (`KERNEL_TARGET_REMOTE`) falla por auth | El repo del kernel es privado y falta credencial scoped. | Autenticá `gh`/git con un token **scoped** al repo del kernel (nunca org-wide). |

## Verificación automatizada

La prueba E2E vive en
[`.pipeline/tests/kernel-demo-cycle.test.js`](../../.pipeline/tests/kernel-demo-cycle.test.js)
y se corre con la suite del pipeline:

```bash
npm run test:pipeline
# o puntual:
node --test .pipeline/tests/kernel-demo-cycle.test.js
```

Cubre: avance por fase, target verificado en cada fase mutante, **abort** ante un
target que apunta a `intrale/platform`, delivery sin auto-merge, y lockfile
pineado.
