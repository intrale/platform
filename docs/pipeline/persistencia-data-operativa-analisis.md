# Persistencia de data operativa del pipeline — análisis comparativo

> **Naturaleza:** spike documental (issue #3898). El entregable es **este documento** + un plan de migración *draft*. No hay código de pipeline modificado en este PR.
> **Estado:** propuesta de decisión para desbloquear una futura épica de implementación.
> **Anclaje:** cada afirmación sobre el estado actual cita `path:línea` real del codebase (HEAD de `agent/3898-pipeline-dev`).

---

## 1. Resumen ejecutivo

### El problema en una frase

La configuración operativa del pipeline (horarios por provider, allowlists de pausa parcial, ventanas, cooldowns) **no es durable ni auditable de forma uniforme**: parte se pierde o se revierte cuando el pipeline se sincroniza con `main`, y parte sobrevive pero sin versionado ni traza de quién/cuándo la cambió.

### Los dos vectores de pérdida (matiz crítico de guru)

`git reset --hard` **no borra archivos untracked/ignored** — solo revierte los *tracked*. Por eso el dolor del operador viene de **dos vectores distintos que requieren soluciones distintas**:

| Vector | Qué pasa | Evidencia |
|--------|----------|-----------|
| **V1 — Config *tracked* revertida** | `restart.js` hace `git reset --hard FETCH_HEAD` en cada sync; cualquier ajuste local a un archivo versionado (`priority-windows.json`, `waves.json`, `agent-models.json`) vuelve al estado de `origin/main`. | `.pipeline/restart.js:105` |
| **V2 — Config *ignored* sin versionar** | Las allowlists/schedules/pausas están en `.gitignore`: sobreviven al reset, pero **no tienen versionado, ni auditoría, ni durabilidad** ante `rm`, limpieza o migración de máquina. | `.gitignore:124-130`, `.gitignore:134` |

No todo el dato necesita la misma solución. Confundir V1 con V2 lleva a sobre-ingeniería (poner una BD remota para algo que un commit firmado resuelve gratis).

### Recomendación final

**Solución híbrida por clase de dato, sesgada a file-first/git, con SQLite embebido como escalón de coordinación:**

1. **Config declarativa durable** (schedules, allowlists, priority-windows, ventanas QA) → **repositorio git separado con commits firmados (GPG/SSH)**, montado como subdir de `.pipeline/`. Resuelve V1 (sale del working tree que `reset --hard` pisa) y V2 (versionado + no-repudio + auditoría tamper-evident gratis).
2. **Estado transiente/efímero** (cooldowns, listener-offset, circuit-breaker) → **se queda como JSON volátil**, regenerable. No necesita BD. Es el caso donde "se pierde" es el comportamiento *correcto*.
3. **Estado de coordinación de alto write** (waves, blocked-issues, infra-health) → **JSON plano hoy; SQLite embebido (`node:sqlite`) como escalón** si aparece contención de escritura o se necesitan queries/transacciones atómicas.

**Por qué no una BD remota:** ninguna necesidad funcional actual (queries complejas, multi-host, concurrencia masiva) la justifica. Una BD remota agrega credenciales al runtime Node del pipeline —que hoy **no las tiene**—, latencia de red en cada lectura de intake, un servicio always-on (punto de falla + target de ataque permanente) y rompe el modelo filesystem-first del proyecto (memoria `feedback_filesystem-source-of-truth`). El AWS SDK Java existe en el backend pero **no** en el runtime Node de `.pipeline/` (no hay `.pipeline/package.json`), así que DynamoDB sumaría además un costo de bootstrap de dependencia.

### Tamaño estimado de la implementación futura

**Medio** (coincide con guru). No es un rewrite: es (a) crear el repo git de config + un wrapper de read/write de ~80-120 líneas, (b) migrar ~6 archivos de config de `.gitignore` al repo versionado, (c) opcionalmente introducir SQLite para coordinación. Sin servicios externos, sin credenciales nuevas, sin infra always-on.

---

## 2. Análisis comparativo (matriz)

La matriz **no es plana** (`opción × dimensión`). Sigue el eje de guru: cruza **opción × clase-de-dato × dimensión**, e incorpora la **7ma dimensión de seguridad** de security.

### 2.1 Las tres clases de dato (eje de guru)

| Clase | Ejemplos (archivo real) | Naturaleza | Persistencia ideal |
|-------|-------------------------|-----------|--------------------|
| **C1 — Config declarativa durable** | `provider-schedule.json`, `.partial-pause.json` (`.gitignore:125`), `priority-windows.json`, `waves.json`, ventanas QA | debe sobrevivir y ser auditable | versionado + durable + tamper-evident |
| **C2 — Estado transiente/efímero** | `cooldowns.json` (`.gitignore:128`), `listener-offset.json` (`.gitignore:130`), `circuit-breaker-infra.json` (`.gitignore:134`) | se regenera, TTL corto | volátil OK — no requiere BD |
| **C3 — Estado de coordinación** | `waves.json`, `blocked-issues.json` (`.gitignore:127`), infra-health | semi-durable, alto write | embebido rápido, escrituras atómicas |

**Tesis a defender:** *mezclar las 3 clases en una sola tecnología es el error a evitar.* Una BD remota para C2 es desperdicio (el dato es deliberadamente efímero); un commit git por cada write de C3 es inviable (alto write, ruido de historia). La recomendación correcta es **híbrida**. La matriz de abajo lo confirma: ninguna opción gana en las 3 clases a la vez.

### 2.2 Matriz opción × dimensión (escala: ✅ fuerte · 🟡 aceptable · ❌ débil)

| Opción | Durabilidad | Compl. operativa | Costo | Latencia (intake) | Acoplamiento (refactor) | Auditoría/versionado | **7. Seguridad** | Clase de dato que mejor sirve |
|--------|-------------|------------------|-------|-------------------|--------------------------|----------------------|------------------|-------------------------------|
| **SQLite embebido** (`node:sqlite`) | ✅ disco, ACID | ✅ zero-dep en Node 24 | ✅ $0 | ✅ µs (local) | 🟡 read/write wrapper | 🟡 requiere tabla audit-log | 🟡 sin red; archivo a proteger; audit no es tamper-evident por sí solo | **C3** (coordinación) |
| **LevelDB / RocksDB** | ✅ disco | 🟡 dep nativa (bootstrap) | ✅ $0 | ✅ µs | 🟡 API KV, binario opaco | ❌ sin historial nativo | 🟡 sin red; binario no inspeccionable; sin audit | C3 (write-heavy) |
| **Repo git separado firmado** | ✅ commits + remoto | ✅ git que el operador ya domina | ✅ $0 | ✅ lectura = read file local | ✅ archivos planos, mínimo wrapper | ✅ `git log`/`git blame`/`revert` + firma GPG/SSH | ✅ **no-repudio gratis, tamper-evident, sin credenciales de red** | **C1** (declarativa durable) |
| **DynamoDB** (AWS) | ✅ gestionado | ❌ credenciales + SDK + IAM | 🟡 pay-per-request | ❌ red por lectura | ❌ SDK no está en runtime Node | 🟡 streams/audit-log explícito | 🟡 cifrado at-rest/TLS, pero credenciales nuevas + blast radius IAM | C1/C3 *solo si* hay necesidad multi-host |
| **Redis** | 🟡 RDB/AOF, pensado para volátil | ❌ servicio always-on | 🟡 hosting/RAM | 🟡 red (local: rápido) | ❌ cliente + nuevo servicio | ❌ sin historial; audit aparte | ❌ **A05: sin AUTH/TLS = exposición total**; always-on = target permanente | **C2** (TTL nativo) — pero JSON volátil ya lo cubre |

### 2.3 La 7ma dimensión: Seguridad (eje de security) — mapeo OWASP

| Riesgo OWASP | Aplica a | Lectura por opción |
|--------------|----------|--------------------|
| **A01 Broken Access Control** | todas | `.partial-pause.json` es **control de acceso efectivo** (decide qué issues procesa el pipeline). Quién puede escribir la config = propiedad de seguridad. Git firmado restringe escritura legítima por identidad criptográfica; BD requiere IAM/grants explícitos. |
| **A02 Cryptographic Failures** | DynamoDB / PostgreSQL / Redis | Secrets at-rest e in-transit (TLS) son responsabilidad nueva en las remotas. Las embebidas/file-based no exponen red → N/A. |
| **A05 Security Misconfiguration** | Redis / Postgres remoto | Redis sin AUTH/TLS = exposición total de la config de control. Defaults inseguros. Descarte fuerte para C1. |
| **A08 Data Integrity Failures** | todas | *Config poisoning*: validar **schema al leer**. El proyecto ya tiene el patrón (`agent-models.json` + `agent-models.schema.json`, `data-residency-exclusions.json` + `.schema.json`). **Preservar este patrón es requisito**, sea cual sea el backend. |
| **A09 Logging/Monitoring Failures** | todas | El audit trail debe ser **tamper-evident**, no solo "existir". Git firmado lo da gratis; una tabla audit-log en BD solo cuenta si es **append-only/WORM**. Ya existe `.pipeline/lib/partial-pause-audit.js` (audita cambios de allowlist con autor+timestamp+motivo) — la solución elegida debe preservar o mejorar esa traza. |

**Criterio de descarte por gestión de secretos:**
- **Embebidas / file-based** (SQLite, LevelDB, repo git): superficie mínima, **sin credenciales de red**. El archivo/BD debe quedar con permisos restrictivos (no world-readable) y **nunca** contener secrets en claro.
- **Remotas** (DynamoDB, PostgreSQL, Redis): introducen credenciales en el runtime Node del pipeline, **que hoy no las tiene**. Si se eligiera una, es **obligatorio** consumirlas vía el cargador unificado `.pipeline/lib/credentials.js` (#3311, lee de `~/.claude/secrets/credentials.json`) — nunca env inline, nunca archivo de credenciales en repo, nunca loggear el DSN/connection-string. Sumar el costo de rotación al análisis.

---

## 3. Detalles por opción

### 3.1 SQLite embebido (`node:sqlite`)

**Qué es / cómo funciona.** Base de datos relacional ACID, single-file, sin servidor. **Hallazgo clave de este spike:** el runtime del pipeline corre en **Node v24.13.1** (verificado: `node --version`), que incluye el módulo `node:sqlite` **built-in** — es decir, SQLite **sin agregar ninguna dependencia** a un `.pipeline/` que deliberadamente no tiene `package.json` (deps mínimas). Esto neutraliza el principal contra histórico de SQLite en Node (la dep nativa `better-sqlite3`).

**Pros para el pipeline.** Latencia de microsegundos (archivo local, sin red) → no degrada el intake/spawn que el Pulpo ejecuta en cada ciclo. Escrituras **atómicas y transaccionales** → ideal para C3 (coordinación), donde hoy varios JSON sueltos pueden quedar inconsistentes entre sí (ej. el desync `waves.json` ↔ `.partial-pause.json` que ya motivó un detector en `pulpo.js:10586`). Queries SQL para reporting del dashboard sin parsear N archivos.

**Contras.** El archivo `.db` es **binario opaco**: el operador pierde la transparencia de abrir un `.json` con un editor (contra de DX señalado por ux). La auditoría **no es tamper-evident por sí sola** — requiere una tabla audit-log append-only y disciplina de no-UPDATE/DELETE. No versiona: un `reset --hard` no lo toca (si está fuera del tracking) pero tampoco da historial de cambios.

**Pseudocódigo minimalista.**
```js
// node:sqlite — zero dependencias en Node 24
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('.pipeline/state/coordination.db');
db.exec(`CREATE TABLE IF NOT EXISTS waves(
  issue INTEGER PRIMARY KEY, status TEXT, updated_at TEXT);`);
const upsert = db.prepare(
  `INSERT INTO waves(issue,status,updated_at) VALUES(?,?,?)
   ON CONFLICT(issue) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`);
upsert.run(3898, 'dev', new Date().toISOString());
```

### 3.2 LevelDB / RocksDB

**Qué es / cómo funciona.** Key-value stores embebidos, log-structured, optimizados para throughput de escritura alto. RocksDB (fork de LevelDB por Facebook) agrega column families y mejor compactación.

**Pros para el pipeline.** Escrituras muy rápidas (C3 write-heavy). Embebido, sin red.

**Contras.** Requiere **dependencia nativa** (`level`, `classic-level`) → costo de bootstrap en un runtime sin `package.json`, recompilación por plataforma (Windows incluido), y un binario opaco sin transparencia para el operador. **Sin historial/versionado nativo** (A09 débil). No aporta queries relacionales. Frente a SQLite-built-in pierde en casi todo para este caso: misma opacidad, pero agrega la dependencia que SQLite ya no necesita. **Descartada** salvo que aparezca un perfil de write extremo que SQLite no aguante (improbable en la escala del pipeline).

**Pseudocódigo.**
```js
const { Level } = require('level'); // <-- dep nativa, requiere npm install + build
const db = new Level('.pipeline/state/coord', { valueEncoding: 'json' });
await db.put('wave:3898', { status: 'dev', updatedAt: Date.now() });
```

### 3.3 Repo git separado con commits firmados (recomendado para C1)

**Qué es / cómo funciona.** Un repositorio git **distinto del repo de código** (o un subdir con su propio `.git`), montado en `.pipeline/config-data/`, donde vive la config declarativa durable como archivos planos (JSON/YAML). Cada cambio = un commit **firmado** (GPG o SSH signing). Push opcional a un remoto privado para durabilidad off-machine.

**Pros para el pipeline.** Resuelve **los dos vectores a la vez**: sale del working tree que `restart.js:105` pisa con `reset --hard` (V1) y aporta versionado + durabilidad que la config ignored no tiene (V2). **Auditoría tamper-evident gratis**: `git log`/`git blame` dan autor+timestamp+motivo verificables criptográficamente (no-repudio, A09 ✅), y `git revert` da rollback con un mental model que el operador **ya domina** (DX ✅, ux). Cero infra, cero credenciales de red, cero servicio always-on. Archivos planos = el operador sigue editando con un editor de texto y entiende el estado (transparencia, ux). Latencia de lectura = leer un archivo local (✅).

**Contras.** No apto para C3 write-heavy: un commit por cada cambio de coordinación generaría ruido de historia y contención. Requiere setup inicial de firma (GPG/SSH) y un wrapper que haga `commit` en cada write de config (≈ `git add && git commit -S -m`). Si el operador edita a mano sin commitear, el cambio no queda auditado → mitigable con un hook `post-write` o un pre-commit del Pulpo.

**Pseudocódigo.**
```js
const { execFileSync } = require('node:child_process');
const CFG = '.pipeline/config-data';
function writeConfig(file, obj, motivo, author) {
  fs.writeFileSync(`${CFG}/${file}`, JSON.stringify(obj, null, 2));
  execFileSync('git', ['-C', CFG, 'add', file]);
  // -S firma el commit → no-repudio; autor + timestamp van en el commit
  execFileSync('git', ['-C', CFG, 'commit', '-S',
    '--author', author, '-m', `config(${file}): ${motivo}`]);
}
// Auditoría: git -C .pipeline/config-data log --show-signature -- .partial-pause.json
```

### 3.4 DynamoDB (AWS)

**Qué es / cómo funciona.** BD NoSQL serverless gestionada, pay-per-request, ya presente en la *infra del producto* (backend Kotlin usa AWS SDK Java).

**Pros para el pipeline.** Durabilidad y disponibilidad gestionadas por AWS. Escalable. DynamoDB Streams puede alimentar un audit-log.

**Contras (decisivos).** El AWS SDK **no está en el runtime Node del pipeline** (no hay `.pipeline/package.json`; verificado: `.pipeline/node_modules` no existe) → sumaría dependencia + bootstrap. Introduce **credenciales de red** en un runtime que hoy no las maneja → obliga `credentials.js` + rotación + IAM least-privilege con tabla/cuenta **aislada** de la DynamoDB de negocio (Requisito 4 de security: no reusar credenciales del backend, no ampliar blast radius). **Latencia de red en cada lectura de intake** → degrada el throughput del Pulpo (dimensión latencia). Auditoría requiere Streams + tabla append-only explícita (no tamper-evident por defecto). **Sin necesidad funcional que lo justifique hoy.** PostgreSQL/RDS comparte este mismo perfil (credenciales + red + always-on/servicio gestionado + costo recurrente) con ACID y SQL a cambio; no se desarrolla como opción separada porque sus trade-offs frente al caso de uso son los mismos que DynamoDB y la conclusión no cambia.

**Pseudocódigo.**
```js
// Requiere @aws-sdk/client-dynamodb (no presente) + credenciales vía credentials.js
const creds = require('./lib/credentials').load(); // NUNCA env inline
const ddb = new DynamoDBClient({ region: 'us-east-1', credentials: creds.aws });
await ddb.send(new PutItemCommand({ TableName: 'pipeline-config',
  Item: { pk: { S: 'partial-pause' }, value: { S: JSON.stringify(allowlist) } } }));
```

### 3.5 Redis

**Qué es / cómo funciona.** Store in-memory con persistencia opcional (RDB/AOF) y **TTL nativo** — el fit teórico para C2 (estado efímero).

**Pros para el pipeline.** TTL nativo expresa "esto caduca" sin lógica propia. Muy rápido.

**Contras (decisivos).** Es un **servicio always-on**: contradice el modelo determinístico/event-driven, agrega un punto de falla **y** un target de ataque permanente. **A05 Security Misconfiguration**: Redis sin AUTH/TLS = exposición total de la config de control (`.partial-pause.json`, `blocked-issues.json`) → riesgo alto. Para C2, **el JSON volátil actual ya cumple**: el dato se regenera, "perderse en el reset" es el comportamiento correcto. Redis resolvería un problema que no existe a cambio de infra y superficie de ataque nuevas. **Descartado.**

---

## 4. Recomendación con plan de migración (draft)

### 4.1 Opción elegida: híbrido file-first por clase de dato

Derivado de la matriz (§2.2), no de preferencia previa:

| Clase | Solución | Por qué (celda ganadora de la matriz) |
|-------|----------|----------------------------------------|
| **C1 — declarativa durable** | **Repo git separado firmado** | Única opción con ✅ en auditoría tamper-evident + seguridad + DX, resolviendo V1 y V2 a la vez. |
| **C2 — transiente/efímero** | **JSON volátil (status quo)** | "Perderse" es correcto. Ninguna BD aporta valor; Redis agregaría riesgo. |
| **C3 — coordinación write-heavy** | **JSON hoy; SQLite (`node:sqlite`) como escalón** | Latencia µs + escrituras atómicas + zero-dep en Node 24. Resuelve inconsistencias multi-archivo (ej. desync detectado en `pulpo.js:10586`). |

Esto **refuta parcialmente** la idea de "una sola tecnología": la solución correcta es híbrida, y cada clase usa la celda que gana en su columna.

### 4.2 Fases de implementación (qué cambia y dónde)

**Fase 0 — Preparación (Simple).**
- Crear `.pipeline/config-data/` como repo git independiente (`git init`, remoto privado opcional).
- Configurar firma de commits (GPG o SSH signing) para la identidad del operador/Pulpo.
- Documentar el modelo en `docs/pipeline/`.

**Fase 1 — Migrar C1 al repo versionado (Medio).**
- Mover de `.gitignore` (V2) al repo de config: `.partial-pause.json`, `provider-schedule.json` y la config declarativa hoy ignored. Mover de tracked en `main` (V1) la que sufre `reset --hard`: `priority-windows.json`, `waves.json` (la parte declarativa), `agent-models.json`.
- Escribir un wrapper `.pipeline/lib/config-store.js` (~80-120 líneas): `readConfig(file)` (lee + valida contra `.schema.json` existente — preservar patrón A08) y `writeConfig(file, obj, motivo, author)` (escribe + `git commit -S`).
- Adaptar los call-sites que hoy hacen `fs.readFileSync` de esos archivos para pasar por el wrapper. Preservar/integrar `partial-pause-audit.js`.

**Fase 2 — SQLite para C3 (Medio, opcional/diferible).**
- Solo si aparece contención de write o necesidad de queries atómicas. Introducir `coordination.db` vía `node:sqlite`, migrar `waves`/`blocked-issues`/infra-health con una tabla audit-log append-only.

**Fase 3 — C2 sin cambios.** Documentar explícitamente que cooldowns/listener-offset/circuit-breaker **quedan volátiles a propósito**.

### 4.3 Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| Operador edita config a mano sin commitear → cambio sin auditar | Hook `post-write` / pre-commit del Pulpo que commitea automáticamente; o que el Pulpo rechace config con working-tree sucio en el repo de config. |
| Firma GPG/SSH agrega fricción de setup | Documentar setup una vez; el Pulpo puede firmar con una key propia de servicio. |
| `reset --hard` (`restart.js:105`) afecta al repo de config si queda dentro del working tree principal | El repo de config es **independiente** (su propio `.git`) y/o queda en `.gitignore` del repo principal → el reset no lo alcanza. **Verificar en la implementación.** |
| Schema drift (config poisoning, A08) | `readConfig` valida contra `.schema.json` al leer (patrón ya usado en `agent-models.json`/`data-residency-exclusions.json`). Falla cerrada con mensaje accionable al operador (DX, ux). |
| SQLite `.db` corrupto / lock | Degradar con mensaje accionable, no stacktrace (ux). Backup periódico del `.db`. |

### 4.4 Esbozo de criterios de aceptación de la implementación futura

- La config declarativa durable vive en `.pipeline/config-data/` (repo git independiente) y **sobrevive** a `node .pipeline/restart.js` (que ejecuta `reset --hard FETCH_HEAD`).
- Cada cambio de config produce un commit **firmado** con autor+timestamp+motivo; `git log --show-signature` lo verifica.
- `config-store.js` valida contra `.schema.json` al leer; un JSON inválido falla cerrada con mensaje al operador.
- C2 (cooldowns/listener-offset/circuit-breaker) permanece volátil; un test confirma que no se persiste.
- (Si se implementa Fase 2) writes de coordinación son atómicos; un test reproduce el escenario de desync `waves`↔`partial-pause` y verifica consistencia.
- Diff de credenciales = **cero**: ninguna credencial de red nueva en el runtime del pipeline.

---

## 5. Referencias técnicas

### Docs internos del proyecto (vigentes — verificados)
- `docs/pipeline/provider-schedule.md` — horarios de actividad/apagado por provider (C1).
- `docs/pipeline/pausa-parcial.md` — allowlist de pausa parcial `.partial-pause.json` (C1, control de acceso).
- `docs/pipeline/modo-descanso.md` — `rest-mode.json` y ventanas (C1/C2).
- `docs/pipeline/waves-schema.md` — esquema de `waves.json` (C3, coordinación).

### Anclas de código citadas (estado actual)
- `.pipeline/restart.js:105` — `git reset --hard FETCH_HEAD` (origen del vector V1).
- `.gitignore:124-130`, `.gitignore:134` — config ignored sin versionar (vector V2).
- `.pipeline/agent-models.json` + `.pipeline/agent-models.schema.json` — patrón tracked + validación de schema a preservar (A08).
- `.pipeline/data-residency-exclusions.json` + `.schema.json` — config compliance-sensible (Requisito 5 de security).
- `.pipeline/priority-windows.json`, `.pipeline/waves.json` — config declarativa durable (vector V1).
- `.pipeline/lib/credentials.js` (#3311) — cargador unificado de secretos; consumo obligatorio si se eligiera una opción remota.
- `.pipeline/lib/partial-pause-audit.js`, `.pipeline/pulpo.js:10586` — auditoría de allowlist y detector de desync ya existentes (a preservar/integrar).
- Runtime: **Node v24.13.1** (sin `.pipeline/package.json` → deps mínimas; `node:sqlite` disponible sin dependencias).

### Docs oficiales de las opciones evaluadas
- SQLite (`node:sqlite`): https://nodejs.org/api/sqlite.html · https://www.sqlite.org/docs.html
- LevelDB: https://github.com/google/leveldb · RocksDB: https://rocksdb.org/
- Git commit signing (GPG/SSH): https://git-scm.com/book/en/v2/Git-Tools-Signing-Your-Work
- DynamoDB: https://docs.aws.amazon.com/dynamodb/ · AWS SDK for JavaScript v3: https://docs.aws.amazon.com/sdk-for-javascript/
- PostgreSQL: https://www.postgresql.org/docs/ · AWS RDS: https://docs.aws.amazon.com/rds/
- Redis: https://redis.io/docs/ · seguridad/AUTH: https://redis.io/docs/management/security/

---

*Spike #3898 — documento de decisión. Recomendación derivada de la matriz (§2.2), alineada con los ejes de guru (clasificación de dato), security (7ma dimensión + secretos como descarte + auditoría tamper-evident) y ux (DX del operador). Pendiente de revisión por guru/arquitecto antes del cierre.*
