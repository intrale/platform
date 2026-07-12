# Inventario de lo migrado — Ola 9.1 · Motor → repo del kernel (#4663)

> **Alcance 9.1:** mover código del **motor** + preservar historia + inventariar.
> El ajuste de imports/wiring es #4664 y la paridad E2E es #4665 — **fuera** de este issue.
> El `.pipeline/` del producto **queda tal cual** (coexistencia; freeze/cutover posterior);
> acá sólo se **extrajo** el subconjunto motor hacia el repo del kernel.
>
> **Frontera autoritativa:** [`docs/pipeline/kernel-migration-plan.md`](../pipeline/kernel-migration-plan.md)
> §2.1 (skills) y §2.3 (`.pipeline/*.js` + hooks). (Corrige la referencia rota
> `docs/pipeline/ola9-sub-olas-migracion.md` del body — CA-6.)

## 1. Origen y destino

| Campo | Valor |
|-------|-------|
| Repo origen | `intrale/platform` |
| Commit origen (main) | `6f8675c1b3045c5236fe9d4ffb77271c67fb84c5` ("Ola 9.1 · Crear repo del kernel… #4667") |
| Repo destino | `intrale/kernel` (**privado** — REQ-SEC-2 visibilidad) |
| Rama destino | `import/motor-9.1` |
| Tag pineado destino | `motor-9.1-import` (annotated) — REQ-SEC-5 (consumo por tag/commit pineado) |
| Commit tip destino (kernel) | `cefcf303e00a1a71a44049665afd171a24a1d6ea` |
| Commits en la historia motor extraída | **694** (rango `8b7b4291…` "El Centinela v2 #812" → `cefcf303…`) |

> **Nota de gobernanza (REQ-SEC-2):** el repo del kernel es privado, pero *branch
> protection* no está disponible en el plan actual (GitHub Free · repo privado →
> `GET …/branches/main/protection` devuelve HTTP 403). Mitigación: visibilidad
> privada + colaboradores ⊆ platform + tag pineado + revisión humana para
> integrar a `main`. GitHub rechaza un PR entre historias no relacionadas
> ("no history in common with main"); la integración a `main`
> (`git merge --allow-unrelated-histories`, reconciliando los `.gitkeep` del
> scaffold del commit 1) queda como paso de **#4664 (wiring)** o merge humano.
> El deliverable de 9.1 —"push al repo del kernel por tag/commit pineado"— queda
> satisfecho por la rama + tag.

## 2. Método de extracción

- **Herramienta:** `git filter-repo` **v2.47.0** (instalado con `pip install git-filter-repo`;
  `git-filter-repo` no venía en el entorno — PRE-2).
- **Aislamiento:** ejecutado sobre un **clon/staging temporal** (`git clone --no-hardlinks`
  desde el worktree en `platform@6f8675c1b`), **nunca** sobre el repo vivo (CA-1).
- **Selección + re-ubicación:** un `--filename-callback` determinístico
  ([`.pipeline/kernel-bootstrap/motor-9.1-filename-callback.py`](../../.pipeline/kernel-bootstrap/motor-9.1-filename-callback.py))
  que mantiene sólo la frontera §2.1/§2.3 y la re-ubica al layout del kernel
  (`kernel-repo-design.md §1`). Se usó callback en vez de la receta literal del
  Arquitecto porque ésta tenía dos bugs de path: `--path pulpo.js` (el archivo vive
  en `.pipeline/pulpo.js`) y la exclusión de `apk-freshness.js` en un 2º pase con el
  path *pre-rename* (que ya no matchea tras el rename).
- **2º pase:** `git filter-repo --path lib/__tests__/apk-freshness.test.js --invert-paths`
  para excluir el test huérfano del módulo de producto excluido.

### Mapa de re-ubicación (platform → kernel)

| Origen (platform) | Destino (kernel) |
|-------------------|------------------|
| `.pipeline/pulpo.js` | `core/pulpo.js` |
| `.pipeline/dashboard.js` | `core/dashboard.js` |
| `.pipeline/lib/**` (excepto `apk-freshness.js` + su test) | `lib/**` |
| `.claude/skills/{delivery,branch,cost,handoff,reset,ops,auth,monitor,ghostbusters,pipeline-dev}` | `skills/…` |
| `.claude/skills/_frozen/scrum` | `skills/_frozen/scrum` |
| `.claude/hooks/{agent-concurrency-check,agent-registry,activity-logger}.js` | `hooks/…` |

## 3. Inventario efectivo (801 archivos)

| Top-level (kernel) | Archivos | Contenido |
|--------------------|---------:|-----------|
| `core/` | 2 | `pulpo.js`, `dashboard.js` |
| `hooks/` | 3 | `agent-concurrency-check.js`, `agent-registry.js`, `activity-logger.js` |
| `lib/` | 782 | `.pipeline/lib/**` (incluye `credentials.js`, `handoff.js`, `redact.js`, `architect-*`, `write-deliverable.js`, delivery/agent-launcher/commander/multi-provider, tests y fixtures) **menos** `apk-freshness.js` + `apk-freshness.test.js` |
| `skills/` | 14 | 10 skills genéricas + `_frozen/scrum` (11 directorios) |
| **Total** | **801** | |

## 4. Guardia de frontera (CA-2 — nada de producto se movió)

`git ls-files` del staging es la unión exacta de §2.1/§2.3. Verificado ausente:

```
$ git ls-files | grep -iE '(^|/)(android-dev|backend-dev|web-dev|ux)/|/_frozen/(desktop|ios)-dev/|skills/(refinar|po|priorizar|review|guru|security|planner|historia|doc|qa)/|apk-freshness|config\.yaml|CLAUDE\.md|^\.pipeline/|^\.claude/'
→ (sin resultados) — GUARD OK, cero producto
```

- `apk-freshness.js` **y** su test excluidos (adaptador de producto — conoce el APK).
- Archivos en `lib/` cuyo **nombre** referencia una skill de producto
  (`android-dev-deliverable-guard.js`, `delivery/commit-builder.js`, `delivery/pr-builder.js`)
  se mantienen: son **mecanismos** genéricos (el scope de enforcement lo decide el
  caller), consistente con §2.3 "`lib/**` → kernel excepto `apk-freshness.js`" y el
  principio del contrato #4010 §2 (mecanismo→kernel).

## 5. Historia preservada (CA-1 — no squash)

| Archivo | Commits en kernel | Commits en platform | ¿Match? |
|---------|------------------:|--------------------:|:-------:|
| `core/pulpo.js` | 337 | 337 | ✅ |
| `lib/credentials.js` | 4 | 4 | ✅ |
| `lib/redact.js` | 5 | 5 | ✅ |
| `lib/handoff.js` | 1 | 1 | ✅ (creado una vez, nunca modificado) |

Verificación en el remoto (branch `import/motor-9.1`):
`GET repos/intrale/kernel/commits?sha=import/motor-9.1&path=core/pulpo.js` → ≥100 (paginado; no squash).

## 6. Escaneo de secretos historia-completa (CA-3 / REQ-SEC-1 — fail-closed)

- **Herramienta:** `gitleaks`/`trufflehog` **no instalados** (verificado). Se usó la
  primitiva fail-closed del runtime `.pipeline/sanitizer.js` aplicada a **toda la
  historia** (`git rev-list --objects --all` → cada blob por `sanitize()`), tal como
  #4662 (RS-2 / Guru RS) cerró como método equivalente aceptado del proyecto
  (equivalencia con `kernel-migration-plan.md §3.3`).
  Escáner: [`.pipeline/kernel-bootstrap/scan-history-9.1.js`](../../.pipeline/kernel-bootstrap/scan-history-9.1.js).
- **Resultado:** **2390 blobs** escaneados (historia completa); **cero secretos reales**.
- **773 matches adjudicados** como falsos positivos, con allowlist auditada
  ([`.pipeline/kernel-bootstrap/motor-9.1-secret-allowlist.json`](../../.pipeline/kernel-bootstrap/motor-9.1-secret-allowlist.json)):
  - Vectores de test **fake** deliberados (`AKIAIOSFODNN7EXAMPLE` = ejemplo oficial AWS docs,
    `sk-ant-fake-*`, `ghp_AbCdEf…`, `test-secret-no-real`) en la suite de redacción #2993.
  - Fixtures binarios (`.mp3` TTS, `.pyc`).
  - Variables de runtime (`token = params.get('token')`, `Bearer ${apiKey}`), comentarios
    que documentan los propios patrones de redacción, y rangos de char en regex.
- **Fail-closed:** el escáner frena ante **cualquier** hit fuera de la allowlist
  (demostrado: rechazó `lib/*.test.js` hasta agregarlos explícitamente). Una fuga real
  nueva bloquearía el cutover.

```
$ node .pipeline/kernel-bootstrap/scan-history-9.1.js <staging> .pipeline/kernel-bootstrap/motor-9.1-secret-allowlist.json
OK — 2390 blob(s) de historia completa escaneados; cero hallazgos reales (773 match(es) adjudicados …)
```

- **Frontera de secretos preservada (CA-4 / REQ-SEC-3):** `lib/credentials.js` sigue
  leyendo de `~/.claude/secrets/credentials.json` (path canónico, fuera del repo);
  `lib/handoff.js` mantiene `require('./redact')` (cadena de redacción intacta);
  `lib/redact.js` conserva sus patrones (AWS/JWT/api-key/password). El kernel **nace
  sin secretos**.

## 7. Fuera de alcance (no en 9.1)

- Ajuste de imports/wiring de los `.js` → **#4664**.
- Integración a `main` del kernel (merge unrelated-histories + reconciliar scaffold) → **#4664** / merge humano.
- Paridad E2E + test funcional de la invariante de redacción SEC-1 → **#4665**.
- Externalización del estado operativo del `.pipeline/` → **9.4**.
- Partición de skills "a-decidir", `config.yaml`, `CLAUDE.md` → **9.2/9.3**.

## 8. Tooling reproducible (queda en platform)

- `.pipeline/kernel-bootstrap/motor-9.1-filename-callback.py` — selección + re-ubicación.
- `.pipeline/kernel-bootstrap/scan-history-9.1.js` — escáner de secretos historia-completa (fail-closed, con allowlist).
- `.pipeline/kernel-bootstrap/motor-9.1-secret-allowlist.json` — falsos positivos adjudicados.
- `.pipeline/tests/kernel-scan-history-9.1.test.js` — tests `node --test` del escáner/allowlist.
