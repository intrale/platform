# Verificación en CI del trailer de autoría (#7632)

> Parte de la épica #7589 (autoría). #7631 **escribe** el trailer en el squash
> de delivery; esta pieza **controla** en CI, antes del merge, que la evidencia
> esté completa y sea consistente.

## Qué verifica — y qué NO

El check verifica **consistencia, no autenticidad**. El trailer es texto que el
autor del PR puede escribir. Un verde sólo dice que las piezas coinciden entre
sí; **no es prueba de autoría** y no se tiene que usar como gate de confianza en
ningún otro lado. La autenticidad de la firma humana la resuelve el gate
`authorship` de `delivery.js` (#7631), que corre en el host desde `main` y lee el
registro de firmas.

`node .pipeline/lib/authorship/cli.js verify --pr <N>` controla, en este orden, y
reporta **todos** los hallazgos:

1. hay un bloque de trailers y es el último párrafo del mensaje de squash propuesto;
2. los campos `Intrale-*` tienen formato válido (el de `trailer.js`);
3. no hay claves `Intrale-*` duplicadas ni fuera del bloque;
4. el issue de `Intrale-Issue` existe (consulta a GitHub con `gh`);
5. el bloque `authorship-anchor` del body del PR coincide con el trailer, con su
   propio marcador `issue=N` y con el número de la rama `agent/<N>-…`.

| Código | Cuándo aparece |
|---|---|
| `MISSING_TRAILER` | No hay bloque `authorship-anchor`, o un `Intrale-*` de un commit interno no está en el bloque (no llegaría al squash). |
| `INVALID_FORMAT` | Falta un campo, un valor no respeta el formato, clave `Intrale-*` desconocida o ancla sin cierre. |
| `DUPLICATE_KEY` | Clave `Intrale-*` repetida o dos bloques `authorship-anchor`. |
| `KEY_OUTSIDE_BLOCK` | Línea `Intrale-*` en el body fuera del bloque. |
| `ISSUE_NOT_FOUND` | GitHub respondió 404 para el issue del trailer. |
| `ANCHOR_MISMATCH` | El bloque no coincide con el trailer, el marcador o la rama. |
| `TOO_LARGE` | Body + commits superan 64 KB; no se parsea. |
| `UNVERIFIABLE` | No se pudo consultar GitHub (403, rate limit, red, JSON ilegible) o excepción inesperada. |

## De dónde sale el "mensaje de squash propuesto" (D-A)

GitHub no expone el mensaje final antes del merge. El verificador lo reconstruye
con **la misma función que usa delivery**, `commit-builder.buildSquashMessage`, a
partir de:

- las líneas `Intrale-Issue`, `Intrale-Human-Direction` e `Intrale-AI-Assisted`
  del bloque `<!-- authorship-anchor issue=N --> … <!-- /authorship-anchor -->`
  del body del PR (lo escribe `delivery.js` con `copy.applyAnchorToBody`, con las
  mismas líneas que lleva el squash);
- los mensajes de los commits de la rama (`gh pr view --json commits`).

Después aplica `trailer.verifyTrailer` sobre el resultado. Un merge manual que no
pasa por delivery queda cubierto por la auditoría de `main` (más abajo).

**Consecuencia operativa:** el ancla la agrega delivery justo antes del merge. En
la corrida del check al abrir el PR todavía no existe, así que en `dry-run` el
check queda verde con un warning "Falta el trailer…". Editar el body no vuelve a
disparar el workflow (sólo `opened`/`synchronize`/`reopened`).

## Modo (D-B)

Se lee del bloque `authorship:` del `config.yaml` **de la rama base**, con un
lector mínimo propio (`ci-mode.js`, sin `js-yaml`). Nunca de labels, variables ni
archivos del PR.

| Bloque `authorship:` | Modo | Resultado con hallazgos |
|---|---|---|
| ausente (o config inexistente) | `dry-run` | `::warning::` con prefijo `[modo de prueba — no bloquea]`, exit 0 |
| `enabled: false` o `gate_mode: off` | desactivado | un único `::notice::`, exit 0 |
| `gate_mode: dry-run` (o sin `gate_mode`) | `dry-run` | warning, exit 0 |
| `gate_mode: enforce` | `enforce` | `::error::`, exit 1 |
| otro valor (`enforcee`) o bloque mal formado | `enforce` | `::error::`, exit 1 |

Es una política **distinta** de `rollout.js` (#7631), donde "ausente" cae en el
modo más estricto ya visto. `gate_mode: off` se trata como apagado porque es el
único apagado que reconoce `rollout.js`: si CI lo leyera como "valor
desconocido → enforce", apagar la feature frenaría todos los PR de agente.

En `dry-run` el job termina `success`, así que `pr-status` no suma un freno falso
(#7622). En PRs que no son `agent/*`, `schedule` o `workflow_dispatch` queda
`skipped`, y `classify` tampoco lo cuenta como fallo.

## Dónde corre

### `pr-checks.yml` → job `authorship-trailer` ("Autoría del PR (trailer)")

- `if: github.event_name == 'pull_request' && startsWith(github.head_ref, 'agent/')`.
- Permisos del job: `contents`, `pull-requests` e `issues` en `read`. Nada en `write`.
- `actions/checkout` pineado por SHA, con `ref: ${{ github.base_ref }}`,
  `persist-credentials: false` y `sparse-checkout` de los archivos del CLI +
  `.pipeline/config.yaml`. No hay checkout del head del PR ni `npm install`.
- Los datos del PR (`PR_NUMBER`, `HEAD_REF`, `BASE_REF`, `GH_TOKEN`, `GH_REPO`)
  entran sólo por `env:`; ningún `run:` interpola `${{`.
- **Bootstrap:** si la base todavía no tiene `cli.js` (el PR que introduce el
  check, o una base como `develop`), emite un `notice` y sale con 0.
- Suma al `needs:` de `pr-status` y a su `classify` (por `env:`).
- `$GITHUB_STEP_SUMMARY`: tabla con modo, formato del trailer, issue existe y
  bloque = trailer, más la aclaración "consistencia, no autenticidad".

### `authorship-main-audit.yml` (informativo)

- `push` a `main`, sólo `contents: read` (no consulta la API).
- Recorre los commits del push (`git rev-list before..after`, máximo 50) y corre
  `verify --commit <sha> --informative`. Nunca falla el run.
- Un commit es candidato si tiene alguna línea `Intrale-*`, o si el título
  termina en `(#N)` y trae un `Co-Authored-By` de un proveedor IA.
- Emite un único `::warning::` por commit: *"Entró a main un squash de agent/\*
  sin trailer de autoría (commit abc1234)."*
- Omite los commits anteriores a `go_live_date`.

## Límites conocidos

- **El YAML del workflow sale del PR.** En eventos `pull_request` GitHub ejecuta
  la versión del workflow del merge ref, así que un PR puede reescribir los steps
  del job. El script y el `config.yaml` sí salen de la base (cubierto por test);
  el control efectivo sobre el YAML es el gate `authorship` de `delivery.js`
  (corre en el host desde `main`) más la auditoría de `main`.
- **Consistencia, no autenticidad** (ver arriba).
- La detección de "squash de agente" en la auditoría es heurística (sin API).

## Seguridad

- `gh` se invoca con `execFile` y array de argumentos (`shell: false`). Los
  números de PR/issue se validan con `^\d{1,7}$` **antes** de llamar; si no
  matchean, no se invoca `gh`.
- Mensajes de anotación **fijos**: ningún texto del PR llega a una anotación.
  Sólo se interpola el número de issue validado y el sha corto validado como hex,
  y todo pasa por el escape de GitHub (`%`, `\r`, `\n`; `:` y `,` en propiedades).
- Tope de 64 KB antes de cualquier regex.
- `GH_TOKEN` no se imprime nunca.

## Archivos

| Archivo | Rol |
|---|---|
| `.pipeline/lib/authorship/cli.js` | Dispatcher; único que hace I/O. |
| `.pipeline/lib/authorship/verify.js` | Núcleo puro (`verifyProposedMessage`, `verifyCommitMessage`). |
| `.pipeline/lib/authorship/ci-mode.js` | Lector del bloque `authorship:` + tabla D-B. |
| `.pipeline/lib/authorship/gh-client.js` | Adaptador de `gh` (`issueExists`, `prView`). |
| `.pipeline/lib/authorship/annotations.js` | Mensajes, escape y step summary. |
| `.pipeline/lib/__tests__/authorship-ci-*.test.js` | Tests (CA-9 1-12, modo, anotaciones, empaquetado). |
| `.pipeline/tests/pr-checks-workflow.test.js` | Tests estructurales de los workflows (CA-9 13-16). |

Si se agrega un `require` al cierre de `cli.js`, hay que sumar el archivo al
`sparse-checkout` de **ambos** workflows en el mismo commit;
`authorship-ci-packaging.test.js` lo exige.
