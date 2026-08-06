#!/usr/bin/env node
'use strict';

// =============================================================================
// kernel-audit-negative-tests.js — #5213 CA-5
//
// Matriz de pruebas NEGATIVAS: ejecuta con las credenciales REALES del principal
// runtime cada operación capaz de destruir el rastro de auditoría, y exige que
// AWS la deniegue. Inspeccionar las policies no alcanza — una policy puede leerse
// correcta y estar anulada por un allow heredado, un boundary ausente o una
// SCP mal ordenada. La única prueba es intentarlo y que falle.
//
// TRES DECISIONES DE SEGURIDAD QUE NO SON NEGOCIABLES:
//
// 1. **Guarda de identidad.** El runner se niega a correr si el llamador no es
//    el principal runtime. Corrido con una sesión administrativa, `delete-trail`
//    y `stop-logging` NO serían denegados: destruirían el trail de verdad. La
//    guarda es lo que hace seguro ejecutar esto contra producción.
//
// 2. **Operaciones no destructivas por construcción.** Donde el resultado de un
//    permiso inesperado sería irreversible, los parámetros son un no-op:
//    `update-trail` reenvía la configuración vigente, `put-event-selectors`
//    reenvía el selector vigente, `delete-object` apunta a una clave inexistente
//    con nonce. Si el permiso existiera, la llamada tendría éxito (que es el
//    hallazgo que buscamos) sin romper nada. `stop-logging` y `delete-trail` no
//    admiten esa forma, así que el runner los verifica DESPUÉS: relee el estado
//    del trail y grita si dejó de loguear.
//
// 3. **Falla cerrada.** Denegado = aprobado. Éxito = CRÍTICO. Cualquier otro
//    error = inconclusivo, y un inconclusivo NO aprueba. Un error de red no
//    puede leerse como "está protegido".
// =============================================================================

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { redactResourceName, redactFreeText } = require('./kernel-audit-evidence');

// AWS no unifica el código: S3 devuelve `AccessDenied`, CloudTrail y KMS
// devuelven `AccessDeniedException`, y un deny explícito de IAM agrega
// "with an explicit deny". Los tres son la denegación que la CA pide.
const DENIAL_PATTERNS = Object.freeze([
    /AccessDenied/i, /not authorized to perform/i, /explicit deny/i,
    /UnauthorizedOperation/i, /InsufficientPrivileges/i,
]);

function esDenegacion(texto) {
    return DENIAL_PATTERNS.some((re) => re.test(String(texto || '')));
}

/** Ejecuta el CLI sin tirar: la matriz necesita inspeccionar el fallo. */
function runAwsRaw(args, options = {}) {
    const result = spawnSync('aws', [...args, '--output', 'json'], {
        encoding: 'utf8', env: options.env || process.env, shell: false,
    });
    return {
        status: result.status,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || ''),
    };
}

/**
 * Cada entrada declara UNA capacidad destructiva.
 *
 * - `build` arma los argumentos del CLI; `resource` es el recurso ya anonimizado
 *   que se reporta en la evidencia.
 * - `destructive` marca las que SÍ causarían daño real si el permiso existiera.
 *   Las no destructivas son no-ops o apuntan a recursos inexistentes: si el
 *   permiso existiera, tendrían éxito (que es el hallazgo) sin romper nada.
 *
 * El ORDEN dentro de cada servicio es de menor a mayor daño, y no es cosmético:
 * el runner corta la escalada del servicio ante el primer resultado no denegado.
 */
const NEGATIVE_MATRIX = Object.freeze([
    {
        id: 'trail-update', service: 'cloudtrail', destructive: false,
        capability: 'modificar la configuración del trail',
        resource: (plan) => `cloudtrail/${plan.trailName}`,
        // No-op deliberado: reenvía la configuración vigente.
        build: (plan) => ['cloudtrail', 'update-trail', '--name', plan.trailName,
            '--region', plan.region, '--enable-log-file-validation'],
    },
    {
        id: 'trail-event-selectors', service: 'cloudtrail', destructive: false,
        capability: 'alterar los event selectors',
        resource: (plan) => `cloudtrail/${plan.trailName}`,
        // No-op: reenvía el selector vigente.
        build: (plan) => ['cloudtrail', 'put-event-selectors', '--trail-name', plan.trailName,
            '--region', plan.region, '--event-selectors', JSON.stringify(plan.selector)],
    },
    {
        id: 'trail-stop-logging', service: 'cloudtrail', destructive: true,
        capability: 'detener el trail',
        resource: (plan) => `cloudtrail/${plan.trailName}`,
        build: (plan) => ['cloudtrail', 'stop-logging', '--name', plan.trailName, '--region', plan.region],
    },
    {
        id: 'trail-delete', service: 'cloudtrail', destructive: true,
        capability: 'borrar el trail',
        resource: (plan) => `cloudtrail/${plan.trailName}`,
        build: (plan) => ['cloudtrail', 'delete-trail', '--name', plan.trailName, '--region', plan.region],
    },
    {
        id: 'bucket-read-audit', service: 's3', destructive: false,
        capability: 'leer la auditoría que él mismo genera',
        resource: (plan) => `s3/${redactResourceName(plan.bucket)}`,
        build: (plan) => ['s3api', 'list-objects-v2', '--bucket', plan.bucket,
            '--region', plan.region, '--max-items', '1'],
    },
    {
        id: 'bucket-delete-object', service: 's3', destructive: false,
        capability: 'borrar objetos del destino',
        resource: (plan) => `s3/${redactResourceName(plan.bucket)}`,
        // Clave inexistente con nonce: S3 borra de forma idempotente, así que
        // apuntar a un objeto real destruiría evidencia si el permiso existiera.
        build: (plan, ctx) => ['s3api', 'delete-object', '--bucket', plan.bucket,
            '--region', plan.region,
            '--key', `AWSLogs/${plan.accountId}/negative-test-${ctx.nonce}.json.gz`],
    },
    {
        id: 'bucket-lifecycle-retention', service: 's3', destructive: true,
        capability: 'reducir la retención del destino',
        resource: (plan) => `s3/${redactResourceName(plan.bucket)}`,
        build: (plan) => ['s3api', 'put-bucket-lifecycle-configuration', '--bucket', plan.bucket,
            '--region', plan.region, '--lifecycle-configuration', JSON.stringify({ Rules: [{
                ID: 'NegativeTestShortenRetention', Status: 'Enabled', Filter: { Prefix: '' },
                Expiration: { Days: 1 },
            }] })],
    },
    {
        id: 'bucket-policy-rewrite', service: 's3', destructive: true,
        capability: 'reescribir la policy del destino',
        resource: (plan) => `s3/${redactResourceName(plan.bucket)}`,
        build: (plan) => ['s3api', 'delete-bucket-policy', '--bucket', plan.bucket, '--region', plan.region],
    },
    // `DisableKey` y `ScheduleKeyDeletion` NO aceptan alias: exigen key id. Con
    // el alias devuelven `InvalidArnException`, que NO es una denegación — la
    // prueba quedaría inconclusiva y aprobaría por accidente si el veredicto
    // fuera laxo. El key id lo resuelve la identidad AUDITORA (el runtime no
    // tiene ni `kms:DescribeKey`) y se pasa por `--key-id`.
    {
        id: 'kms-disable-key', service: 'kms', destructive: true,
        capability: 'deshabilitar la clave',
        resource: () => 'kms/clave-del-store',
        requiresKeyId: true,
        build: (plan) => ['kms', 'disable-key', '--key-id', plan.keyId, '--region', plan.region],
    },
    {
        id: 'kms-schedule-deletion', service: 'kms', destructive: true,
        capability: 'programar el borrado de la clave',
        resource: () => 'kms/clave-del-store',
        requiresKeyId: true,
        build: (plan) => ['kms', 'schedule-key-deletion', '--key-id', plan.keyId,
            '--region', plan.region, '--pending-window-in-days', '30'],
    },
]);

/**
 * Guarda de identidad. Sin esto, correr la matriz con una sesión administrativa
 * BORRA el trail en vez de probar que está protegido.
 */
function assertRuntimeIdentity(expectedUserName, aws = runAwsRaw) {
    const result = aws(['sts', 'get-caller-identity']);
    if (result.status !== 0) {
        throw new Error('no se pudo resolver la identidad del llamador; la matriz no corre a ciegas');
    }
    const arn = String((JSON.parse(result.stdout || '{}')).Arn || '');
    if (!arn.endsWith(`/${expectedUserName}`)) {
        throw new Error(`la matriz negativa exige la identidad ${expectedUserName};`
            + ' correrla con otra credencial destruiría el trail en vez de verificarlo');
    }
    return true;
}

/** Clasifica el resultado de UNA operación. Denegado es el único aprobado. */
function clasificar(result) {
    if (result.status === 0) {
        return { outcome: 'NO-DENEGADO', denied: false,
            detalle: 'la operación fue permitida: el runtime puede degradar la auditoría' };
    }
    if (esDenegacion(result.stderr)) {
        return { outcome: 'AccessDenied', denied: true, detalle: null };
    }
    return { outcome: 'inconclusivo', denied: false,
        detalle: redactFreeText(String(result.stderr || '').trim().split('\n').pop() || '') };
}

/**
 * Corre la matriz completa. Devuelve evidencia ya anonimizada más un veredicto
 * agregado. `postCheck` relee el estado del trail después de las operaciones
 * irreversibles para detectar el caso peor: que alguna haya prendido.
 */
function runNegativeMatrix(plan, { nonce, aws = runAwsRaw, skipIdentityGuard = false } = {}) {
    if (!skipIdentityGuard) assertRuntimeIdentity(plan.runtimeUserName, aws);
    const ctx = { nonce: nonce || crypto.randomUUID() };
    // Corta-escalada: en cuanto una operación de un servicio NO resulta denegada,
    // las DESTRUCTIVAS que quedan de ese servicio no se ejecutan. Ese resultado
    // ya prueba que la barrera no está; seguir escalando sólo agrega la chance
    // de detener el trail o deshabilitar la clave de verdad.
    const comprometidos = new Set();
    const results = NEGATIVE_MATRIX.map((entry) => {
        const base = { id: entry.id, capability: entry.capability,
            resource: entry.resource(plan), destructive: entry.destructive };
        if (entry.destructive && comprometidos.has(entry.service)) {
            return { ...base, outcome: 'no-ejecutado', denied: false,
                detalle: `omitida: otra operación de ${entry.service} no fue denegada` };
        }
        // Sin key id, la llamada devolvería `InvalidArnException` en vez de una
        // denegación: es una prueba NO REALIZADA, y decirlo así evita que un
        // error de forma se lea como postura verificada.
        if (entry.requiresKeyId && !plan.keyId) {
            return { ...base, outcome: 'inconclusivo', denied: false,
                detalle: 'falta el key id (lo resuelve la identidad auditora con --key-id)' };
        }
        const clasificado = clasificar(aws(entry.build(plan, ctx)));
        if (!clasificado.denied) comprometidos.add(entry.service);
        return { ...base, ...clasificado };
    });
    return {
        results,
        // Falla cerrada: sólo aprueba si TODAS fueron denegadas. Un inconclusivo
        // o una omitida arrastran el veredicto a rechazado a propósito.
        allDenied: results.every((r) => r.denied),
        notDenied: results.filter((r) => !r.denied).map((r) => r.id),
    };
}

/**
 * Post-check con la identidad auditora: confirma que el trail sigue activo
 * después de haberle tirado `stop-logging` y `delete-trail` encima.
 */
function verificarTrailIntacto(plan, aws = runAwsRaw) {
    const result = aws(['cloudtrail', 'get-trail-status', '--name', plan.trailName, '--region', plan.region]);
    if (result.status !== 0) {
        return { legible: false, logging: null,
            detalle: redactFreeText(String(result.stderr || '').trim().split('\n').pop() || '') };
    }
    return { legible: true, logging: JSON.parse(result.stdout || '{}').IsLogging === true, detalle: null };
}

module.exports = {
    NEGATIVE_MATRIX, DENIAL_PATTERNS, esDenegacion, runAwsRaw,
    assertRuntimeIdentity, clasificar, runNegativeMatrix, verificarTrailIntacto,
};

if (require.main === module) {
    const {
        DEFAULTS, buildPlan,
    } = require('./kernel-cloudtrail-provision');
    const { buildEvidence } = require('./kernel-audit-evidence');
    const ejecutar = process.argv.includes('--run');
    const keyIdIndex = process.argv.indexOf('--key-id');
    try {
        const identity = runAwsRaw(['sts', 'get-caller-identity']);
        if (identity.status !== 0) throw new Error('sin identidad AWS resoluble');
        const plan = {
            ...buildPlan({ accountId: JSON.parse(identity.stdout).Account }),
            keyAlias: DEFAULTS.keyAlias, runtimeUserName: DEFAULTS.runtimeUserName,
            keyId: keyIdIndex !== -1 ? process.argv[keyIdIndex + 1] : undefined,
        };
        if (!ejecutar) {
            process.stdout.write(`${JSON.stringify({ mode: 'dry-run',
                matriz: NEGATIVE_MATRIX.map((e) => ({ id: e.id, capability: e.capability,
                    resource: e.resource(plan) })) }, null, 2)}\n`);
        } else {
            const matriz = runNegativeMatrix(plan, {});
            const trail = verificarTrailIntacto(plan);
            const evidence = buildEvidence({ plan, keyAlias: DEFAULTS.keyAlias,
                generatedAt: new Date().toISOString(),
                negativeTests: { ...matriz, trailIntactoSegunRuntime: trail } });
            process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
            if (!matriz.allDenied) process.exitCode = 1;
        }
    } catch (error) {
        process.stderr.write(`kernel-audit-negative-tests: ${redactSecretValue(error.message)}\n`);
        process.exitCode = 1;
    }
}
