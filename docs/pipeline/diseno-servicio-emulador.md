# Servicio Emulador — Diseño técnico

**Fecha:** 2026-04-11  
**Estado:** Propuesta aprobada por Leo  
**Archivo destino:** `.pipeline/servicio-emulador.js`

---

## Motivación

Hoy el Pulpo maneja el emulador directamente (`ensureQaEnvironment()` / `shutdownIdleEmulator()`). Esto genera acoplamiento: QA, tester y security dependen del ciclo del Pulpo para levantar o matar el emulador.

La propuesta es extraerlo como un **servicio independiente con cola**, igual que Telegram, GitHub y Drive.

---

## Arquitectura

```
.pipeline/servicios/emulador/
├── pendiente/    ← cualquier proceso deja un JSON { action: "start"|"stop" }
├── trabajando/   ← el servicio lo toma
└── listo/        ← confirmación
```

### Productores (quién pide start/stop)

| Productor | Cuándo pide `start` | Cuándo pide `stop` |
|-----------|--------------------|--------------------|
| Pulpo (preflight) | Issue entra en verificación con QA_MODE=android | — |
| Pulpo (idle check) | — | Cola de QA vacía, sin agentes QA/tester/security activos |
| Agente QA | Al iniciar si no detecta emulador via ADB | — |
| Agente Tester | Al necesitar emulador para tests instrumentados | — |

### Consumidor

**`servicio-emulador.js`** — servicio singleton, polling cada 10s, procesamiento secuencial.

---

## Coalescencia de mensajes: Last-Write-Wins

**Regla fundamental:** antes de ejecutar, el servicio lee **todos** los mensajes pendientes, los ordena por timestamp, y **solo ejecuta el último**. Los anteriores se descartan.

### Por qué last-write-wins y no cancelación de pares

La cancelación de pares (contar starts vs stops) da resultados incorrectos:

| Cola | Cancelación de pares | Last-write-wins | Correcto |
|------|---------------------|-----------------|----------|
| `[start, start, stop]` | 1 start neto → START | stop (último) → STOP | STOP |
| `[stop, start, start]` | 1 start neto → START | start (último) → START | START |
| `[start, stop]` | 0 neto → NOOP | stop (último) → STOP | STOP |

El **último mensaje refleja la intención más reciente** del sistema. Los mensajes anteriores ya fueron superados por decisiones posteriores.

### Algoritmo

```javascript
function coalesce(pendingFiles) {
  if (pendingFiles.length === 0) return null;
  
  // Ordenar por timestamp del nombre de archivo (epoch-based)
  const sorted = pendingFiles.sort((a, b) => {
    const tsA = parseInt(a.name.split('-')[0]) || 0;
    const tsB = parseInt(b.name.split('-')[0]) || 0;
    return tsA - tsB;
  });
  
  // El último mensaje gana
  const winner = sorted[sorted.length - 1];
  const action = JSON.parse(fs.readFileSync(winner.path, 'utf8')).action;
  
  // Mover todos a listo/ (descartados + ganador)
  for (const f of sorted) {
    fs.renameSync(f.path, path.join(LISTO, f.name));
  }
  
  return action; // "start" o "stop"
}
```

### Deduplicación contra estado actual

Después de coalescer, si la acción ganadora coincide con el estado actual, es un no-op:

| Acción ganadora | Estado actual | Resultado |
|----------------|---------------|-----------|
| `start` | `running` | No-op (ya está corriendo) |
| `start` | `stopped` | Levantar emulador |
| `stop` | `running` | Matar emulador |
| `stop` | `stopped` | No-op (ya está apagado) |

---

## Estados del servicio

```
stopped ──start──→ starting ──boot ok──→ running
   ↑                  │                     │
   │              boot fail                stop
   │                  │                     │
   └──────────────────┘      stopping ←─────┘
                                │
                            kill ok
                                │
                                └──→ stopped
```

- **`stopped`** — emulador apagado, sin PID
- **`starting`** — spawn ejecutado, esperando ADB device
- **`running`** — emulador respondiendo via ADB
- **`stopping`** — taskkill enviado, esperando confirmación
- Solo un estado a la vez, transiciones atómicas

---

## Formato de mensajes en la cola

```json
{
  "action": "start",
  "requester": "pulpo-preflight",
  "issue": 2061,
  "reason": "QA_MODE=android, emulador necesario",
  "timestamp": 1775941408
}
```

Campos:
- `action` — **obligatorio**: `"start"` o `"stop"`
- `requester` — quién lo pide (para logging/debug)
- `issue` — issue asociado (opcional)
- `reason` — descripción legible (opcional)
- `timestamp` — epoch seconds (obligatorio, usado para ordenamiento)

Nombre del archivo: `{timestamp}-{random}.json` (ej: `1775941408-a3f2.json`)

---

## Integración con el Pulpo

### Cambios en pulpo.js

**Eliminar:**
- `ensureQaEnvironment()` — reemplazado por encolar `{ action: "start" }`
- `shutdownIdleEmulator()` — reemplazado por encolar `{ action: "stop" }`

**Agregar:**
```javascript
function requestEmulator(action, requester, issue, reason) {
  const ts = Date.now();
  const msg = { action, requester, issue, reason, timestamp: Math.floor(ts / 1000) };
  const file = path.join(PIPELINE, 'servicios', 'emulador', 'pendiente', `${ts}-${Math.random().toString(36).slice(2,6)}.json`);
  fs.writeFileSync(file, JSON.stringify(msg, null, 2));
}
```

### Registro en singleton.js / dashboard-v2.js

Agregar `svc-emulador` a la lista de servicios gestionados, igual que `svc-telegram`, `svc-github`, `svc-drive`.

---

## Relación con qa-environment.js

`qa-environment.js` sigue siendo el **ejecutor de bajo nivel** (spawn, taskkill, ADB). El servicio-emulador lo usa internamente:

```
servicio-emulador.js (cola + coalescencia + estado)
    └── qa-environment.js (spawn, kill, adb)
```

No se duplica lógica — el servicio orquesta, `qa-environment.js` ejecuta.

---

## Ciclo de vida completo

```
1. Pulpo detecta issue #2061 necesita QA Android
2. Pulpo encola { action: "start", requester: "pulpo-preflight", issue: 2061 }
3. Servicio-emulador (polling 10s) lee la cola
4. Coalescencia: solo hay 1 mensaje → action = "start"
5. Estado actual = "stopped" → ejecuta start via qa-environment.js
6. Estado → "starting" → (boot ~30s) → "running"
7. Pulpo en siguiente ciclo verifica ADB → emulador listo → lanza agente QA

---

8. QA termina, tester termina, no hay más en cola QA
9. Pulpo encola { action: "stop", requester: "pulpo-idle" }
10. Servicio procesa → estado "running" → stop → "stopped"
11. Recursos liberados (~2.5 GB RAM)
```

### Escenario de coalescencia

```
1. Pulpo encola stop (cola QA vacía)
2. Antes de que el servicio procese, llega un nuevo issue QA
3. Pulpo encola start (nuevo issue necesita emulador)
4. Servicio lee la cola: [stop(t=100), start(t=105)]
5. Last-write-wins → start (t=105 > t=100)
6. Estado actual = "running" → no-op, emulador sigue corriendo
7. Se evitó un stop+start innecesario (ahorro ~60s de boot)
```

---

## Resumen de decisiones de diseño

| Decisión | Elección | Alternativa descartada | Motivo |
|----------|----------|----------------------|--------|
| Resolución de conflictos | Last-write-wins | Cancelación de pares | Pares da resultado incorrecto en [start,start,stop] |
| Procesamiento | Secuencial (1 a la vez) | Paralelo | Emulador es recurso único, no tiene sentido paralelizar |
| Polling | 10s | Event-driven (fs.watch) | Consistencia con otros servicios, fs.watch es frágil en Windows |
| Executor | Reusar qa-environment.js | Código inline | No duplicar lógica de spawn/kill/ADB |
