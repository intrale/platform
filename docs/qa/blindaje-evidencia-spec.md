# Capa 5 — Blindaje de Captura de Evidencia

**Fecha:** 2026-04-09
**Estado:** Implementado
**Contexto:** Estrategia de 5 Capas para solucion definitiva del agente QA
**Decision clave:** Leo rechazó la degradación de evidencia. La evidencia debe ser del
máximo estándar. En vez de degradar, se blindan las 4 causas raíz de fallos de captura.

---

## Filosofia

La evidencia de QA debe ser de un estandar de calidad lo mas alto posible.
No se degrada la evidencia; se eliminan las causas por las cuales podria fallar
la captura. Si el screenrecord no funciona, el problema es de infraestructura
y se debe resolver, no esconder.

## Las 4 causas raiz y sus blindajes

### Blindaje 1: Timeout del screenrecord (limite 3 minutos)

**Causa:** `adb shell screenrecord` tiene un limite de 180 segundos por defecto.
Si el test Maestro tarda mas, el video se corta y queda incompleto.

**Solucion:** Grabacion segmentada. Un loop en el device graba segmentos de 170s
(ligeramente menor al limite para evitar corte abrupto). Al finalizar los tests,
los segmentos se extraen y se concatenan con `ffmpeg -f concat` en un solo video
continuo.

**Implementacion:** `qa/scripts/qa-android.sh`
- Loop de screenrecord en el device: `qa-seg-{port}-{N}.mp4`
- Extraccion de segmentos con `adb exec-out cat`
- Concatenacion con `ffmpeg -f concat -safe 0 -c copy`
- Si solo hay 1 segmento, se copia directamente sin ffmpeg
- Si ffmpeg falla, se usa el ultimo segmento como fallback

### Blindaje 2: ADB pierde conexion con el emulador

**Causa:** Si el emulador se levanto hace poco y ADB no termino de conectar,
el screenrecord arranca y se corta.

**Solucion:** Mini screenrecord de prueba (2 segundos) en el pre-flight check
del Pulpo (Check 4b). Si la grabacion de prueba funciona, el QA real puede
arrancar con confianza. Si falla, se reintenta hasta 3 veces con espera
progresiva (3s, 6s).

**Implementacion:** `.pipeline/pulpo.js` — funcion `preflightQaChecks()`
- Despues de verificar `adb devices` (check 4)
- Ejecuta: `screenrecord --time-limit 2 /sdcard/qa-preflight-test.mp4`
- Verifica que el archivo se genero, luego lo borra
- 3 reintentos con backoff progresivo
- Si falla 3 veces: `blocked:infra` (no penaliza circuit breaker)

### Blindaje 3: Disco lleno

**Causa:** Los videos pesan. Si no se limpian los de sesiones anteriores, el disco
se llena y el screenrecord falla silenciosamente.

**Solucion:** Cleanup automatico antes de cada sesion de grabacion. Si quedan
menos de 500MB libres, se borran los videos, logs y segmentos de sesiones previas.

**Implementacion:** `qa/scripts/qa-android.sh` — fase [6/9]
- `df -m` para verificar espacio libre
- Umbral: 500MB minimo
- Limpia: `maestro-shard-*.mp4`, `screenrecord-*.log`, `screenrecord-seg-*.mp4`
- Variable `QA_FORCE_CLEANUP=1` para forzar limpieza independiente del espacio

### Blindaje 4: Emulador se cuelga / ANR / RAM insuficiente

**Causa:** Falta de RAM, snapshot corrupto, o el test hizo algo que crasheo el
emulador. El emulador puede aparecer como "device" en ADB pero no responder.

**Solucion:** Health check post-boot de 4 puntos con retry desde snapshot limpio.

**Implementacion:** `qa/scripts/qa-android.sh` — fase [2.6/9]

**Los 4 tests del health check:**
1. `sys.boot_completed` == 1 (boot efectivo)
2. `input tap 360 640` responde sin error (no ANR)
3. `MemAvailable` > 100MB (RAM suficiente para screenrecord + Maestro)
4. Mini screenrecord de 2s (pipeline de video funcional)

**Retry:**
- Si algun test falla: `adb emu kill` + relanzar desde snapshot limpio
- Maximo 2 reintentos (3 intentos totales)
- Si falla 3 veces: se reporta como fallo de infraestructura (no de QA)

## Resumen de proteccion

| Causa | Blindaje | Donde | Reintentos |
|-------|----------|-------|------------|
| Timeout screenrecord (3 min) | Grabacion segmentada + ffmpeg concat | qa-android.sh | N/A (eliminado) |
| ADB sin conexion | Mini screenrecord de prueba | pulpo.js pre-flight | 3 intentos |
| Disco lleno | Cleanup automatico (<500MB) | qa-android.sh fase 6 | N/A (preventivo) |
| Emulador colgado/ANR/RAM | Health check 4 puntos + reboot | qa-android.sh fase 2.6 | 2 reintentos |

## Decisiones clave (registro)

- **2026-04-09:** Leo rechaza la degradacion gradual de evidencia. La evidencia debe ser
  de maxima calidad siempre. Si falla la captura, el problema es de infra y se debe
  resolver, no degradar.
- **2026-04-09:** Leo pregunta por que razones podria fallar el screenrecord. Se
  identifican 4 causas raiz, todas prevenibles. Leo aprueba los 4 blindajes.
