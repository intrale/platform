# Ventanas de Prioridad — Especificacion Tecnica

**Fecha:** 2026-04-10
**Estado:** Aprobado por Leo
**Contexto:** Rediseno de ventanas de prioridad para resolver deadlock QA/Build

---

## Problema resuelto

El modelo anterior tenia dos problemas criticos:

1. **Deadlock QA↔Build:** La ventana QA pausaba dev Y build, pero QA necesita APKs que genera el builder. Si los issues no tenian APK, QA no podia avanzar y build estaba bloqueado.

2. **Duracion fija arbitraria:** El config tenia `qa_priority_max_duration_minutes: 15` hardcodeado, en vez de ser dinamico segun la cola.

## Modelo nuevo: ventanas autoexcluyentes con umbral configurable

### Principio rector

> La etapa mas avanzada del pipeline siempre tiene prioridad.
> QA > Build > Dev

### Umbral de activacion (configurable)

Las ventanas se activan **automaticamente** cuando la cantidad de issues acumulados en su cola alcanza el umbral configurado. Por debajo del umbral, los issues compiten normalmente con el resto del pipeline (respetando la prioridad natural por etapa).

**Configuracion en `config.yaml`:**

```yaml
priority_windows:
  activation_threshold: 3          # Cantidad de issues para activar ventana (configurable)
  qa_overrides_build: true         # QA siempre tiene prioridad sobre Build
```

El umbral es el mismo para ambas ventanas (QA y Build). Se configura una sola vez.

### Tabla de comportamiento

| Cola QA    | Cola Build | Comportamiento |
|------------|------------|----------------|
| < umbral   | < umbral   | **Normal** — todos compiten, prioridad natural por etapa (QA > Build > Dev) |
| **>= umbral** | cualquiera | **Ventana QA activa** — QA exclusivo hasta vaciar cola |
| < umbral   | **>= umbral** | **Ventana Build activa** — Build exclusivo hasta vaciar cola |
| **>= umbral** | **>= umbral** | **Ventana QA activa** (QA > Build), Build espera turno |

### Reglas de autoexclusion

1. **Solo una ventana activa a la vez.** QA y Build son mutuamente excluyentes.
2. **QA siempre gana.** Si ambas colas superan el umbral, QA tiene prioridad.
3. **Cuando ninguna ventana esta activa**, todos los skills compiten normalmente. El pipeline respeta la prioridad natural: las fases mas avanzadas se procesan primero.

### Activacion y desactivacion

**Activacion automatica:**
- Se evalua en cada ciclo del Pulpo (cada 30s)
- Si la cola de QA >= umbral → ventana QA se activa (bloquea dev y build)
- Si la cola de Build >= umbral Y la ventana QA NO esta activa → ventana Build se activa (bloquea dev)
- Notificacion por Telegram al activarse

**Desactivacion automatica:**
- Cuando la cola de la ventana activa se vacia → se desactiva
- NO hay timeout fijo. La ventana corre hasta que la cola se vacia o se desactiva manualmente
- Timeout de seguridad: si lleva mas de 2 horas sin completar ningun issue, se notifica por Telegram (pero NO se cierra automaticamente)

**Control manual:**
- Desde el dashboard: botones para activar/desactivar cada ventana
- Las ventanas manuales se comportan igual que las automaticas pero solo se desactivan por accion manual o timeout de seguridad
- Si una ventana manual esta activa y la otra quiere activarse automaticamente, la automatica espera

### Issue sin APK → retorno al builder

Cuando QA detecta que un issue no tiene APK disponible:

1. El pre-flight del Pulpo detecta `apk_missing`
2. El issue se mueve de la cola de verificacion a la cola de build
3. Se agrega un comentario en GitHub: *"QA requiere APK para este issue. Devuelto al builder."*
4. El issue NO se penaliza en el circuit breaker (no es un fallo del agente)
5. Cuando el builder genera el APK, el issue vuelve automaticamente a la cola de QA

### Que bloquea cada ventana

| Ventana activa | Fases bloqueadas | Fases permitidas |
|----------------|------------------|------------------|
| QA             | dev, validacion, build | verificacion, aprobacion, entrega |
| Build          | dev, validacion  | build, verificacion, aprobacion, entrega |
| Ninguna        | (nada)           | todas |

### Cambios respecto al modelo anterior

| Aspecto | Antes | Ahora |
|---------|-------|-------|
| Duracion maxima QA | 15 min fijo | Sin limite (hasta vaciar cola) |
| Duracion maxima Build | 20 min fijo | Sin limite (hasta vaciar cola) |
| Tiempo de espera para activar | 30 min QA / 5 min Build | Inmediato al superar umbral |
| Umbral QA | 3 issues | Configurable (`activation_threshold`) |
| Umbral Build | 2 issues | Mismo umbral configurable |
| Ventanas simultaneas | Posible (ambas activas) | Autoexcluyentes |
| Build durante QA | Bloqueado | Bloqueado (QA > Build) |
| Issue sin APK | Se queda en cola QA | Retorna a cola Build automaticamente |

### Configuracion en config.yaml

Se reemplaza la seccion anterior de priority windows:

```yaml
# ANTES (se elimina):
# qa_priority_queue_threshold: 3
# qa_priority_wait_minutes: 30
# qa_priority_max_duration_minutes: 15
# build_priority_queue_threshold: 2
# build_priority_wait_minutes: 5
# build_priority_max_duration_minutes: 20

# AHORA:
priority_windows:
  activation_threshold: 3          # Issues acumulados para activar ventana
  safety_timeout_hours: 2          # Horas sin completar → notificacion Telegram (no cierra)
  qa_overrides_build: true         # QA > Build (autoexcluyentes)
```

## Decisiones clave (registro)

- **2026-04-10:** Leo indica que la ventana QA no deberia tener timeout fijo de 15 minutos. Debe ejecutar mientras tenga issues en cola.
- **2026-04-10:** Leo indica que las ventanas de QA y Build deben ser autoexcluyentes. Cuando una esta activa, la otra no puede estarlo.
- **2026-04-10:** Leo indica que la etapa mas avanzada siempre tiene prioridad: QA > Build > Dev.
- **2026-04-10:** Leo indica que cuando ninguna ventana esta activa, los skills compiten normalmente (dev, PO, UX, etc.).
- **2026-04-10:** Leo indica que el umbral de activacion debe ser configurable. Propuesto: 3 issues. Mismo umbral para ambas ventanas.
- **2026-04-10:** Leo confirma que la APK es responsabilidad del builder, no del android-dev. Si QA detecta APK faltante, el issue vuelve a la cola del builder con comentario.
- **2026-04-10:** Leo indica que el switch manual entre ventanas se puede hacer desde el dashboard (botones existentes).
