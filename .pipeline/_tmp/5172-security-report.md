## Reporte de auditoría de seguridad — issue #5172

**Veredicto:** sin hallazgos

**Alcance auditado:** rama `agent/5172-pipeline-dev` @ `3e70357a5` (sin PR abierto).
Re-pasada: la aprobación anterior de `security` cubrió hasta `b3863bfbd`; el delta
nuevo es el commit `3e70357a5` ("Fallar cerrado en GATE 3 cuando la configuración no
se puede leer"), auditado en detalle por ser código de gate. 8 archivos, +507/-11:
`pulpo.js`, `lib/config-resolver.js`, `lib/kernel-action-policy.js`,
`lib/desync-detector.js`, `lib/parallel-lane-classifier.js`, `lib/quota-exhausted.js`,
`restart.js` y `lib/__tests__/gate3-config-failclosed.test.js`.

### Hallazgos

**Sin hallazgos.** No se detectó inyección, bypass de autenticación/autorización,
secrets hardcodeados, exposición de datos sensibles ni dependencias nuevas con CVE.
El commit **cierra** un fail-open de gate (mejora neta de postura), no lo abre.

### Verificación empírica (sondas propias, no los tests del autor)

**1 · El fail-open que el commit cierra, verificado en los 7 modos de fallo de config**

Sonda propia sobre `resolve()` con `PIPELINE_DIR_OVERRIDE` a tmpdir. Lo crítico es que
TODO fallo de lectura produzca un error que `isConfigViolation()` reconozca: si alguno
cayera fuera, `pulpo.js:16186` lo trataría como "error ajeno al config" y **procedería
sin GATE 3** (fail-open).

```
1 archivo AUSENTE   => {"name":"ConfigParseViolation","esViolacion":true,"causa":"ENOENT"}
2 archivo VACIO     => {"name":"ConfigParseViolation","esViolacion":true,"causa":"empty-or-not-a-map"}
3 solo espacios     => {"name":"ConfigParseViolation","esViolacion":true,"causa":"empty-or-not-a-map"}
4 no-mapa (lista)   => {"name":"ConfigParseViolation","esViolacion":true,"causa":"empty-or-not-a-map"}
5 schema invalido   => {"name":"ConfigSchemaViolation","esViolacion":true,"causa":"schema-invalido"}
6 config.yaml ES DIR=> {"name":"ConfigParseViolation","esViolacion":true,"causa":"not-a-file"}
7 truncado a medias => {"name":"ConfigSchemaViolation","esViolacion":true,"causa":"schema-invalido"}
```

7/7 reconocidos ⇒ no queda ninguna variante de config ilegible que caiga al camino
tolerante. `resolve()` valida `statSync().isFile()` antes de leer (config-resolver.js:357-370).

**2 · Fail-closed end-to-end sobre el estado EN DISCO (sonda propia, fixture propio)**

`pulpo.realignAllowlistToActiveWave()` con `PULPO_NO_AUTOSTART=1`, ola activa con issues
distintos de la allowlist previa (hay algo real que mutar). Se afirma sobre el archivo,
no sobre el retorno:

```
A schema-invalido  reason=gate3_config_unreadable      ok=false | allowlist_intacta=true | fuga_canario=false
B config AUSENTE   reason=gate3_config_unreadable      ok=false | allowlist_intacta=true
C config VACIO     reason=gate3_config_unreadable      ok=false | allowlist_intacta=true | fuga_canario=false
D config SANO      reason=gate3_confirmation_required  ok=false | allowlist_intacta=true   <- no vacuo
E confirmer AJENO  reason=gate3_confirmation_required  ok=false | allowlist_intacta=true
```

- A/B/C: sin política legible **no se muta** la allowlist. Fail-closed != crash: devuelve
  veredicto, el proceso sigue vivo (D-3) y el auto-recovery de #4832 reanuda al corregir.
- E: la autenticación del confirmador (#4577 CA-5 / RS-4) **no se aflojó**: `chat_id 666`
  fuera de la allowlist `['424242']` sigue sin poder mutar.
- El camino ajv (`ConfigSchemaViolation`), que el test del autor no cubre en este flujo,
  también falla cerrado.

**3 · SEC-1 — el copy nuevo no vuelca valores crudos del config**

`config.yaml` roto con un canario con forma de API key de Anthropic y una AWS key de
ejemplo en las líneas adyacentes al error de sintaxis:

```
GATE 3 realign-allowlist no enforzable — realign ABORTADO (allowlist sin mutar)
 | archivo: ...\config.yaml (vía DIR_OVERRIDE) | causa: YAML inválido — línea 4, col 4
 | acción: corregí esa línea (suele ser indentación o dos puntos sueltos)

leaks(copia JSON)  => {"canary":false,"aws":false,"roto":false}
leaks(linea log)   => {"canary":false,"aws":false,"roto":false}
leaks(telegram)    => {"canary":false,"aws":false,"roto":false}
leaks(error dump)  => {"canary":false,"aws":false,"roto":false} | cause: undefined
```

Se serializó el error entero (`name`, `message`, `stack`, props propias, `cause`) y ninguno
arrastra el snippet de `js-yaml`. El error tipado **no encadena** `cause` a propósito
(config-resolver.js:379-387). En el camino ajv el mensaje es `path` + regla derivados del
SCHEMA (`/concurrencia/max_agentes: tipo esperado: integer`), nunca el valor.

**4 · SEC-1 en el helper de traza nuevo (`logPolicyEnforcementFailure`)**

```
C0) [probe] GATE 3 'desync-autoresolve' sin veredicto — CONFIG INVÁLIDA (...) | leaks: {"canary":false,"aws":false}
C1) [probe] GATE 3 'quota-flag-set' sin veredicto — error inesperado (TypeError); se continúa | leaks: {"canary":false,"aws":false}
```

El camino genérico imprime **sólo `err.name`**, nunca `err.message` — un error ajeno cuyo
mensaje arrastre secretos no se filtra. El helper está envuelto en `try/catch` propio:
nunca lanza al llamador.

**5 · Sin regresión de disponibilidad por el catch que dejó de ser mudo**

Los 6 call-sites `notify-and-proceed` ahora llaman `require('./kernel-action-policy')
.logPolicyEnforcementFailure(...)` **dentro** del `catch`. Si ese `require` lanzara,
escaparía del catch y rompería a `clearFlag` / `clearDesyncFlag` / `restart.syncWithMain`.
Verificado que `kernel-action-policy.js:32-33` sólo requiere builtins (`node:path`,
`node:fs`) en top-level — el módulo ya está en caché cuando se ejecuta el catch, y las
dependencias pesadas (`js-yaml`/`ajv`) entran por `require` lazy **adentro** del helper,
que tiene su propio `try/catch`. No hay camino de escape.

**6 · Inventario completo de call-sites del gate (no queda ninguno mudo)**

```
$ grep -rn "enforceActionPolicy(" .pipeline --include=*.js | grep -v _tmp/ | grep -v __tests__
desync-detector.js:311 | parallel-lane-classifier.js:187 | quota-exhausted.js:766,1058
pulpo.js:16182 (GATEA) | pulpo.js:16261 | restart.js:122
```

7 call-sites + la definición. El único que lee `.proceed` es `pulpo.js:16182` y es el que
falla cerrado. Los otros 6 son `notify-and-proceed` por `config.yaml:1698-1713` y ahora
dejan traza (ver recomendación #5294 sobre el gap preexistente).

**7 · Sweep de patrones peligrosos y dependencias**

`grep` sobre las líneas agregadas del delta: sin `child_process`/`spawn`/`eval`/`new
Function`/`fetch` nuevos; los únicos literales con forma de secreto son fixtures canario
de los propios tests. `git diff --stat origin/main...HEAD -- package.json package-lock.json`
vacío ⇒ **sin cambios de dependencias**, no se agregan CVE. Los CVE preexistentes de
`js-yaml` 4.1.1 y `fast-uri` siguen cubiertos por #5201 y #4854; no se duplican.

**8 · Suites de seguridad verdes sobre este HEAD**

```
gate3-config-failclosed.test.js .................. 7/7 pass
config-resolver-{secrets,guard,failclosed,root} +
error-classifier + pulpo-config-recovery ......... 63/63 pass
node --check sobre los 7 archivos de producción del delta: OK
```

`pulpo-config-recovery.test.js` (#4832) sigue verde **sin editar**.

### Observaciones no bloqueantes

- **#5294 (creada, `needs-human`, priority:low)** — `config.yaml` puede declarar
  `wait-confirmation` en acciones cuyo call-site descarta el veredicto (`worktree-reset`,
  `quota-flag`, `desync-autoresolve`, y `reseed-wave` con enforcement removido en
  `scripts/init-waves-from-partial.js:596-620` por #4633). Hoy es coherente con el YAML
  vigente; el riesgo es que el operador crea tener firma humana y no la tenga. Preexistente,
  no explotable por terceros (requiere editar el config del operador), no bloquea.
- **Fuera de alcance (ya señalado por `qa`)** — la rama arrastra `b3863bfbd` (credenciales
  de Drive al store externo), ajeno a #5172. Auditado en la pasada anterior: recomendaciones
  #5265 / #5266 / #5267. Sin vulnerabilidad explotable; la decisión de separarlo antes del
  merge es de `review`/`aprobacion`, no de seguridad.
