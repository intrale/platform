# Runbook: credenciales y canales del ambiente de pruebas (#7113)

> Complementa `docs/runbooks/credential-rotation.md` (productivo) y
> `docs/pipeline/pipeline-env.md` (#7110, resolvedor de ambiente). Acá está
> **qué provisionar** para que una corrida de prueba tenga sus propios canales
> y **cómo verificar** que no alcanza el chat del operador, el repo real ni la
> cuota productiva.

## Por qué existe

El aislamiento por directorio (#7110/#7111) no alcanza: Telegram, GitHub, los
proveedores de modelo y el vault se resuelven **por credencial**, no por path.
El 08/09/2026 un test que corría en un `pipelineDir` de pruebas levantó el token
productivo de Telegram y mandó 180 avisos al chat del operador; el mismo día,
27 comentarios en un issue público de `intrale/platform`.

Desde #7113 hay **un único punto de decisión**: `lib/credenciales-ambiente.js`.
Recibe el env del proceso, resuelve el ambiente con `lib/pipeline-env.js` y
decide qué store hidratar y a qué destino apunta cada canal. Ningún otro punto
lee `process.env.TELEGRAM_BOT_TOKEN` / `GH_TOKEN` / `*_API_KEY` por su cuenta
(ratchet `lib/__tests__/credenciales-ratchet.test.js`).

## Antes de mergear / arranque manual (host productivo)

El pipeline productivo **sólo hidrata `credentials.json` si el proceso declara
`PIPELINE_AMBIENTE=productivo`**. Los lanzadores (`launch.ps1`, `watchdog.ps1`,
`restart.js`) ya lo declaran (#7112). Para arranques a mano
(`node .pipeline/pulpo.js` desde una consola) declaralo en el host:

```powershell
setx PIPELINE_AMBIENTE productivo
```

Sin declaración el proceso arranca en `pruebas`; con `PIPELINE_STATE_DIR`
apuntando al productivo el dir queda anulado y el pulpo **aborta antes de
hidratar nada** (`[ambiente] sin dir: nada que arrancar`). Es fail-closed a
propósito: un pulpo sin ambiente no toca credenciales.

## Qué hace cada modo

| Canal | `productivo` | cualquier otro modo (`pruebas`, `explicito`) |
|---|---|---|
| Store | `~/.claude/secrets/credentials.json` (+ legacy) | `~/.claude/secrets/credentials.pruebas.json` **sin legacy** |
| Env heredado | intacto | se **purgan** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_LEO_OPERATOR_CHAT_ID`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN` |
| Telegram | bot real | `TELEGRAM_BOT_TOKEN_PRUEBAS` / `TELEGRAM_CHAT_ID_PRUEBAS`; sin ellas → **transporte nulo verificable** |
| GitHub | sesión `gh` del operador | `GH_CONFIG_DIR=<dir>/gh-config` (vacío); `GH_TOKEN` sólo si el store trae `github.token` |
| Proveedores | `agent-models.json` productivo, sesiones OAuth del operador | `<dir>/agent-models.json` deterministic-only; `CLAUDE_CONFIG_DIR` / `CODEX_HOME` → `<dir>/sesiones-pruebas/*` (sentinel inexistente) |
| Vault | `config.yaml` productivo | namespace `/intrale/intrale-pruebas`; apagado salvo `awsProfile` propio |

Al arrancar, el proceso imprime **una vez** el bloque `[ambiente]` (una línea
en productivo, un bloque por canal en pruebas). Se puede pegar en un issue: no
contiene valores.

## Provisionar el ambiente de pruebas

### 1. Store de pruebas (`credentials.pruebas.json`)

Misma estructura que el canónico, **archivo separado** (un `loadIntoEnv` de
pruebas no puede ni ver el productivo):

```
~/.claude/secrets/credentials.pruebas.json
```

```json
{
  "_note": "Ambiente de pruebas #7113. Bot y chat DE PRUEBA; PAT sin write.",
  "_version": 1,
  "telegram": { "bot_token": "<bot de pruebas>", "chat_id": "<chat de pruebas>" },
  "github":   { "token": "<fine-grained PAT de pruebas>" }
}
```

- **No** pongas `providers.*`: en pruebas las API keys **no se hidratan** aunque
  estén (CA-4). El archivo puede no existir: el canal queda apagado y el
  bloque `[ambiente]` lo dice (`sin credentials.pruebas.json`).
- Permisos: igual que el canónico (`icacls` sólo para el usuario del pipeline).

### 2. Telegram

Opción A — **bot de pruebas dedicado**: creá un bot con @BotFather y un grupo
privado donde sólo esté ese bot. `telegram.bot_token` / `telegram.chat_id` van
al store de pruebas. Los envíos salen **sólo por la cola**
`<dir>/servicios/telegram/pendiente` que drena el `servicio-telegram.js` de
ese dir; los HTTPS directos del pulpo se trazan igual.

Opción B — **transporte nulo** (default sin store): nada sale. Cada envío deja
una línea en `<dir>/servicios/telegram/trazas/YYYY-MM-DD.jsonl`:

```json
{"ts":"2026-09-20T10:00:00.000Z","chat_id":"<chat_id>","origen":"pulpo:sendTelegramWithMarkup","texto":"...redactado...","motivo":"telegram.enabled:false (sin credentials.pruebas.json ni TELEGRAM_BOT_TOKEN_PRUEBAS/TELEGRAM_CHAT_ID_PRUEBAS)"}
```

`chat_id` va siempre como `<chat_id>` y `texto` pasa por `redact.redactTelegram`
(URLs de `api.telegram.org/bot<token>` y `chat_id=` redactados). Sin dir de
pruebas la traza va a stderr, nunca a un path productivo.

### 3. GitHub

Creá un **fine-grained PAT** con una identidad que **no** tenga permiso de
escritura sobre `intrale/platform` (por ejemplo, sólo `Contents: read` /
`Issues: read` en un fork o en ningún repo). Va a `github.token` del store de
pruebas. Con eso:

- `gh` arranca con `GH_CONFIG_DIR` vacío: el keyring del operador queda
  inalcanzable.
- Un `gh issue comment` desde pruebas falla **en origen** (`403` de la API), no
  por un guard del pipeline. El guard sigue existiendo como defensa en
  profundidad.

Verificación (sin token en el store):

```
$ GH_CONFIG_DIR=<dir de pruebas>/gh-config gh auth status
You are not logged into any GitHub hosts. To log in, run: gh auth login
```

### 4. Proveedores de modelo

Nada que provisionar. `aplicar()` genera `<dir>/agent-models.json` derivado del
productivo con `default_provider: "deterministic"` y cada skill ruteado a
`deterministic`, sin `fallbacks`. Si alguien lo pisa (por ejemplo, #7111 copia
el productivo al provisionar), se **regenera** en el próximo boot.

Un skill LLM ruteado a `deterministic` falla en `lib/providers/deterministic.js`
(`DETERMINISTIC_SKILLS`): es el comportamiento buscado — falla en origen, cero
cuota. Si un test necesita un LLM real, el operador provisiona una sesión bajo
`<dir>/sesiones-pruebas/claude` (o `codex`) con una cuenta de pruebas; nunca se
cae a `~/.claude` / `~/.codex`.

### 5. Vault

En el `config.yaml` del dir de pruebas:

```yaml
vault:
  enabled: true
  prefix: /intrale
  projectId: intrale          # el perfil lo pisa con intrale-pruebas
  hostId: <host>
  awsProfile: intrale-pruebas # DISTINTO del productivo, obligatorio
```

Reglas (`decidirVault`):

- `awsProfile` vacío o **igual al productivo** ⇒ vault **apagado** con motivo.
  La separación es de principal IAM, no "lógica": un mismo principal con otro
  `projectId` sigue pudiendo leer `/intrale/intrale/*`.
- El principal de pruebas se crea con `docs/pipeline/vault-iam-policy-pruebas.json`:
  `Allow` sólo `parameter/intrale/intrale-pruebas/*`, `Deny` explícito sobre
  `parameter/intrale/intrale/*` y sobre toda escritura. La prueba live de
  `AccessDenied` queda en #7417.

## Verificación rápida

```
node --test .pipeline/lib/__tests__/credenciales-ambiente.test.js   # CA-1..CA-6, CA-9
node --test .pipeline/lib/__tests__/credenciales-ratchet.test.js    # CA-7
node --test .pipeline/lib/__tests__/pipeline-env.test.js            # H1 intacto
```

Y en caliente, con un dir de pruebas:

```
PIPELINE_DIR_OVERRIDE=<dir> node -e "console.log(require('./.pipeline/lib/credenciales-ambiente').aplicar(process.env).resumen.join('\n'))"
```

Debe mostrar `modo=pruebas`, la lista de purgadas y los cuatro canales con su
destino de pruebas. Si ves `telegram ENCENDIDO bot de pruebas`, confirmá que el
`chat_id` del store de pruebas es el grupo de prueba antes de correr nada.

## Acceso a repos privados (#7595)

`platform` continúa público y `kernel` permanece privado. El archivado previsto
para los legacy mantiene su lectura pública, pero impide push y comentarios:
esas operaciones se migran a `platform` antes del archivado.

Para clonar un repo privado, la identidad de pruebas necesita acceso explícito
a **ese repo** mediante GitHub App o token fine-grained de mínimo privilegio.
`GH_TOKEN` sigue siendo opcional; su presencia no acredita acceso. La provisión
de credenciales acotadas corresponde a #7627 y la transición de `platform` a
#7662. No se modifica `credenciales-ambiente.js` ni se amplía el token productivo.

La evidencia de cada identidad registra repo, permisos, fecha y resultado de
clone/push/comentario (cuando esas operaciones estén autorizadas). Si no tiene
acceso, se registra explícitamente como restricción. Nunca se guarda el token
en la URL ni en logs. Ver [visibilidad de repos](visibilidad-repos.md).

## Si algo sale mal

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `[ambiente] sin dir: nada que arrancar` en el host productivo | falta `PIPELINE_AMBIENTE=productivo` | `setx PIPELINE_AMBIENTE productivo` y relanzar (o dejar que el watchdog relance con `launch.ps1`) |
| `[secrets-health] omitido (modo=pruebas…)` en productivo | idem: el proceso se cree de pruebas | idem |
| Llegó un aviso al chat del operador desde una corrida de prueba | el proceso corrió en `productivo` (declaración heredada + `PIPELINE_STATE_DIR` productivo) | revisar el bloque `[ambiente]` del log; una corrida de prueba **no puede** declarar productivo con dir distinto del productivo (SEC-1) |
| `vault APAGADO … coincide con el productivo` | `awsProfile` de pruebas = productivo | crear el principal de pruebas con la policy de arriba y un profile propio |
| Un agente de pruebas falla con `DETERMINISTIC_SKILLS` | esperado: el skill pide LLM y el ambiente no tiene | provisionar sesión de pruebas bajo `<dir>/sesiones-pruebas/` si el test lo necesita |
