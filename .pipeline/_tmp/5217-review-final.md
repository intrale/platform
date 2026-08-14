## Code review semántico — aprobado

Reviso sólo lo que el linter no puede ver (patrones, cohesión, cobertura lógica, riesgos de arquitectura). El linter ya pasó con 1 warning de tamaño de diff.

### Lo que está bien

**La decisión de arquitectura central es la correcta.** El punto de fallo que arruinaba este issue era usar `readUnifiedStore()` (que delega en `loadIntoEnv` → itera `ENV_MAPPING`) para Drive, con CA-6 prohibiendo agregar Drive a `ENV_MAPPING` — o sea, una cadena que colapsa a `""` en silencio. La entrega usa `resolveScopedRefs` contra el namespace, sin tocar `process.env`. Verificado en runtime con la env de Drive limpia:

```
oauthReady= true  missing= []
sources= {"clientId":"store:google_drive.oauth_client_id","clientSecret":"store:google_drive.oauth_client_secret",
          "refreshToken":"store:google_drive.oauth_refresh_token","folderId":"store:google_drive.drive_folder_id"}
state= ok configurado
```

**Un solo resolvedor, no dos.** `resolveTelegramCredentials` (#4907) y `resolveDriveCredentials` (#5172, que llegó a `main` en paralelo) quedan como wrappers que delegan en `resolveCredential` + spec. Conservar dos cadenas de precedencia que pueden divergir en silencio habría sido reintroducir el bug por otra vía. Los wrappers preservan firma y contrato (R-5), y `driveCompatSource()` degrada las etiquetas sólo en el borde de compatibilidad.

**Un solo punto de escritura.** `writeCanonicalPaths` extrae el core ya probado de `rotateKey` (backup → tmp → rename → chmod → retención) y `rotateKey` pasa a delegar, en vez de que el setup OAuth haga su propio `writeFileSync`. Correctamente **no** se extendió `MANAGED_KEYS` — Drive no es un provider administrable por la UI del dashboard y entraría con semántica `editable` que no le corresponde. El fail-closed sobre store ilegible (en vez de degradar a `{}`) es la decisión correcta: degradar habría borrado Telegram y todos los providers de IA ante un JSON mal formado.

**`hydrate: false` separa dos cosas que estaban pegadas** — pertenecer al inventario del vault (provisión, IAM, rotación) vs. inyectarse en el `process.env` global. `ENV_DESCRIPTORS` intacto, `ENV_MAPPING` derivado con filtro, y `HYDRATED_DESCRIPTORS` como denominador de la ventana sombra. Este último detalle importa: usar `ENV_DESCRIPTORS` habría dejado la ventana de #5427 permanentemente bajo el umbral y el fallback a archivo no se retiraría nunca. Verifiqué que ningún otro consumidor del repo lee `GOOGLE_OAUTH_*` / `GOOGLE_DRIVE_FOLDER_ID` del ambiente, así que sacar la hidratación no rompe a nadie.

**Cobertura lógica real, no sólo compilación.** El fix de `resolveDriveParentId` (alias `root` en vez de `parents: [""]`) cierra el bloqueante del review anterior, y se aplica tanto en `driveListFolder` como en `driveCreateFolder`. Los tests son genuinos: `credential-resolution-pattern.test.js` trae **self-tests del detector** (positivo con line numbers, negativo con 4 formas legítimas, y el caso "en comentario"), sin los cuales el assert "no hay violaciones" sería un no-op silencioso. Los tests modificados **no fueron debilitados**: se adaptaron a un comportamiento que efectivamente cambió, y de hecho el PR *agrega* anclas que antes no existían (la invariante CA-6 que fija `hydrate:false` en exactamente las 4 claves de Drive y `vaultScopePlan` sin cambios).

### Verificación de baseline

`secrets-manifest.test.js` da 25/23/2 en esta rama. Corrí el mismo archivo en un branch limpio sobre `main` y da **25/23/2 con las mismas dos fallas por nombre** (`telegram.leo_operator_chat_id` vs `notify-telegram.js` y `vault-shadow-metrics.js`). No atribuibles. `qa/scripts/__tests__` 86/86 · libs de credenciales 135/135.

### Observaciones no bloqueantes

- `credentials-vault-5353.test.js:280` — `assert.equal(Object.keys(ENV_MAPPING).length, HIDRATADAS)` es tautológico (`X === X`): `HIDRATADAS` se define como esa misma expresión. Antes era `assert.equal(..., 13)`, un ancla absoluta. Derivar tiene sentido en los asserts que cruzan runtime contra el mapping, pero en esta línea el único propósito era anclar el número y se perdió. Queda mitigado por `secrets-manifest.test.js:199`, que ancla `ENV_MAPPING` contra el JSON del manifiesto (fuente independiente).
- Cobertura de R2 incompleta: no hay test del nivel **env** de R2 ni de placeholder, y `qa-video-share-credentials.test.js:477` inyecta `bucket: 'fake-bucket'` en el store pero nunca assertea `cred.values.bucket` — el camino "store pisa el fallback `intrale-qa-evidence`" queda sin cubrir. Una línea lo cierra. No bloquea: R2 no está provisionado y ningún CA depende de que suba.
- La atomicidad de `writeCanonicalPaths` se testea sólo por ausencia de `.tmp.` huérfanos; un `writeFileSync` directo pasaría igual. El módulo acepta `fsImpl` inyectable y ningún test lo usa para asertar el orden `writeFileSync(tmp)` → `renameSync`.
- `credentials-vault-shadow-5448.test.js:323` — mensaje stale: dice "exactamente los 13 descriptores" pero ahora compara contra `HYDRATED_DESCRIPTORS`, que son 9.
- Asimetría escritor/lector latente: el setup escribe `google_drive` **top-level**, mientras `resolveScopedRefs` prioriza `data.namespaces.google_drive` sobre la clave top-level. Hoy no se dispara, pero si alguna vez existe `namespaces.google_drive` (vocabulario multi-producto de #5219/#5352) la escritura queda sombreada en silencio y el operador ve "guardado OK" mientras el consumidor lee otro valor — justo la clase de falla que este issue cierra.
- El mensaje de faltantes junta con `" y "`: "falta account_id y access_key_id y secret_access_key". Cosmético.
- La alerta de Semgrep sobre `qa/scripts/__tests__/drive-oauth-setup-persist.test.js:34` es el fixture sintético `ya29.FAKE-...`. Falso positivo, pero genera ruido en code-scanning; cambiar la forma del fixture lo elimina.

### Recomendaciones registradas como issues (pendientes de aprobación humana)

- **#5783** — la sección AWS nueva del runbook (`credential-rotation.md:323-330`) dice "no es un pendiente / el pipeline los consume vía perfil", pero `secret-vault.js:514` hace fail-closed exigiendo `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` **en el ambiente** sin fallback a perfil, y `secrets-manifest.json` las declara `consumer_status: "broken"` / `blocked_by: "#5040"`. No es defecto de implementación: el texto lo dicta CA-15 tal como fue redactado.
- **#5784** — caminos de error sin salida en `google-drive-oauth-setup.js` (preexistentes en `main`, verificado): `tokenReq.on("error")` no sale y el proceso cae al timeout de 5 min con el mensaje equivocado; `server.listen` sin handler `'error'` (EADDRINUSE no capturable por `main().catch()`); bind a todas las interfaces en vez de loopback. `state`/PKCE ya está en #5324.
- **#5785** — `npm run test:pipeline` no se ejecuta en ningún workflow, así que los guards anti-regresión de este PR sólo protegen si alguien los corre a mano.

Ninguna de las tres bloquea: son mejoras de calidad independientes, y las tres son **recomendaciones pendientes de aprobación humana** (`tipo:recomendacion` + `needs-human`).
