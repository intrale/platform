## 🔐 Auditoría de seguridad — APROBADO (pasada 3)

**HEAD auditado:** `3d3fcfcba` · rama `agent/5172-pipeline-dev` · sin PR abierto.

Delta propio de esta pasada: **un solo commit**, `3d3fcfcba` ("Cerrar dos fail-open de la migración al config-resolver"). El otro commit del rango (`ecb552459`, #5276) ya está en `origin/main` (`git merge-base --is-ancestor` ⇒ true) y se audita en su issue.

**Sin vulnerabilidades.** El commit *cierra* dos fail-open; no abre ninguno.

### Lo que verifiqué con sondas propias (no los tests del autor)

1. **SEC-1** — config roto con canario tipo API key + AWS key en líneas adyacentes, y otro canario dentro del valor para forzar el camino ajv. Serialicé el error entero (`name`/`message`/`stack`/props/`cause`) y reconstruí la línea exacta que emiten los runners: `leaks = false` en los tres caminos nuevos (YAML, ajv, degradación de TTL de cuota). `cause` no se encadena; el payload de Telegram del supervisor es literal estático.
2. **Fix (1), cuota** — con config corrupta y `setFlag` **sin** `maxDays` (como lo llama `dispatch-with-fallback.js`): ya no lanza y el flag **se persiste**. Antes se perdía la señal de cuota y el pipeline seguía despachando contra un proveedor en 429.
3. **Fix (2), runners** — harness hermético que no debilita el `pipelineDir` explícito. Control **no vacuo**: `relaunch → skip` y `kill-respawn → skip` sólo al corromper el config. `MODULE_NOT_FOUND` sigue fail-soft.
4. **Sin regresión de clasificación**: ambos errores tipados siguen dando `corruption`.
5. **Guard CA-2**: ningún lector de `config.yaml` fuera del resolver — los `yaml.load` que sobreviven son todos de work-files/contratos (verificado leyendo `pulpo.js:1433`).
6. **`kernel-table-verify`**: la migración *endurece* el fail-closed — "config ilegible" ya no se disfraza de "sección kernel ausente".
7. **Sin cambios de dependencias** ⇒ no entran CVEs. Sin `child_process`/`eval`/`fetch` nuevos en producción.
8. Suites verdes: 12/12 nuevas + 46/46 de config-resolver.

### Observación destacada (no bloqueante) — para `review`

El sentinel de fail-closed `__configViolation` viaja en el **mismo objeto** que la sección `watchdog:` parseada de `config.yaml`, y esa sección **no está en el schema**. Reproducido sobre un config **sano y schema-válido**:

```
validateConfig(doc con watchdog.__configViolation=true)  => true
CONTROL liveness   => ACTION:kill-respawn   |  SPOOF => ACTION:skip
CONTROL supervisor => ACTION:relaunch       |  SPOOF => ACTION:skip
```

El copy al operador además queda falso ("config.yaml ilegible o inválido" sobre un archivo válido), lo que manda la respuesta a incidentes al archivo equivocado.

**No lo hago bloqueante** porque no cruza frontera de privilegio: escribir `config.yaml` exige el mismo acceso que escribir los propios runners `.js`, y verifiqué que no hay vía de menor privilegio (ningún endpoint del dashboard muta config; las escrituras con `yaml.dump` van a work-files). Es confusión dato/control en un mecanismo de seguridad, no una vulnerabilidad explotable. Queda en **#5298** por si `review` prefiere cerrarlo en esta entrega.

### Recomendaciones creadas (pendientes de aprobación humana)

- **#5298** — `[security]` Sacar el sentinel `__configViolation` del namespace de datos de `config.yaml` (`priority:low`). Incluye la opción de declarar `watchdog:` en el schema con `additionalProperties: false`, que además cierra la clase entera: hoy toda esa sección viaja sin validar.
- **#5299** — `[security]` Confinar `opts.configPath` a un prefijo permitido antes de exponerlo por CLI (`priority:low`). No alcanzable hoy desde datos externos; es blindaje a futuro.

Ambas llevan `needs-human` + `tipo:recomendacion`: **no entran al pipeline** hasta aprobación humana. Ninguna bloquea este issue.

### Higiene (sin issue, para `review`/`tester`)

Los dos tests nuevos no limpian sus tmpdirs (sin `rmSync` / `t.after`): dejan directorios `p5172-*` / `q5172-*` por corrida. Sin riesgo de seguridad, pero suma al problema de disco conocido.

### Fuera de alcance

La rama arrastra `b3863bfbd` (credenciales de Drive al store externo), ajeno a #5172, auditado en la primera pasada (#5265 / #5266 / #5267). Separarlo o no antes del merge es decisión de `review` / `aprobacion`.

📄 Entregable: `.pipeline/assets/docs/5172/security-verificacion-5172.md` (`sensible: true` — no se publica).
