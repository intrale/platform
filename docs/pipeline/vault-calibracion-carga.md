# Calibración de tráfico físico del vault (#5800)

Runbook y cierre de la historia #5800 — *Instrumentar y medir el tráfico real de
resoluciones del vault*. La medición separa **lecturas físicas** de **hits de
caché** y de **joins single-flight**, y sólo las lecturas físicas alimentan el
pico y la extrapolación mensual que después configura el umbral de ráfaga.

## 1. Piezas y quién entregó cada una

La historia se dividió en tres entregas; este documento cierra el padre.

| Pieza | Archivo | Entregada por |
|-------|---------|---------------|
| Enum cerrado + clasificador único de resoluciones | `.pipeline/lib/secret-vault.js` (`VAULT_TELEMETRY_CATEGORIES`) | #5803 |
| Composición del sink sin re-clasificar (sin doble conteo) | `.pipeline/lib/credentials.js` | #5803 |
| Núcleo puro: validación, agregación, fórmula y evidencia | `.pipeline/lib/vault-calibration-scenario.js` | #5804 |
| CLI de recálculo sobre un lote ya capturado | `.pipeline/tools/vault-audit-calibrate.js` | #5804 |
| Preflight de integración, corrida y publicación del artefacto | `.pipeline/lib/vault-load-calibration.js` | #5805 |
| CLI de la corrida productiva | `.pipeline/scripts/run-vault-calibration.js` | #5805 |
| Traducción completa de errores en el borde de la corrida | `.pipeline/scripts/run-vault-calibration.js` | #5800 (ver §4) |

**Regla que ordena todo:** la categoría de una resolución la decide **un solo
clasificador**, en el núcleo del vault. `credentials.js` inyecta el sink por
identidad referencial y no vuelve a clasificar; el agregador deduplica. Cualquier
segundo contador reintroduce el doble conteo que la receta mitigaba.

## 2. Precondición: el HEAD medido

La corrida **falla cerrada** si no puede demostrar que el HEAD integra las cuatro
dependencias. No existe "calibración parcial válida": una evidencia de otro HEAD
firmaría un umbral que no corresponde al código que corre.

| Dependencia | Commit integrado |
|-------------|------------------|
| #5339 | `c97bd56cb046defd0b64544d4e5a785e2ba0de84` |
| #5340 | `93a0649648881c1c04b59cf3ed5bf2853823a698` |
| #5791 | `70865d26853946dbeef40c2df12f5307f08fa54a` |
| #5792 | `8d782c0b76ffd36d9f4e7c00c5aa36f765f1c40d` |

Además del preflight de dependencias, la corrida exige **árbol de trabajo
limpio**: con cambios sin commitear el SHA registrado no describiría el código
que efectivamente corrió.

## 3. Runbook

```bash
cat corrida.json | node .pipeline/scripts/run-vault-calibration.js --stdin
cat corrida.json | node .pipeline/scripts/run-vault-calibration.js --stdin --json
node .pipeline/scripts/run-vault-calibration.js --help
```

Sobre de entrada (claves cerradas: una clave de más es un error, no un dato que
se ignora):

```json
{
  "scenario": {
    "window_start_ms": 1735689600000,
    "window_duration_ms": 60000,
    "bucket_ms": 10000,
    "concurrency": 4,
    "launches": 8,
    "distribution": "sequential",
    "sequence_seed": 7,
    "unit": "physical_read"
  },
  "required_commits": [
    { "issue": 5339, "commit": "<40 hex>" },
    { "issue": 5340, "commit": "<40 hex>" },
    { "issue": 5791, "commit": "<40 hex>" },
    { "issue": 5792, "commit": "<40 hex>" }
  ],
  "project_id": "<producto>",
  "scope_logico": "<nombre logico del scope medido>",
  "shared_scopes": []
}
```

La corrida publica `.pipeline/audit/vault-load-calibration.json` y **invalida la
evidencia anterior al arrancar**: si falla, ese directorio queda limpio a
propósito.

Para **auditar un número ya medido sin volver a correr la carga** (no toca AWS,
no escribe archivos), está el CLI hermano:

```bash
cat lote.json | node .pipeline/tools/vault-audit-calibrate.js --stdin --pretty
```

### Códigos de salida de la corrida

Son estables: un operador o un wrapper discrimina por número, nunca parseando el
mensaje.

| Código | Significado | Quién lo corrige |
|--------|-------------|------------------|
| 0 | evidencia publicada | — |
| 1 | argumentos ausentes, desconocidos o mal formados | quien invoca |
| 2 | stdin ausente, no es JSON, o el sobre trae claves ajenas | quien invoca |
| 3 | HEAD, árbol sucio, procedencia o dependencia no integrada | quien opera el repo |
| 4 | la identidad no es de sólo lectura o excede los scopes | quien provisiona el acceso |
| 5 | el escenario, el lote de la corrida o el driver no cerraron | quien declara el sobre / el acceso al vault |
| 6 | la métrica no es finita o no es entero seguro | quien declara la ventana |
| 7 | no se pudo publicar el artefacto | disco / permisos |
| 8 | defecto del núcleo o del cableado — **reportar el incidente** | pipeline-dev |

Cada error imprime **causa, impacto y próximo paso** con textos literales
estáticos: nunca se interpola la entrada, así que la tabla no puede reintroducir
un dato sensible que el núcleo ya descartó.

## 4. El hueco que cerró #5800

`runCalibration` propaga los `CalibrationError` del núcleo de escenario (#5804)
**tal cual** hacia el CLI de la corrida (#5805), para no perder su `code`. Pero
la tabla de traducción del CLI cubría sólo su propia familia
(`LOAD_CALIBRATION_*`): los 29 códigos `CALIBRATION_*` caían al fallback y se le
presentaban al operador como *"condicion no prevista … reportar el incidente"*
con **salida 8 (interno)**.

Eso alcanzaba a los errores más frecuentes de una corrida — campo de más en el
escenario, entero fraccionario, `bucket_ms` que no divide la ventana,
distribución desconocida y fallo de resolución contra el vault — y mandaba a
abrir un incidente del pipeline cuando lo que había era un parámetro mal
declarado o un acceso faltante.

Las 29 filas se agregaron agrupadas **por quién puede corregir el problema**, que
es lo que decide el código de salida (escenario y driver → 5; clave peligrosa →
2; procedencia → 3; métrica → 6; interno → 8 **sólo** para defectos de núcleo o
cableado). Un test de exhaustividad recorre ahora **ambas** familias de códigos y
falla si aparece uno nuevo sin fila, más un test que impide que un error
corregible por el operador vuelva a presentarse como defecto del pipeline.

## 5. Qué no hace esta instrumentación

- **No crea** otra caché, scheduler ni sistema de auditoría: reusa el borde del
  driver, el caché versionado y el single-flight que ya viven en el vault.
- **No amplía permisos**: la corrida usa una identidad de sólo lectura acotada al
  único scope declarado en `scope_logico`.
- **No publica** valores, payloads, nombres de secreto, hashes estables,
  `process.env`, argumentos, paths absolutos ni stdout/stderr crudo. El evento es
  un DTO por allowlist y la redacción ocurre **antes** de cualquier sink, también
  en el camino de excepción.
- **No cuenta** `cache_hit` ni `single_flight_join` en el numerador: viajan a la
  evidencia sólo como trazabilidad, y el artefacto lo declara explícitamente en
  `excluded_from_physical_metrics`.

## 6. Verificación

```bash
node --test .pipeline/tests/vault-audit-calibrate.test.js \
            .pipeline/tests/run-vault-calibration.test.js \
            .pipeline/lib/vault-load-calibration.test.js \
            .pipeline/lib/__tests__/secret-vault-telemetry-5803.test.js \
            .pipeline/lib/__tests__/credentials-vault-telemetry-5803.test.js
npm run test:pipeline
```
