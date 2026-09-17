# Cuota efectiva y confirmación manual de Gemini (#6564)

El tier contratado no es observable automáticamente con `agy` 1.2.4. El modo
no interactivo expone catálogo y cuota, pero ningún comando de cuenta/plan.
`/usage` no identifica el tier. La cuota disponible tampoco prueba una suscripción.

El operador confirma el tier abriendo `agy` interactivo y leyendo el header que
muestra email y plan tier. Esa información permanece en la terminal del operador:
no se copia a logs, capturas, snapshots ni alertas del pipeline.

El health-cron comprueba primero la sesión con `agy models` y sólo si responde
con catálogo válido ejecuta `agy -p "/usage" --output-format json`. Usa el mismo
launcher con `shell:false`, timeout de 30 segundos y caché durable de 15 minutos
(4 minutos para resultados no verificables). Una respuesta que consumió generación
se descarta y bloquea nuevos probes durante 15 minutos, incluso tras reinicios.

En Git Bash, la comprobación manual exige:

```bash
MSYS_NO_PATHCONV=1 agy -p "/usage" --output-format json
```

Sin `MSYS_NO_PATHCONV=1`, Git Bash convierte `/usage` en una ruta y puede disparar
un turno real de aproximadamente 13.000 tokens. La invocación Node sin shell
conserva el argumento literal y evita esa conversión.

Los tres estados del eje `plan_check` son `plan_quota_ok`, `plan_tier_unknown`
y `cli_license_unavailable`. El panel sólo muestra cuota verificada con ambos
grupos semanales válidos y medición de hasta 30 minutos. La falta de verificación
no cambia la salud del proveedor. Al segundo tick consecutivo se alerta por
Telegram, con dedupe independiente de 24 horas; sin sesión sólo alerta la salud.

`state/agy-plan-probe.json` guarda fracciones, ventanas, resets saneados, grupos
de tabla cerrada, fecha y metadatos cerrados de caché. No guarda texto libre ni
identificadores de conversación y no accede al token OAuth.

La verificación de persistencia de sesión en producción requiere un reinicio
operativo coordinado: `node .pipeline/restart.js` sincroniza main y reinicia los
procesos del pipeline. Luego `agy models` debe devolver rc=0 y catálogo no vacío.
El probe aislado no reemplaza esa evidencia posterior al reinicio.
