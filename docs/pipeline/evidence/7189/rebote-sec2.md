# Rebote SEC-2: identidad del escritor CAS

El intento anterior terminó por límite de uso del agente. El log registra
`You've hit your usage limit` y `turn.failed`; la corrección quedó sin commit.

La sonda resuelve las credenciales una vez y comparte el entorno entre STS,
el escritor y el readback, sin `--profile` que sustituya las claves verificadas.
CA-B3 usa también el resolvedor de credenciales del backend.

## Verificación empírica del 14 de septiembre de 2026

Comando: `node --test .pipeline/tests/opstate-cas-identity-7189.test.js .pipeline/lib/__tests__/opstate-cutover-probe-7189.test.js`

```text
{"source":"otro-principal","principal":"otro-principal","exitCode":1,"writes":0,"writerFromEnv":false,"mismoEntorno":false}
{"source":"runtime-principal","principal":"runtime-principal","exitCode":0,"writes":1,"writerFromEnv":true,"mismoEntorno":true}
{"source":"perfil","principal":"runtime-principal","exitCode":0,"writes":1,"writerFromEnv":true,"mismoEntorno":true}
tests 65
pass 65
fail 0
```

La misma prueba cargando con `Module._compile` el script de `git show
4fa04a607:.pipeline/scripts/opstate-cutover-probe.js` confirmó `writes:1` para
`otro-principal`. El test falla: el escritor se construye antes de detectar el
problema; el readback de la prueba rechaza el `--profile` antiguo. En la versión
corregida no se construye el escritor ni se intenta el readback para esa identidad.

Son pruebas de cableado con STS y transporte DynamoDB simulados, sin red ni
mutaciones de AWS. No acreditan una nueva ejecución contra IAM real.

La regresión de `operational-state*`, `partial-pause*`, `waves*`,
`kernel-store-migrate*`, `kernel-coordination-store*` y `opstate*`, más el nuevo test,
dio 802/802. `pulpo-runtime-auth-7189.test.js` dio 17/17. No se editaron tests
existentes. El lint dio `652 archivos JS escaneados, 0 violations`.

El smoke test dio `SMOKE TEST OK`: Pulpo, dashboard y Telegram vivos; dashboard
HTTP 200. Informó antigüedad de `last-restart.json` como warning. No hubo restart.
`git diff --stat origin/main -- .pipeline/config.yaml` produjo salida vacía.

`bash ./gradlew check --no-daemon` terminó con código 0:

```text
BUILD SUCCESSFUL in 1m 31s
343 actionable tasks: 168 executed, 175 from cache
```
