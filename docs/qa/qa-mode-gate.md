# Gate de evidencia QA por `qaMode`

_Issue #2351 — Endurecimiento del gate-evidencia-on-exit y del pattern-match de APK en `rejection-report.js`._

## Resumen

El Pulpo clasifica cada issue de QA en uno de tres modos (`qaMode`) durante el
preflight. El gate de evidencia audiovisual (video + audio narrado) se aplica
sólo a los modos que realmente producen video. Los otros modos saltan el gate
de forma **explícita y auditada** — nunca por inferencia ni por ausencia de
labels.

## Tabla de modos

| `qaMode`     | Cuándo aplica                                                  | Requiere video + audio | Requiere logs API | Criterio del preflight                  |
|--------------|----------------------------------------------------------------|------------------------|-------------------|-----------------------------------------|
| `android`    | Issues con label `app:client`, `app:business` o `app:delivery` | **Sí**                 | No                | `requiresEmulator === true`             |
| `api`        | Backend puro (`area:backend` sin ningún `app:*`)               | No                     | **Sí**            | `hasBackendLabel && !requiresEmulator`  |
| `structural` | Docs, infra, pipeline (sin `app:*` ni `area:backend`)          | No                     | No                | Ningún label de ruteo QA                |

## Reglas de bypass (R1 — Security)

1. **Whitelist explícita**: sólo `qaMode === 'api'` o `qaMode === 'structural'`
   saltan la evidencia audiovisual. Cualquier otro valor (`android`, `ui`,
   vacío, desconocido) **exige** video.
2. **Autoridad**: el `qaMode` que usa el gate viene del preflight del Pulpo
   (`preflightQaChecks` en `.pipeline/pulpo.js`), cacheado en memoria. Si
   falta (ej. tras un restart), se cae al `modo` del YAML del agente — el
   Pulpo ya inyecta el `modo` en el YAML antes de lanzar al agente QA para
   que este fallback siga siendo correcto.
3. **Nunca inferir**: la ausencia de labels `app:*` por sí sola **no** activa
   el bypass. Un issue UI al que accidentalmente le falten labels sigue
   exigiendo video.

## Logging auditable (R3 — Security, CA-3)

Cada bypass emite un log estructurado con prefijo legible + JSON inline:

```
[2026-04-20 21:14:02] [gate-bypass] 🟢 gate-bypass #2023 qaMode=api source=preflight — QA-API no requiere evidencia audiovisual {"event":"gate-bypass","issue":"2023","qaMode":"api","source":"preflight","labels":["area:backend"],"decision":"skip-video","reason":"QA-API no requiere evidencia audiovisual"}
```

El JSON final es parseable — cualquier herramienta puede consumirlo (monitor,
auditorías, métricas). Los campos:

| Campo     | Descripción                                                       |
|-----------|-------------------------------------------------------------------|
| `event`   | `gate-bypass` (constante)                                         |
| `issue`   | Número del issue (string)                                         |
| `qaMode`  | Modo normalizado (`api`, `structural`)                            |
| `source`  | `preflight` (autoritativo) / `yaml` (fallback) / `none` (sin info)|
| `labels`  | Labels del issue al momento del check                             |
| `decision`| `skip-video` (constante)                                          |
| `reason`  | Frase legible en español                                          |

## Pattern-match de APK en `rejection-report.js` (R2 + R5, CA-2)

El rejection-report usaba un regex laxo sobre el buffer crudo del log para
detectar "APK no se pudo generar". Eso disparaba falsos positivos cuando:

- Paths/filenames del proyecto contenían palabras como `apk-not-found`
  (matcheaba sin ser un error real).
- Tareas Release fallaban por un bug conocido de AGP + Kotlin MP
  (`bundle<Flavor>ReleaseClassesToRuntimeJar`) mientras los APKs Debug **sí**
  se generaban bien.

### Nuevo contrato del matcher

1. **R5 — Líneas de falla real**: el regex aplica sólo a líneas que empiezan
   con `FAILURE:` o contienen `> Task ... FAILED`. Si el texto crudo menciona
   "apk-not-found" en un path pero no hay líneas de falla real, no se dispara
   el match.
2. **R2 — APK fresco**: si el match dispara, se verifica el APK Debug de cada
   flavor en `app/composeApp/build/outputs/apk/<flavor>/debug/`. Un APK se
   considera **válido** sólo si `mtime > buildStartTime`. APKs stale (p.ej.
   de hace 3 días) **no** enmascaran un build actual roto.
3. **buildStartTime** se estima a partir de `elapsed` (duración del agente)
   más un margen de seguridad de 10 min. Si no hay `elapsed` confiable, usa
   una ventana de 30 min hacia atrás.
4. **Descarte auditado**: cuando el match se descarta porque hay APKs frescos,
   se emite un log estructurado `match-dismissed` con el detalle de cada
   flavor (edad, tamaño, fresh/stale).

```
[rejection-report] match-dismissed {"event":"match-dismissed","issue":"2023","pattern":"apk_not_generated","reason":"APK(s) debug frescos presentes — la falla probable es sólo de tasks Release (bug AGP+KMP)","apkStatus":{"anyFresh":true,"allFresh":true,"allPresent":true,"flavors":[{"flavor":"client","exists":true,"fresh":true,"ageSec":120,"sizeKb":25340},...]}}
```

## Bypass quirúrgico (R4, CA-4)

Los cambios **no** afectan a:

- El gate de `verifier` (tester/qa/security).
- La validación de labels requeridos para ruteo.
- El gate de QA para merge del PR.
- La detección de otros patrones en `rejection-report.js` (timeouts,
  crashes, deserialización, etc.).

Sólo se tocan: `validateQaEvidence` + el sitio `gate-evidencia-on-exit` en
`.pipeline/pulpo.js`, y el pattern-match de APK en `.pipeline/rejection-report.js`.

## Archivos implicados

- `.pipeline/pulpo.js` — gate + cache de `qaMode` autoritativo.
- `.pipeline/rejection-report.js` — pattern-match + check de frescura.
- `.pipeline/lib/qa-evidence-gate.js` — resolución de `qaMode` + bypass event.
- `.pipeline/lib/apk-freshness.js` — extracción de líneas de falla + check APK.
- `.pipeline/lib/__tests__/qa-evidence-gate.test.js` — tests CA-1, CA-6, R1, R3.
- `.pipeline/lib/__tests__/apk-freshness.test.js` — tests CA-2, R2, R5.
