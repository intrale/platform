# Costo de pasar los repos a privados — medición y recomendación (#7594)

> Spike de medición. Ventana medida: **2026-08-24 → 2026-09-22 (30 días)**. Tarifas tomadas el 2026-09-23.
> Datos agregados: [`evidence/7594/actions-usage-summary.json`](evidence/7594/actions-usage-summary.json) · tarifas: [`evidence/7594/pricing.json`](evidence/7594/pricing.json).

## Decisión

- **`platform` → seguir público por ahora.** Hoy cuesta USD 0. Privatizarlo tal como está costaría **USD 196/mes** (Team + GHAS), o **USD 120/mes** si antes se optimiza *Security SAST*.
- **Un solo workflow explica el 82 % del costo:** *Security SAST*, y adentro de él el job *OWASP Dependency Check*, que corre en cada PR. Pasarlo a un schedule diario baja los minutos de ~18.000 a ~5.300 por mes. Esa optimización es la condición para privatizar `platform`.
- **`kernel` → sigue privado.** No tuvo runs en la ventana: costo USD 0, dentro de los minutos incluidos.
- **Los 21 repos legacy → archivar.** No corren Actions, así que privatizarlos o archivarlos cuesta USD 0. La decisión es solamente de exposición.

## Por repo

| Repo | Recomendación | USD/mes | Motivo |
|---|---|---:|---|
| `platform` | **Público** (privatizar después de optimizar SAST) | **0** hoy · 120 privado optimizado · 196 privado sin optimizar | 18.008 min facturables por mes medidos; el 82 % es Security SAST. |
| `kernel` | **Privado** (ya lo es) | **0** | 0 runs en la ventana; 28 min en todo su historial, dentro de la cuota incluida. |
| 21 repos legacy (`repo`, `codex`, `backend`, `users`, `app`, `intrale-*`, `back-core`, …) | **Archivar** | **0** | Sin Actions y sin push desde 2025-06: la decisión es de exposición o archivado, no de costo. |

## Escenarios para `platform` (costo mensual)

> **⚠ Limitación — sin calibrar contra una factura real.** El método no se comparó con lo que GitHub factura de verdad. `kernel` (privado) es el único repo que permite hacerlo, pero no tuvo runs en la ventana. Su historial completo (22 runs, 2026-07-13 → 2026-07-28) da **28 min facturables (6,95 min crudos)** por este método. Para calibrar, un humano con `admin:org` tiene que comparar ese número con `/organizations/intrale/settings/billing/usage` de julio. Hasta entonces, los montos son una medición por job, no una factura.

| Escenario | Min. facturables | Excedente | USD minutos | USD storage | USD asientos | GHAS o control perdido | **Total USD/mes** |
|---|---:|---:|---:|---:|---:|---|---:|
| Seguir público | 0 | 0 | 0,00 | 0,00 | 0,00 | Code scanning y secret scanning incluidos gratis | **0,00** |
| Privado · Free | 18.008 | 16.008 | 96,03 | 0,52 | 0,00 | ⚠ **Se pierde: code scanning / push protection** (GHAS no se vende en Free) | **96,55** |
| Privado · Team + GHAS | 18.008 | 15.008 | 90,03 | 0,15 | 8,00 | GHAS 98,00 (2 committers × USD 49) | **196,18** |
| Privado · Team optimizado + GHAS | 5.321 | 2.321 | 13,92 | 0,15 | 8,00 | GHAS 98,00 (2 committers × USD 49) | **120,07** |

- **Privado · Free, detalle de lo que se pierde:** el `upload-sarif` de Semgrep (`security-sast.yml`) deja de publicar alertas en la pestaña Security. También se pierden el secret scanning y la push protection del lado del servidor. El reemplazo es parcial: Semgrep, detect-secrets y *Secret scan (blocking)* siguen corriendo en CI, pero ya no hay push protection. Un secreto commiteado por un agente llega igual al remoto.
- **Referencia sin GHAS:** Team optimizado sin GHAS costaría ~USD 22/mes (13,92 + 0,15 + 8). Free optimizado costaría ~USD 20/mes (3.321 min de excedente × 0,006 + 0,52). Los dos pierden los mismos controles que *Privado · Free*.
- **Excedente** = `max(0, minutos facturables − incluidos del plan)`. Free incluye 2.000 min y Team 3.000. El precio Team (USD 4 por asiento) figura en la página de pricing como precio de los primeros 12 meses.
- **Storage:** 2,59 GB de artefactos vigentes (366 artefactos) y 8,02 GB de caché. La caché no paga porque está debajo de los 10 GB gratis por repo. Los artefactos pagan el excedente sobre 0,5 GB (Free) o 2 GB (Team).

### Costo por release (runners caros)

| Workflow | Runner | Min. facturables por release | USD por release | Último run |
|---|---|---:|---:|---|
| `distribute-desktop.yml` | Linux + **Windows ×2** | 29 | 0,15 | 2026-08-28 |
| `distribute-web.yml` | Linux | 13 | 0,08 | 2026-08-28 |
| `distribute-android.yml` | Linux | 10 | 0,06 | 2026-04-09 |
| `distribute-ios.yml` | **macOS ×10** (3 jobs) | sin runs completados: no hay medición | — | nunca |

Con la cadencia actual, los releases pesan menos de USD 1 por mes. iOS es el riesgo: cada minuto de macOS consume 10 de la cuota. Si se activa, hay que medirlo antes de privatizar.

## Workflows que dominan el costo (top 5)

| # | Workflow | Min. facturables | % del total | p50 / p95 (min) | Optimización propuesta |
|---|---|---:|---:|---|---|
| 1 | **Security SAST** | 14.703 | **81,7 %** | 13 / 226 | Pasar *OWASP Dependency Check* de correr en cada PR a un schedule diario: ahorra ~12.068 min/mes. Sumar `concurrency` + `cancel-in-progress`: ahorra ~23 min más. |
| 2 | Admission Gate | 1.207 | 6,7 % | 1 / 1 | Nada material: son jobs de segundos que se redondean a 1 min, y ya tiene `concurrency`. |
| 3 | PR Checks | 951 | 5,3 % | 2 / 13 | `concurrency` + `cancel-in-progress`: ~37 min/mes. |
| 4 | Operational State Lint | 320 | 1,8 % | 1 / 1 | Consolidar los 5 lints en un solo job (un redondeo por commit en lugar de cinco): ~559 min/mes entre todos. |
| 5 | Ghost Artifact Lint | 319 | 1,8 % | 1 / 1 | Consolidación de lints (ver #4). Los lints **ya tienen** filtros de `paths`, así que agregarlos no ahorra nada. |

**Security SAST domina el costo.** Sin tocarlo, ninguna otra optimización cambia la decisión. El escenario "optimizado" suma los ahorros medidos de estas cuatro reglas (12.068 + 23 + 37 + 559 = 12.687 min). No usa un porcentaje supuesto. Este spike no aplica ninguna de las optimizaciones: eso queda para la historia que ejecuta la decisión.

## Impacto no económico de privatizar

| Tema | Qué pasa si `platform` pasa a privado |
|---|---|
| **Releases** | `distribute-desktop.yml` publica los instaladores MSI/Deb como *prerelease* en GitHub Releases. En privado, los testers sin acceso al repo no pueden bajarlos. |
| **Distribución a testers (RS-4)** | Hay que moverla a un canal con control de acceso: **Firebase App Distribution**, que ya usa Android, o **URLs firmadas con expiración**. **Nunca** un bucket público ni un link permanente. |
| **APKs** | Ya se distribuyen por Firebase App Distribution, así que no cambia nada. |
| **Web** | Se despliega a S3 + CloudFront, así que no depende de la visibilidad del repo. |
| **Artefactos** | Siguen existiendo, pero consumen la cuota de storage del plan (ver escenarios). La retención de 14 días ya está configurada. |
| **Pages** | No se usa: `repos/intrale/platform/pages` devuelve 404. Sin impacto. |
| **Herramientas externas** | Todo lo que lee el repo sin autenticarse deja de funcionar: links compartidos a PRs o issues, clones anónimos y servicios de terceros sin GitHub App instalada. El pipeline propio usa `gh` autenticado, así que no se afecta. |
| **Controles de seguridad (RS-1)** | Sin GHAS se pierden code scanning, secret scanning y push protection, que hoy son gratis (ver escenarios). |
| **Exposición histórica (RS-2)** | Privatizar **no** borra lo que ya fue público: historial git, forks, clones y cachés de terceros siguen existiendo. **No reemplaza rotar credenciales.** Un secreto que estuvo en la historia se rota igual. |
| **Comentarios e issues de terceros (RS-3)** | Cerrar el repo **reduce la superficie**, porque ya no puede comentar cualquiera (el vector de #6996). Colaboradores, bots y GitHub Apps siguen escribiendo, así que `admission-gate.yml` y la validación de autor de los markers de dependencias **se mantienen** en cualquier escenario. |

## Método (cómo se midió)

La API de timing de Actions devuelve 0 minutos facturables en repos públicos, así que el consumo se deriva de la **duración real de cada job**:

1. **Un día por vez:** `GET /repos/intrale/{repo}/actions/runs?created=YYYY-MM-DD&per_page=100`, paginado. Si un día supera los 1000 resultados, se parte por hora. Así se evita el tope silencioso de la API.
2. **Jobs de cada run:** `GET /actions/runs/{id}/jobs?filter=all`. Incluye los reintentos (`run_attempt > 1`), que en privado también se facturan.
3. **Minutos por job:** `ceil((completed_at − started_at) / 60 s) × multiplicador` (Linux 1, Windows 2, macOS 10), con mínimo 1 min por job que corrió. `started_at` es posterior a la cola, así que **la espera no cuenta**. Los jobs `skipped` o sin `started_at` valen 0.
4. **Crudos vs. redondeados:** 15.056,78 min crudos contra **18.008 facturables**. El redondeo por job suma un 20 %, casi todo en jobs de segundos (Admission Gate: 128 min crudos se facturan como 1.207).
5. **Storage:** `actions/cache/usage` y `actions/artifacts` filtrando los no expirados.
6. **Committers activos (para GHAS):** autores distintos de commits de los últimos 90 días (máximo entre repos): 2.
7. **Volumen medido:** 2.847 runs, 3.990 jobs y 2.971 llamadas a la API, con throttle por `x-ratelimit-remaining`.

Para reproducirlo (con la sesión de `gh` existente o un `GH_TOKEN` de solo lectura con `actions:read` y `metadata:read`):

```bash
node scripts/measure-actions-billing.js --repos platform,kernel --days 30 \
     --pricing docs/pipeline/evidence/7594/pricing.json \
     --out docs/pipeline/evidence/7594 --raw <dir-fuera-del-repo>
```

Las respuestas crudas se cachean en `--raw`, que por diseño está fuera del repo, para poder reanudar. El JSON versionado tiene solamente agregados.

---

**Tarifas** (consultadas el 2026-09-23): Linux USD 0,006/min · Windows USD 0,010/min · macOS USD 0,062/min ([actions-runner-pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)). Cuota incluida y storage: Free 2.000 min / 0,5 GB, Team 3.000 min / 2 GB, artefactos USD 0,25/GB, caché gratis hasta 10 GB por repo ([product-billing/github-actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions)). Team USD 4 por asiento por mes ([pricing](https://github.com/pricing)). GHAS: Secret Protection USD 19 + Code Security USD 30 por committer activo por mes ([changelog GHAS](https://github.blog/changelog/2025-03-04-introducing-github-secret-protection-and-github-code-security/)).
