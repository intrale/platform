# Cierre de la sub-ola 9.2 — guardrail anti-regresión + paridad

Issue [#5068](https://github.com/intrale/platform/issues/5068), última de la
cadena del épico [#5064](https://github.com/intrale/platform/issues/5064):
[#5065](https://github.com/intrale/platform/issues/5065) (contrato) →
[#5066](https://github.com/intrale/platform/issues/5066) (loader) →
[#5067](https://github.com/intrale/platform/issues/5067) (skills) → **#5068**.

Blinda el resultado de la sub-ola: sin enforcement, la parametrización se
degrada sola.

## 1. Guardrail anti-regresión (repo del kernel)

Vive en `intrale/kernel`. Documentación completa en
[`contracts/anti-regression.md`](https://github.com/intrale/kernel/blob/main/contracts/anti-regression.md)
de ese repo.

| Pieza | Qué hace |
|---|---|
| `contracts/forbidden-terms.json` | Términos, scopes y excepciones. Versionado, **no inline en el workflow**. |
| `contracts/coupling-baseline.json` | Inventario de la deuda preexistente del motor. Ratchet. |
| `bin/check-product-coupling.js` | Scanner de **contenido** (no de diff), sin dependencias. |
| `.github/workflows/anti-regression.yml` | Lo corre en cada push y cada PR. |
| `lib/__tests__/check-product-coupling.test.js` | 19 tests. |

Dos regímenes: **strict** (tolerancia cero) sobre `skills/`, la superficie que
la 9.2 parametrizó; **baseline** (ratchet) sobre `core/`, `lib/` y `hooks/`, que
ninguna historia de la 9.2 tocó — su migración es la 9.4 y su freeze la 9.5.
El razonamiento completo, incluido por qué no es tolerancia cero en todo, está
en el doc del kernel.

### Prueba de la regresión (CA-1)

No asumida: se reintrodujo el acople a propósito **en un commit de prueba
pusheado**, y se observó al CI del kernel fallar de verdad.

| Corrida | Rama | Veredicto |
|---|---|---|
| [30350743684](https://github.com/intrale/kernel/actions/runs/30350743684) | `agent/5068-guardrail-paridad` | ✅ success — árbol limpio |
| [30350824691](https://github.com/intrale/kernel/actions/runs/30350824691) | `prueba/5068-regresion-ci` (descartable, ya eliminada) | ❌ **failure** — regresión detectada |

Log real del step *"Verificar que no hay acople de producto"* de la corrida que
falló:

```
✗ Acople de producto detectado — 2 ocurrencia(s) que rompen el build:

  skills/delivery/SKILL.md
    skills/delivery/SKILL.md:636:21  término "product-name" → "intrale"
      gh pr create --repo intrale/platform --assignee leitolarreta
    skills/delivery/SKILL.md:636:49  término "operator-account" → "leitolarreta"
      gh pr create --repo intrale/platform --assignee leitolarreta

  Cómo seguir: resolvé el valor por el contrato del adaptador (contracts/README.md) en vez de
  escribir el literal. Los skills leen los accessors vía `kernel-adapter-env`.
  La lista de términos y sus excepciones vive en contracts/forbidden-terms.json.

Resumen por scope:
  skills-orchestration (strict): 2 hallazgo(s), 2 violación(es)
  engine (baseline): 142 hallazgo(s), baseline 142, 0 violación(es)
```

Reproducción local equivalente:

```
$ echo 'gh pr create --repo intrale/platform --assignee leitolarreta' >> skills/delivery/SKILL.md
$ node bin/check-product-coupling.js
✗ Acople de producto detectado — 2 ocurrencia(s) que rompen el build:

  skills/delivery/SKILL.md
    skills/delivery/SKILL.md:637:21  término "product-name" → "intrale"
      gh pr create --repo intrale/platform --assignee leitolarreta
    skills/delivery/SKILL.md:637:49  término "operator-account" → "leitolarreta"
      gh pr create --repo intrale/platform --assignee leitolarreta
...
EXIT=1
```

Es el escenario Gherkin 1 del issue: *el build falla nombrando el archivo y el
término detectado*. Tras revertir, `EXIT=0`.

El ratchet del motor también se probó: agregar una ocurrencia nueva en
`lib/redact.js` (baseline 1 → encontradas 2) rompió el build; al revertir, verde.

## 2. Paridad del pipeline de Intrale

Módulo: [`.pipeline/lib/kernel-parity-92.js`](../../.pipeline/lib/kernel-parity-92.js).
Tests: [`.pipeline/tests/kernel-parity-9.2.test.js`](../../.pipeline/tests/kernel-parity-9.2.test.js).
Corrida registrada: [`evidencia/paridad-9.2-5068.txt`](./evidencia/paridad-9.2-5068.txt).

```bash
node .pipeline/lib/kernel-parity-92.js          # ../kernel por defecto
KERNEL_ROOT=/ruta/al/kernel node .pipeline/lib/kernel-parity-92.js --json
```

#### Dónde se enforza el fail-closed

La paridad requiere un checkout del kernel con `bin/adapter-env.js`. Mientras la
rama del kernel de la 9.2 no esté mergeada, ese binario sólo existe en el
checkout de la sub-ola — no en el `../kernel` canónico. Por eso la ausencia de
puente se trata distinto según quién pregunta:

| Contexto | Sin checkout del kernel | Por qué |
|---|---|---|
| `npm run test:pipeline` (suite compartido) | los 3 tests de integración **skipean** | corre en entornos de todos los agentes; romperlo ahí no agrega garantía, sólo tira abajo el build del pipeline entero |
| `KERNEL_PARITY_STRICT=1 node --test .pipeline/tests/kernel-parity-9.2.test.js` | **falla** (3 fallos) | es la corrida que respalda la evidencia de la sub-ola |
| `node .pipeline/lib/kernel-parity-92.js` (CLI) | **exit 1** + error explicando cómo apuntar `KERNEL_ROOT` | es donde se *afirma* la paridad |

La paridad nunca se da "verde por omisión": `verifyParity()` devuelve
`ok:false` con error cuando no hay puente, y hay tests que cubren tanto ese
retorno como el exit code del CLI. El skip del suite compartido es visible en
el reporte (`﹣ ... # sin checkout del kernel disponible`), no silencioso.

Corrida estricta contra el checkout de la sub-ola — 13/13:

```bash
KERNEL_PARITY_STRICT=1 KERNEL_ROOT=/c/Workspaces/Intrale/kernel.agent-5068 \
  node --test .pipeline/tests/kernel-parity-9.2.test.js
# ℹ tests 13 · pass 13 · fail 0 · skipped 0
```

Cuando la rama del kernel se mergee y `../kernel` traiga `bin/adapter-env.js`,
los tres tests dejan de skipear solos, sin tocar código.

### Qué significa "opera idéntico"

Un `SKILL.md` es un prompt en Markdown: no tiene superficie ejecutable que
asertar. El puente por el que un skill obtiene una convención es
`bin/adapter-env.js` del kernel, que proyecta cada accessor del loader a una
variable de entorno.

Entonces la paridad tiene un significado preciso: para cada uno de los cinco
flujos, **el valor que hoy resuelve el contrato es exactamente el literal que el
skill tenía hardcodeado antes de la sub-ola**. Si coinciden, el skill emite los
mismos comandos y el comportamiento observable no cambió.

Los literales esperados **no** se leen del manifiesto — eso sería tautológico.
Están escritos como constantes en el módulo, tomados del estado pre-9.2
(`contracts/inventory.md` del kernel, relevado en #5065, y `CLAUDE.md` del
producto), con la fuente citada check por check.

### Resultado: 5/5

| Flujo | Verifica |
|---|---|
| `branch` | patrón `agent/<issue>-<slug>`, base `origin/main`, protegidas `main develop` |
| `delivery` | repo `intrale/platform`, assignee `leitolarreta`, keyword `Closes`, auto-merge `false` |
| `qa-gate` | labels `qa:passed` / `qa:skipped` / `qa:pending` |
| `monitor-dashboard` | `Intrale Platform` + entrypoints resueltos, `node --check` verde, colas de estado presentes |
| `reset-ops` | `workspace.root` y `worktreesRoot` (existen y el root es checkout git), `worktreePrefix` |

### Sobre `kernel.consume: false`

Que el manifiesto declare `consume: false` **no** invalida la verificación: es
el estado de diseño de la 9.2. La coexistencia está gateada a propósito y
habilitar el consumo del paquete es la 9.4/9.5 — ver el encabezado de
`.pipeline/lib/kernel-resolver.js`: *migrar el estado del motor es la sub-ola
9.4 y el freeze del motor local es la 9.5*. La 9.1 cerró su paridad (#4665) en
el mismo régimen. Lo que la 9.2 cambió, y lo que se verifica acá, es la
resolución de convenciones por el contrato, que corre con el consumo apagado
igual: el puente lee el manifiesto del producto, no el paquete publicado.

## 3. Rollback (CA-4)

| Repo | Tag | Verificación |
|---|---|---|
| `intrale/platform` | `pre-ola-9.2-stable` (`d95626325`) | ancestro de HEAD; `pulpo.js`, `dashboard.js` y `config.yaml` presentes y parseando en el tag |
| `intrale/kernel` | `pre-ola-9.2-skills-stable` (`70ebb22`) | ancestro de HEAD |

Ambos cambios son **puramente aditivos** — el commit del kernel toca 6 archivos,
los 6 nuevos, 0 modificados; en el producto, ningún archivo preexistente
referencia los módulos nuevos. Volver al tag remueve las piezas sin dejar
dependencias colgando: no hay pérdida de operación.

## 4. Deuda que este cierre deja explícita

El baseline del motor enumera **142 ocurrencias en 38 archivos**, que colapsan
en 6 conceptos. Cinco son mecánicos; el sexto —stack Android/Gradle
(`gradlew`, `composeApp`, applicationIds, URL del backend, 17 hallazgos en 6
archivos)— **no se resuelve con configuración plana**: necesita un descriptor de
producto (`build.cmd`, `build.appModulePath`, `flavors[].applicationId`,
`smoke.baseUrl`) y justifica una historia propia en la 9.3/9.4.

El baseline hace esa deuda visible, contable y no-creciente. La tabla por
concepto está en `contracts/anti-regression.md` del kernel.

## 5. Estado de `main` del kernel

Al momento de este cierre, la cadena 9.2 (#5065 → #5066 → #5067) **no está
mergeada** a `main` del kernel: vive en ramas (`agent/5065-adapter-contract`,
`agent/5066-adapter-config-loader`, `agent/5067-parametrizar-skills`) y sólo hay
un PR abierto en ese repo, el de fixtures (#1).

Consecuencia: `main` del kernel todavía tiene 52 literales de producto en los
skills activos, y el check anti-regresión sale **rojo** ahí. Es el resultado
correcto, no un falso positivo — `main` está acoplado de verdad. Queda verde
cuando la cadena mergea. La rama de este issue, que apila toda la cadena, sale
verde.
