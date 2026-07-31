## Reporte de auditoría de seguridad — issue #5172

**Veredicto:** sin hallazgos

**Alcance auditado:** rama `agent/5172-pipeline-dev` @ `3d3fcfcba` (sin PR abierto).
Tercera pasada. Las anteriores cubrieron hasta `b3863bfbd` y `3e70357a5`. El delta
propio de esta pasada es **un solo commit**, `3d3fcfcba` ("Cerrar dos fail-open de la
migración al config-resolver"), 6 archivos / +498 líneas: `lib/quota-exhausted.js`,
`pulpo-liveness-run.js`, `watchdog-supervisor-run.js`, `lib/kernel-table-verify.js` y
2 tests nuevos. El otro commit del rango (`ecb552459`, #5276) **ya está en `origin/main`**
— verificado con `git merge-base --is-ancestor ecb552459 origin/main` — y se audita en
su propio issue.

### Hallazgos

**Sin hallazgos bloqueantes.** No se detectó inyección, bypass de autenticación o
autorización, secrets hardcodeados, exposición de valores crudos ni dependencias con
CVE. El commit **cierra** dos fail-open (mejora neta de postura).

Se registran dos observaciones **no bloqueantes** como recomendaciones con
`needs-human`: **#5298** (sentinel `__configViolation` in-band) y **#5299**
(`opts.configPath` sin confinamiento). Detalle abajo.

### Verificación empírica (sondas propias, no los tests del autor)

**1 · SEC-1 — ninguno de los tres caminos nuevos vuelca valores crudos del config**

`config.yaml` roto con canario tipo API key de Anthropic + AWS key en las líneas
adyacentes al error, y por separado un canario **dentro del valor** que viola el schema
(camino ajv). Se serializó el error entero (`name`, `message`, `stack`, props propias,
`cause`) y se reconstruyó la línea exacta que emiten los runners:

```
camino YAML  → name=ConfigParseViolation  causa=yaml-invalido linea=4 columna=17
  linea log  : FAIL-CLOSED: config.yaml ilegible o invalido (causa=yaml-invalido, linea=4, columna=17)
  leaks(linea log)  {"canary":false,"aws":false,"token_literal":false}
  leaks(dump err)   {"canary":false,"aws":false,"token_literal":false}
  leaks(err.message){"canary":false,"aws":false,"token_literal":false}
  cause encadenada  : undefined

camino ajv   → name=ConfigSchemaViolation causa=schema-invalido linea/col=undefined
  err.message: /concurrencia/max_agentes: tipo esperado: integer
  leaks       {"en_linea_runner":false,"en_message":false,"en_dump":false}

degradacion TTL de cuota (stderr)
  leaks       {"canary":false,"token":false}
```

El error tipado no encadena `cause` a propósito; el camino ajv deriva el texto del
SCHEMA (path + regla), nunca del valor. El payload de la alerta Telegram del supervisor
(`watchdog-supervisor-run.js:195-200`) es **100% literal estático** — no interpola `err`.

**2 · Fix (1) — el fail-open de cuota efectivamente se cierra, sin abrir otro**

Sonda propia con config corrupta y `setFlag` **sin** `maxDays` (que es como lo llama el
único call-site de producción, `dispatch-with-fallback.js`):

```
setFlag lanzo?       : NO (no lanza)
flag PERSISTIDO?     : true      → quota-exhausted.json escrito
traza de degradacion : [quota-exhausted] DEGRADACION TTL: no se pudo resolver el cap
                       de días para provider=anthropic — config inválida (causa=yaml-i...
leaks en stderr      : {"canary":false,"token":false}
```

Antes del fix, un config corrupto hacía que la señal de cuota se perdiera y el pipeline
siguiera despachando contra un proveedor en 429. El TTL cae a un default clampeado a
`[MIN_TTL_DAYS, MAX_TTL_DAYS]` y la degradación deja traza: no es el `catch {}` mudo
que el issue vino a matar.

**3 · Fix (2) — el fail-closed de los runners es real, no sólo texto de log**

Harness hermético propio en tmpdir (copia de los runners + shims que re-exportan los
módulos reales), que **no debilita** el `pipelineDir` explícito:

```
CONTROL supervisor (config sano)                 => ACTION:relaunch
CORRUPTO supervisor                              => ACTION:skip  (+ alerta al operador)
CONTROL liveness (hb vencido 999999ms, PID cruza)=> ACTION:kill-respawn
CORRUPTO liveness (sin override por env)         => ACTION:skip
```

El control **no es vacuo**: con config sano el supervisor sí relanza y el liveness sí
mata. La degradación que se evitaba está medida: `config.yaml` declara
`pulpo_liveness_kill_seconds: 180` y el default del módulo es 90s, o sea caer al default
reducía a la mitad el umbral de kill (dirección destructiva). `MODULE_NOT_FOUND` sigue
fail-soft a defaults, y la discriminación es por `isConfigViolation(err)` — no por
`err.code`, así que un bug del resolver no se hace pasar por corrupción de config.

**4 · Sin regresión de clasificación (D-G)**

```
ConfigParseViolation     => clasificado como: "corruption"
ConfigSchemaViolation    => clasificado como: "corruption"
```

Si el resolver lanzara un `name` fuera de la lista cerrada de `error-classifier.js`, la
corrupción de config dejaría de clasificarse como `corruption` — regresión silenciosa.
No ocurre.

**5 · Guard CA-2 — ningún lector de `config.yaml` fuera del resolver**

Barrido propio sobre producción (excluye `_tmp/`, `__tests__/`, `*.test.js`). Los
`yaml.load` que sobreviven son todos de **work-files / contratos**, no de config:
`dashboard.js:810` (loader genérico), `pulpo.js:1433` (`readYaml` de work-files,
verificado leyendo la función), `pipeline-rewind.js:457`, `task-contract.js:139`,
`rejection-report.js:333,375,1395`, `test-connectivity-state.js:262`. El único lector
real de config fuera del resolver es `test-dev-routing-regression.js:15`, que es el
harness allowlisteado por CA-3. `kernel-table-verify.js` (lector Nº29, llegado desde
#5276) quedó migrado en este commit.

**6 · `kernel-table-verify` — la migración endurece el fail-closed, no lo relaja**

No hay `try/catch` alrededor de `resolve()`; el error tipado sube hasta el `.catch` del
CLI, que sale con exit code 2. Verificado que "config ilegible" ya no se disfraza de
"sección kernel ausente":

```
A YAML corrupto            -> ConfigParseViolation | YAML inválido
B archivo inexistente      -> ConfigParseViolation | configuración no accesible
C YAML valido sin kernel:  -> Error genérico | faltan claves de config (kernel.tableName...)
```

Antes, `yaml.load(...) || {}` colapsaba un archivo vacío o `null` a `{}` y lo reportaba
como "faltan claves". Ahora `resolve()` lo rechaza como `empty-or-not-a-map`.

**7 · Patrones peligrosos y dependencias**

Sin `child_process` / `spawn` / `eval` / `new Function` / `vm.` en los 4 archivos de
**producción** del delta. Las 4 apariciones de `execFileSync` están sólo en los tests
nuevos, con binario `process.execPath` literal, args como array y **sin `shell: true`**;
la única interpolación pasa por `JSON.stringify` sobre constantes locales. Sin `fetch` /
`http` / `https` / `net` / `createServer` nuevos. Las escrituras nuevas apuntan a
`fs.mkdtempSync(os.tmpdir())`. Sin secrets hardcodeados (cero coincidencias de
`token|api_key|password|secret|AKIA|BEGIN .*PRIVATE` sobre las líneas agregadas).

```
$ git diff --stat origin/main...HEAD -- package.json package-lock.json \
      .pipeline/package.json .pipeline/package-lock.json
(vacío)
```

Sin cambios de dependencias ⇒ no se incorporan CVEs.

**8 · Suites verdes sobre este HEAD**

```
config-failclosed-runners-5172 + quota-setflag-config-corrupta-5172  → 12/12
config-resolver-{secrets,guard,failclosed} + gate3-config-failclosed → 46/46
```

### Observaciones no bloqueantes (recomendaciones creadas)

**#5298 · El sentinel `__configViolation` viaja en el namespace de datos de config.yaml.**
`loadWatchdogConfig()` devuelve `{ __configViolation: true }` por el mismo canal que, en
el camino sano, es la sección `watchdog:` parseada. Esa sección **no está en el schema**
(`config-schema.js` no la menciona; `additionalProperties` de tope es `undefined`), así
que la clave pasa la validación. Reproducido sobre un config **sano y schema-válido**:

```
validateConfig(doc con watchdog.__configViolation=true)  => true
CONTROL liveness   => ACTION:kill-respawn   |  SPOOF => ACTION:skip
CONTROL supervisor => ACTION:relaunch       |  SPOOF => ACTION:skip
```

Y el copy al operador queda falso: el log dice "hasta que config.yaml sea legible" y el
supervisor alerta "config.yaml ilegible o inválido" sobre un archivo válido, mandando la
respuesta a incidentes al archivo equivocado.

**Por qué NO bloquea:** escribir `config.yaml` exige el mismo privilegio que escribir los
propios runners `.js`. Verificado que no hay vía de menor privilegio — ningún endpoint
del dashboard muta config (`app.post|put|patch` + `req.body` filtrado por `config`: sin
resultados) y las escrituras con `yaml.dump` del pipeline apuntan a work-files. **No
cruza frontera de privilegio ⇒ no es vulnerabilidad explotable**, sí es confusión
dato/control en un mecanismo de seguridad. Queda señalado para que `review` decida si lo
cierra en esta entrega o en la recomendación.

**#5299 · `opts.configPath` no está confinado a un prefijo.** Deliberado y consistente
con D-1 (el argumento es código, no entorno). No alcanzable hoy: el único call-site de
producción (`kernel-table-verify.js:416`) nunca lo cablea desde argv/env/config. Se
recomienda contenerlo antes de exponer cualquier flag `--config` por CLI.

**Higiene (sin issue, para `review`/`tester`):** los dos tests nuevos no limpian sus
tmpdirs (sin `rmSync` / `t.after`), dejando directorios `p5172-*` / `q5172-*` por corrida
— suma al problema de disco conocido del entorno, sin riesgo de seguridad.

### Fuera de alcance

La rama arrastra `b3863bfbd` (credenciales de Drive al store externo), ajeno a #5172 y
auditado en la primera pasada (recomendaciones #5265 / #5266 / #5267). Sin vulnerabilidad
explotable; separarlo o no antes del merge es decisión de `review` / `aprobacion`.
