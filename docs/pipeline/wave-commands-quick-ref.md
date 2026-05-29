# Cheat sheet operativo · waves.json

Referencia rápida para operar la planificación multi-ola del pipeline (`waves.json`) desde Telegram, terminal y dashboard. Pensado para que el operador no tenga que leer código para arrancar el día verificando que las olas estén alineadas con la operación real.

Audiencia: humano operador del pipeline (no usuario final del producto).

---

## Sección 1 · Comandos Telegram

Para correr desde el bot Telegram del Commander.

| Comando | Qué hace | Cuándo usarlo |
|---|---|---|
| `/wave status` | Muestra la ola activa, las planificadas (hasta 5) y el conteo de issues por estado. | Arranque del día. Para confirmar que la operación matchea la planificación visible en dashboard. |
| `/wave next` | Lista solo las próximas olas planificadas (sin la activa). | Verificar que hay roadmap cargado para los próximos sprints. |
| `/wave add <N> <issues>` | Agrega una ola planificada nueva, ej. `/wave add 12 3601 3602 3603`. | Cuando terminó la planificación de la próxima ola y querés guardarla antes de promoverla. |
| `/wave promote <N>` | Promueve la ola planificada `N` a activa y archiva la activa anterior. **Bloqueante** si quedó un marker `.failed.*` de un crash previo. | Cuando la ola actual cerró y querés arrancar la siguiente. |
| `/wave ack-desync` | Marca el estado actual de desync como reconocido (oculta el banner WARN hasta que la divergencia cambie). | Cuando viste el banner y la divergencia es esperada (ej. mid-promote manual). No destraba el dispatch, solo silencia el banner. |

---

## Sección 2 · Comandos pipeline / terminal

Para correr desde bash en la raíz del repo.

| Comando | Qué hace | Cuándo usarlo |
|---|---|---|
| `cat .pipeline/waves.json | jq '.active_wave'` | Muestra la ola activa en JSON crudo. | Para verificar el estado canónico sin pasar por el dashboard. |
| `cat .pipeline/.partial-pause.json | jq '.allowed_issues'` | Muestra la allowlist operacional real que ve el Pulpo. | Para comparar con `waves.json.active_wave.issues` y detectar desync a mano. |
| `node .pipeline/restart.js` | Reinicia todos los servicios del pipeline (incluye boot hook de bootstrap). | Después de modificar `.partial-pause.json` o `waves.json` a mano, para que el Pulpo lea el estado nuevo y reevalúe init/desync. |
| `rm .pipeline/.init-failed.flag` | Destraba el dispatch tras un bootstrap fallido, una vez corregido el archivo. | Cuando ves el banner CRÍTICO "Bootstrap de olas falló" y ya arreglaste `.partial-pause.json`. Alternativa: restart del Pulpo (lee el archivo corregido y limpia el flag solo si el init pasa OK). |
| `rm .pipeline/.desync-detected.flag` | Destraba el dispatch tras desync (decisión humana de cuál archivo es la verdad). | Cuando auditaste qué pasó con la divergencia y elegiste con qué archivo seguir. **No es lo mismo que `ack-desync`** — éste destraba el procesamiento, el otro solo silencia el banner. |
| `rm .pipeline/.desync-acknowledged.flag` | Re-muestra el banner desync (no destraba nada). | Si por error reconociste un desync y querés volver a verlo. |

---

## Sección 3 · Diagnóstico

Para investigar qué pasó cuando algo no cierra.

| Acción | Comando | Qué leer |
|---|---|---|
| Ver último bootstrap | `cat .pipeline/audit/waves-bootstrap.jsonl | tail -1 | jq` | Campos clave: `outcome` (ok/noop/error), `imported_count`, `source_sha256`, `result_sha256`, `errors`. Si `outcome=error`, el campo `errors[]` dice qué falló. |
| Ver historial completo de bootstraps | `cat .pipeline/audit/waves-bootstrap.jsonl | jq` | Append-only con hash chain. Cada línea tiene `ts`, `pid`, `hostname`. |
| Ver flag init-failed actual | `cat .pipeline/.init-failed.flag | jq` | Si existe, contiene `reason` + `errors[]` del último fallo. El dispatch del Pulpo está suspendido mientras este archivo exista. |
| Ver flag desync actual | `cat .pipeline/.desync-detected.flag | jq` | Si existe, contiene `waves_allowlist`, `partial_allowlist`, `added`, `removed`. |
| Ver ack persistido | `cat .pipeline/.desync-acknowledged.flag | jq` | Si existe, contiene el `hash` del estado reconocido. Si el hash actual del desync coincide → banner oculto. Si cambia → banner reaparece. |
| Ver contador de ciclos limpios | `cat .pipeline/_desync-clean-cycles.counter | jq '.count'` | Cuántos ciclos consecutivos corrieron sin desync. Usado para gating de PR2 (remoción del fallback legacy en `getAllowlist()`). Threshold: 3. |
| Logs del Pulpo | `tail -200 .pipeline/logs/pulpo.log` | Busca líneas `[init-waves]`, `desync-detector`, `[desync-clean-cycles]`. |

---

## Ejemplo end-to-end · Arrancar el día verificando que las olas estén alineadas

```bash
# 1. Verificar el estado canónico desde Telegram
/wave status
#   → Muestra Ola activa "Bootstrap from .partial-pause.json" con 10 issues
#     y 0 planificadas.

# 2. Confirmar que la operación real matchea
cat .pipeline/.partial-pause.json | jq '.allowed_issues'
#   → [3559, 3605, 3613, ..., 3647]

cat .pipeline/waves.json | jq '.active_wave.issues[].number'
#   → 3559, 3605, 3613, ..., 3647 — coincide → OK, no hay desync.

# 3. Si el dashboard muestra el banner WARN "Divergencia detectada":
#    El operador ya editó .partial-pause.json sin actualizar waves.json
#    (ej. agregó un issue de emergencia con /allow).
#
#    Decidir: ¿queremos que ese issue forme parte de la ola activa?
#       SÍ → editar waves.json, agregar el issue. Reiniciar Pulpo.
#       NO → quitar el issue de .partial-pause.json. Reiniciar Pulpo.
#       "Sé que está, lo voy a arreglar después" → /wave ack-desync
#           para silenciar el banner sin destrabar el dispatch.

# 4. Si el dashboard muestra el banner CRÍTICO "Bootstrap de olas falló":
#    El init de waves.json no completó (shape inválida en partial-pause).
#    El Pulpo NO está procesando issues hasta que se corrija.
cat .pipeline/audit/waves-bootstrap.jsonl | tail -1 | jq '.errors'
#   → ["clave desconocida no admitida: \"foo\""] — alguien metió un campo
#     no whitelisteado en .partial-pause.json
#
# Corregir:
vim .pipeline/.partial-pause.json    # sacar el campo "foo"
node .pipeline/restart.js            # restart limpia el flag si el init OK

# 5. Planificar la próxima ola (opcional)
/wave add 2 3700 3701 3702
/wave status     # verificar que aparece como planned

# 6. Promover cuando esté lista
/wave promote 2  # se vuelve activa, la 1 se archiva
```

---

## Glosario operativo

- **Bootstrap**: proceso one-shot al boot del Pulpo que sintetiza `waves.json.active_wave` desde `.partial-pause.json` si la canónica está vacía. Solo corre cuando `active_wave === null`. Idempotente.
- **Desync**: divergencia entre `waves.json.active_wave.issues` y `.partial-pause.json.allowed_issues`. Detectado al boot del Pulpo. Banner WARN, dispatch suspendido.
- **Init-failed**: el bootstrap arrojó error (shape inválido, write falló, path inseguro). Banner CRÍTICO, dispatch suspendido.
- **Shadow mode**: el desync-detector loggea el desync pero el Pulpo se autobloqueó. "Shadow" porque la operación sigue, pero sin procesar.
- **Ack persistido**: archivo `.desync-acknowledged.flag` con el SHA-256 del estado reconocido. Oculta el banner desync hasta que la divergencia cambie.
- **Counter de ciclos limpios**: contador en `_desync-clean-cycles.counter` que se incrementa en cada boot sin desync. Threshold ≥3 habilita PR2 (remoción del fallback legacy en `getAllowlist()` → solo lee `waves.json`).

---

## Referencias técnicas (para devs)

- `lib/init-waves-from-partial.js` — módulo del bootstrap, REQ-SEC-1..7 documentados en cabecera.
- `lib/init-failed-state.js` — flag persistente fail-closed.
- `lib/desync-detector.js` — detección de divergencia (no auto-repara).
- `lib/desync-ack.js` — reconocimiento operacional del banner WARN.
- `lib/desync-clean-cycles.js` — counter para gating PR2.
- `pulpo.js` boot hook — orquesta init + detect + dispatch.
- Issue de diseño: #3617 (este). Issue de la lib base: #3489.
