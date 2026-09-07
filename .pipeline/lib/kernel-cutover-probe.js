'use strict';

// =============================================================================
// kernel-cutover-probe.js — Sonda POSITIVA del cutover durable (#5208)
//
// Responde la única pregunta que el cutover no puede responder solo:
// **¿lo que la API del kernel dice que escribió está REALMENTE en DynamoDB?**
//
// El riesgo que esta sonda existe para matar es el FALSO VERDE de comparar dos
// conjuntos vacíos. Con ambas tablas en `ItemCount: 0`, cualquier comparación
// "API vs DynamoDB" da verde sin probar nada, y `migrated_count: 0` del migrador
// es un DIAGNÓSTICO —no paridad— porque el único descriptor del repo declara el
// id RESERVADO `intrale-platform` (el control-plane no se da de alta como
// producto). Por eso acá se ESCRIBE una entidad controlada NO VACÍA y recién
// después se compara.
//
// QUÉ HACE, EN ORDEN (fail-closed: cualquier paso rojo aborta y no sigue):
//
//   1. IDENTIDAD  — `aws sts get-caller-identity` y verifica que el principal
//      efectivo sea el `kernel.runtimePrincipal` declarado en config. Probar con
//      un principal administrativo esconde permisos faltantes Y excesivos.
//   2. ALTA       — `durableRegisterProduct` (project-bootstrap.js, #4821): el
//      ÚNICO poblador. Nunca se llama al driver DynamoDB directo desde el alta.
//      Escribe en DOS particiones (#5204): `descriptor#self` en la del tenant;
//      `product#<id>` + `catalog#index` en la del control-plane.
//   3. LECTURA API — `getDescriptor` / `listProducts` por la API del kernel.
//   4. LECTURA CRUDA — `aws dynamodb get-item --consistent-read`, invocando la
//      CLI por un camino SEPARADO del driver del store. Si ambos caminos usaran
//      el mismo código, la comparación sería el mismo bug mirándose al espejo.
//   5. COMPARACIÓN — `PK`, `SK`, versión y contenido canónico, entidad por
//      entidad. Un campo que no coincide es rojo.
//   6. NEGATIVA CROSS-TENANT — un contexto ajeno NO puede leer la partición del
//      tenant de la sonda. Se informa el resultado SIN revelar identificadores
//      del otro tenant.
//
// CONTEXTO FUERA DE BANDA (A01 · SEC-1). El `contextProjectId` se recibe del
// operador y se valida contra la gramática de ids seguros; el descriptor se
// CONSTRUYE a partir de él. Nunca al revés: no se deriva contexto del payload,
// del descriptor, ni de un dato migrado. `durableRegisterProduct` reejecuta esa
// comprobación y el store la reejecuta otra vez en `assertSameProject`.
//
// CERO SECRETOS EN LA SALIDA (A02 · SEC-2). Todo el reporte pasa por
// `redactSecrets` del migrador y por `redactAccountIds` de acá: el account-id de
// 12 dígitos de cualquier ARN sale como `<ACCT>`.
//
// NO SE IMPORTA DESDE EL PULPO. Es una herramienta de operador, standalone. El
// runtime del pipeline no la carga nunca: no puede dejarlo fuera de servicio.
//
// ESTILO: errores como DATO (`{ ok:false, code, error }`), NUNCA throw a través
// de la frontera del módulo, NUNCA `process.exit` fuera del CLI.
// =============================================================================

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { canonicalize, isSafeId, isReservedProjectId, CONTROL_PLANE_PROJECT_ID } = require('./project-descriptor');
const { redactSecrets, sha256Canonical } = require('./kernel-store-migrate');

// SK literales del alcance del cutover (mismos strings que construye
// `kernel-store.js`; se declaran acá para que la sonda no dependa de un builder
// interno del store y la comparación sea genuinamente independiente).
const SK_DESCRIPTOR = 'descriptor#self';
const SK_CATALOG = 'catalog#index';
const skProduct = (id) => `product#${id}`;

// Tenant ficticio para la sonda NEGATIVA. Es un id seguro y no reservado que
// NUNCA se da de alta: sólo se usa como contexto para comprobar que no puede
// leer la partición ajena.
const CROSS_TENANT_PROBE_ID = 'cutover-cross-tenant-probe';

// -----------------------------------------------------------------------------
// Redacción
// -----------------------------------------------------------------------------

// Account-ids de AWS (12 dígitos) en cualquier ARN o salida. Se aplica ADEMÁS de
// `redactSecrets` (que cubre claves/tokens), porque un account-id no es un
// secreto criptográfico pero sí es dato operativo que no puede entrar al repo.
function redactAccountIds(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\b\d{12}\b/g, '<ACCT>');
}

function redactAll(text) {
  return redactAccountIds(redactSecrets(String(text == null ? '' : text)));
}

// -----------------------------------------------------------------------------
// AWS CLI (camino SEPARADO del driver del store — ver paso 4 del encabezado)
// -----------------------------------------------------------------------------

function runAwsCli(args, deps = {}) {
  const exec = deps.spawnSync || spawnSync;
  const res = exec('aws', args, { encoding: 'utf8', shell: false, env: deps.env || process.env });
  if (res.error) return { ok: false, code: 'aws_cli_spawn_failed', error: redactAll(res.error.message) };
  if (res.status !== 0) {
    return { ok: false, code: 'aws_cli_failed', status: res.status, error: redactAll(res.stderr || res.stdout) };
  }
  return { ok: true, stdout: res.stdout };
}

// -----------------------------------------------------------------------------
// Paso 1 — Identidad efectiva del runtime (SEC-6)
// -----------------------------------------------------------------------------

/**
 * Verifica que el principal AWS efectivo sea el declarado en
 * `kernel.runtimePrincipal`. Fail-closed: sin coincidencia, no se escribe nada.
 */
function verifyRuntimeIdentity(opts = {}) {
  const expected = opts.expectedPrincipal;
  if (!expected || typeof expected !== 'string') {
    return {
      ok: false,
      code: 'runtime_principal_ausente',
      error: 'runtime_principal_ausente: falta `kernel.runtimePrincipal` en .pipeline/config.yaml. '
        + 'Qué hacer ahora: sin el principal declarado no hay contra qué comparar la identidad efectiva, '
        + 'y probar con un principal administrativo esconde permisos faltantes y excesivos. No sigas.',
    };
  }
  const args = ['sts', 'get-caller-identity', '--output', 'json'];
  if (opts.profile) args.push('--profile', opts.profile);
  const res = runAwsCli(args, opts);
  if (!res.ok) return res;

  let ident;
  try {
    ident = JSON.parse(res.stdout);
  } catch (e) {
    return { ok: false, code: 'identidad_ilegible', error: `identidad_ilegible: ${redactAll(e.message)}` };
  }
  const arn = String(ident.Arn || '');
  // El nombre del principal es el último segmento del ARN (`.../user/<nombre>`).
  const actual = arn.split('/').pop();
  if (actual !== expected) {
    return {
      ok: false,
      code: 'identidad_inesperada',
      error: `identidad_inesperada: el principal efectivo es "${redactAll(actual)}" pero config declara "${expected}". `
        + 'Qué hacer ahora: corré la sonda con la identidad runtime real (perfil de #5207). '
        + 'La trampa prohibida: NO la corras con un perfil administrativo para "que funcione" — '
        + 'un admin pasa todas las sondas y no prueba la postura IAM que va a producción.',
    };
  }
  return { ok: true, principal: actual, arn: redactAll(arn) };
}

// -----------------------------------------------------------------------------
// Descriptor de la sonda — se CONSTRUYE desde el contexto, nunca al revés
// -----------------------------------------------------------------------------

function buildProbeDescriptor(contextProjectId, opts = {}) {
  return {
    schemaVersion: '1.0',
    identity: {
      projectId: contextProjectId,
      name: opts.name || 'Sonda de cutover durable',
    },
    repositories: [
      { id: 'main', url: 'https://github.com/intrale/platform', role: 'primary' },
    ],
    board: {
      ref: 'https://github.com/orgs/intrale/projects/1',
      admissionLabels: ['Ready'],
      routing: [{ label: 'area:pipeline', capability: 'pipeline' }],
    },
    capabilities: [{ interface: 'pipeline', skills: ['pipeline-dev'] }],
    authority: { signers: ['leitolarreta'], gates: { gate2: 'enforce' } },
  };
}

// -----------------------------------------------------------------------------
// Paso 4/5 — Lectura cruda + comparación
// -----------------------------------------------------------------------------

// Desenvuelve un ítem en formato AttributeValue de DynamoDB a JS plano.
function fromAttrValue(av) {
  if (av == null || typeof av !== 'object') return av;
  if ('S' in av) return av.S;
  if ('N' in av) return Number(av.N);
  if ('BOOL' in av) return av.BOOL;
  if ('NULL' in av) return null;
  if ('L' in av) return av.L.map(fromAttrValue);
  if ('M' in av) {
    const out = {};
    for (const [k, v] of Object.entries(av.M)) out[k] = fromAttrValue(v);
    return out;
  }
  return av;
}

function fromAttrItem(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(item)) out[k] = fromAttrValue(v);
  return out;
}

/**
 * Lectura CONSISTENTE cruda por AWS CLI. No pasa por el driver del store.
 */
function getItemConsistent(opts = {}) {
  const { tableName, region, pk, sk } = opts;
  const args = [
    'dynamodb', 'get-item',
    '--table-name', tableName,
    '--region', region,
    '--key', JSON.stringify({ PK: { S: pk }, SK: { S: sk } }),
    '--consistent-read',
    '--output', 'json',
  ];
  // `--profile` es OBLIGATORIO cuando el operador lo declara: sin él la CLI cae
  // a `AWS_PROFILE` del entorno y la lectura "de verificación" termina hecha con
  // una identidad distinta de la del runtime — que es exactamente el riesgo
  // "probar con un principal administrativo" que la historia manda evitar.
  if (opts.profile) args.push('--profile', opts.profile);
  const res = runAwsCli(args, opts);
  if (!res.ok) return res;
  let parsed;
  try {
    parsed = res.stdout && res.stdout.trim() ? JSON.parse(res.stdout) : {};
  } catch (e) {
    return { ok: false, code: 'getitem_ilegible', error: `getitem_ilegible: ${redactAll(e.message)}` };
  }
  return { ok: true, item: fromAttrItem(parsed.Item), raw: parsed };
}

/**
 * Compara una entidad leída por la API contra la leída con `--consistent-read`.
 * Fail-closed: un ítem ausente del lado crudo es rojo, y un ítem VACÍO también
 * (dos vacíos no son paridad — es el falso verde que la historia anticipa).
 *
 * @returns {{ ok:boolean, entity:string, checks:Array<{campo,api,dynamo,ok}> }}
 */
function compareEntity({ entity, expectedPK, expectedSK, apiBody, dynamoItem }) {
  const checks = [];
  const push = (campo, api, dynamo) => {
    checks.push({ campo, api, dynamo, ok: api === dynamo });
  };

  if (!dynamoItem) {
    return {
      ok: false,
      entity,
      checks: [{ campo: 'presencia', api: 'presente', dynamo: 'AUSENTE', ok: false }],
      reason: 'la lectura consistente no encontró el ítem: la API afirma haber escrito algo que DynamoDB no tiene.',
    };
  }
  push('PK', expectedPK, dynamoItem.PK);
  push('SK', expectedSK, dynamoItem.SK);

  const apiCanon = apiBody == null ? null : canonicalize(apiBody);
  const dynCanon = dynamoItem.body == null ? null : canonicalize(dynamoItem.body);

  // La entidad tiene que ser NO VACÍA de los dos lados. Éste es el corte que
  // impide declarar paridad comparando dos ausencias.
  const apiVacio = apiCanon == null || apiCanon === '{}' || apiCanon === 'null';
  const dynVacio = dynCanon == null || dynCanon === '{}' || dynCanon === 'null';
  checks.push({ campo: 'no-vacío', api: apiVacio ? 'VACÍO' : 'no vacío', dynamo: dynVacio ? 'VACÍO' : 'no vacío', ok: !apiVacio && !dynVacio });

  // Versión: `catalog#index` la lleva en `body.version` (CAS optimista del
  // store). Las entidades que no la tienen reportan `schemaVersion`, que sí es
  // universal en el envelope. Nunca se omite el campo: un "no aplica" mudo es
  // indistinguible de un campo que no se miró.
  const apiVer = apiBody && apiBody.version != null ? String(apiBody.version) : null;
  const dynVer = dynamoItem.body && dynamoItem.body.version != null ? String(dynamoItem.body.version) : null;
  if (apiVer != null || dynVer != null) {
    push('body.version', apiVer, dynVer);
  } else {
    push('schemaVersion', '1.0', dynamoItem.schemaVersion == null ? null : String(dynamoItem.schemaVersion));
  }

  push('contenido (sha256 canónico)', apiCanon == null ? null : sha256Canonical(apiBody), dynCanon == null ? null : sha256Canonical(dynamoItem.body));

  return { ok: checks.every((c) => c.ok), entity, checks };
}

// -----------------------------------------------------------------------------
// Reporte del operador (UX-5208: estados textuales inequívocos, sin color)
// -----------------------------------------------------------------------------

function renderProbeReport(result) {
  const lines = [];
  lines.push('===== SONDA DE CUTOVER DURABLE =====');
  lines.push('');
  for (const step of result.steps) {
    const marca = step.ok ? '[OK]' : '[FALLA]';
    lines.push(`${marca} ${step.etapa} — ${step.detalle}`);
    for (const sub of step.checks || []) {
      const m = sub.ok ? '  [OK]  ' : '  [FALLA]';
      lines.push(`${m} ${String(sub.campo).padEnd(28)} | api: ${String(sub.api)} | dynamo: ${String(sub.dynamo)}`);
    }
  }
  lines.push('');
  lines.push('--- RESULTADO ---');
  if (result.ok) {
    lines.push('[OK] sonda POSITIVA verde: la entidad controlada NO VACÍA coincide entre la API del kernel y la');
    lines.push('     lectura consistente de DynamoDB (PK, SK, versión y contenido), y la sonda negativa');
    lines.push('     cross-tenant fue rechazada como corresponde. Cero eventos onDegraded.');
  } else {
    lines.push(`[FALLA] la sonda ABORTÓ en la etapa "${result.failedStage || '?'}".`);
    lines.push(`        Causa: ${result.error || 'sin detalle'}`);
    lines.push('        Qué hacer ahora: NO cierres la ventana de cutover y NO declares el cutover exitoso.');
    lines.push('        Volvé atrás siguiendo docs/pipeline/runbook-cutover-durable.md §1.');
  }
  return redactAll(lines.join('\n'));
}

// -----------------------------------------------------------------------------
// API principal
// -----------------------------------------------------------------------------

/**
 * Ejecuta la sonda completa. Nunca lanza: errores como dato.
 *
 * @param {object} opts
 * @param {string}  opts.contextProjectId  tenant NO reservado, fuera de banda.
 * @param {object}  opts.kernelConfig      { tableName, region, runtimePrincipal }
 * @param {string}  [opts.profile]         perfil AWS del runtime (identidad efectiva).
 * @param {object}  [opts.deps]            inyección para tests (spawnSync, register, createStore…).
 */
async function runCutoverProbe(opts = {}) {
  const steps = [];
  const deps = opts.deps || {};
  const fail = (etapa, code, error) => {
    steps.push({ etapa, ok: false, detalle: redactAll(error) });
    return { ok: false, code, error: redactAll(error), failedStage: etapa, steps, report: renderProbeReport({ ok: false, steps, failedStage: etapa, error }) };
  };

  const contextProjectId = opts.contextProjectId;
  const kernelCfg = opts.kernelConfig || {};

  // ── Guardas de contexto (A01) ──────────────────────────────────────────────
  if (!isSafeId(contextProjectId)) {
    return fail('contexto', 'contexto_invalido',
      `contexto_invalido: "${String(contextProjectId)}" no es un projectId seguro. `
      + 'Qué hacer ahora: pasá un id de la forma [a-z0-9][a-z0-9-]{1,63}. El contexto se declara fuera de banda, '
      + 'nunca se deriva del descriptor ni de un dato migrado.');
  }
  if (isReservedProjectId(contextProjectId)) {
    return fail('contexto', 'contexto_reservado',
      `contexto_reservado: "${contextProjectId}" es un id RESERVADO. `
      + 'Qué hacer ahora: usá un tenant controlado NO reservado. La trampa: `intrale-platform` es el id del '
      + 'descriptor del repo y el default del migrador, pero el control-plane no se da de alta como producto — '
      + 'el alta corta antes de escribir.');
  }
  if (!kernelCfg.tableName || !kernelCfg.region) {
    return fail('config', 'config_incompleta',
      'config_incompleta: faltan `kernel.tableName` y/o `kernel.region`. '
      + 'Qué hacer ahora: completalos en .pipeline/config.yaml antes de abrir la ventana.');
  }

  // ── Paso 1 · identidad efectiva ────────────────────────────────────────────
  const ident = deps.verifyRuntimeIdentity
    ? deps.verifyRuntimeIdentity({ expectedPrincipal: kernelCfg.runtimePrincipal, profile: opts.profile })
    : verifyRuntimeIdentity({ expectedPrincipal: kernelCfg.runtimePrincipal, profile: opts.profile, env: deps.env, spawnSync: deps.spawnSync });
  if (!ident.ok) return fail('identidad', ident.code, ident.error);
  steps.push({ etapa: 'identidad', ok: true, detalle: `principal runtime efectivo verificado contra config: ${ident.principal}` });

  // ── Paso 2 · alta durable (único poblador) ─────────────────────────────────
  const degradations = [];
  const descriptor = buildProbeDescriptor(contextProjectId, { name: opts.productName });
  const register = deps.durableRegisterProduct || require('./project-bootstrap').durableRegisterProduct;
  let alta;
  try {
    alta = await register(
      { projectId: contextProjectId, name: descriptor.identity.name },
      descriptor,
      {
        contextProjectId,
        kernelConfig: { durable: true, tableName: kernelCfg.tableName, region: kernelCfg.region },
        createStore: deps.createStore,
        storeDriver: deps.storeDriver,
        onAlert: (a) => { degradations.push(a); },
      },
    );
  } catch (e) {
    // Texto exacto de `project-bootstrap.js:427`. Se matchea por la frase estable
    // "no sobreescribe su descriptor" (y no por el código de error) porque
    // `KernelStoreContextError` no está exportado por ese módulo.
    const yaExiste = /no sobreescribe su descriptor|ya est[áa] registrado/i.test(String(e && e.message));
    if (!yaExiste) {
      return fail('alta', 'alta_fallida',
        `alta_fallida: ${e && e.message}. Qué hacer ahora: revisá los permisos del principal runtime sobre `
        + '`kernel.tableName`. Si el error menciona KMS, falta `kms:Decrypt`/`kms:GenerateDataKey` sobre la CMK '
        + 'que cifra la tabla — y ese permiso se comprueba con la identidad runtime, no con un admin.');
    }
    // Re-ejecución sobre un tenant ya dado de alta. Se DECLARA en el reporte: la
    // evidencia sigue siendo válida (el ítem existe y es no vacío) pero no fue
    // escrita por esta corrida, y el operador tiene que poder distinguirlo.
    alta = { status: 'preexistente', catalogProjectId: CONTROL_PLANE_PROJECT_ID, preexistente: true };
  }
  steps.push({
    etapa: 'alta',
    ok: true,
    detalle: alta.preexistente
      ? 'el tenant YA estaba dado de alta: el alta no se repitió (no sobreescribe, a propósito). '
        + 'La evidencia de abajo verifica el estado persistido, no una escritura de esta corrida.'
      : `producto dado de alta (status ${alta.status}) · descriptor en la partición del tenant · `
        + `product#/catalog# en la del control-plane (${alta.catalogProjectId})`,
  });

  // ── Paso 3/4/5 · API vs lectura consistente ────────────────────────────────
  const getItem = deps.getItemConsistent || getItemConsistent;
  const readOpts = { tableName: kernelCfg.tableName, region: kernelCfg.region, profile: opts.profile, env: deps.env, spawnSync: deps.spawnSync };

  const factory = deps.createStore || require('./kernel-store').createKernelStore;
  const storeConfig = { kernel: { tableName: kernelCfg.tableName, region: kernelCfg.region } };
  const mkStore = (ctx, ns) => factory({
    contextProjectId: ctx,
    allowedNamespaces: ns,
    config: storeConfig,
    driver: deps.storeDriver,
    onAlert: (a) => { degradations.push(a); },
  });

  let apiDescriptor;
  let apiProducts;
  try {
    apiDescriptor = await mkStore(contextProjectId).getDescriptor(contextProjectId);
    apiProducts = await mkStore(CONTROL_PLANE_PROJECT_ID, [CONTROL_PLANE_PROJECT_ID]).listProducts();
  } catch (e) {
    return fail('lectura-api', 'lectura_api_fallida', `lectura_api_fallida: ${e && e.message}`);
  }

  const comparaciones = [];

  // descriptor#self — partición del TENANT.
  const dynDescriptor = getItem({ ...readOpts, pk: contextProjectId, sk: SK_DESCRIPTOR });
  if (!dynDescriptor.ok) return fail('lectura-consistente', dynDescriptor.code, dynDescriptor.error);
  comparaciones.push(compareEntity({
    entity: 'descriptor#self (partición del tenant)',
    expectedPK: contextProjectId,
    expectedSK: SK_DESCRIPTOR,
    apiBody: apiDescriptor && apiDescriptor.body ? apiDescriptor.body : apiDescriptor,
    dynamoItem: dynDescriptor.item,
  }));

  // product#<id> — partición del CONTROL-PLANE.
  const dynProduct = getItem({ ...readOpts, pk: CONTROL_PLANE_PROJECT_ID, sk: skProduct(contextProjectId) });
  if (!dynProduct.ok) return fail('lectura-consistente', dynProduct.code, dynProduct.error);
  const apiProduct = (apiProducts || []).find((p) => p && (p.productId === contextProjectId || p.projectId === contextProjectId)) || null;
  comparaciones.push(compareEntity({
    entity: `product#${contextProjectId} (partición del control-plane)`,
    expectedPK: CONTROL_PLANE_PROJECT_ID,
    expectedSK: skProduct(contextProjectId),
    apiBody: apiProduct,
    dynamoItem: dynProduct.item,
  }));

  // catalog#index — partición del CONTROL-PLANE, con `body.version` (CAS).
  const dynCatalog = getItem({ ...readOpts, pk: CONTROL_PLANE_PROJECT_ID, sk: SK_CATALOG });
  if (!dynCatalog.ok) return fail('lectura-consistente', dynCatalog.code, dynCatalog.error);
  // `catalog#index` no se compara con `compareEntity`: la API no devuelve el
  // índice crudo sino los productos ya resueltos (`listProducts`), así que la
  // comparación honesta es "el alta aparece de los DOS lados" más las claves y
  // la versión CAS. El campo del índice es `body.productIds` (kernel-store.js).
  const catalogPresente = !!(dynCatalog.item && dynCatalog.item.body);
  const idsEnDynamo = catalogPresente && Array.isArray(dynCatalog.item.body.productIds)
    ? dynCatalog.item.body.productIds
    : [];
  const catalogTieneAlta = idsEnDynamo.includes(contextProjectId);
  const apiTieneAlta = !!apiProduct;
  const versionCatalogo = catalogPresente ? dynCatalog.item.body.version : null;
  comparaciones.push({
    ok: catalogPresente && catalogTieneAlta && apiTieneAlta && Number(versionCatalogo) >= 1 && idsEnDynamo.length > 0,
    entity: 'catalog#index (partición del control-plane)',
    checks: [
      { campo: 'PK', api: CONTROL_PLANE_PROJECT_ID, dynamo: catalogPresente ? dynCatalog.item.PK : 'AUSENTE', ok: catalogPresente && dynCatalog.item.PK === CONTROL_PLANE_PROJECT_ID },
      { campo: 'SK', api: SK_CATALOG, dynamo: catalogPresente ? dynCatalog.item.SK : 'AUSENTE', ok: catalogPresente && dynCatalog.item.SK === SK_CATALOG },
      { campo: 'body.version (CAS)', api: '≥1', dynamo: catalogPresente ? String(versionCatalogo) : 'AUSENTE', ok: Number(versionCatalogo) >= 1 },
      { campo: 'no-vacío (productIds)', api: apiTieneAlta ? `${(apiProducts || []).length} producto(s)` : 'VACÍO', dynamo: idsEnDynamo.length > 0 ? `${idsEnDynamo.length} id(s)` : 'VACÍO', ok: apiTieneAlta && idsEnDynamo.length > 0 },
      { campo: 'indexa el alta', api: apiTieneAlta ? contextProjectId : 'NO LISTADO', dynamo: catalogTieneAlta ? contextProjectId : 'NO INDEXADO', ok: catalogTieneAlta && apiTieneAlta },
    ],
  });

  for (const c of comparaciones) {
    steps.push({ etapa: `comparación · ${c.entity}`, ok: c.ok, detalle: c.ok ? 'api y lectura consistente coinciden' : (c.reason || 'discrepancia'), checks: c.checks });
  }
  const comparacionRoja = comparaciones.find((c) => !c.ok);
  if (comparacionRoja) {
    return {
      ok: false, code: 'discrepancia', failedStage: `comparación · ${comparacionRoja.entity}`,
      error: `la entidad ${comparacionRoja.entity} no coincide entre la API y la lectura consistente`,
      steps, comparaciones, degradations,
      report: renderProbeReport({ ok: false, steps, failedStage: `comparación · ${comparacionRoja.entity}`, error: 'discrepancia entre API y lectura consistente' }),
    };
  }

  // ── Paso 6 · negativa cross-tenant (A01) ───────────────────────────────────
  // El contexto ajeno NO puede leer la partición de la sonda. Se informa el
  // resultado SIN revelar el identificador del tenant sondeado desde el ajeno.
  let aislamientoOk = false;
  let aislamientoDetalle = '';
  try {
    await mkStore(CROSS_TENANT_PROBE_ID).getDescriptor(contextProjectId);
    aislamientoDetalle = 'un contexto ajeno LEYÓ la partición del tenant sondeado: el aislamiento NO se cumple.';
  } catch (e) {
    // El rechazo es el resultado esperado. Se reporta la CLASE del error, no el
    // mensaje crudo, para no filtrar identificadores del otro lado.
    aislamientoOk = e && (e.name === 'KernelStoreIsolationError' || /isolation/i.test(String(e.name)) || /aislamiento|isolation/i.test(String(e.message)));
    aislamientoDetalle = aislamientoOk
      ? 'un contexto ajeno fue RECHAZADO al intentar leer la partición del tenant sondeado (aislamiento efectivo).'
      : `el rechazo llegó por una causa distinta al aislamiento (${e && e.name}): no prueba el control.`;
  }
  // Defensa en profundidad: la partición del tenant ajeno tiene que estar VACÍA
  // en la lectura cruda. Sin esto, un rechazo de la API podría convivir con un
  // ítem realmente escrito del otro lado.
  const dynCross = getItem({ ...readOpts, pk: CROSS_TENANT_PROBE_ID, sk: SK_DESCRIPTOR });
  if (!dynCross.ok) return fail('negativa-cross-tenant', dynCross.code, dynCross.error);
  const crossVacio = !dynCross.item;
  steps.push({
    etapa: 'negativa cross-tenant',
    ok: aislamientoOk && crossVacio,
    detalle: `${aislamientoDetalle} Partición del contexto ajeno en la lectura consistente: ${crossVacio ? 'vacía' : 'CONTIENE datos'}.`,
  });
  if (!aislamientoOk || !crossVacio) {
    return {
      ok: false, code: 'aislamiento_no_verificado', failedStage: 'negativa cross-tenant',
      error: aislamientoDetalle, steps, comparaciones, degradations,
      report: renderProbeReport({ ok: false, steps, failedStage: 'negativa cross-tenant', error: aislamientoDetalle }),
    };
  }

  // ── Fail-loud: cualquier degradación observada invalida el verde ────────────
  if (degradations.length > 0) {
    const causas = degradations.map((d) => (d && d.stage) || 'desconocido').join(', ');
    steps.push({ etapa: 'degradación', ok: false, detalle: `se observaron ${degradations.length} evento(s) de degradación (${causas}).` });
    return {
      ok: false, code: 'degradacion_observada', failedStage: 'degradación',
      error: `se observaron ${degradations.length} evento(s) de degradación durante la sonda (${causas}). `
        + 'Qué hacer ahora: NO cierres la ventana. Una degradación durante el cutover significa que el store real '
        + 'puede seguir siendo filesystem mientras el reporte dice DynamoDB.',
      steps, comparaciones, degradations,
      report: renderProbeReport({ ok: false, steps, failedStage: 'degradación', error: 'degradación observada durante la sonda' }),
    };
  }
  steps.push({ etapa: 'degradación', ok: true, detalle: 'cero eventos onDegraded durante toda la sonda.' });

  return { ok: true, steps, comparaciones, degradations, contextProjectId, report: renderProbeReport({ ok: true, steps }) };
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { projectId: null, profile: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project-id') { args.projectId = argv[i + 1]; i += 1; }
    else if (argv[i] === '--profile') { args.profile = argv[i + 1]; i += 1; }
  }
  return args;
}

// Cablea el driver DynamoDB REAL con el MISMO camino que usa el pulpo en su boot
// durable (`buildDurableStore`): env AWS acotado por `buildAwsScopedEnv` → runner
// de la CLI → driver. Si la sonda armara el driver de otra forma, estaría
// probando un cableado que producción no usa.
//
// Las credenciales salen del perfil AWS del RUNTIME (nunca de un admin). Se leen
// con `aws configure get`, viven sólo en el env del proceso hijo y no entran
// jamás al reporte.
function buildRuntimeDriver(kernelCfg, profile, deps = {}) {
  const runtimeCreds = require('./kernel-runtime-credentials');
  // El `--profile` de la línea de comandos pisa al declarado en config: la sonda
  // tiene que poder correrse contra un perfil puntual sin editar `config.yaml`.
  const kernel = profile ? { ...kernelCfg, runtimeProfile: profile } : kernelCfg;
  const resolved = runtimeCreds.resolveRuntimeAwsEnv({ kernel, deps, env: deps.env });
  if (!resolved.ok) return { ok: false, code: resolved.code, error: resolved.error };

  const { createAwsCliRunner, createAwsCliDynamoDriver } = require('./provisioner-infra');
  const { run } = createAwsCliRunner(resolved.env);
  return { ok: true, driver: createAwsCliDynamoDriver({ run }), source: runtimeCreds.describe(resolved) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let kernelCfg = {};
  try {
    // Punto ÚNICO de lectura de config (#5174): `lib/config-resolver`. Un
    // `yaml.load` propio acá leería un config sin resolver —sin merge de
    // producto, sin overrides de entorno, sin las prohibiciones de claves— y la
    // sonda validaría contra una configuración que el pipeline no usa.
    const cfg = require('./config-resolver').resolve({ pipelineDir: path.join(__dirname, '..') });
    kernelCfg = (cfg && cfg.kernel) || {};
  } catch (e) {
    process.stdout.write(`[FALLA] no se pudo leer .pipeline/config.yaml: ${redactAll(e.message)}` + '\n');
    process.exitCode = 1;
    return;
  }
  const drv = buildRuntimeDriver(kernelCfg, args.profile);
  if (!drv.ok) {
    process.stdout.write(`[FALLA] ${drv.error}` + '\n');
    process.exitCode = 1;
    return;
  }
  const res = await runCutoverProbe({
    contextProjectId: args.projectId,
    profile: args.profile,
    kernelConfig: kernelCfg,
    deps: { storeDriver: drv.driver },
  });
  process.stdout.write((res.report || res.error || '') + '\n');
  process.exitCode = res.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((e) => {
    process.stdout.write(`[FALLA] error inesperado: ${redactAll(e && e.message)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  runCutoverProbe,
  buildRuntimeDriver,
  verifyRuntimeIdentity,
  buildProbeDescriptor,
  compareEntity,
  getItemConsistent,
  fromAttrItem,
  fromAttrValue,
  redactAccountIds,
  renderProbeReport,
  parseArgs,
  SK_DESCRIPTOR,
  SK_CATALOG,
  skProduct,
  CROSS_TENANT_PROBE_ID,
};
