# Spike — Estado del camino a la persistencia externa y el pipeline distribuido

> **Naturaleza:** hallazgos de un spike de código ejecutado el **2026-07-28** sobre el HEAD de `main`
> (`5ee814c9d`). El entregable es este documento: registro de qué existe, qué está apagado y qué
> falta, para tomar decisiones sin volver a investigar.
> **No implementa nada.** No enciende flags, no crea tablas, no toca AWS.
>
> **Contexto:** disparado por la pregunta operativa "¿cuál es el paso que externaliza el estado para
> dejar de tener config/estado local y poder correr múltiples instancias distribuidas del pipeline?".
>
> **Prior art:** [`persistencia-data-operativa-analisis.md`](persistencia-data-operativa-analisis.md) (#3898),
> [`externalizacion-estado-operativo-remoto.md`](externalizacion-estado-operativo-remoto.md) (#4398),
> [`contrato-kernel-gestion-remota.md`](contrato-kernel-gestion-remota.md),
> [`roadmap-olas.md`](roadmap-olas.md).

---

## 1. Conclusión en una frase

**La capa de persistencia remota no hay que construirla: ya está construida, mergeada, testeada y
apagada. Pero cubre sólo el estado del *kernel*, no el estado operativo del día a día — y ese
segundo pedazo sigue sin envoltorio, con cientos de accesos directos al filesystem.**

Esto **corrige** una afirmación previa ("el envoltorio de acceso al estado no lo construyó nadie"):
es más matizado y cambia la decisión.

---

## 2. Lo que YA existe y está mergeado

| Pieza | Dónde vive | Origen |
|---|---|---|
| Store durable DynamoDB single-table, namespaceado por `projectId`, escrituras condicionales, versionado optimista, leases con dueño, validación fail-closed en cada lectura | `.pipeline/lib/kernel-store.js` + `.pipeline/contracts/kernel-store.schema.json` | #4744 |
| Migrador JSON → DynamoDB con backup, verificación y rollback | `.pipeline/lib/kernel-store-migrate.js` | #4745 |
| Driver DynamoDB de producción + provisioning de tabla con IAM least-privilege | `.pipeline/lib/provisioner-infra.js`, `docs/pipeline/kernel-iam-policy.md` | #4820 |
| Alta durable + lectura de catálogo desde el store + coexistencia con FS (flag de cutover único) | #4821 | #4804 |
| Boot del supervisor multi-producto desde el store, con cota de instancias | `.pipeline/lib/kernel-supervisor.js` | #4822 |
| Store de coordinación (claims de fase con lease) | `.pipeline/lib/kernel-coordination-store.js` | Ola Puente |
| API remota de gestión con auth real (JWT/Cognito, permisos por producto, buzón de comandos del operador `encolado → procesando → confirmado/rechazado`, anti-replay) | `docs/pipeline/contrato-kernel-gestion-remota.md` | #4795 |

Cobertura de tests: `durable-cutover.test.js`, `kernel-store.test.js`,
`kernel-durable-driver-4820.test.js`, `kernel-store-migrate.test.js`,
`kernel-coordination-store.test.js`, `product-isolation-4811.test.js`.

---

## 3. Lo que está apagado (y por qué está bien que lo esté)

En `.pipeline/config.yaml` (sección `kernel:`, líneas ~1397-1422):

```yaml
kernel:
  tableName: ""      # vacío
  region: ""         # vacío
  durable: false     # default OFF — todo sigue en FS, cero llamadas AWS
```

- `durable` es el **flag de cutover único**: gatea lectura y escritura a la vez; nunca coexisten
  dos fuentes de verdad.
- El default `false` es un **fail-safe deliberado**, no un olvido: con `durable: true` y
  `tableName: ""` el arranque **falla fail-closed**. Dejarlos vacíos mientras `durable: false` es el
  estado correcto y esperado.
- **Consecuencia:** hoy no hay ninguna tabla real detrás. Encenderlo requiere provisionar la tabla,
  cargar región/nombre y correr el migrador — no es sólo cambiar un booleano.

---

## 4. Lo que NO cubre el store durable (el hueco real)

El store del kernel persiste **descriptores, catálogo de productos, firmas, audit-log y claims de
fase**. Es decir: la identidad y la coordinación de proyectos.

**No cubre el estado operativo del día a día** — el registro de olas, la allowlist de ejecución, el
tablero, las sesiones, los contadores. Ese estado sigue siendo archivos planos leídos directamente
desde cualquier parte del código.

Medición sobre `main` (excluyendo tests, worktrees temporales y `node_modules`):

| Estado | Archivos que lo tocan directo |
|---|---|
| Registro de olas (`waves.json`) | **33** |
| Allowlist de ejecución | **160** |

No hay un módulo de acceso único para ninguno de los dos. Mientras siga así, **cambiar dónde vive
ese estado es inviable**: habría que reescribir cada punto de acceso, con riesgo de dejar la mitad
leyendo el archivo viejo y la otra mitad la base — el peor escenario posible (dos verdades).

---

## 5. Qué falta, en orden de dependencia

1. **Envoltorio único de acceso al estado operativo** (olas + allowlist). Sin cambiar dónde vive el
   dato: mismo comportamiento, un solo punto de entrada. Es la precondición mecánica de todo lo demás.
2. **Namespaceado por proyecto** de ese estado (hoy es plano y global: dos proyectos se pisan).
   Es el contenido central de la **Ola 9.4**.
3. **Encendido real del store durable del kernel**: provisionar tabla, cargar `tableName`/`region`,
   migrar con el migrador existente, verificar, y recién ahí `durable: true`.
4. **Mover el estado operativo al store** una vez que 1 y 2 estén hechos.
5. **Multi-instancia distribuida**: recién es posible con 1-4 cerrados. La coordinación por leases ya
   existe (`kernel-coordination-store.js`); lo que falta es que el estado que se disputa esté afuera.

---

## 6. Implicancia para la decisión

- El roadmap ([`roadmap-olas.md`](roadmap-olas.md) §2) fija la **Ola 9.4** como próxima. Este spike
  **no la mueve**, la **precisa**: dentro de la 9.4, el primer entregable debe ser el envoltorio de
  acceso, no el namespaceado — el namespaceado sin envoltorio es tocar 193 lugares a mano.
- El encendido del store durable (punto 3) es **independiente y paralelizable**: no depende del
  envoltorio, porque el store del kernel cubre otras entidades. Puede hacerse antes, después o en
  simultáneo.
- Ningún punto de este spike requiere construir capa nueva de persistencia. Todo lo pendiente es
  **conectar, namespacear y encender** lo que ya está.

---

## 7. Trazabilidad

| Afirmación | Verificación |
|---|---|
| Store, migrador, driver y supervisor existen | `ls .pipeline/lib/kernel-*.js`; issues #4744, #4745, #4820, #4821, #4822 cerrados |
| API remota con auth existe | `docs/pipeline/contrato-kernel-gestion-remota.md`; #4795 |
| `durable: false`, tabla vacía | `.pipeline/config.yaml:1417-1419` |
| Store no cubre olas/allowlist | Encabezado de `.pipeline/lib/kernel-store.js:14-27` (entidades: descriptor, product, catalog, signature, audit, claim) |
| 33 / 160 puntos de acceso directo | `grep -rln "waves\.json" .pipeline --include=*.js` y `grep -rln "allowlist" .pipeline --include=*.js`, filtrando tests/worktrees/node_modules |
