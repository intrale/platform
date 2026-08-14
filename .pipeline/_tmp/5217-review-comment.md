## Code review — `review` (fase `aprobacion`) · Issue #5217

**Veredicto: rechazado.** El cambio en sí es de muy buena calidad —el resolvedor genérico está bien diseñado, los 15 CA están cubiertos y `npm run test:pipeline` da **7831 pass / 0 fail** sobre la rama—. El problema no está en el diseño: está en la **base**. La rama nunca hizo el merge con `origin/main` que su propio pre-checklist pide como primer ítem, y en el interín **#5172 aterrizó en `main` una implementación del mismo feature**. Las dos no pueden convivir.

---

### Lo que está bien (verificado en esta pasada)

- **CA-1 / CA-2 empíricamente cumplidos.** Con el env de Drive borrado y el config del repo sin claves flat, la resolución sale del store canónico:

```
$ env -u GOOGLE_OAUTH_CLIENT_ID -u GOOGLE_OAUTH_CLIENT_SECRET -u GOOGLE_OAUTH_REFRESH_TOKEN \
      -u GOOGLE_DRIVE_FOLDER_ID node -e "...resolveCredential(DRIVE_SPEC)..."
{"valid": true, "state": "ok", "missing": [], "storeNamespaceFound": true,
 "sources": {"clientId":"store:google_drive.oauth_client_id",
             "clientSecret":"store:google_drive.oauth_client_secret",
             "refreshToken":"store:google_drive.oauth_refresh_token",
             "folderId":"store:google_drive.drive_folder_id"}}
```

  Y el código de `origin/main` en el mismo entorno colapsa, que es exactamente el bug:
  `codigo viejo -> driveAvailable(OAuth) = false | lens: id=0 sec=0 rt=0`.

- **CA-5 / CA-6 / CA-7** verificados: `git status --porcelain .claude/hooks/telegram-config.json` sin salida, y `credentials.js` / `agent-models-validate.js` **no aparecen en el diff**.
- **CA-13 / CA-14**: `R2 {"state":"absent","stateLabel":"no provisionado","missing":["account_id","access_key_id","secret_access_key"]}` — el estado se distingue de "no configurado", tal como pedía el CA.
- **R-5 sin regresión**: `resolveTelegramCredentials` conserva nombre, firma y semántica de precedencia (incluida la prioridad de `sponsor_chat_id` sobre `chat_id` dentro del nivel legacy); el wrapper delega en `resolveCredential`.
- `writeCanonicalPaths` como punto de escritura único, con el guard fail-closed sobre store corrupto y el rechazo de dot-paths de prototype pollution, es una mejora real sobre lo que había.
- Los tests están bien pensados: el detector de CA-8 se autovalida con casos positivo / negativo / comentario, así que no puede degradarse a no-op en silencio. Buen criterio.

---

### Bloqueante · La rama está 3 commits atrás y el merge no es trivial

```
$ git rev-list --count origin/main ^agent/5217-pipeline-dev
3

$ git merge-tree --write-tree --name-only origin/main agent/5217-pipeline-dev
qa/scripts/qa-video-share.js
scripts/google-drive-oauth-setup.js

Auto-merging qa/scripts/qa-video-share.js
CONFLICT (content): Merge conflict in qa/scripts/qa-video-share.js
Auto-merging scripts/google-drive-oauth-setup.js
CONFLICT (content): Merge conflict in scripts/google-drive-oauth-setup.js
```

Conflicto de contenido en **los dos archivos centrales del PR**. Y no es textual, es semántico: `origin/main` ya trae de **#5172** una resolución de credenciales de Drive con otra arquitectura.

```
$ grep -n "resolveDriveCredentials\|describeMissingDriveCredentials" qa/scripts/qa-video-share.js   # en origin/main
214:function resolveDriveCredentials(opts = {}) {
279:function describeMissingDriveCredentials(cred) {
287:const DRIVE_CREDENTIALS = resolveDriveCredentials();
1337:    resolveDriveCredentials,
1338:    describeMissingDriveCredentials,
```

Eso dispara tres roturas concretas al mergear.

#### 1. CA-6 es falso contra `main` — y hay dos tests que se contradicen

#5172 metió las 4 claves de Drive **en `ENV_MAPPING`**, exactamente lo que CA-6 prohíbe:

```
$ node -e "const c=require('./.pipeline/lib/credentials.js');
           console.log(Object.keys(c.ENV_MAPPING).filter(k=>k.startsWith('google_drive.')))"   # en origin/main
["google_drive.oauth_client_id","google_drive.oauth_client_secret",
 "google_drive.oauth_refresh_token","google_drive.drive_folder_id"]

assert de CA-6 del PR ("google_drive no debe estar en ENV_MAPPING") -> FALLA
```

El PR agrega en `credentials-scoped-refs.test.js` un test que afirma **lo contrario** de lo que afirma `.pipeline/lib/__tests__/credentials-google-drive.test.js` — que ya está en `main` y valida que esas 4 claves **sí** se hidratan vía `loadIntoEnv`. Después del merge **uno de los dos falla sí o sí**. No hay resolución de conflicto textual que los reconcilie.

Dato colateral que lo confirma en vivo: en una shell del pipeline hoy `process.env.GOOGLE_OAUTH_CLIENT_ID` **ya viene seteada**. O sea, el riesgo R-1 que CA-6 quería evitar (Drive heredado por todo proceso hijo de todo agente) **ya está materializado en `main`**.

#### 2. El PR rompe exports que un test de `main` importa por nombre

`main` tiene `qa/scripts/__tests__/qa-video-share-drive-credentials.test.js:26-27`, que hace `const { resolveDriveCredentials, describeMissingDriveCredentials } = require(...)`. El módulo del PR no los exporta:

```
$ node -e "const m=require('./qa/scripts/qa-video-share.js');
           const {resolveDriveCredentials, describeMissingDriveCredentials}=m; ..."
resolveDriveCredentials         -> undefined
describeMissingDriveCredentials -> undefined
llamada -> TypeError: resolveDriveCredentials is not a function
```

Es el mismo modo de falla que el PR blindó cuidadosamente para Telegram en R-5 — sólo que para Drive no se podía ver, porque la rama nunca vio #5172.

#### 3. El `test:pipeline` verde se obtuvo sobre una base que no existe

Los 7831 tests pasan **sobre la rama aislada**, donde ningún archivo de #5172 está presente. Ese verde no dice nada sobre el árbol que se va a mergear.

---

### Qué hay que hacer

1. `git merge origin/main` y resolver los dos conflictos.
2. Reconciliar `qa-video-share.js`: el resolvedor genérico de #5217 **supersede** a `resolveDriveCredentials` de #5172 (es más general y cumple los CA). Sacar el código muerto y **retirar o migrar** `qa/scripts/__tests__/qa-video-share-drive-credentials.test.js`, que apunta a la API vieja.
3. **Decidir explícitamente qué pasa con `ENV_MAPPING`.** CA-6 dice que Drive no va ahí; `main` ya lo tiene. Cumplir CA-6 obliga a sacar esas 4 entradas de `.pipeline/lib/credentials.js` y a ajustar `credentials-google-drive.test.js` — pero ese archivo está declarado **"NO tocar"** en la receta técnica, porque cuando se escribió el CA `ENV_MAPPING` estaba limpio. Es una colisión de alcance real: no la resuelvas en silencio en ninguna de las dos direcciones. O se sacan (documentando que #5172 las introdujo en el interín), o se pide sign-off de `po`/`security` en el issue para relajar CA-6.
4. Re-correr `npm run test:pipeline` **sobre el árbol mergeado**, no sobre la rama.

---

### No bloqueantes (para el mismo pase)

- **`scripts/google-drive-oauth-setup.js:234-240`** — si `persistTokens` tira (que ahora es un camino de diseño: `writeCanonicalPaths` es fail-closed ante store corrupto, y el runbook nuevo lo documenta como "aborta sin escribir"), el `catch` loguea y cae en `process.exit(0)`. El operador ve el error, pero el script **reporta éxito por exit code** justo cuando perdió el refresh token recién emitido. Debería ser `process.exit(1)`. Viene heredado de la estructura previa, pero este PR es el que vuelve ese camino probable.
- **`qa/scripts/qa-video-share.js:14`** — encabezado stale: `// 1. Google Drive (si google_credentials_path configurado en telegram-config.json)`. Sigue siendo técnicamente cierto (es el fallback de Service Account), pero al lado del bloque nuevo que insiste en "SOLO LECTURA" queda desalineado.
- **`qa-video-share.js:1400-1410`** — el diagnóstico se inyecta en un bloque de código con `parse_mode: "Markdown"`, y `DRIVE_SPEC.remediation` contiene backticks simples. Con los delimitadores balanceados debería parsear bien, pero es un riesgo residual sobre el único canal que le avisa al operador que la evidencia se perdió. Vale un test de forma sobre el string final, o sacar los backticks de `remediation`.

> Review del agente `review`. Ningún valor de credencial fue leído ni impreso: toda la clasificación es por nombre de clave, presencia y longitud.
