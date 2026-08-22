# Waves — Cheat Sheet operativa (#3616)

Guía rápida para el operador del pipeline V3. Comandos primero, contexto
después.

> ¿Qué es una **ola**?
> Onda de issues planificados que el pipeline procesa juntos. Cada ola tiene
> un objetivo de negocio (`goal`) y un set de issues (`issues[]`). Sólo una
> ola es **activa** a la vez; las demás esperan en `planned_waves[]` o
> quedan en `archived_waves[]` cuando cierran.

---

## Comandos Telegram

| Comando | Qué hace | Ejemplo |
|---|---|---|
| `/wave status` | Muestra la ola activa, las próximas 5 planificadas y métricas. | `/wave status` |
| `/wave next` | Muestra solo la siguiente ola planificada. | `/wave next` |
| `/wave list` | Lista todas las olas (activa + planificadas + archivadas). | `/wave list` |
| `/wave promote N` | Promueve la ola planificada `N` a activa (atómico). | `/wave promote 5` |
| `/wave add #M [a wave N]` | Agrega issue `#M` a una ola (default: planificada siguiente). | `/wave add #3700 a wave 5` |
| `/wave repair` | (Futuro #3618) diagnostica desync y sugiere acciones. | `/wave repair` |

> Todos los comandos respetan el lock + atomic write + audit trail.
> El **operador no edita archivos a mano** — usa los comandos.

---

## Modelo de archivos

```
.pipeline/
├── waves.json           ← FUENTE DE VERDAD (planificación)
├── .partial-pause.json  ← espejo derivado (intake del pulpo)
└── archived/
    ├── waves.YYYY-MM-DDTHH-MM-SS.json     ← backup cada save
    └── partial-pause-rollback.*.json      ← snapshots transaccionales
```

- **`waves.json` es lo que importa.** Activa + planificadas + archivadas +
  dependencias.
- **`.partial-pause.json` es el espejo.** Lo lee el pulpo para decidir qué
  issues procesa. Se actualiza automáticamente al hacer `/wave promote`.
- **NUNCA editar `.partial-pause.json` a mano.** Si querés cambiar el set:
  `/wave add` y/o `/wave promote`.

---

## Numeración

- La primera ola se siembra con `number = max(archived.number) + 1`
  (default `1` si no hay archivadas).
- Las olas planificadas se numeran secuencialmente (las crea el
  `/planner` o se agregan con `/wave add`).
- El campo `name` es libre — usalo para identificar la ola con un slogan
  legible (ej. `"Ola N+5 — Multi-provider"`).

---

## Troubleshooting

| Síntoma | Primera acción |
|---|---|
| Dashboard muestra **"Planificación no disponible"** | `/wave status` — confirmar si hay activa. Si no, `/wave promote N` para la siguiente. |
| Pulpo no agarra issues nuevos | Verificar `.partial-pause.json` (`cat .pipeline/.partial-pause.json`) contra `/wave status`. Si difieren, ver "desync" abajo. |
| Telegram: **"waves.json y .partial-pause.json desincronizados"** | Pipeline en `human-block`. Ver sección **Recuperación ante desync** abajo. |
| Telegram: **"Pipeline sin ola activa — allowlist vacía"** | Normal entre olas; `/wave promote N` si querés iniciar una nueva. |
| Telegram: **"`.partial-pause.json` malformado, init abortado"** | Inspeccionar `.partial-pause.json` — algún ID no entero. Corregir o restaurar desde `archived/`. |

---

## Recuperación ante desync

Si el detector marca inconsistencia entre `waves.json` y
`.partial-pause.json`, el pipeline queda en `human-block`. Pasos:

```bash
# 1. Ver el diff exacto
cat .pipeline/.desync-detected.flag | jq .

# 2. Comparar ambos archivos
diff <(jq '.active_wave.issues[].number' .pipeline/waves.json) \
     <(jq '.allowed_issues[]'          .pipeline/.partial-pause.json)

# 3. Decidir cuál refleja la realidad operativa:
#    - Si waves.json está bien → re-promover la ola para regenerar
#      .partial-pause.json: /wave promote <number>
#    - Si .partial-pause.json está bien → restaurar waves.json desde
#      archived/ (snapshot más cercano al estado actual) o re-sembrar
#      con: node .pipeline/scripts/init-waves-from-partial.js

# 4. Limpiar el flag
rm .pipeline/.desync-detected.flag

# 5. Restart del pulpo (opcional — el flag se chequea al boot)
node .pipeline/restart.js
```

> El detector **nunca auto-repara**. La decisión es siempre humana.

---

## Boot del pulpo: orden importante

1. **`recoverIncompletePromote`** (#3520) — si hay marker stale de un
   `/wave promote` que crasheó a mitad, restaura ambos archivos desde
   snapshot.
2. **`init-waves-from-partial`** (#3616) — si `waves.json` está vacío y
   `.partial-pause.json` tiene allowlist, siembra una ola seed. Idempotente:
   re-ejecutar no toca nada si ya hay `active_wave`.
3. **`detectDesync`** (#3518) — si quedaron inconsistentes,
   alerta + `human-block`.

Después de estos tres pasos, el pulpo recién arranca el loop principal.

---

## Snapshot operativo: estado típico al iniciar el día

```bash
$ cat .pipeline/waves.json | jq '.active_wave.number, .planned_waves[].number'
1        # ola activa
2
3
4

$ cat .pipeline/.partial-pause.json | jq '.allowed_issues'
[3559, 3616, 3638]

$ # El desync-detector NO emite alerta → todo en sync.
```

Si ves esto, todo bien. Si ves otra cosa, mirá troubleshooting arriba.

---

## Referencias

- `docs/pipeline/waves-schema.md` — schema 1.0 detallado + diagrama.
- `docs/pipeline/modelo-planificacion-multi-ola.md` — modelo conceptual.
- `lib/waves.js` — implementación canónica.
- Issue **#3616** — esta funcionalidad (init + sin fallback + dashboard).
