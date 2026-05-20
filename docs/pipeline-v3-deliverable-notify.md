# Notificación Telegram de entregables del pipeline V3

> Issue origen: [#3414](https://github.com/intrale/platform/issues/3414).
> Receivers downstream: [#3415](https://github.com/intrale/platform/issues/3415) (`/rechazar`),
> [#3416](https://github.com/intrale/platform/issues/3416) (rebobinado),
> [#3417](https://github.com/intrale/platform/issues/3417) (puntos de no retorno).

## Qué hace

Cada vez que un skill notificable (`guru`, `po`, `ux`, `planner`) cierra una
fase del pipeline `definicion` con `resultado: aprobado`, el Pulpo encola un
mensaje Telegram con preview del entregable. Es **human-in-the-loop opcional
y no bloqueante**:

- **No intervenir** → el pipeline sigue (default).
- **Intervenir** → vía comando `/rechazar` (issue separado), que parsea el
  envelope canónico embebido en el mensaje y rebobina al paso correspondiente.

## Cómo se activa

Bloque `deliverable_notifications` en [`.pipeline/config.yaml`](../.pipeline/config.yaml):

```yaml
deliverable_notifications:
  enabled: false                       # OFF por default — flip a true para activar
  kill_switch: false                   # true corta inmediato sin reiniciar el pulpo
  skills: [guru, po, ux, planner]      # subset notificable
  truncate_chars: 1500                 # cap del preview de `notas:`
  attachment_root: ".pipeline/assets/mockups"
  dedup_window_hours: 24
  audit_file: ".pipeline/audit/deliverable-notifications.jsonl"
```

### Rollout sugerido

1. Mergear con `enabled: false`. Validar `node --test
   .pipeline/lib/__tests__/deliverable-notify.test.js` (33 tests).
2. Flippear `enabled: true` en producción. **No requiere reiniciar el
   pulpo** — el bloque se lee en cada ciclo de `brazoBarrido`.
3. Observar `.pipeline/audit/deliverable-notifications.jsonl` durante 1-2 días.
4. Si aparece ruido inesperado: `kill_switch: true` → corta runtime sin
   editar más nada y sin reiniciar.

## Formato del mensaje (CA-UX-1)

```
🎨 #3414 · criterios · ux
Notificación Telegram de entregables parciales del pipeline (…)

<preview de `notas:` truncado a 1500 chars>

🔗 https://github.com/intrale/platform/issues/3414

<!-- pipeline-meta {"issue":3414,"fase":"criterios","skill":"ux","pipeline":"definicion","ts":1716172800} -->
```

- **Header (línea 1)**: emoji + `#N` + fase + skill, separador punto medio `·`.
- **Subtítulo (línea 2)**: título del issue truncado a 80 chars.
- **Preview**: `notas:` del YAML procesado, truncado en límite de línea.
- **Footer**: URL del issue (link nativo de Telegram).
- **Envelope (invisible)**: HTML comment con JSON estructurado que `/rechazar`
  (#3415) parsea para routing.

### Caso especial UX con PNG

Cuando el skill es `ux` y `yaml.photo` apunta a un archivo válido bajo
`attachment_root`, el mensaje se envía como `sendPhoto` multipart con
caption corto (sin notas) — el detalle queda para el issue.

### Emojis canónicos por skill (CA-UX-2)

| Skill | Emoji |
|---|---|
| `guru` | 🔍 |
| `po` | 📋 |
| `ux` | 🎨 |
| `planner` | 🗺️ |

Cualquier skill fuera de este set degrada a `📦` (neutral). Cambiar emojis
requiere edición de `lib/deliverable-notify.js` y aprobación CODEOWNERS.

## Defensas de seguridad

| CA | Mecanismo | Archivo |
|---|---|---|
| CA-SEC-1 | Validación de path del adjunto bajo `attachment_root` (rechaza `..`, null-byte, paths absolutos fuera del root, symlinks que escapan) | `lib/deliverable-notify.js → validateAttachmentPath()` |
| CA-SEC-2 | `skill` / `fase` / `pipeline` del envelope derivan del nombre de archivo y directorio del pulpo — NUNCA del YAML editable | `pulpo.js → brazoBarrido()` pasa `skill = skillFromFile(r.file.name)` |
| CA-SEC-3 | Audit JSONL persiste `content_hash` + preview **sanitizado** truncado a 200 chars + ruta **relativa** (nunca absoluta) | `lib/deliverable-notify.js → buildPreview()` + `appendAudit()` |
| Telegram payload sanitization | `text` / `caption` pasan por `sanitizeTelegramPayload` (redacta tokens, JWT, AWS keys) | `lib/sanitize-payload.js` |

## Dedup (CA-FN-7)

`shouldSkipByDedup` compara `(issue, skill, content_hash(notas))` contra el
audit JSONL. Si encuentra una entrada idéntica dentro de `dedup_window_hours`
(default 24h), salta el envío y deja una línea de audit con
`skipped_dedup: true`.

Esto evita spam por re-promociones tras rebote o por bugs del pulpo
(incidente histórico tipo #3150).

## Troubleshooting

### "No me llegan notificaciones"

```bash
# 1. ¿Está activo el bloque?
grep -A1 "^deliverable_notifications:" .pipeline/config.yaml

# 2. ¿El pulpo está leyendo el config nuevo? Mirá el log de barrido:
tail -50 .pipeline/logs/pulpo.log | grep "barrido"

# 3. ¿Hay entradas recientes en el audit?
tail .pipeline/audit/deliverable-notifications.jsonl

# 4. ¿Hay dropfiles en la cola del servicio Telegram?
ls .pipeline/servicios/telegram/pendiente/ | grep deliverable
```

### "Recibo notificaciones duplicadas"

Verificá que el `dedup_window_hours` no esté en `0` o ausente. El default es
24h y debería ser suficiente. Si el issue rebotó muchas veces y cada
re-promoción cambia `notas:` (porque cada agente genera nuevo análisis), no
es bug — son entregables distintos.

### "El audit está creciendo mucho"

JSONL append-only. Para rotación, agregar al cron habitual del pipeline. No
hay rotación automática hoy (deuda conocida — issue futuro si se necesita).

### "Kill switch sin frenar la cola"

`kill_switch: true` deja de **encolar** nuevos. Los dropfiles ya escritos en
`.pipeline/servicios/telegram/pendiente/` se procesan igual (es el flujo
normal del servicio-telegram). Para vaciar la cola en caliente:

```bash
rm .pipeline/servicios/telegram/pendiente/*-deliverable-*.json
```

## Tests

```bash
node --test .pipeline/lib/__tests__/deliverable-notify.test.js
```

33 tests cubriendo CA-FN-1, CA-FN-2, CA-FN-4, CA-FN-5, CA-FN-6, CA-FN-7,
CA-FN-8, CA-SEC-1, CA-SEC-3, CA-UX-1, CA-UX-2, CA-UX-4.

## Hook point en el pulpo

`pulpo.js → brazoBarrido()`, dentro del bloque "Todos aprobaron" (después de
los caminos de rebote/needs-human), justo **antes** del `for (const a of
archivos) moveFile(a.path, procesadoDir)` final.

```js
// Pseudocódigo del wire:
try {
  const notifyCfg = (config && config.deliverable_notifications) || {};
  if (notifyCfg.enabled && !notifyCfg.kill_switch) {
    for (const r of resultados) {
      if (r.resultado !== 'aprobado') continue;
      const notifySkill = skillFromFile(r.file.name); // CA-SEC-2: NO del YAML
      deliverableNotify.notify({ /* ... */ });
    }
  }
} catch (e) {
  log('barrido', `📨 notify excepción #${issue}/${fase}: ${e.message}`);
}
```

El `try/catch` garantiza CA-FN-8: cualquier error del notify NUNCA bloquea el
`moveFile` que cierra la promoción de fase.

## Out of scope (NO incluido en #3414)

- Comando `/rechazar` y su parser → **#3415** (receiver del envelope).
- Lógica de rebobinado del pipeline → **#3416**.
- Puntos de no retorno (qué fases NO se pueden rebobinar) → **#3417**.
- Timeouts o wake-locks en Telegram (Leo lo descartó explícitamente).
- Aprobaciones explícitas `/aprobar` (Leo lo descartó: aprobación implícita
  = silencio).
- Notificación de skills no críticos (`tester`, `builder`, `qa`, `review`,
  `sizing`) — aceptado como diseño, no como deuda.
- Audio TTS narrado (CA-UX-9: alta frecuencia → spam auditivo).
