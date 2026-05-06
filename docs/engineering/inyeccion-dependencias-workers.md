# Inyección de dependencias en workers Node del pipeline

> Aplica a los servicios Node.js bajo `.pipeline/servicio-*.js` que invocan herramientas externas (CLI, HTTP, FS) y necesitan ser testeables sin spawn ni fixtures de filesystem.

## Motivación

Los workers del pipeline (ej. `servicio-github.js`, `servicio-telegram.js`, `servicio-drive.js`) suelen invocar binarios externos vía `child_process.execSync`/`spawn`. Tests E2E que stubean ese binario en disco sufren tres problemas en Windows bajo carga concurrente (947 tests en paralelo, ~72 s):

1. **PATH lookup desde `cmd.exe` falla transitoriamente** — el shell child no resuelve `node` o el shim `gh.cmd` a tiempo.
2. **EBUSY/EACCES en NTFS** al `appendFileSync` sobre un log compartido por decenas de procesos.
3. **Metadata flush atrasado**: el test lee el log antes de que el OS haga flush y obtiene `calls=[]`.

Resultado histórico: tests CA1 y Backward-compat de `servicio-github.test.js` rebotaban a issues completamente NO relacionados (#2956, #2993, #3015), porque la suite completa fallaba por flakiness y bloqueaba el pipeline de testing.

## Patrón

**Inyectar la dependencia como objeto JS con métodos**, no como binario externo. El worker recibe un parámetro opcional `{ ghClient = defaultGhClient }`; en producción no se pasa nada y se usa el default que envuelve `execSync` 1:1; en tests se pasa un mock JS puro.

### Forma del default

```js
// .pipeline/servicio-github.js

const defaultGhClient = {
  editIssue(issueNumber, { addLabel, removeLabel } = {}) {
    if (addLabel) {
      execSync(`"${GH_BIN}" issue edit ${issueNumber} --add-label "${esc(addLabel)}"`,
               { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true });
    }
    if (removeLabel) {
      execSync(`"${GH_BIN}" issue edit ${issueNumber} --remove-label "${esc(removeLabel)}"`,
               { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true });
    }
  },
  commentIssue(issueNumber, body) { /* execSync ... */ },
  createIssue({ title, body, labels, repo } = {}) {
    const out = execSync(/* ... */).trim();
    const m = out.match(/\/(\d+)\s*$/);
    return { number: m ? parseInt(m[1], 10) : null, url: out };
  },
  listLabels({ repo, limit } = {}) { /* execSync, parse JSON */ },
  createLabel(name, color, { repo } = {}) {
    try {
      execSync(/* ... */);
      return { created: true, alreadyExists: false };
    } catch (e) {
      // Idempotencia: si ya existe (carrera concurrente), tratar como éxito.
      if (String(e.stderr || e.message).includes('already exists')) {
        return { created: false, alreadyExists: true };
      }
      throw e;
    }
  },
};
```

### Inyección en el worker

```js
function processQueue({ ghClient = defaultGhClient } = {}) {
  // ...
  switch (data.action) {
    case 'comment':
      ghClient.commentIssue(data.issue, data.body);
      break;
    case 'label':
      ensureLabels(data.label, ghClient);
      ghClient.editIssue(data.issue, { addLabel: data.label });
      break;
    // ...
  }
}
```

### Mock en el test

```js
const test = require('node:test');
const assert = require('node:assert/strict');

function makeFakeGhClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    editIssue(issue, opts) { calls.push({ method: 'editIssue', args: [issue, opts] }); },
    commentIssue(issue, body) { calls.push({ method: 'commentIssue', args: [issue, body] }); },
    createIssue(opts) {
      calls.push({ method: 'createIssue', args: [opts] });
      return overrides.createIssue?.(opts) ?? { number: 9999, url: 'https://...' };
    },
    listLabels(opts) {
      calls.push({ method: 'listLabels', args: [opts] });
      return overrides.listLabels?.(opts) ?? [];
    },
    createLabel(name, color, opts) {
      calls.push({ method: 'createLabel', args: [name, color, opts] });
      return overrides.createLabel?.(name, color, opts) ?? { created: true, alreadyExists: false };
    },
  };
}

test('action=label invoca editIssue con addLabel', () => {
  const ghClient = makeFakeGhClient();
  // setup queue file...
  svc.processQueue({ ghClient });
  const editCall = ghClient.calls.find(c => c.method === 'editIssue');
  assert.deepEqual(editCall.args, [8001, { addLabel: 'needs-human' }]);
});
```

## Qué se gana

| Beneficio | Detalle |
|---|---|
| **Determinismo en CI** | No depende de spawn / NTFS / log compartido. El test corre 100% en JS, sin tocar el FS más allá de los archivos de cola que el worker lee. |
| **Velocidad** | ~80 ms por test → sub-ms. Multiplicado por 947 tests, son ~75 s ahorrados por run. |
| **Aislamiento** | El test prueba la **decisión** del worker (qué `gh` invocar y con qué argv), no que `cmd.exe` pueda spawnear un script. La responsabilidad del spawn la cubre el runtime de Node. |
| **Cobertura intacta** | Cada caso de uso del worker (comment / label / remove-label / create) sigue verificándose con la misma granularidad — solo se valida directo en JS. |

## Qué NO se pierde

| Cosa que el stub externo aparentaba validar | Realidad |
|---|---|
| "Que `gh` existe en el PATH" | El stub lo forzaba, no era validación real. |
| "Que la sintaxis de `gh issue edit` es correcta" | El stub no parseaba sintaxis, aceptaba cualquier argv. |
| "Que el spawn de Windows funciona" | No es responsabilidad del unit test del worker. Lo cubre Node mismo. |

## Salvaguardas que hay que preservar al migrar un worker

Cuando refactorás un worker para usar este patrón, **estas reglas no se mueven**:

1. **El override de binario sigue afuera.** En `servicio-github.js`, `GH_BIN_OVERRIDE` resuelve el path en el `defaultGhClient`. Permite que un futuro smoke test E2E real (con `--dry-run` o repo fixture) apunte a un stub sin tocar más código.
2. **La sanitización de payload se queda en el call site, no en el client.** Si un caller futuro reusa el client desde otro path, debe sanitizar primero. Mover el sanitizado dentro del client invierte la responsabilidad y crea una superficie de leak silencioso.
3. **La idempotencia de operaciones concurrentes se preserva.** Ej. `createLabel` debe seguir capturando "already exists" en stderr y devolviendo `{ alreadyExists: true }` sin arrojar. Sin esto, dos workers creando el mismo label en paralelo rompen.
4. **La guardia de validación previa se ejecuta antes del client.** Ej. `validateOrderFresh()` en `servicio-github.js` corre antes de `ghClient.editIssue()`. Es lógica de decisión, no de transporte.

## Smoke test E2E real (complementario, opcional)

El unit test del worker valida la **decisión**. La integración real con el binario `gh` se valida con un smoke test **separado** que corra fuera del paralelo masivo:

- Apuntando a un repo fixture con `--dry-run`, o
- Stubeando `gh` con `GH_BIN_OVERRIDE` en un proceso aislado (no concurrente).

Eso queda fuera del scope del unit test y vive como issue independiente (#3028 al momento de redactar este doc).

## Cuándo NO usar este patrón

- **Cuando el worker no invoca herramientas externas.** Si la lógica es 100% JS (parser, validador, mapper), un mock es overkill — testealo directo.
- **Cuando el binario es parte de la unit que querés validar.** Ej. tests del propio resolver de PATH (cubierto por `validate-java-home.test.js`) deben tocar el FS — eso ES el dominio del test.

## Referencias

- Issue origen: [#3025 — fix(pipeline): tests del stub gh fallan por concurrencia en Windows (EBUSY/NTFS)](https://github.com/intrale/platform/issues/3025)
- Implementación de referencia: `.pipeline/servicio-github.js` + `.pipeline/__tests__/servicio-github.test.js`
- Issues derivados (oportunidades, no bloqueantes):
  - #3027 — replicar el patrón en otros workers del pipeline.
  - #3028 — smoke test E2E real contra `gh` con repo fixture.
  - #3031 — migrar `defaultGhClient` a `execFileSync` (defense-in-depth contra shell injection).
