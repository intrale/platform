# Runbook: visibilidad y archivado de repositorios (#7595)

## Decisión y estado de ejecución

La decisión de [#7594](https://github.com/intrale/platform/issues/7594),
documentada en [el reporte de costo](../pipeline/costo-privatizar-repos-7594.md),
es **archivar los 21 repos legacy conservándolos públicos**. Archivar no oculta
el código ni borra forks, clones o cachés. Privatizarlos además requeriría una
decisión explícita por repo y repetir las precondiciones de este runbook.
`platform` permanece público; `kernel` ya es privado y no cambia.

**Estado: ejecutado.** El owner `leitolarreta` archivó los 21 repos legacy el
**26/09/2026 a las 07:27 (hora local del operador)**, de a uno, con su script
de operador (log `operador/archivar-repos-legacy-20260926-072717.log`, fuera del
repo): 21 archivados, 0 ya archivados, 0 salteados, cada uno verificado como
`archived=true` y todavía `public`. El Commander lo cotejó con
`gh repo list intrale`, y esta pasada lo re-verificó de forma read-only (§7).
No se cambió la visibilidad de ningún repo. `platform` (público) y `kernel`
(privado) quedaron intactos. Los repos de `unlam-tec-*` y los personales quedan
fuera de alcance por decisión del operador del 25/09.

Los 14 repos legacy con workflows registrados quedaron archivados con ese
retiro aceptado por el owner: un repo archivado es de sólo lectura y no dispara
Actions. Ninguno tenía runs ni releases (baseline y post-archivado), por lo que
no se cortó ninguna publicación. Los hallazgos del escáner siguen su triage
aparte (§7): la revocación/rotación de las credenciales expuestas (Firebase y API keys de GCP)
se sigue en #7683 y no bloquea esta historia.

## 1. Evidencia y herramientas

Evidencia versionada en [`../pipeline/evidence/7595/`](../pipeline/evidence/7595/):

- `inventory.json`: los 23 repos, visibilidad y archivado observados con
  `gh repo list intrale --limit 100 --json name,visibility,isArchived`.
- `legacy-baseline.json`: salida del verificador por cada repo antes del cambio.
- `secret-scan-summary.json`: conteos y códigos de salida del escaneo del historial.
- `anonymous-references.json`: referencias exactas desde archivos tracked de
  `docs/`, `README.md` y `.github/`; no contiene texto de credenciales.
- `credential-url-check.json`: búsqueda de URLs con credenciales, sin imprimir
  coincidencias ni valores. Una coincidencia requiere revisión, incluso si
  resulta ser texto de ejemplo en un log.
- `verification.txt`: tests, smoke y limitaciones de validación.

El verificador es Node puro y sólo hace GET autenticados por la sesión de `gh`:

```bash
export PATH="/c/Workspaces/gh-cli/bin:$PATH"
node .pipeline/lib/verify-repo-post-change.js \
  --repo intrale/codex --visibility public --archived false --profile legacy
```

Para un repo archivado se cambia únicamente `--archived true`. Código 0
significa que los controles consultados pasaron, no que todo el runbook esté
cumplido. Código 1 incluye evidencia del control fallido. Un 403/404, timeout
o respuesta ilegible no equivale a ausencia de workflows o releases.
El perfil legacy pagina workflows/releases y consulta el contador de runs;
sólo permite declarar CI/SAST/distribución no aplicables si los tres están vacíos.
Repos con workflows requieren revisión manual y evidencia de su retiro aceptado.

Perfil para un futuro repo activo privatizado:

```bash
node .pipeline/lib/verify-repo-post-change.js \
  --repo intrale/platform --visibility private --archived false --profile active \
  --since <fecha-UTC-del-PATCH> --minimum-rules <cantidad-previa> --sast required
```

Se usa la rama por defecto real (no se presupone `main`), reglas efectivas,
último run por workflow, análisis SARIF posterior al cambio, Actions habilitado
y política de forks sin ejecución, secretos ni tokens de escritura. La cantidad
de reglas es un mínimo: el owner compara además su contenido con el snapshot
previo. `--sast not-applicable` requiere justificación manual; no acredita una
migración de SARIF a artefactos. Si hay varios analizadores, se coteja el análisis
posterior de cada uno en la evidencia: el control automático acredita al menos uno.
Releases consultadas no prueban una distribución: descargas, publicación por
plataforma, identidad de pruebas, agentes y bot llevan su propia evidencia.

## 2. Escaneo previo, sin publicar secretos

Se descargó Gitleaks **8.30.1** del release oficial y se verificó el SHA256 del
ZIP contra `gitleaks_8.30.1_checksums.txt`. Los mirrors y reportes redactados
quedan fuera del repo, en el directorio temporal `intrale-7595-scan` del operador.
No se versionan secretos, matches, ubicaciones (archivo, línea o commit) de
hallazgos, mensajes de commits ni reportes crudos: la evidencia sólo lleva
conteos por regla. La rotación de lo encontrado se sigue en #7683.

Por cada repo se ejecutó un clone `--mirror` sin profundidad y un escaneo
`git --log-opts=--all`: todas las referencias descargadas, sin limitar la ventana
de fechas. No cubre objetos remotos inaccesibles ni clones externos. Configuración
independiente del repo escaneado, sin baseline y sin respetar comentarios de allow:

```toml
[extend]
useDefault = true
```

```bash
git clone --mirror https://github.com/intrale/<repo>.git <directorio-externo>/<repo>.git
git -C <directorio-externo>/<repo>.git rev-list --all --count
gitleaks git <directorio-externo>/<repo>.git --log-opts=--all \
  --config <directorio-externo>/scan.toml --redact=100 --ignore-gitleaks-allow \
  --gitleaks-ignore-path <directorio-externo-sin-ignore> --timeout 180 \
  --report-format json --report-path <directorio-externo>/reporte-redactado.json
```

Código 1 significa hallazgos; otro error/timeout no es un escaneo limpio.
Los hallazgos requieren triage por el responsable de seguridad. Para secretos
reales: revocación/rotación en el emisor y comprobación de que la credencial
anterior no funciona, sin pegar su valor; para falsos positivos: justificación
por fingerprint firmada. Un historial sin hallazgos tampoco garantiza ausencia
absoluta de secretos. Se repite el escaneo si cambian refs antes de ejecutar.

## 3. Operación humana, de a un repo

1. El owner confirma decisión por repo, fecha, reglas previas, consumidores,
   acceso de identidades y escaneo/triage cerrado. En los legacy con workflows
   acepta expresamente que el archivado impide futuras ejecuciones/publicaciones.
2. Para privatizar (no previsto ahora), cualquier ruleset exige primero un plan
   que lo mantenga aplicado, con costo aprobado y evidencia de funcionamiento.
   Se resuelven consumidores anónimos **antes** del PATCH. Ninguna credencial va
   en una URL: se usa `gh auth`/credential helper con acceso acotado por repo.
3. Sólo el owner humano ejecuta un comando por vez, con el nombre literal del
   repo revisado. No se ofrece un loop de mutación:

   ```bash
   gh api --method PATCH repos/intrale/<repo> -F archived=true
   ```

   Si en otra decisión se autoriza privatizar, el comando específico es
   `gh api --method PATCH repos/intrale/<repo> -f visibility=private`.
4. Captura estado final (`gh repo view intrale/<repo> --json visibility,isArchived`)
   y ejecuta el verificador. Adjunta JSON, identidad del owner y fecha al registro.
   Workflows existentes no se borran para fabricar un «sin workflows»: se documenta
   su retiro aceptado y se revisa cualquier distribución dependiente.
5. Verifica lectura anónima de enlaces para archivado público y acceso de las
   identidades que todavía deban leer. Un repo archivado no admite push ni nuevos
   comentarios: esos flujos deben migrarse a `platform` antes del archivado,
   con prueba real allí. No se promete que el bot siga escribiendo en el legacy.
6. Ejecuta `bash .pipeline/smoke-test.sh` y adjunta salida. Sólo con el registro
   completo del repo anterior se habilita el siguiente. El pipeline no se reinicia.

Registro por operación: repo, decisión, refs escaneadas/fecha, fingerprint y
resolución de hallazgos, aceptación del retiro de CI, consumidores migrados,
owner, instante del PATCH, estado previo/final, resultado del verificador y smoke.
Para los 21 legacy, owner, fecha y estado final están registrados en §7.

## 4. Plan de transición de `platform` (CA-9)

| Etapa | Entregable y criterio de pase verificable | Firma |
|---|---|---|
| 1 — Ola Poda del CI | #7658 inventaría **todo** el CI y documenta qué controles se conservan, cuáles se retiran y su pérdida. #7659 saca SAST del PR según esa decisión; #7660 implementa el resto; #7661 registra consumo por job/SO. Los cuatro issues cerrados, workflows acordados mergeados, un run exitoso por workflow conservado y evidencia de destino de SAST. | Owner y responsables de seguridad/CI aceptan por escrito los controles retirados y la evidencia. |
| 2 — Medición todavía pública | Una o dos olas completas de trabajo normal con CI reducido. Registrar fechas, número de runs/jobs por SO, minutos redondeados por job, storage, cadencia de releases y errores; proyectar mes incluyendo Windows/macOS, asientos y seguridad. Si una plataforma no tuvo actividad, falta evidencia: se mide su release antes de pasar. | Owner firma representatividad de la ventana y costo mensual medido/proyectado; PO acepta la evidencia de trabajo normal. |
| 3 — Privatización (#7662) | Plan elegido con cuota/costo que cubran el consumo medido y presupuesto autorizado. Rulesets funcionando antes del PATCH y controles de seguridad preservados o reemplazados con aceptación explícita. Todas las precondiciones siguientes probadas aún en público; ejecución humana por repo y verificaciones posteriores. | Owner autoriza costo, plan y cambio; seguridad cierra escaneo/credenciales; PO verifica distribución y mockups. |

**Condición dura: si el CI medido no entra en el plan elegido, `platform` no
se privatiza. El CI no se corta.** No alcanza con que un plan esté contratado:
la alternativa elegida debe estar probada en funcionamiento antes del PATCH.
`kernel` permanece privado y no forma parte de ninguna mutación ni reversión.

Precondiciones **no aplica en esta historia → las ejecuta #7662**:

- `distribute-desktop.yml` y `docs/desktop-testers-guide.md`: canal autenticado
  o URL de vida corta, descarga real por tester externo y aviso del canal nuevo.
  Sin bucket público ni URL firmada de larga vida.
- `security-sast.yml`: destino SARIF/code scanning o artefacto/check verificado;
  un upload fallido rompe el pase aunque `continue-on-error` deje el job verde.
- Skill UX y `screenshots-mockup-gate.js`: nuevo mecanismo de imágenes probado
  mediante captura de un mockup renderizado para el operador.
- #7624: escaneo completo/rotación del historial de `platform`.
- #7627: GitHub App o token fine-grained por repo para agentes, bot e identidad
  de pruebas. `credenciales-ambiente.js` no cambia: `GH_TOKEN` opcional sólo sirve
  en privado si la identidad tiene acceso explícito a ese repo; ausencia de
  acceso se registra, nunca se resuelve ampliando un token global.
- `admission-gate.yml`: cotejar que no hace checkout del head del PR, y políticas
  de forks sin ejecución, write tokens ni secrets. Pruebas reales de clone,
  push y comentario con **cada identidad**, no sólo con el token del owner.
- CI, Android/Firebase, iOS/TestFlight, Web/S3-CloudFront y Desktop: runs y
  distribución posteriores al cambio, no sólo un CI global verde.

## 5. Referencias anónimas y costos

El inventario adjunto registra archivo/línea por repo legacy. Al mantenerse
públicos, los enlaces de lectura y raw conservan acceso anónimo; los links de
issues/PR que requieran escritura se redirigen a `platform` antes del archivado.
Los badges de workflows retirados requieren aclaración del estado histórico.
No se da por resuelta una publicación Maven/artifact sin revisar su consumidor.
Desktop y mockups de `platform` no aplican aquí porque sigue público.

Legacy: **USD 0 proyectado contra USD 0 de consumo de Actions observado**
(cero runs antes y después del archivado del 26/09/2026, ver §7). Un repo
archivado no ejecuta Actions, así que el consumo posterior es cero por
construcción; la factura del ciclo queda como comprobación. No se compran asientos ni se
cambia de plan en esta historia. El owner registra comprobación a los 30 días
o al cerrar un ciclo después del último cambio; #7662 desglosa Actions por SO,
storage, asientos y plan. Desvío mayor al 20% requiere notificación al operador
con causa; con base cero, cualquier cargo nuevo exige revisión.

## 6. Reversión sólo por owner humano (CA-7)

Para desarchivar el repo revisado:

```bash
gh api --method PATCH repos/intrale/<repo> -F archived=false
```

Antes de volver público un repo privatizado se escanea **todo el historial
actual**, incluidos commits creados en privado, y se resuelve/rota cada hallazgo.
Sólo entonces el owner ejecuta:

```bash
gh api --method PATCH repos/intrale/<repo> -f visibility=public
```

**`kernel` queda excluido de toda reversión.** Desarchivar puede reactivar CI:
el owner revisa workflows y presupuesto antes del cambio. Se repiten controles
de reglas, acceso, consumidores y smoke. Los forks públicos desacoplados por
privatización **no se recuperan** al volver público. Rotar secretos sigue siendo
necesario aunque ya se haya cambiado la visibilidad.

## 7. Tabla de ejecución por repo

Estado final: archivado ejecutado por el owner `leitolarreta` el 26/09/2026 07:27
(log del operador `archivar-repos-legacy-20260926-072717.log`), en el orden de
menor a mayor riesgo de la tabla. Estado final re-verificado read-only el
2026-09-26 ~10:43 UTC con `gh repo list intrale`
([`inventory-post-archive.json`](../pipeline/evidence/7595/inventory-post-archive.json):
23 repos, 21 archivados, `platform` PUBLIC y `kernel` PRIVATE sin archivar) y con
el verificador por repo ([`post-archive-verifier.txt`](../pipeline/evidence/7595/post-archive-verifier.txt)).

| Orden | Repo | Estado previo | Estado final (26/09/2026) | Evidencia previa | Verificador post-archivado | Owner / fecha de ejecución |
|---|---|---|---|---|---|---|
| — | platform | PUBLIC; archived=false | PUBLIC; archived=false — sin cambio (etapa 3, #7662) | Fuera de mutación | Fuera de mutación | No aplica / no aplica |
| — | kernel | PRIVATE; archived=false | PRIVATE; archived=false — sin cambio | Fuera de mutación | Fuera de mutación | No aplica / no aplica |
| 1 | codex | PUBLIC; archived=false | PUBLIC; archived=true | 71 commits; 0 hallazgos; 0 workflows | exit 0: public, archivado, sin workflows/runs/releases | leitolarreta / 26/09/2026 07:27 |
| 2 | app | PUBLIC; archived=false | PUBLIC; archived=true | 8 commits; 0 hallazgos; 0 workflows | exit 0: public, archivado, sin workflows/runs/releases | leitolarreta / 26/09/2026 07:27 |
| 3 | back-core | PUBLIC; archived=false | PUBLIC; archived=true | 0 commits; 0 hallazgos; 0 workflows | exit 0: public, archivado, sin workflows/runs/releases | leitolarreta / 26/09/2026 07:27 |
| 4 | kotlin-multiplatform-example | PUBLIC; archived=false | PUBLIC; archived=true | 1 commits; 0 hallazgos; 0 workflows | exit 0: public, archivado, sin workflows/runs/releases | leitolarreta / 26/09/2026 07:27 |
| 5 | intrale-mobile-mercadopago | PUBLIC; archived=false | PUBLIC; archived=true | 6 commits; 0 hallazgos; 0 workflows | exit 0: public, archivado, sin workflows/runs/releases | leitolarreta / 26/09/2026 07:27 |
| 6 | intrale-web | PUBLIC; archived=false | PUBLIC; archived=true | 11 commits; 0 hallazgos; 0 workflows | exit 0: public, archivado, sin workflows/runs/releases | leitolarreta / 26/09/2026 07:27 |
| 7 | repo | PUBLIC; archived=false | PUBLIC; archived=true | 9 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`publish-ktor-artifacts.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 8 | backend | PUBLIC; archived=false | PUBLIC; archived=true | 99 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 9 | intrale-back-test | PUBLIC; archived=false | PUBLIC; archived=true | 41 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 10 | intrale-delivery | PUBLIC; archived=false | PUBLIC; archived=true | 72 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 11 | intrale-files | PUBLIC; archived=false | PUBLIC; archived=true | 88 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 12 | intrale-products | PUBLIC; archived=false | PUBLIC; archived=true | 64 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 13 | intrale-users | PUBLIC; archived=false | PUBLIC; archived=true | 99 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 14 | intrale-test | PUBLIC; archived=false | PUBLIC; archived=true | 90 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 15 | intrale-commons | PUBLIC; archived=false | PUBLIC; archived=true | 227 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 16 | intrale-core | PUBLIC; archived=false | PUBLIC; archived=true | 12 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 17 | intrale-arq-ms | PUBLIC; archived=false | PUBLIC; archived=true | 3 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 18 | intrale-parent | PUBLIC; archived=false | PUBLIC; archived=true | 199 commits; 0 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 19 | users | PUBLIC; archived=false | PUBLIC; archived=true | 161 commits; 2 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |
| 20 | intrale-mobile | PUBLIC; archived=false | PUBLIC; archived=true | 34 commits; 8 hallazgos; 0 workflows | exit 0: public, archivado, sin workflows/runs/releases | leitolarreta / 26/09/2026 07:27 |
| 21 | intrale-notifications | PUBLIC; archived=false | PUBLIC; archived=true | 24 commits; 1 hallazgos; 1 workflows | exit 1 sólo por workflow registrado (`main.yml`); public, archivado, 0 runs, 0 releases | leitolarreta / 26/09/2026 07:27 |

### Resultado empírico

- **Archivado (26/09/2026):** 21/21 repos legacy con `archived=true` y `visibility=public` en el verificador. Ninguno cambió de visibilidad.
- **Verificador:** 7 repos con código 0 (`codex`, `app`, `back-core`, `kotlin-multiplatform-example`, `intrale-mobile-mercadopago`, `intrale-web`, `intrale-mobile`). Los otros 14 devuelven código 1 **únicamente** por el control «sin workflows»: conservan registrado el workflow que ya figuraba en el baseline (`main.yml`, o `publish-ktor-artifacts.yml` en `repo`). En todos ellos pasan los controles de visibilidad, archivado, runs (0) y releases (0). El código 1 queda registrado tal cual: el owner aceptó el retiro de esos workflows al archivar, y un repo archivado no dispara Actions. No se borraron workflows para fabricar un «sin workflows».
- **CA-1:** cumplido según el alcance ajustado del 23/09. Los 21 legacy quedaron archivados y públicos, y `platform` sigue público con su fundamento en el plan de transición por etapas (§4, #7658-#7662). `kernel` sigue privado.
- **CA-4:** cumplido para los 21 legacy (visibilidad, archivado, runs y releases verificados uno por uno arriba). Los controles ligados a `platform` (CI propio, distribución Desktop, SAST, mockups, identidades) **no aplican en esta historia**: `platform` no cambió y quedan como precondiciones de #7662.
- **Escaneo previo:** Gitleaks 8.30.1 (SHA256 del ZIP `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`) sobre los 21 mirrors: 18 sin hallazgos (incluido `back-core`, vacío) y 11 hallazgos en `users` (2), `intrale-mobile` (8) e `intrale-notifications` (1, regla `private-key`). Se versionan sólo conteos por regla, sin archivo, línea ni commit. Archivar no cambia su exposición: el código ya era público. La revocación/rotación de la cuenta de servicio Firebase, de las API keys de GCP y el triage del resto se siguen en #7683, que no bloquea esta historia.
- **Costo:** USD 0 proyectado frente a USD 0 observado (0 runs antes y después). Un repo archivado no genera consumo de Actions.
