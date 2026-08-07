## Reporte de auditoría de seguridad — issue #5450

**Veredicto:** sin hallazgos

**Alcance auditado:** rama `agent/5450-pipeline-dev`, commit `c486f80aa` ("fix(pipeline): redactar claves sensibles de primer nivel en avisos"), diff contra `origin/main` (7 archivos, +345/-17). Sin PR abierto. Módulos: `.pipeline/lib/notify-telegram.js`, `.pipeline/servicio-telegram.js`, `.pipeline/lib/vault-shadow-metrics.js`, `.pipeline/lib/telegram-burst-grouper.js`, `.pipeline/lib/credentials.js`, `.pipeline/vault-shadow-status.js` y la suite `vault-private-notifications-5450.test.js`.

### Hallazgos

**Sin hallazgos.** El único hallazgo bloqueante de la revisión anterior (rev-2) quedó cerrado y verificado empíricamente en esta pasada. No se detectaron vulnerabilidades nuevas introducidas por el diff.

### Verificación del rechazo rev-2 (claim único)

Claim: *"`.pipeline/lib/notify-telegram.js:126` — la redacción de `context` sólo aplica el motor por nombre de clave cuando el valor es un objeto; un secreto de baja entropía bajo una clave sensible de primer nivel se persiste en texto plano en el dropfile y viaja en el body, tanto por el canal privado como por el grupal."*

**Estado: RESUELTO.**

```
# Canal privado (con chat_id)
$ node -e "... notifyTelegram({chat_id:'-777', component:'vault-shadow', message:'evento',
                               context:{password:C, token:C, api_key:C, apiKey:C, secret:C}}) ..."
resultado: {"ok":true,"dropPath":".../pendiente/alert-vault-shadow-1786013635780-10072.json"}
TOP-LEVEL sensitive key persisted canary: false
--- dropfile ---
"text": "vault-shadow: evento\n\npassword: [REDACTED]\ntoken: [REDACTED]\napi_key: [REDACTED]\napiKey: [REDACTED]\nsecret: [REDACTED]\n..."

# Canal grupal (camino histórico SIN chat_id) — la audiencia más amplia
$ node -e "... sin TELEGRAM_LEO_OPERATOR_CHAT_ID: notifyTelegram({context:{password:C, token:C},
                                                                  holder:{pid:1234, hostname:'host-1', token:C}}) ..."
drop SIN chat_id (destino grupal) contiene canario: false
chat_id en drop: (ausente -> CHAT_ID grupal)
--- text ---
holder: pid=1234 host=host-1
password: [REDACTED]
token: [REDACTED]
```

La causa raíz se corrigió como se pidió: `const safeCtx = redactObject(ctx)` se evalúa **antes** de iterar (`notify-telegram.js:135`), con el mismo criterio para `holder` (`:117`), de modo que la tabla de claves sensibles se aplica también a los valores escalares de primer nivel. Los dos casos de regresión están cubiertos por tests nuevos (primer nivel y camino sin `chat_id`).

### Controles verificados como conformes

- **REQ-SEC-5450-1 — allowlist de destino.** Igualdad canónica contra `TELEGRAM_LEO_OPERATOR_CHAT_ID` en productor (`notify-telegram.js:75-87`) y consumidor (`servicio-telegram.js:120`, aplicado en `:877`). Matriz ejercitada en esta pasada: `-777`→`{ok:true,chatId:"-777"}`; `-999`, `"-777x"`, `" -777"`, número `-777` (no-string) y `9007199254740993` → `unauthorized_chat_id`. `telegramSend` arma `{chat_id: CHAT_ID, ...params}`, así que el override efectivamente pisa el default sólo cuando pasó la allowlist.
- **REQ-SEC-5450-2 — fail-closed.** Ancla ausente → `no_operator_chat_id`; ancla `""` → `no_operator_chat_id`; ancla `"abc"` → `invalid_operator_chat_id`; destino distinto → `unauthorized_chat_id`. En todos los casos **no se crea el dropfile** (`cola creada: false`) y **no** se degrada al `CHAT_ID` grupal; en el consumidor el drop se mueve a `listo/` sin enviar (`servicio-telegram.js:878-882`). Ningún motivo incluye el identificador recibido.
- **REQ-SEC-5450-3 — redacción antes de persistir.** Canario de alta entropía inyectado en `component`, `message`, `diag`, `action`, `detail`, `context` y `holder` simultáneamente: 0 coincidencias en el dropfile en reposo (que es el mismo `text` del body saliente). Canario de baja entropía bajo clave sensible: 0 coincidencias.
- **REQ-SEC-5450-4 — minimización.** El payload de fallback lleva sólo nombre lógico, host, vía y timestamp; el de cumplimiento, conteos, hosts, ventana y timestamp. Verificado: `JSON.stringify(sent).includes('OPENAI_API_KEY') === false`. `chat_id` no se incorpora al texto ni a los logs (los rechazos loguean sólo el motivo).
- **REQ-SEC-5450-5 — dedupe seguro.** Fallback: 1er `record` → 1 aviso; 2do `record` → sigue en 1 (dedupe por nombre lógico). Con el estado `vault-resolution.dedupe.json` corrupto → **2 avisos**: el defecto produce repetición, nunca silencio. El commit del dedupe está condicionado a `notification.ok === true` (`vault-shadow-metrics.js:566` y `:906`), así que un encolado fallido reintenta. Cumplimiento se liga al `t0` persistido, de modo que sólo un reinicio de ventana rearma el aviso.
- **REQ-SEC-5450-6 — integridad de archivo.** `fs.writeFileSync(..., { mode: 0o600, flag: 'wx' })`: creación exclusiva verificada (`EEXIST` al intentar escribir sobre un archivo ya existente ⇒ no sigue un symlink pre-plantado). `chat_id` no participa del nombre ni del path (`alert--REDACTED-high-entropy--<ts>-<pid>.json`).
- **A09 — logging.** Los rechazos imprimen únicamente el motivo; no aparecen `chat_id`, valores, fragmentos, hashes ni longitudes.
- **Aislamiento de burst.** Los drops privados reciben una clave única (`telegram-burst-grouper.js:163`), así que nunca se agrupan con drops grupales ni entre sí; un aviso privado no puede terminar mezclado en un envío al chat del grupo.
- **Retrocompatibilidad.** `chat_id` ausente → `{ok:true, chatId:null}` y el drop conserva formato y destino históricos.
- **Secrets hardcodeados.** El escaneo del diff (`sk-*`, `AKIA*`, `ghp_`, `xox*-`, `-----BEGIN`, asignaciones literales de password/secret) no encontró ninguno.
- **Dependencias.** `npm audit --omit=dev` → `{"high":2,"critical":0,"total":2}`, preexistentes (`js-yaml`, `fast-uri`) y ya seguidas en #5512, #5201 y #4854. El diff no toca `package.json` ni `package-lock.json` y no incorpora dependencias externas nuevas (todos los `require` agregados son módulos locales o `node:*`).
- **Suite focalizada.** `node --test` sobre las 7 suites afectadas → `tests 147 | pass 146 | fail 0 | skipped 1`.

### Recomendaciones independientes

- **#5610 — `[security] Ampliar la tabla de claves sensibles de redact.js: bot_token, authorization y bearer no se tachan`** (`priority:low`, `tipo:recomendacion` + `needs-human`). Al ejercitar el motor común se vio que `SENSITIVE_JSON_KEYS` (`constants.js:62-73`) tiene 10 entradas y que `normalizeKey` elimina `_`/`-`, por lo que `bot_token` normaliza a `bottoken` y no matchea `token`; `authorization` tampoco está en la tabla. Es un límite del **diccionario compartido**, no de este diff, y **no hay hoy camino explotable**: ningún llamador de `notifyTelegram` en `.pipeline/` emite esas claves y los avisos del núcleo de #5450 llevan sólo nombres lógicos. Queda como hardening, no bloquea la aceptación.
