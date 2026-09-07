## Reporte de auditoría de seguridad — issue #6708

**Veredicto:** sin hallazgos

**Alcance auditado:** rama `agent/6708-pipeline-dev` @ `db01a93bb` (sin PR abierto).
Re-ejecución de la fase: la pasada anterior auditó `4ab28a2d4` y aprobó. El delta
nuevo es un solo commit — `db01a93bb` "rotular el escalon de disco como texto en
la pill visible" (5 archivos, +217/-3): `disk-guard.js` (LEVEL_LABELS/levelLabel),
`dashboard.js`, `views/dashboard/header-meta.js`, `views/dashboard/home.js` y un
test nuevo. Auditoría incremental sobre el delta + revalidación empírica de los
invariantes destructivos al HEAD actual.

### Hallazgos

Sin hallazgos.

#### Superficie nueva evaluada (delta `4ab28a2d4..db01a93bb`)

- **A03 Inyección / XSS — el nuevo campo `label` que llega a la UI.** No explotable.
  El valor no es de origen externo: sale de `dg.levelLabel()`, lookup contra un mapa
  `Object.freeze`. Las tres superficies lo neutralizan:
  - SSR (`home.js:5380`): `escapeHtmlText(c.val)`; el color inline sigue gateado por
    `_safeCssColor` (`/^#[0-9a-fA-F]{3,8}$/`) antes de interpolarse.
  - Cliente (`header-meta.js:241`): `textContent`, no `innerHTML`; `style.color` sólo
    si matchea el mismo regex hex.
  - El cliente sólo acepta `dsk.label` si `typeof === 'string'`.

#### Invariantes destructivos revalidados al HEAD (no los tocó el delta; se verificaron igual)

- **A09 Retención de evidencia** — `isInfraNoisePath` sigue protegiendo los cuatro
  vectores del rechazo grave histórico; ninguno se clasifica como ruido borrable:
  `logs/security-incident.log`, `.pipeline/logs/pulpo.log`,
  `.pipeline/audit/ghostbusters-worktrees.jsonl`, `audio/operator-incident.wav`,
  `.pipeline/audit/disk-guard.jsonl` => todos `false`.
- **A03 Inyección de comandos en la medición** — `disk-guard.js:275,286,310` usa
  `execSync` con `drive` interpolado en el string. NO alcanzable: la única fuente de
  `drive` es el default `'C:'` de la firma (`measureFreeBytes`/`measureTotalBytes`);
  el grep de call sites no encuentra ningún llamador que pase `drive`.
- **A01 Borrado confinado** — `isForbiddenTarget` se re-evalúa inmediatamente antes
  del `rmSync` recursivo (`ghostbusters-worktrees.js:230-236`), con `ABORT` si el
  re-guard falla. El fallback más peligroso queda detrás del gate.
- **Guardián ciego no borra (fail-closed)** — medición fallida no escala:
  `classify(NaN|null|undefined|'ocho')` => `'unknown'`, y
  `actionsFor('unknown')` => `{rotateCaches:false, reclaimWorktrees:false, freezeHeavyPhases:false}`.
  Un `Number(null)===0` no puede clasificar como `red` y disparar la escalera destructiva.

#### Secrets y dependencias

- `node .pipeline/lib/precommit-secret-scan.js --range origin/main HEAD` => `exit=0`.
- Grep independiente sobre líneas agregadas (`api_key|secret|password|AKIA|Bearer|eyJ|private_key|BEGIN PRIVATE`): 0 coincidencias.
- Sin cambios en `package.json`, `package-lock.json`, `build.gradle` ni `libs.versions.toml`: no hay superficie de CVE nueva.

#### Tests

`node --test disk-gauge-label-6708 disk-guard infra-noise ghostbusters-worktrees`
=> `tests 105 | pass 105 | fail 0 | skipped 0`.

### Observación de robustez (NO bloqueante, no es vulnerabilidad)

`levelLabel()` resuelve con `LEVEL_LABELS[level] || ...`, sin `hasOwnProperty`, así
que una clave heredada de `Object.prototype` devuelve el miembro del prototipo en vez
de `'SIN DATO'`:

```
levelLabel('constructor')  => function Object() { [native code] }
levelLabel('toString')     => function toString() { [native code] }
levelLabel('__proto__')    => [object Object]
```

Contradice el contrato declarado en el comentario ("nunca devuelve undefined... cae a
SIN DATO") y el test nuevo sólo cubre `'escalon-que-no-existe'`. **No es explotable:**
`level` lo escribe el propio clasificador, alcanzar esas claves exige escritura local
al JSON de estado, y la salida es texto estático de native code que además va escapado
con `escapeHtmlText`. Impacto real: cosmético (la celda mostraría basura). Fix sugerido:
`Object.prototype.hasOwnProperty.call(LEVEL_LABELS, level) ? ... : LEVEL_LABELS[LEVELS.UNKNOWN]`.

No se abre issue de recomendación por esto: el cupo anti-explosión de 3 por issue ya se
consumió en la pasada anterior (#6728, #6729, #6730).
