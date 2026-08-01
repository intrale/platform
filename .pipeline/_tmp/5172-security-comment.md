## 🔒 Auditoría de seguridad — `verificacion` · **aprobado**

Auditado `agent/5172-pipeline-dev` @ `b3863bfbd` (sin PR abierto). Re-pasada: la aprobación anterior de `security` cubrió hasta `6f7c13c65`; el delta nuevo es **`b3863bfbd`** (migración de credenciales de Google Drive al store externo), auditado en detalle por tocar manejo de secretos.

**Sin vulnerabilidades explotables introducidas.** No hay inyección, bypass de autenticación/autorización, secrets hardcodeados ni exposición de valores crudos.

### Verificado empíricamente (sondas propias, no los tests del autor)

| # | Qué | Resultado |
|---|-----|-----------|
| SEC-1 / CA-14 | `config.yaml` con canario `sk-ant-LEAK-CANARY-…` + `AKIA…` en la línea adyacente al parse-error. Se serializó `{name, message, stack, props propias, describeConfigFailure, formatConfigFailureLog, formatConfigFailureTelegram}` | `leakSecret: false`, `leakAws: false` — sólo `"YAML inválido — línea 4, col 4"` |
| Camino ajv | mismo canario como **valor** de config | `"/concurrencia/max_agentes: tipo esperado: integer"` — path + regla, nunca el dato |
| SEC-4 / CA-16 | overrides con `TELEGRAM_BOT_TOKEN` y `ANTHROPIC_API_KEY` hidratados en el env | `leakBot: false`, `leakAnthropic: false`, y el debilitamiento sale con nivel `ALERTA` |
| SEC-3a / CA-12 | `PIPELINE_STATE_DIR=<tmp>/evil.yaml` | resuelve a `evil.yaml/config.yaml` + `st.isFile()` ⇒ neutralizado |
| CA-9 | `/logs/history` con config inválida | `getKnownSkills()` ⇒ set vacío ⇒ rechaza **cualquier** `agente`. El allowlist de #4444 no se debilita |
| CA-2 | `grep yaml.load\|loadAll\|DEFAULT_FULL_SCHEMA` en `.pipeline/**/*.js` | los sobrevivientes leen **archivos de trabajo**, no `config.yaml` |
| Inyección | diff completo | cero `child_process` nuevo en producción |
| XSS | pantallas nuevas del dashboard | todo por `lib/escape-html`, `503`/`500` con `nosniff` + `no-store` |
| Deps | `package.json` / `package-lock.json` | **sin cambios**. `js-yaml` y `fast-uri` son preexistentes y sin superficie atacante; js-yaml ya cubierto por #5201 |
| Suites | `config-resolver-{secrets,guard,failclosed,root}` + `credentials-google-drive` + `qa-video-share-drive-credentials` | **64 pass / 0 fail** |

También revisé que ningún consumidor de gate migrado (`kernel-action-policy`, `operator-absence-policy`, `product-registry-loader`, `kernel-provision`, `servicio-reconciler`) tenga un camino donde *"config rota"* termine abriendo un gate. No lo hay: todos propagan el error tipado, y `admissionGateSettings()` conserva los defaults del archivo en vez de degradar a "gate apagado".

### Recomendaciones no bloqueantes creadas

Las tres salen del commit `b3863bfbd`. **Requieren aprobación humana** (`needs-human` + `tipo:recomendacion`): no entran al pipeline automático hasta que se les quite el label. **No bloquean ni dependen de este issue.**

- **#5265** `priority:medium` — escritura destructiva del store de credenciales. `scripts/google-drive-oauth-setup.js:117-126` hace read-modify-write con la lectura en un `catch` mudo; si el store está truncado o ilegible (no ENOENT), el write posterior lo pisa entero. Reproducido con el bloque textual del script: `ANTES: telegram, providers, aws, multimedia` → `DESPUES: google_drive`. No bloquea porque no es explotable por un tercero (script manual del operador) y el patrón `catch` mudo es heredado — lo que cambió con este commit es el **radio de daño**: el destino pasó de un archivo versionado recuperable por git a la única copia viva de todos los secretos del pipeline.
- **#5266** `priority:low` — `{ mode: 0o600 }` sólo se honra al **crear** el archivo. Verificado: `modo tras rewrite con {mode:0o600} sobre archivo existente: 0666`, y el store real está hoy en `-rw-r--r--` (0644). Fix: `chmodSync` explícito post-write.
- **#5267** `priority:low` — `google-drive-oauth-setup.js:107-108` imprime los primeros 20 chars de `access_token` y `refresh_token`. Código **preexistente** (línea de contexto en el diff), pero es la excepción al patrón de redacción que el resto del pipeline ya sostiene.

📄 Reporte completo: `.pipeline/assets/docs/5172/security-verificacion-5172.md` (marcado `sensible: true` — no se publica en canal público).
