# Auditor del modelo operativo (`process-audit`)

> Issue #6809. Complementa a #6793 (auditor calidad-precio del **modelo** por agente): éste audita
> **cómo trabaja el proceso**. Publica en el registro único de propuestas (#6807).

## Qué hace

Cada `cadence_days` lee la telemetría que el pipeline ya persiste, evalúa tres ejes y, si encuentra
algo accionable **con una métrica que lo respalde**, publica una **sugerencia** en el registro de
propuestas con el productor `auditor-proceso`. Ahí termina su trabajo.

- **100 % determinístico**: Node puro, sin LLM, sin red, sin `gh`.
- **Sólo sugiere, nunca aplica**: no toca `config.yaml`, `agent-models.json`, `provider-schedule.json`,
  issues ni labels. Las propuestas que suben costo o riesgo salen como `cambio-de-configuracion` y
  requieren la decisión del operador.
- **Un solo canal**: `propuestas-registry.publicar()`. Si el registro rechaza o está degradado, se
  loguea y **no** se degrada a Telegram ni a ningún otro canal.
- **Sin métrica no hay propuesta**: todo hallazgo lleva `metrica { nombre, valor, ventana }`. Los
  veredictos `mantener` y `sin_evidencia_suficiente` no se publican.

## Módulos (`.pipeline/lib/process-audit/`)

| Módulo | Rol | Escribe |
|---|---|---|
| `hourly-rollup.js` | Acumulador horario que alimenta `persistMetricsSnapshot` del Pulpo | `metrics-history-hourly.jsonl` (1 línea/hora, tope 2160 = 90 días) |
| `read-hourly.js` | Lector acotado del rollup (tope de bytes, whitelist, líneas corruptas descartadas) | — |
| `read-verdicts.js` | Veredictos de `procesado/`, rebotes, corridas con costo, fallos de `spawn-exit` | — |
| `read-control-age.js` | Antigüedad de controles apagados vía `git log -S` (allowlist cerrada, sin shell) | — |
| `axis-process.js` | Eje proceso | — |
| `axis-capacity.js` | Eje capacidad y paralelismo | — |
| `axis-providers.js` | Eje proveedores, cuota y plan | — |
| `bands.js` | Bandas congeladas para la dedup | — |
| `publish.js` | Hallazgo → payload del registro (plantillas fijas) | — (escribe el registro) |
| `index.js` | `runAudit()`: corre los tres ejes, cada uno aislado | — |
| `cron.js` | `tickIfDue()` del brazo del Pulpo + `readStatus()` para el dashboard | `state/process-audit-cron.json` |

## Fuentes por tipo de sugerencia

| Tipo (`clave`) | Eje | Fuente (`evidencia.tipo`) | Regla |
|---|---|---|---|
| `paso_determinizable` | proceso | `rebound-events+procesado` (+ corridas de `provider-cost`) | `(skill, fase)` evaluativo con ≥20 veredictos, todos iguales, y el skill usa un modelo según `agent-models.json` |
| `paso_sobra` | proceso | `rebound-events+procesado` | idem, con skill determinístico. `security` nunca se propone |
| `fallo_recurrente` | proceso | `spawn-exit` | firma `sha256(skill\|fase\|death_kind\|exit_code)[:12]` con ≥5 ocurrencias en ≥3 días UTC (sin fase en `spawn-exit`: va `-`) |
| `fase_costosa` | proceso | `provider-cost` | fase evaluativa con ≥30 % de los tokens facturables (in+out+cache_write) y <10 % de variación del veredicto; rebotes y reintentos van como soporte |
| `control_apagado` | proceso | `git-log-config` | control de `CONTROLES_AUDITADOS` con `enabled: false` hace ≥14 días |
| `ociosidad_sin_trabajo` | capacidad | `metrics-history-hourly` | ≥50 % del tiempo con cero agentes y trabajo elegible mediano 0 en las horas ociosas ⇒ atacar el bloqueo; **prohíbe subir** |
| `ociosidad_con_trabajo` | capacidad | `metrics-history-hourly` | ociosidad con trabajo elegible esperando ⇒ revisar el gate; tampoco sube |
| `concurrencia_subir` | capacidad | `metrics-history-hourly` | cap lleno ≥20 % del régimen y `mem_p95` con cap lleno + costo marginal < `yellow_max_percent`; paso +1 con condición de reversión |
| `concurrencia_bajar` | capacidad | `metrics-history-hourly` | pico de RAM con cap lleno ≥ `orange_max_percent` (gana sobre subir) |
| `detector_revisar` | proveedores | `quota-detector+quota-ledger` | flag de cuota con la ventana observada (muestras frescas) < 95 % |
| `schedule_mover` | proveedores | `quota-series` | horas de única pata viva y gateada con otro proveedor en reposo por horario |
| `cadena_reordenar` | proveedores | `quota-series+quota-balance` | proveedor agotado, otra pata viva, sin gate y con muestras en la ventana, y aun así la cadena quedó agotada con trabajo elegible (≥1 h): la cadena de esos agentes no llega a la pata con saldo. Cita el saldo de la otra pata. Si el fallback absorbió el agotamiento, no hay nada que reordenar |
| `plan_subir` | proveedores | `quota-ledger+quota-series` | ≥2 semanas limpias, las dos últimas agotadas, cadena agotada con trabajo elegible y ninguna otra pata viva con muestras mientras estaba agotado |
| `plan_bajar` | proveedores | `quota-ledger` | ≥2 semanas limpias con consumo máximo <30 % y cero horas gateado |

### Eje capacidad: orden obligatorio

1. **Causa antes que remedio.** Si la ociosidad se explica por falta de trabajo elegible, `subir`
   queda prohibido y se sugiere atacar el bloqueo (citando la causa dominante de `dispatch-facts`).
2. **`bajar`** si el pico de RAM con el cap lleno llegó a naranja (sesgo a la estabilidad).
3. **`subir`** (+1, nunca un salto) sólo con saturación medida y margen contra `yellow_max_percent`.
   Costo marginal = pendiente de la regresión de `mem_p50` contra la cantidad de agentes.
4. En cualquier otro caso: **`mantener`**. Menos de 24 horas válidas (`min_samples_hora`):
   `sin_evidencia_suficiente`.

Los umbrales son los vigentes de `resource_limits` (diurno y `night_window`); el auditor no propone
umbrales nuevos. La ociosidad se calcula **sólo** con `dispatch-facts` (`conteo.elegibles` + `cause`),
nunca con `byFase.pending`.

### Eje proveedores: orden de descarte

`1. flag falso → 2. schedule → 3. cadena → 4. plan`. El resultado de cada paso viaja textual en
`evidencia.resumen` (por ejemplo `1. flag falso: no, 2. schedule: no, 3. cadena: no, 4. plan: causa`).

- **Ventana limpia**: la serie de cuota se considera contaminada antes de `QUOTA_CLEAN_SINCE =
  2026-09-10` (corrección del detector). Con menos de 2 semanas limpias no hay sugerencia de plan; el
  reporte deja `ventana_limpia_desde`.
- **Créditos de reset (#7185)**: se marcan como confusor, se cuentan y su salto nunca suma consumo.
- El techo del plan superior no está declarado en la config: la propuesta cita el techo actual y pide
  cotizar antes de decidir.

## Dedup: bandas congeladas

El registro deduplica por `productor + tipo + accion + evidencia.tipo + evidencia.referencia`, no por
el valor. Por eso:

- `evidencia.referencia = "<eje>:<metrica>:banda-<lo>-<hi>"`, con las bandas de `bands.js`
  (porcentajes en tramos de 10 pp, horas/conteos/días en escalas anchas).
- `accion` no lleva valores medidos (sólo identificadores y valores de config); los números van en
  `evidencia.resumen` y en `costo/riesgo.detalle`, que no entran al hash.
- Misma banda ⇒ `duplicada` (si está viva) o `rechazada_previamente` (si el operador la rechazó).
  Si la métrica cambia de banda, es una propuesta nueva.

## Rollup horario (`metrics-history-hourly.jsonl`)

`metrics-history.jsonl` guarda ~24 h. El Pulpo, después de persistir cada snapshot, llama a
`hourly-rollup.accumulate()` en un `try/catch` propio. Acumula en memoria (O(1) por muestra,
reservorios de ≤120 valores) y escribe **una** línea al cambiar la hora UTC:

```json
{ "schema": 1, "ts_hora": "2026-09-23T10:00:00.000Z", "n_muestras": 120,
  "muestras_cero_agentes": 96, "min_cero_agentes": 48,
  "por_agentes": { "0": { "n": 96, "mem_p50": 64, "mem_p95": 70, "mem_max": 72, "cpu_p50": 5, "cpu_max": 9 } },
  "elegibles_p50": 0, "elegibles_max": 0, "elegibles_p50_cero": 0, "muestras_elegibles": 120,
  "causa_moda": "partial-pause", "cap_efectivo": 1, "nocturna": false,
  "muestras_en_cap": 0, "en_cap": { "n": 0, "mem_p95": null, "mem_max": null } }
```

Los hechos de despacho se memoizan ~1 min (y el watchdog de despacho refresca el mismo cache), así
que el rollup no recalcula `recolectarHechosDespacho` en cada ciclo. Un reinicio del Pulpo pierde la
hora en curso; el lector descarta horas con pocas muestras.

## Configuración

```yaml
process_audit:
  enabled: false        # autoridad; sólo `true` exacto enciende el brazo
  cadence_days: 7       # 1..30
  window_days: 14       # 7..30
  min_samples_hora: 60  # 1..120
```

Un valor fuera de rango deja el auditor **apagado** (sin clamp silencioso). El gate se relee en cada
tick horario: encender o apagar no requiere reiniciar el Pulpo. El tope diario de propuestas es
`propuestas.cuota_diaria_por_productor`; además, cada corrida intenta como máximo 10 publicaciones.

### Cómo encenderlo

1. Poner `process_audit.enabled: true` en `.pipeline/config.yaml` (PR normal: es autoridad).
2. La primera corrida ocurre en el próximo tick horario. Los ejes capacidad y proveedores responden
   `sin_evidencia_suficiente` hasta juntar 24 horas de rollup y 2 semanas limpias de cuota: es lo
   esperado.

## Estado visible

- `state/process-audit-cron.json`: `last_run_at`, `last_reason`, veredicto y cantidad de hallazgos por
  eje, propuestas nuevas y motivos de no publicación.
- `GET /api/dash/process-audit` (sólo lectura, gate loopback del dashboard): `enabled`,
  `config_valida`, `estado` (`inactivo` | `esperando_primera_corrida` | `activo`), `last_run_at`,
  `last_reason`, conteos por eje. Sólo booleanos, números, un ISO y tokens `[a-z_]`. No hay ruta para
  encender el auditor ni para forzar una corrida.
- Log del Pulpo con el tag `process-audit` (sólo transiciones).

## Seguridad (SEC-6809-1..10)

- Toda la telemetría se proyecta por whitelist (`skill`, `fase`, `provider`, números, enums); ningún
  texto libre (`motivo`, stderr, `raw_excerpt`) viaja a la propuesta. Los fallos se agrupan por firma
  hash. Los textos salen de plantillas fijas; `publicar()` además aplica `detectInjection` y
  `redactObject`.
- `git log` se invoca con `execFileSync('git', argv)`, sin shell, timeout de 10 s, `maxBuffer` de
  1 MB y un presupuesto total de 30 s por corrida, sólo para las claves de `CONTROLES_AUDITADOS`.
- Tests: `node --test .pipeline/lib/process-audit/__tests__/*.test.js` (incluye
  `policy-readonly.test.js`, que espía `fs` y `child_process` durante una corrida completa).
