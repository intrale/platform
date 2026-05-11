# docs/secrets-inventory.md — Inventario de credenciales del pipeline V3

> Inventario **declarativo** de las credenciales que el pipeline V3 usa. Este
> documento contiene SÓLO metadata (provider, env var, owner, fechas, links).
> Acá NUNCA aparece el valor de un secret, ni un prefijo, ni los "primeros 4
> chars" — aunque suene inofensivo, los logs van a Telegram/PDFs/dashboard y un
> atacante con acceso parcial a esos canales pivota desde el prefijo.

## ¿Cómo se usa?

1. Cuando se agrega un nuevo provider al pipeline (ver
   [`docs/pipeline-multi-provider.md`](pipeline-multi-provider.md)), se agrega una
   fila a la tabla.
2. El campo `expires_at` se calcula como `last_rotated + 90 días`. La política
   de rotación es **≤ 90 días** por convención.
3. El cron `lib/credential-rotation-cron.js` corre dentro de `pulpo.js` y cada
   hora compara `expires_at` contra `now()` (UTC). Notifica al `owner` por
   Telegram en T-14, T-7, T-3, T-1 días, y escala a `priority:critical` cuando
   pasa la fecha sin rotar.
4. Para rotar, seguir el runbook: [`docs/runbooks/credential-rotation.md`](runbooks/credential-rotation.md).
5. Después de rotar, **commitear** la actualización del campo `last_rotated`
   en este archivo. El cron NO toca este archivo: la fuente de verdad es git.

## Tabla de credenciales activas

| provider | env_var | owner | last_rotated | expires_at | account_id | rotation_runbook_url | revocation_endpoint |
|----------|---------|-------|--------------|------------|------------|----------------------|---------------------|
| anthropic | `ANTHROPIC_API_KEY` | leitolarreta | 2026-04-15 | 2026-07-14 | `intrale-pipeline-v3` | [runbook](runbooks/credential-rotation.md#anthropic) | https://console.anthropic.com/settings/keys |
| openai-codex | `OPENAI_API_KEY` | leitolarreta | _no aplica todavía_ | _no aplica todavía_ | _pendiente alta_ | [runbook](runbooks/credential-rotation.md#openai) | https://platform.openai.com/api-keys |

**Notas**:

- `account_id` es un **identificador opaco** que el provider asocia a la cuenta
  emisora del token (ej: nombre del workspace, organization id). NO es el
  secret. Sirve para que la persona que rota sepa contra qué cuenta operar.
- `openai-codex` está declarado en `agent-models.json` como provider opcional
  (referenciado por skills futuros vía rollout #3079). Mientras no haya skill
  asignado, NO requiere credencial inyectada y el cron no genera recordatorios.
  Cuando un skill lo use, hay que dar de alta `OPENAI_API_KEY` y completar la
  fila acá.

## Reglas inquebrantables

- **No pegar el secret**. Ni el valor, ni los primeros 4 chars, ni un screenshot
  con la key visible.
- **No pegar prefijos del secret** (ej: `sk-ant-...XYZ`). Aunque ASCII art
  sugiera ofuscación, el prefijo deja huella.
- **No screenshots de consolas con keys visibles**. Si necesitás documentar la
  consola del provider, recortar a la parte de metadata (id de cuenta, fecha
  de creación) y NUNCA a la columna que muestra el token.
- **Fuente de verdad de `last_rotated`**: el commit que actualiza este archivo.
  Ningún cron, ninguna tarea automática edita este markdown.
- **Formato de fechas**: ISO 8601 estricto `YYYY-MM-DD`. El cron parsea con
  `new Date()` y otros formatos pueden fallar silenciosamente (riesgo: el
  recordatorio no se dispara nunca).
- **Si una credencial se rotó por incidente** (no por vencimiento programado):
  igual hay que actualizar `last_rotated` con la fecha de la rotación. El
  inventario refleja el último cambio efectivo, no la programación teórica.
- **Si una credencial se revocó** (ya no se usa): borrar la fila completa **en
  el mismo PR** que remueve el provider de `agent-models.json`. No dejar
  filas huérfanas.

## ¿Qué NO está en este archivo?

- **Detección de leaks**: este archivo es declarativo. La detección de leaks
  en archivos trackeados se hace con `gitleaks` (recomendación #3101, pendiente).
- **Audit log de uso**: qué proceso usó qué credencial cuando, eso vive en
  `.pipeline/logs/credential-rotations.log` (issue S5, pendiente).
- **PIPELINE_PROVIDER_OVERRIDE break-glass**: ese flag tiene su propio audit
  log append-only (`.pipeline/logs/credential-overrides.log`) y está fuera de
  scope de este inventario. Ver §6.9 de `docs/pipeline-multi-provider.md`.
