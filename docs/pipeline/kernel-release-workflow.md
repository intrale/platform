# Workflow de release del kernel — supply-chain (#4695 · Workstream C)

> Publish + firma + pin/bump del kernel `@intrale/operating-kernel`. Superficie
> nueva de cadena de suministro (OWASP **A08** integridad + **A01** control de
> acceso). Ver diseño en [`kernel-repo-design.md` §2–§4](kernel-repo-design.md),
> [`contrato-kernel-adaptador.md` §7](contrato-kernel-adaptador.md).

## Qué entrega este issue

Tres piezas, dos repos:

| Pieza | Repo | Estado |
|-------|------|--------|
| `release.yml` (publish + gate humano + firma cosign) | `intrale/kernel` | **Propuesto**, sin commitear (CA-C0, ver abajo) |
| `pipeline.config.json:kernel` (pin exacto + firma) | `intrale/platform` (este) | Migrado |
| `.pipeline/lib/kernel-resolver.js` (verificación fail-closed) | `intrale/platform` (este) | Implementado |

## CA-C0 · Gate bloqueante antes de commitear el `release.yml`

El `release.yml` destinado a `intrale/kernel/.github/workflows/release.yml` se
versiona **en este repo** como
[`kernel-release-workflow.proposed.yml`](kernel-release-workflow.proposed.yml)
—artefacto revisable—, **no** en el repo del kernel. Motivo: CA-C0 exige el
**sign-off de `security` sobre el YAML concreto ANTES del commit** del workflow
(el kernel ejecuta código arbitrario en las máquinas de dev: una versión
maliciosa = RCE). El commit al repo del kernel se hace recién con el sign-off
registrado, junto al escaneo de secretos previo al primer commit.

### Controles verificables en el YAML propuesto

- **CA-C1 (A01):** sin auto-publish. `permissions: contents: read` a nivel
  workflow; el job `publish` corre detrás de `environment: release` con required
  reviewers (gate humano nativo de GitHub) y eleva `packages/id-token/contents:
  write` sólo ahí. El job `verify` chequea `tag == package.json.version` (pin
  exacto) antes de publicar.
- **CA-C2 (A08):** firma del tag con **sigstore/cosign OIDC keyless** (`id-token:
  write`), sin claves privadas de larga vida (decisión de diseño cerrada por el
  arquitecto — NO GPG, NO provenance npm: GitHub Packages no la soporta). La
  firma se adjunta al GitHub Release.
- **CA-C4 (A01):** token de publish = `secrets.GITHUB_TOKEN` scoped al job (no
  PAT embebido). Branch protection en `main` del kernel + 2FA obligatorio en el
  registry se configuran en Settings del repo del kernel (fuera del YAML; parte
  del checklist de CA-C0).

## CA-C2/CA-C3 · Consumo pineado y verificado en el adaptador

`pipeline.config.json:kernel` migró el pin por SHA
(`pinnedRef: github:Intrale/kernel#704167b…`) a **versión exacta de registry** +
bloque `signature` (cosign OIDC) + `integrity` SRI:

- **Pin exacto:** `version: "0.1.0"` (nunca `^`/`~`). `kernel-resolver` rechaza
  rangos con `EXACT_SEMVER` (`/^\d+\.\d+\.\d+$/`).
- **Firma verificada antes de bumpear:** `assertReleaseSignature(pkg, manifest)`
  se invoca en `resolveEntry` (después de `assertKernelCompatible`) y es
  **fail-closed** — si la firma no verifica, NO se degrada en silencio al motor
  local. Corre también en el self-bootstrap (kernel-N → kernel-N+1) para evitar
  el loop de envenenamiento.
- **`npm ci` + SRI:** consumo reproducible contra `package-lock.json` con hashes
  SRI. El campo `integrity.sri` se puebla desde el lockfile cuando
  `@intrale/operating-kernel@0.1.0` esté publicado y firmado (gate humano CA-C1).
- **Coexistencia:** `consume: false` permanece intacto. El motor local de
  `.pipeline/` sigue operativo; el freeze es la sub-ola 9.5, fuera de este issue.

### Contrato de error accionable (DX · ux)

El gate fail-closed distingue las 3 causas con formato `Qué pasó / Por qué / Cómo
seguir` (mismo contrato que `assertKernelCompatible`):

1. **firma ausente/no verifica** → incluye el comando `cosign verify-blob …`.
2. **versión es un rango** en vez de exacta.
3. **paquete habilitado pero ausente/incompatible** (lo cubre `resolveEntry`).

## Comando de verificación manual (cosign)

```bash
cosign verify-blob \
  --certificate-identity-regexp '^https://github\.com/Intrale/kernel/\.github/workflows/release\.yml@refs/tags/v\d+\.\d+\.\d+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  <blob.tgz> --signature <kernel-X.Y.Z.sig> --certificate <kernel-X.Y.Z.pem>
```

## Tests

`node --test .pipeline/tests/kernel-resolver.test.js` cubre: (a) rechazo sin
firma verificada (incluye verificador que lanza excepción y config de firma
ausente), (b) rechazo de rangos/comodines semver, (c) fail-closed con paquete
ausente/incompatible, (d) happy-path de firma verificada, más el mapeo A03
`version→tag` y la declaración de firma en el manifiesto real.
