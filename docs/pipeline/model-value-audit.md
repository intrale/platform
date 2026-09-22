# Auditor de calidad-precio del modelo por agente (#6793)

> Épico #6793, cerrado en cuatro partes: lectura/sanitización/precios (#7517),
> señal de calidad (#7518), recomendador/reporte/audit/CLI (#7519) y cadencia en
> el Pulpo + publicación (#7520, esta doc). Código en
> `.pipeline/lib/model-value-audit/`; CLI en `.pipeline/scripts/model-value-report.js`.

## 1. Objetivo

Responder, una vez por semana y sin intervención humana, la pregunta del
operador: *¿qué agente corre con un modelo más caro (o más flojo) de lo que su
calidad justifica?* El auditor **marca, no ejecuta**: emite un veredicto cerrado
por skill con su evidencia numérica y, como máximo, **un mensaje por corrida**
al operador, sólo si hay algo accionable. Nunca edita `agent-models.json`: un
cambio de modelo sigue siendo un PR revisado por un humano.

## 2. Fuentes e integridad

| Fuente | Archivo | Qué aporta | Integridad |
|---|---|---|---|
| Corridas de agentes | `metrics/spawn-exit-*.jsonl` | `n`, muerte temprana, duración por skill | cadena hash verificada; un archivo roto en la ventana ⇒ **señal rota**, ningún veredicto accionable |
| Rebotes | `metrics/rebound-events.jsonl` | tasa de rebote por skill | sin cadena (#7508) — `no_verificada` |
| QA | `metrics/label-mutations.jsonl` | `qa:failed` por issue | sin cadena (#7508) — `no_verificada` |
| Modelo efectivo | `metrics/effective-model.jsonl` | modelo observado por corrida | sin cadena (#7508) — `no_verificada` |
| Costo real | `metrics/provider-cost.jsonl` | USD por corrida (#6558) | sin cadena (#7508); filas sin `ts` ⇒ costo `no evaluable` |
| Precios | `lib/pricing.js` (tabla + fallback embebido) | precio por proveedor/modelo, antigüedad | `sha256` de la tabla; vencida si supera `pricing_max_age_days` |
| Modelo declarado | `agent-models.json` | modelo configurado por skill | `sha256` de los bytes leídos viaja en el reporte |

Toda fila pasa por listas blancas (skills despachables de la config, proveedores
de `agent-models.json`, fases) y por `stripForOutput` antes de tocar cualquier
salida. Lo que no está en la lista se descarta y se cuenta en `desconocidos`.

## 3. Reglas del recomendador (orden y umbrales)

La primera regla que aplica gana, por skill:

1. integridad rota ⇒ `no evaluable` (motivo `integridad_rota`)
2. sin modelo observable en la ventana ⇒ `no evaluable`
3. proveedor sin tabla de precios ⇒ `no evaluable`
4. modelo sin clave en la tabla ⇒ `no evaluable` (`modelo_sin_precio`, #7507)
5. `n < min_sample` (o `min_sample_by_skill[skill]`) ⇒ `sin evidencia suficiente`
6. skill protegido ⇒ `mantener` (`security` protegido SIEMPRE, piso en código)
7. **subir** si rebote ≥ `subir_rebound` (0,30) **o** muerte temprana ≥ `subir_early_death` (0,10) **o** QA fallido ≥ `subir_qa_fail` (0,25) — no depende del costo
8. **bajar** sólo con TODO: rebote ≤ `bajar_rebound` (0,05), muerte temprana ≤ `bajar_early_death` (0,02), QA fallido 0 %, costo evaluable en la ventana y un modelo más barato en el mismo proveedor
9. `mantener`

Una métrica sin dato (`null`) nunca es cero: no dispara `subir` ni habilita `bajar`.

## 4. Invariantes

- **Read-only salvo dos escrituras**: el audit append-only (`audit/model-value-audit.jsonl`, sólo con `registrar: true` o `--registrar`) y el estado del cron (`state/model-value-audit-cron.json`, sólo desde el cron). Ambas resueltas vía `write-target` e inventariadas en `lib/write-points.json`.
- **Nunca** toca `agent-models.json`, `config.yaml`, `metrics/*`, `lib/pricing.js`.
- Fail-closed: `enabled` sólo enciende con el booleano `true` exacto; sección malformada ⇒ el brazo no corre y no escribe.
- Cadencia idempotente: el estado se escribe **antes** de correr; si no se puede persistir, no corre ni publica (nunca un repetidor horario).
- Un `last_run_at` futuro o corrupto **no** silencia el auditor: se trata como vencido.
- Como máximo **un** mensaje por corrida (≤ 3.500 chars, texto plano, sin `parse_mode`), y sólo si hay un `subir`/`bajar` o un hallazgo de precios (tabla vencida o modelo sin precio). Todo `mantener`/`sin evidencia` con precios al día ⇒ silencio explicado en el log.
- El texto hacia el operador usa el vocabulario de `report.js` (`subir de modelo`, `bajar de modelo`, `35,0 %`, `12,00 USD`, `2.656`) y pasa por controles/invisibles → redacción de secretos → tope por ítems enteros antes de encolarse.
- El adaptador `registry` nunca degrada a `telegram-plain` si #6807 no está disponible.

## 5. Configuración (`config.yaml`, con defaults)

```yaml
model_value_audit:
  enabled: false            # AUTORIDAD · fail-closed; sólo `true` exacto enciende el brazo
  cadence_days: 7           # cada cuánto corre (el tick del Pulpo es horario)
  window_days: 30           # ventana de evaluación; mínimo 30 (CA-1 de #6145)
  min_sample: 10            # corridas mínimas por skill para opinar
  min_sample_by_skill: {}   # override por skill, p. ej. { guru: 20 }
  pricing_max_age_days: 60  # antigüedad máxima de la tabla de precios
  protected_skills: [security, review, tester, qa, po]   # AUTORIDAD · nunca `bajar`
  thresholds: { subir_rebound: 0.30, subir_early_death: 0.10, subir_qa_fail: 0.25, bajar_rebound: 0.05, bajar_early_death: 0.02 }
  registrar: false          # AUTORIDAD · escribir cada corrida en audit/model-value-audit.jsonl
  publish: telegram-plain   # AUTORIDAD · 'telegram-plain' | 'registry' (#6807) | 'none'
```

- El schema (`lib/config-schema.js`) es estricto: clave desconocida, `window_days < 30`,
  `min_sample < 1`, umbral fuera de `[0, 1]` o `publish` fuera del enum ⇒
  `ConfigSchemaViolation` y el pipeline no arranca.
- `enabled`, `registrar`, `publish` y `protected_skills` son de **autoridad**:
  sólo cambian en archivo, nunca por variable de entorno.
- Si una clave falta, el cron usa `cadence_days: 7`, `window_days: 30`,
  `publish: none` (sin canal explícito no se publica); el recomendador usa sus
  propios defaults.
- **Audio**: el mensaje se narra por default (evento `model_value_audit` en
  `lib/audio-policy.js`). Se apaga en `pipeline.config.json`:
  `audio_policy.by_event.model_value_audit: false` (o `audio_policy.kill_switch: true`).

## 6. Corrida automática (Pulpo)

Brazo `model-value` en `pulpo.js` (junto a `vault-cut` y `#5453`): timer horario
siempre montado; en cada tick relee la config (`loadConfig()`), evalúa el gate y
sólo corre si `now - last_run_at ≥ cadence_days`. Orden del tick:

```
resolveSection → inFlight → due? → escribir last_run_at (atómico) → runAudit
  → registrar (sólo === true) → ¿hay algo accionable? → publish
```

Log (`pulpo.log`, componente `model-value`), sólo transiciones:
`deshabilitado` · `no_due` · `corrida sin hallazgos accionables (N agentes; …)` ·
`publicado <hash8> (K ítems, audio sí|omitido)` · `suprimido <motivo>` ·
`estado no persistible, corrida omitida (<code>)` · `corrida falló (<code>)`.

## 7. Mensaje al operador (`publish: telegram-plain`)

```
Auditoría de modelos por agente · 2026-08-22 → 2026-09-21
guru: subir de modelo (claude-sonnet-4-6) — rebote 35,0 % en 40 corridas, destino claude-opus-4-6
doc: bajar de modelo (claude-sonnet-4-6 → claude-haiku-4-5) — ahorro estimado 8,33 USD por mes, 40 corridas sin rebote
La tabla de precios tiene 136 días (última: 2026-05-08) y no tiene claude-opus-5, que corrió 2.801 veces: 1 agente no se pudo evaluar. Hace 10 semanas que la tabla está vencida. Refrescarla: #7507.
Ojo: el modelo declarado no se está propagando (propagación de modelos apagada); aceptar una sugerencia implica encender el rollout (#6274).
Nada se cambió solo. Reporte completo: node .pipeline/scripts/model-value-report.js --dias=30 --hasta=2026-09-21 · ref c0bf9536
```

Máximo 5 ítems (`subir` → `bajar` → precios) + `y N más en el reporte completo`;
el título es el mismo string que `proposal.titulo`; `ref <hash8>` son los 8
primeros caracteres de `evidencia.referencia`. Se encola como dropfile
`{ text, plain: true, disable_web_page_preview: true }` en
`servicios/telegram/pendiente/` y el servicio lo manda **sin** `parse_mode`.
Después del texto se pide la narración del mismo texto (`deliverable-notify.generateAudioNotifications`,
perfil `default`); si el audio falla, el texto ya salió (`audio omitido (<code>)`).

## 8. Propuesta (puerto `publish(proposal, ctx)`)

Forma alineada al draft de #6807 al 2026-09-21:

```json
{ "titulo": "Auditoría de modelos por agente · 2026-08-22 → 2026-09-21",
  "tipo": "cambio-de-configuracion",
  "accion": "revisar 2 sugerencias: subir guru, bajar doc; refrescar pricing.json",
  "evidencia": { "tipo": "metrica", "referencia": "<hash_self del audit | sha256 del reporte>", "resumen": "≤ 500 chars" },
  "beneficio": "≤ 300 chars", "costo": { "nivel": "bajo|medio|alto" }, "riesgo": { "nivel": "…", "detalle": "opcional" },
  "sensible": false }
```

`productor: 'auditor-modelos'` viaja en el `ctx`, no en el payload. Mapeo
cerrado: `bajar` ⇒ costo `bajo`, riesgo `medio` con propagación apagada / `bajo`
encendida; `subir` ⇒ costo `medio`, riesgo `bajo`; sólo precios ⇒ `bajo`/`bajo`
y `accion = refrescar pricing.json (#7507)`. Adaptadores: `telegram-plain`,
`none` (no invoca nada) y `registry` (**pendiente de #6807**: mientras no esté
mergeado devuelve `adaptador_no_disponible` y no publica por otro canal).

## 9. CLI reproducible

```bash
node .pipeline/scripts/model-value-report.js --dias=30 --hasta=2026-09-21            # tabla humana
node .pipeline/scripts/model-value-report.js --dias=30 --hasta=2026-09-21 --compacto # 4 columnas
node .pipeline/scripts/model-value-report.js --dias=30 --hasta=2026-09-21 --json     # JSON canónico (sha256 reproducible)
node .pipeline/scripts/model-value-report.js --dias=30 --registrar                   # además, registra la corrida en el audit
```

Exit codes: `0` reporte emitido; `1` argumentos/config/lectura inválidos; `2`
`--registrar` falló. El mensaje de Telegram cita exactamente el comando que
regenera su reporte (`--dias` y `--hasta` fijos ⇒ misma ventana mañana).

## 10. Formato del audit (`audit/model-value-audit.jsonl`)

Una línea por corrida registrada, encadenada por hash (`lib/audit-log.appendChained`),
sin texto libre: identificadores whitelisteados, enums, contadores y hashes.

```json
{"agent_models_sha256":"…","integridad":{"spawn_exit":"verificada","rebound_events":"no_verificada","label_mutations":"no_verificada","provider_cost":"no_verificada","effective_model":"no_verificada","broken_files":0},"pricing":{"sha256":"…","version":1,"updated_at":"2026-05-08T00:00:00Z"},"propagation_enabled":false,"report_sha256":"…","skills":{"doc":{"n":40,"veredicto":"bajar"}},"ts":"2026-09-21T12:00:00.000Z","ventana":{"from":"…","to":"…","dias":30},"created_at":"…","hash_prev":"…","hash_self":"…"}
```

`publicado` / `motivo_no_publicado` no van en la entrada (su forma la fija #7519):
viven en el log del brazo y en el retorno del tick.

## 11. Estado de dependencias (verificado 2026-09-21)

| Issue | Estado | Efecto sobre el auditor |
|---|---|---|
| #6558 | CLOSED | `provider-cost.jsonl` v2 con `ts`; sólo filas nuevas post-deploy son evaluables |
| #6274 | CLOSED | `pipeline.model_propagation.enabled` es la fuente del flag de propagación (hoy `false` ⇒ advertencia en cada `bajar`) |
| #7506 | OPEN | costo sin caché (`cache_read`/`cache_write`): el costo por agente puede estar sobreestimado |
| #7507 | OPEN | `pricing.json` sin `claude-opus-5`: los agentes Anthropic salen `no evaluable` y el hallazgo de precios es el primer mensaje esperado |
| #7508 | OPEN | rebotes/QA/costo/modelo efectivo sin cadena de integridad (`no_verificada`) |
| #6807 | OPEN (`Ready`, `blocked:dependencies`) | adaptador `registry` y dedup del hallazgo semanal llegan cuando esté mergeado |

## 12. Cómo apagar / operar

- Apagar el brazo: `model_value_audit.enabled: false` en `config.yaml` (se relee en ≤ 1 h, sin restart).
- Silenciar sin apagar: `publish: none` (corre y, con `registrar: true`, deja audit; no habla).
- Apagar sólo el audio: `audio_policy.by_event.model_value_audit: false` en `pipeline.config.json`.
- Forzar una corrida: borrar `state/model-value-audit-cron.json` (el próximo tick horario corre) o usar la CLI.
- **Post-merge**: `node .pipeline/restart.js` (nunca desde Git Bash). Un dashboard con `config-schema.js` viejo en memoria rechaza la sección nueva.
