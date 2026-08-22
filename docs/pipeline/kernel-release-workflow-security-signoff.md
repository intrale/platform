# Sign-off de seguridad — `kernel-release-workflow.proposed.yml` (#4695 · CA-C0)

> **Veredicto: 🟢 APROBADO CON OBSERVACIONES.** Se otorga el sign-off de CA-C0.
> El `release.yml` puede commitearse al repo del kernel y el release puede publicarse
> en cualquiera de los dos modos de gate (`--gate=environment` / `--gate=dispatch`).
>
> Este documento **sí** matchea el patrón que `.pipeline/bin/kernel-release.js` busca
> para dar por cumplido CA-C0 (`/security.*(sign-?off|4695)|kernel-release.*sign-?off/i`),
> a diferencia del informe previo, cuyo veredicto era negativo.

- **Alcance:** `docs/pipeline/kernel-release-workflow.proposed.yml` + la transformación de gate
  (`.pipeline/lib/kernel-release-gate.js`, extraída de `.pipeline/bin/kernel-release.js`) y su
  verificación fail-closed `assertGateSafety()`.
- **Fecha:** 2026-07-26
- **Auditor:** `/security`
- **Reemplaza a:** `kernel-release-workflow-auditoria-seguridad.md` (veredicto 🔴 BLOQUEADO, misma fecha).
- **Evidencia:** `.pipeline/lib/__tests__/kernel-release-gate-4695.test.js` → **16/16 OK**.

---

## Estado de los findings de la auditoría previa

| ID | Severidad | Estado | Verificación |
|----|-----------|--------|--------------|
| CRITICAL-1 | 🔴 Critical | **CERRADO** | Ejecución real de la transformación sobre el YAML real, en LF y CRLF |
| HIGH-1 | 🟠 High | **CERRADO** | Aserción estructural + inspección línea por línea de todos los `run:` |
| HIGH-2 | 🟠 High | **CERRADO** | Los 3 SHA resueltos contra la API de GitHub |
| MEDIUM-1 | 🟡 Medium | **CERRADO** | Un solo `npm pack`; se publica y se firma el mismo `$BLOB` |
| MEDIUM-2 | 🟡 Medium | **CERRADO** | Job `guard` fail-closed previo a todo checkout + `refs/tags/` calificado |
| LOW-1 | ⚪ Low | **CERRADO** | Resuelto por la validación de `guard` |
| MEDIUM-3 | 🟡 Medium | **CERRADO en esta auditoría** | Finding nuevo; remediado y con test (ver abajo) |

### CRITICAL-1 — el gate ya no puede evaporarse

La transformación por regex frágiles se reemplazó por edición estructural tolerante a EOL
(`normalizeEol` + `dropChildBlock`) más una **red fail-closed** (`assertGateSafety`) que corre
**antes de escribir el archivo**: `kernel-release.js:160-165` aborta con `fail()` y el mensaje
"No se escribió ni se commiteó nada" si la verificación tira.

Resultado verificado ejecutando la transformación real (no leyendo el código):

```
LF   dispatch    triggers=["workflow_dispatch"]          env=undefined   OK
LF   environment triggers=["push","workflow_dispatch"]   env="release"   OK
CRLF dispatch    triggers=["workflow_dispatch"]          env=undefined   OK
CRLF environment triggers=["push","workflow_dispatch"]   env="release"   OK
```

La combinación del bug (gate borrado + push vivo) es **imposible** ahora: en `dispatch` no
sobrevive ningún trigger automático, y la aserción rechaza explícitamente ese caso
(test `assertGateSafety rechaza gate=dispatch con el trigger push vivo`).

Refuerzos adicionales verificados:
- El YAML quedó **LF puro** (0 bytes CR) y `.gitattributes` fija `*.yml text eol=lf` — se ataca la causa raíz, no sólo el síntoma.
- **`Intrale/kernel` no tiene ningún otro workflow** (`.github/workflows` → 404), así que el push del tag de la fase 4 en modo `dispatch` no puede disparar nada por otra vía. Verificado contra la API.

### HIGH-1 — sin interpolación en `run:`

Ningún `run:` del workflow contiene `${{`. Todo valor externo entra por `env:` y se lee como
variable de shell (`$REF`, `$TAG`, `$VERSION`, `$BLOB`). Además la propiedad quedó **asegurada
estructuralmente**: `assertGateSafety` recorre todos los steps de todos los jobs y falla ante
cualquier `run` que interpole.

### HIGH-2 — actions pineadas por SHA, y los SHA son reales

Las tres están pineadas a SHA de 40 y **cada SHA fue resuelto contra la API de GitHub** para
confirmar que corresponde al tag que declara el comentario (un SHA inventado habría roto el
workflow en runtime):

| Action | SHA | Tag verificado |
|--------|-----|----------------|
| `actions/checkout` | `11d5960a…677262` | v4.4.0 ✅ |
| `actions/setup-node` | `49933ea5…820020` | v4.4.0 ✅ |
| `sigstore/cosign-installer` | `d58896d6…65e159` | v3.9.2 ✅ |

`assertGateSafety` también rechaza cualquier `uses:` sin pin por SHA.

### MEDIUM-1 / MEDIUM-2 — cadena de integridad y validación de entrada

- Se empaqueta **una sola vez** (`npm pack`, `id: pack`); se publica ese mismo `$BLOB`, se firma ese
  mismo `$BLOB` y se adjunta su `sha256` al Release. La firma queda atada al artefacto real.
- El job `guard` valida `^v[0-9]+\.[0-9]+\.[0-9]+$` **antes de cualquier checkout**, con
  `permissions: {}`, y los checkouts usan `ref: refs/tags/…` (una rama homónima no puede suplantar al tag).

---

## Finding nuevo detectado y remediado en esta auditoría

### 🟡 MEDIUM-3 · `npm ci` ejecutaba scripts de terceros dentro del job que firma (A08)

**Dónde:** `kernel-release-workflow.proposed.yml`, job `publish`, paso "Instalar dependencias".

El job `publish` corre con `contents: write` + `packages: write` + `id-token: write`. El paso era
`npm ci` a secas, que ejecuta los scripts de instalación de **todas** las dependencias — y el kernel
declara `optionalDependencies: { "@anthropic-ai/sdk": "*", "puppeteer": "*", "sharp": "*" }`;
`puppeteer` y `sharp` descargan binarios de la red en su postinstall.

Ese código de terceros corría **antes** de `npm pack`, `npm publish` y `cosign sign-blob`, en un job
donde las variables OIDC (`ACTIONS_ID_TOKEN_REQUEST_*`) están disponibles a nivel job. Una dependencia
comprometida podía manipular el árbol antes de empaquetar — con lo cual **se publicaría y se firmaría
el tarball manipulado, y la firma sería válida** — o pedir un token OIDC y firmar en nombre del kernel.
Es decir, degradaba justamente la garantía que CA-C2 existe para dar.

**Verificado que el paso era innecesario:** el kernel **no tiene `prepare` ni `prepack`** y su `files:`
es una lista estática, así que empaquetar no necesita `node_modules` ni esos scripts.

**Remediación aplicada:** `npm ci` → `npm ci --ignore-scripts`, con el motivo documentado en el YAML,
más el test de regresión `el job publish no ejecuta scripts de dependencias de terceros (MEDIUM-3)`.
Atenuante preexistente: la fase 1 de `kernel-release.js` pinea los comodines `*` y genera el
`package-lock.json`, así que las versiones quedan fijadas con hash de integridad.

---

## Observaciones residuales (no bloquean · recomendadas para #4695 o seguimiento)

- ⚪ **LOW-2 · La red fail-closed no cubre escaladas de permisos.** `assertGateSafety` valida
  `permissions.contents` sólo en forma de mapping: no detecta `permissions: write-all` a nivel
  workflow (forma string) ni permisos elevados agregados a un job que hoy es read-only (probado
  empíricamente: ambos casos pasan). No es explotable con el YAML actual — que ya fue auditado —
  pero conviene endurecer el verificador para que una edición futura del archivo no abra ese flanco
  sin que nadie lo note.
- ⚪ **LOW-3 · El precheck CA-C0 confía en el nombre del archivo, no en el veredicto.** El chequeo de
  `kernel-release.js:103-107` da por cumplido el sign-off si *existe* un archivo cuyo nombre matchea
  el patrón. Un informe de seguridad **con veredicto negativo** destrabaría el gate si quedara
  guardado con un nombre que matchea — de hecho el auditor previo tuvo que elegir el nombre a
  propósito para evitarlo. Recomendación: parsear el veredicto dentro del documento.
- ℹ️ El gate `environment` depende de configuración fuera del YAML (required reviewers). Esto **sí**
  está cubierto fail-closed: la fase 3 verifica post-creación que el reviewer quedó registrado y, si
  el plan no lo permite, borra el environment a medio crear y aborta (`kernel-release.js:189-206`).

---

## Checklist OWASP

| Categoría | Estado | Nota |
|-----------|--------|------|
| A01 Broken Access Control | **PASS** | Gate humano efectivo en los dos modos, verificado por ejecución + aserción fail-closed |
| A02 Cryptographic Failures | PASS | cosign OIDC keyless; sin claves de larga vida |
| A03 Injection | **PASS** | Ningún `${{ }}` dentro de `run:`; asegurado estructuralmente |
| A04 Insecure Design | PASS | El gate se verifica después de aplicarlo; ya no se confía en que la edición haya funcionado |
| A05 Security Misconfiguration | PASS | `guard` valida el tag fail-closed; checkout por `refs/tags/` |
| A06 Vulnerable Components | PASS | Sin dependencias nuevas; scripts de instalación deshabilitados en el job de firma |
| A07 Auth Failures | PASS | `secrets.GITHUB_TOKEN` builtin scoped al job; sin PAT embebido |
| A08 Software Integrity | **PASS** | Actions por SHA (verificados), un solo tarball publicado y firmado, sha256 adjunto |
| A09 Logging Failures | PASS | No se loguean secretos |
| A10 SSRF | PASS | Sin URLs construidas con input externo |

---

## Condiciones de vigencia

Este sign-off cubre el `kernel-release-workflow.proposed.yml` **en su estado actual**. Debe
re-emitirse si se modifica el YAML, la transformación de gate o los pines de las actions. El
test `kernel-release-gate-4695.test.js` (16/16) es el guardián de las propiedades firmadas:
si falla, el sign-off queda suspendido.

`--skip-signoff-check` **no es necesario** y no debe usarse: el precheck CA-C0 queda satisfecho
por este documento.
