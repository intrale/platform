# Snapshot de credenciales por lanzamiento (#5799)

Cómo llega hoy una credencial a un proceso hijo del pipeline, qué cambia con el
snapshot por intento, y en qué orden se enciende sin dejar el pipeline sin
agentes.

Historia: [#5799](https://github.com/intrale/platform/issues/5799), hija de
#5791, bajo el paraguas #5440. Consume la API de snapshot aislado de
[#5798](https://github.com/intrale/platform/issues/5798) y la base de vault de
#5339.

---

## El problema

Hasta esta historia, el material de credenciales que recibía un hijo salía de
`process.env` del Pulpo, hidratado **una sola vez en el boot**
(`lib/hydrate-provider-env.js`). Ese diseño tiene tres consecuencias:

| Consecuencia | Qué se ve en producción |
|---|---|
| **Rotación atada al proceso padre** | Una credencial rotada no llega a ningún hijo hasta reiniciar el Pulpo. |
| **Coexistencia de material** | Las credenciales de TODOS los providers viven en el proceso padre; que el hijo no las reciba depende sólo del filtro de salida (`build-child-env.js`). |
| **Sin identidad de intento** | Primario, reintento y fallback comparten la misma fuente mutable: un objeto de env reutilizado puede arrastrar la credencial del provider anterior. |

`build-child-env.js` seguía siendo una buena frontera —filtra por allowlist,
provider efectivo y scopes— pero filtra **un env que ya contiene todo**. Lo que
cambia acá es de dónde sale lo que entra a esa frontera.

---

## Qué hace el snapshot por intento

Cada **intento** de lanzamiento pide su propio snapshot al vault para el
**provider efectivo ya resuelto**, y ese objeto —nuevo, no cacheado, no
compartido, no mutado— es la única fuente del material de credenciales que entra
por `buildChildEnv({ processEnv })`.

Son intentos, cada uno con su snapshot:

- el lanzamiento de un agente por el Pulpo (`lanzarAgenteClaude`);
- el lanzamiento del Commander;
- cada reintento del glitch 1M de Anthropic;
- **cada eslabón** de la cascada de fallback, incluido el secundario in-flight.

```
resolver provider efectivo
  → createCredentialSnapshot({ destination, scopes: ['providers'], provider })   (#5798)
  → composeAttemptProcessEnv({ baseEnv: process.env, snapshot, providersCfg })
  → buildChildEnv({ processEnv })                                                (#3085)
  → stripReservedChildSecrets()                                                  (#5462)
  → spawn
```

El orden importa: el snapshot se pide **después** de saber qué provider corre,
así el fallback nunca materializa la credencial del primario; y se pide
**inmediatamente antes** de construir el env, así una rotación entra sin
reiniciar nada.

### Módulos

| Archivo | Rol |
|---|---|
| `.pipeline/lib/attempt-credential-snapshot.js` | Frontera por intento: gate, decisión de "¿requiere snapshot?", pedido y composición del `processEnv`. |
| `.pipeline/lib/credentials.js` | `createCredentialSnapshot()` — la API de #5798. No se reimplementa ni se envuelve el loader del vault. |
| `.pipeline/lib/build-child-env.js` | Frontera de mínimo privilegio. **Firma pública sin cambios**; sólo se endureció el rechazo de un `processEnv` inválido. |
| `.pipeline/pulpo.js` | Los call-sites: `lanzarAgenteClaude` y `construirEnvCommander`. |

---

## Composición del env del intento

`composeAttemptProcessEnv()` arma un objeto **nuevo** por intento:

- copia el env base **sin ninguna variable de credencial de provider** — las
  purgadas se derivan del `providers` de `agent-models.json` más el mapa de
  defaults, nunca de una lista escrita a mano (lección de `providers.groq`,
  #3353);
- aplica encima el `snapshot.env`;
- las variables que **no** son credenciales de provider (`PATH`, `PIPELINE_*`,
  scopes `github` / `aws` / `gradle-android`) siguen viniendo del env base, y es
  `buildChildEnv` quien decide cuáles cruzan al hijo.

### Detalle de Windows que no es opcional

`process.env` resuelve **case-insensitive** en Windows: el SO guarda `Path`,
`ProgramFiles`, `windir`, y `process.env.PATH` igual responde. Un objeto literal
no tiene esa propiedad. Por eso, cuando el snapshot obliga a materializar una
copia, los nombres canónicos de `SYSTEM_ALLOWLIST` y de los `CREDENTIAL_SCOPES`
se re-resuelven case-insensitive contra el env base y se escriben bajo el nombre
canónico. Sin eso el hijo se queda sin `PATH`, sin `SystemRoot` y sin `ComSpec`,
que en Windows no es una degradación: es un proceso que no arranca.

Y **sin snapshot no se copia nada**: se devuelve el env base tal cual. Copiar un
`process.env` real degradaría ese lookup, y con el gate cerrado el camino legacy
tiene que quedar idéntico.

---

## Gate de rollout y orden de encendido

```yaml
# .pipeline/config.yaml
pipeline:
  credential_snapshot_enabled: false   # default
vault:
  enabled: false                       # default
```

**El orden importa y no es simétrico.** Con el vault cerrado,
`createCredentialSnapshot()` falla con `SNAPSHOT_VAULT_DISABLED`; como acá ese
fallo **aborta el lanzamiento** (fail-closed, ver abajo), abrir
`credential_snapshot_enabled` antes que `vault.enabled` deja al pipeline sin
lanzar un solo agente.

1. `vault.enabled: true` (más el resto del provisioning de #5339: `hostId`,
   `awsProfile`, cobertura de secretos).
2. Verificar que el vault resuelve el scope `providers` para los providers en
   uso.
3. Recién entonces `pipeline.credential_snapshot_enabled: true`.
4. `/restart` y observar el log de `lanzamiento` — un
   `❌ credential-snapshot abortó el spawn` es la señal de que el paso 2 no
   estaba.

Para revertir alcanza con volver el flag a `false`: el camino legacy vuelve
entero, sin migración de estado.

### Qué NO hace el gate cerrado

Nada. Cero llamadas al vault, cero cambios en el env, cero costo. El único
efecto residual del cambio es estructural: `lanzarAgenteClaude` es `async` y sus
dos call-sites capturan la rejection con `.catch()`.

---

## Fail-closed

Un intento aborta **antes del spawn** cuando el snapshot es *requerido* y no se
pudo emitir. "Requerido" es una condición explícita, no una suposición:

> gate `credential_snapshot_enabled` abierto **y** el provider efectivo consume
> credencial desde el entorno del hijo.

Un provider con `auth_mode: oauth` (Anthropic vía OAuth Max, Codex vía
`~/.codex`, Gemini vía cuenta Google) autentica fuera del env: no hay key que
pedir, así que tampoco hay snapshot que exigir. Los que sí lo requieren son los
de régimen `api_key` — hoy `cerebras`, `nvidia-nim`, `kimi-moonshot`.

Qué pasa en cada camino cuando el snapshot falla:

| Camino | Desenlace |
|---|---|
| Agente del Pulpo | `AttemptSnapshotError`, sin spawn. El workfile queda en `trabajando/` y lo recupera `brazoHuerfanos` — el mismo desenlace que ya tenía el rechazo de env-isolation. |
| Commander (primario Anthropic) | El turno rechaza, igual que el `reject()` previo del bloque de env-isolation. |
| Commander (cascada) | `advanceOrGiveUp(provider, 'env_isolation_error')`: se prueba el eslabón siguiente. Si se agota la cascada, canned — el operador nunca queda mudo. |

### Fail-closed sí, frágil no

El aborto es sobre la superficie de **credenciales**, no sobre cualquier error.
En el camino del Pulpo: un `AttemptSnapshotError` aborta siempre, y con el gate
abierto aborta cualquier fallo de la preparación del env. Con el gate **cerrado**,
un error ajeno al snapshot (leer `agent-models.json`, resolver la config del
skill) degrada al env del padre —el comportamiento previo a #5799— y deja una
señal `⚠️` en el log. Ahí no hay ninguna credencial en juego que proteger, y
convertir ese fallo en un aborto dejaría al pipeline sin lanzar agentes por una
razón que nada tiene que ver con la seguridad.

Los errores exponen **destino, provider y un código estable**
(`SNAPSHOT_VAULT_DISABLED`, `SNAPSHOT_SECRET_INVALID`,
`SNAPSHOT_ANCHOR_UNRESOLVED`, …). Nunca valores, hashes ni la serialización del
snapshot: el mensaje del driver no se reenvía, se traduce.

---

## Identidad de intento

El env que devuelve la frontera del Commander lleva una marca **no enumerable**
`__attemptProvider`. Sirve para una sola cosa: que un env precomputado se pueda
reutilizar **sólo dentro del mismo provider**. Antes, `attemptEnv = preEnv || …`
era exactamente la vía por la que el env del turno (construido para el primario)
se reutilizaba en el eslabón siguiente de la cascada.

Es no enumerable porque `spawn` copia las propiedades enumerables del env: una
marca enumerable viajaría al hijo como una variable de entorno más.

---

## Tests

```bash
node --test .pipeline/tests/build-child-env.test.js \
            .pipeline/tests/dispatch-build-env-integration.test.js \
            .pipeline/tests/pulpo-agent-spawn-env-containment.test.js
```

- `build-child-env.test.js` — gate fail-closed, providers oauth vs api_key,
  rotación N/N+1, aislamiento por referencia, snapshot mal formado, redacción de
  errores y logs, canonicalización de nombres en Windows, contrato endurecido de
  `processEnv`.
- `dispatch-build-env-integration.test.js` — flujo end-to-end Pulpo/Commander:
  primario, cascada de profundidad 2, concurrencia con providers distintos,
  rotación entre lanzamientos, y **cero llamadas a spawn** ante hidratación
  inválida.
- `pulpo-agent-spawn-env-containment.test.js` — barrido del fuente real de
  `pulpo.js`: los canarios de #5462 siguen cubriendo commander y fallback, ahora
  a través del punto único, con el snapshot apagado y encendido.

---

## Ver también

- [`vault-secretos-aws.md`](vault-secretos-aws.md) — el vault, su gate y el
  bootstrap de credencial raíz (#5339).
- [`inventario-credenciales.md`](inventario-credenciales.md) — qué secretos
  existen y quién los consume.
- [`../pipeline-multi-provider.md`](../pipeline-multi-provider.md) §5.2 — la
  frontera `build-child-env` y el flag `env_isolation_enabled`.
