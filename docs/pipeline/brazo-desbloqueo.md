# Brazo de desbloqueo — re-promoción automática de issues bloqueados por dependencias

> Referenciado desde `pulpo.js` y desde el issue #4361. Documenta el mecanismo
> que destraba automáticamente un issue cuando cierra la dependencia que lo
> bloqueaba, sin intervención manual.

## Objetivo

Cuando un issue declara que depende de otro (`depends_on: [N]`) y el issue `N`
se cierra, el dependiente debe **re-habilitarse solo** y volver a la cola de
trabajo. Sin este mecanismo, el marcador queda retenido en el cajón de
"bloqueado por dependencias" y el pipeline lo saltea indefinidamente (caso real:
#4300 dependía de #4255; al cerrarse #4255, el #4300 quedó retenido y hubo que
destrabarlo a mano).

## Piezas del flujo

El brazo se compone de tres capas con responsabilidades separadas:

| Capa | Archivo | Responsabilidad |
|------|---------|-----------------|
| **Detección** | `.pipeline/lib/dep-resolver.js` | Parsear las dependencias declaradas en el body/comentarios del issue. |
| **Decisión pura** | `.pipeline/lib/brazo-desbloqueo-core.js` | Dado `{issue → [deps]}` y el estado de cada dep, decidir qué markers liberar. Sin `fs`/`gh`. |
| **Efecto** | `.pipeline/lib/rebote-classifier.js` | Mover los work-files de `bloqueado-dependencias/` a `pendiente/` y quitar el label. |

La frontera que las orquesta es `brazoDesbloqueoImpl` en `pulpo.js` (~línea
13640): lee los issues con label `blocked:dependencies`, consulta GitHub por el
estado de cada dependencia, invoca `selectMarkersToRelease` y aplica el efecto.

## Formatos de `depends_on` soportados

El parser (`dep-resolver.resolveDependencies`) reconoce cuatro patrones en el
body del issue (además del marker canónico en comentarios del pulpo). Todos son
**line-based, anclados a inicio de línea, case-insensitive y O(n)** (anti-ReDoS):

1. **Sección canónica** (`B1`):
   ```markdown
   ## Dependencias detectadas por el pipeline

   - #4255
   - #4256
   ```
2. **Sección genérica** (`B2`) — sólo si el bloque contiene exclusivamente
   bullets puros `- #N` (si hay texto narrativo, el bloque se descarta):
   ```markdown
   ## Dependencias

   - #4255
   ```
3. **Verbos GitHub-nativos** (`B3`), una dependencia por línea:
   ```
   Depends on #4255
   Blocked by #4256
   ```
4. **Campo manifest `depends_on:`** (`B4`, issue #4361):
   ```
   depends_on: [4255]
   depends_on: [4255, 4256]
   depends_on: 4255
   depends_on: [#4255]
   ```

Si varias fuentes declaran deps, la salida es la **unión** (deduplicada, ordenada
ascendente, con cap de 20).

## Semántica fail-closed

El default seguro es **no tocar labels / mantener bloqueado**:

- Si ninguna fuente produce un marker válido → `{ deps: null, source: null }`.
  El caller interpreta `null` como "no toques los labels".
- `depends_on: []` o `depends_on:` vacío → `[]` (sin deps por esta vía; el issue
  no se libera por este camino).
- Un segmento con caracteres no numéricos (letras narrativas, `[-1]` con guion,
  brackets mal formados) → la línea entera se descarta.
- Números fuera de rango (`#0`, `#9999999`) → filtrados (`0 < n < 1_000_000`).
- Referencias negadas (`does not depend_on: [N]`) → no matchean (el anclaje
  exige que la línea arranque con la palabra clave).
- Líneas dentro de code fences (```` ``` ````) → ignoradas.

En la decisión de liberación (`selectMarkersToRelease` / `allDepsClosed`), un
marker se libera **sólo si TODAS sus deps están explícitamente `CLOSED`**. Si el
estado de alguna dep es desconocido/ilegible (error de API, no figura en el mapa
de estados), se asume abierta → **no se libera** (conservador, evita destrabes
prematuros).

## Latencia (polling, no event-driven)

El brazo corre por **polling cada 30 minutos** (`UNBLOCK_INTERVAL_MS` en
`pulpo.js`), no por webhook. Los criterios "al cerrarse un issue se destraba el
dependiente" se cumplen **eventualmente**: hasta ~30 min de demora entre el
cierre de la dependencia y la re-promoción. Es comportamiento esperado, no un
defecto. Un disparo event-driven (webhook `issues.closed`) sería una
optimización futura fuera del scope actual.

## Interacción con la pausa parcial

La re-promoción **no bypasea** los controles del pipeline:

- Respeta `.paused` (halt total): con el pipeline pausado, el brazo no libera.
- Respeta la allowlist de `.partial-pause.json`: en pausa parcial, un
  dependiente que no esté en la allowlist **permanece bloqueado** aunque sus deps
  hayan cerrado. Un cierre de issue (evento externo, potencialmente inducido) no
  puede colar trabajo a la cola saltando controles.
- Respeta el gate de admisión (`needs-definition` / `Ready`) y los markers
  `needs-human`.

## Anti-amplificación e idempotencia

Cerrar una única dependencia puede destrabar N dependientes. El brazo:

- Itera con **cap de 50 issues por ciclo**.
- Es **idempotente**: si el label ya fue removido, el issue se saltea (no hay
  loop close→promote→close).
- No dispara re-evaluaciones recursivas sin cota.

## Cobertura de estado (gap raíz de #4300)

El brazo sólo enumera issues que ya tienen el label `blocked:dependencies`. Un
dependiente que declare `depends_on:` pero **nunca reciba ese label** no es
re-evaluado al cerrar su dep. El label se aplica hoy por el **camino canónico**:
cuando un agente rebota con categoría `dependency_block` (ver
`reboteClassifier.classifyRebote`), el pipeline pega `blocked:dependencies`,
mueve los work-files a `bloqueado-dependencias/` y deja que el brazo los destrabe.

El caso #4300 se coló porque declaraba su dependencia **sólo en prosa narrativa**
(`depende de #4255`), sin ninguna sintaxis machine-readable ni rebote de
dependencia — por eso nunca recibió el label ni entró al cajón que el brazo
vigila. La sintaxis `depends_on: [N]` (B4, #4361) cierra el hueco de detección:
un issue que la use queda cubierto por el flujo canónico. **Recomendación
operativa:** declarar dependencias siempre con una sintaxis reconocida (sección
canónica, `Depends on #N` o `depends_on: [N]`), nunca sólo en prosa.

## Tests

- `.pipeline/lib/__tests__/dep-resolver.test.js` — patrones B1–B4, fail-closed,
  code fences, bounds, negaciones, cap y dedup.
- `.pipeline/lib/__tests__/brazo-desbloqueo-core.test.js` — decisión pura y los
  escenarios Gherkin literales de #4361 (dep única cierra → libera; deps
  múltiples con una abierta → bloqueado).
- `.pipeline/tests/brazo-desbloqueo-wedge.test.js` — end-to-end de la sintaxis
  `depends_on: [N]` (detección → decisión → reingreso a `pendiente/`) y
  regresión del wedge del watchdog.
