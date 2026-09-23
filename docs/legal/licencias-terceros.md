# Licencias de dependencias de terceros

> Issue #7592 (parte de #7589). Inventario automático de licencias de Gradle y npm,
> `NOTICE` generado y gate bloqueante en CI (`check-licenses`).

## Si el CI te frenó por licencias

El job `check-licenses` de `pr-checks.yml` imprime una línea por problema, con un
prefijo que se puede buscar en el log, y debajo la acción:

```
LICENCIA PROHIBIDA: org.example:foo@1.2.3 — GPL-3.0-only — regla denied[gpl] — copyleft fuerte: …
  → Reemplazá la dependencia o pedí una excepción (docs/legal/licencias-terceros.md#excepciones)
```

Hay tres caminos, según el caso:

1. **Reemplazar la dependencia** (el camino preferido ante `LICENCIA PROHIBIDA`).
   Buscá una alternativa con licencia permitida, sacá la dependencia y regenerá:
   `npm run licenses:generate`.
2. **Agregar un alias** (ante `LICENCIA DESCONOCIDA` de una licencia que en realidad
   es conocida, por ejemplo una declarada por URL o con otro nombre). Sumalo en
   `config/licenses/policy.json` → `aliases`:
   ```json
   "https://example.com/licenses/LICENSE-2.0": "Apache-2.0"
   ```
   Un alias es preferible a una excepción: vale para todas las versiones y no vence.
3. **Pedir una excepción** (ver [Excepciones](#excepciones)).

Otros prefijos posibles: `EXCEPCIÓN VENCIDA`, `EXCEPCIÓN INVÁLIDA`,
`EXCEPCIÓN SIN APROBAR`, `DRIFT` (el `NOTICE` no coincide con las dependencias:
ejecutá `npm run licenses:generate` y commiteá el resultado) e `INVENTARIO` (el
escaneo no se pudo completar).

## Cómo regenerar el inventario y el NOTICE

```bash
./gradlew licensesInventory --no-daemon   # artifacts.json de licensee en los 6 módulos
npm run licenses:generate                 # NOTICE + reporte + inventario
npm run licenses:check                    # el mismo gate que corre el CI
```

Se generan y se versionan:

| Archivo | Contenido |
|---|---|
| `NOTICE` | Atribuciones de lo que se **distribuye** con el producto: nombre, versión, licencia SPDX, copyright (si está declarado) y URL pública. |
| `docs/legal/third-party-licenses.md` | Reporte legible: resumen, distribuido vs. herramientas de build/test, obligación de cada licencia, totales, excepciones y fuera de alcance. |
| `docs/legal/third-party-inventory.json` | Inventario normalizado; el CI lo usa para mostrar las dependencias nuevas o cambiadas respecto de la base. |
| `config/licenses/npm-copyrights.json` | Caché de copyright de paquetes npm distribuidos (se llena al generar con `node_modules` instalado). |

Las salidas son deterministas (orden estable, sin fechas ni paths absolutos): dos
corridas sobre las mismas dependencias dan los mismos bytes. El CI regenera todo en
memoria y falla si difiere de lo versionado (drift, mismo patrón que
`verifyNoLegacyStrings`).

### Cómo funciona

- **Gradle:** el plugin `app.cash.licensee` (versión exacta en
  `gradle/libs.versions.toml`) se aplica a `:shared`, `:app:composeApp`, `:backend`,
  `:users`, `:tools:forbidden-strings-processor` y `:qa`, **sólo como extractor**
  (`violationAction(IGNORE)`). Resuelve el classpath runtime de cada target (JVM,
  Android por variante, Wasm e iOS). En `:qa` y `:tools`, que son tooling, también
  inventaría compilación y test (configuración `licenseInventoryBuildTest`).
- **npm:** se leen los lockfiles v3 declarados en la política (`package-lock.json`,
  `.claude/hooks/package-lock.json`, `docs/qa/package-lock.json`) con Node puro, sin
  dependencias nuevas. No se copian `resolved` ni `integrity`.
- **Política:** un único evaluador (`scripts/licenses/policy.js`) para los dos
  ecosistemas, contra `config/licenses/policy.json`.

## Política

Modelo asumido: propietario o source-available (decisión D2 del PO en #7592). Si
#7589 cambia el modelo, se ajusta la política; el mecanismo no cambia.

| Categoría | Licencias | Efecto |
|---|---|---|
| Prohibidas (`denied`) | GPL, AGPL, SSPL (todas las versiones) | El gate falla con la regla y el motivo. |
| Permitidas con obligación (`allowed_with_obligation`) | LGPL-2.1/3.0, MPL-2.0, EPL-1.0/2.0 | Pasan; la obligación queda en el reporte. |
| Permitidas (`allowed`) | MIT, Apache-2.0, BSD-2/3, ISC, 0BSD, Python-2.0 y otras permisivas | Pasan; la atribución va al `NOTICE`. |
| Cualquier otra | — | **Desconocida ⇒ falla.** |

Reglas fail-closed:

- Licencia ausente, vacía, `UNLICENSED`, `NOASSERTION`, `NONE`, `SEE LICENSE IN …`,
  un nombre que no mapea a SPDX o una expresión que no parsea ⇒ **desconocida**.
- `A OR B` pasa si alguna alternativa está permitida; `A AND B` exige todas;
  `A WITH X` se busca en `with_exceptions` y, si no está, vale lo que vale `A`.
- Inventario vacío, un ecosistema en cero o un módulo sin `artifacts.json` ⇒ el job
  falla. Nunca aparece "0 prohibidas" porque no se escaneó nada.

## Excepciones

Una excepción permite, **para una versión exacta**, una dependencia que la política
no permite. Se declara en `config/licenses/policy.json` → `exceptions` con los cinco
campos obligatorios:

```json
{
  "paquete": "org.example:foo@1.2.3",
  "licencia": "GPL-3.0-only",
  "justificacion": "Sólo se usa en una herramienta interna que no se distribuye; evaluado con legal",
  "aprobado_por": "leitolarreta",
  "revisar_antes": "2027-03-31"
}
```

- `paquete`: `grupo:artefacto@versión` (Gradle) o `nombre@versión` (npm). Sin
  comodines ni rangos (`*`, `^`, `~`, `1.x`).
- `licencia`: la licencia tal como figura en el reporte. Si cambia la licencia o
  sube la versión, la excepción **deja de aplicar**.
- `revisar_antes`: fecha `AAAA-MM-DD`. Vale hasta el final de ese día (UTC). Vencida
  ⇒ `EXCEPCIÓN VENCIDA` y el gate falla. Una fecha que no parsea es inválida.
- Si falta cualquier campo ⇒ `EXCEPCIÓN INVÁLIDA` y el gate falla.

### Quién aprueba: el label humano

Una excepción **nueva o modificada** respecto de la rama base hace fallar el gate
(`EXCEPCIÓN SIN APROBAR`) salvo que el PR tenga el label
`licencias:excepcion-aprobada`.

- Ese label lo aplica **sólo un humano** (hoy, `leitolarreta`). Ningún agente ni
  skill del pipeline lo aplica; un test estático
  (`scripts/licenses/__tests__/label-guard.test.js`) lo verifica sobre `.pipeline/`,
  `.claude/skills/` y `.claude/hooks/`.
- El workflow **no** se dispara con el evento `labeled` (eso permitiría que una
  corrida parcial deje un `pr-status` verde sobre un rojo). El job lee los labels
  por API en cada corrida. Después de aplicar el label, re-corré el job fallido:

  ```bash
  gh run rerun <run-id> --failed
  ```

- Quitar una excepción no requiere aprobación.

## Fuera de alcance

La lista completa, con el motivo de cada ítem, está al final de
[third-party-licenses.md](third-party-licenses.md#fuera-de-alcance) y se declara en
`config/licenses/policy.json` (`out_of_scope` y `npm.excluidos`). Resumen:

- El fixture `fixtures/demo/target/` (proyecto de juguete de test).
- Dependencias sólo de test o `compileOnly` de los módulos distribuidos (no se
  empaquetan).
- Plugins de Gradle, `buildSrc` y el toolchain npm de Kotlin/Wasm (herramientas de
  build).
- SDKs de plataforma (JDK, Android SDK, frameworks de Apple).
- Paquetes npm `private: true` y links de workspace (código propio).

## Qué NO es este gate

Este gate controla **licencias**, no **vulnerabilidades**. Que una dependencia tenga
una licencia permitida no dice nada sobre su seguridad. El escaneo de CVEs vive en
`security-sast.yml` y en OWASP Dependency-Check (`dependencyCheck` en
`build.gradle.kts`); los dos gates son independientes.
