# Verificación del rebote de #6564

El intento anterior dejó la implementación sin commit y terminó por cuota del
agente. El log `6564-pipeline-dev.attempt-1.log` termina con
`You've hit your usage limit` y `turn.failed`; el Pulpo sintetizó
`agente_exit_code: 1`. No se encontró un error de implementación como causa
de esa salida. La pasada del 17/09 conservó el trabajo y repitió las verificaciones.

El backup informó `no-unpushed-commits` y el merge de `origin/main` respondió
`Already up to date.`. La implementación mide cuota, no el tier contratado:
probe aislado, caché durable, eje de plan separado de salud, alerta desde el
segundo tick y badges definidos por UX rev. 2.

## Evidencia de esta pasada

- `node --test .pipeline/tests/*.js`: 2406 aprobadas, cero fallos y tres
  omisiones declaradas por la suite (2409 casos, 188826 ms).
- `bash ./gradlew check --no-daemon`: `BUILD SUCCESSFUL in 2m 53s`,
  343 tareas (168 ejecutadas, 175 desde caché), sin exclusiones manuales.
- `bash .pipeline/smoke-test.sh`: `SMOKE TEST OK`; tres servicios activos,
  dashboard HTTP 200 y catálogo de 14 modelos. Advierte que el último restart
  es antiguo; no prueba persistencia posterior a un reinicio nuevo.
- Invariante de causas: 57 pruebas aprobadas, cero fallos.
- Probe real aislado: `cli_catalog_ok`, 14 modelos y `plan_quota_ok` con los dos
  grupos semanales. Resultado saneado en `live-rebote.json`.
- `node .pipeline/tools/verify-gemini-plan-6564.js`: tres estados HTTP/SSR
  comprobados en Chromium; badge sin superposición con credencial. Alerta
  capturada: cero envíos en tick 1, uno en tick 2 y ninguno adicional en tick 3.
  El sender es sintético: no verifica entrega real en Telegram.
- Capturas inspeccionadas contra el mockup UX rev. 2. Video regenerado desde
  esas capturas con la narración existente: video de 26 s y audio de 25,128 s.
  Es una secuencia narrada de estados, no una grabación continua de interacción.
- Búsqueda de identidad (`@|token|conversation_id`) sin coincidencias en
  `live-rebote.json` y `telegram-sintetico.txt`. Los archivos de producción
  modificados no contienen `plan_tier_free`, `PLAN PAGO` ni `PLAN GRATUITO`.

Los artefactos se encuentran en `.pipeline/evidence/6564/`. No corresponde
`qa:skipped`: cambian superficies visibles de dashboard y Telegram.

## Límite operativo pendiente

CA-1 requiere comprobar `agy models` después del reinicio operativo del pipeline.
Esta pasada comprueba la sesión actual; no ejecuta `restart.js`, que sincroniza
main y termina los procesos del pipeline. El cambio permanece en la rama del
issue para delivery y revisión humana. La aceptación posterior al despliegue
debe registrar por separado esa persistencia: el smoke y el probe aislado no
la sustituyen.
