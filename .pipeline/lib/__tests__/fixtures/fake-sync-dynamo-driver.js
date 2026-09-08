'use strict';

// =============================================================================
// fake-sync-dynamo-driver.js — driver DynamoDB SÍNCRONO en memoria (#5113)
// =============================================================================
//
// Emula la superficie que consume `operational-state-backend.js` (get/put/delete)
// evaluando de verdad las dos condiciones que usa el CAS:
//
//   - `attribute_not_exists(#pk)`  → create-once (un solo ganador)
//   - `#b.#v = :ev`                → compare-and-set por versión
//
// Evaluarlas de verdad (y no aceptar todo write) es lo que hace que el test de
// lost update pruebe algo: con un fake permisivo, el segundo escritor con
// versión stale pasaría y el test daría un falso verde justo sobre el
// invariante que #5113 tiene que garantizar.
//
// El `failWith` permite simular degradación del store (CA-A7) sin red.

function createFakeSyncDynamoDriver(opts = {}) {
    const items = new Map();     // `${PK}|${SK}` -> item
    const calls = [];            // traza para asertar que NO se llamó a algo
    let failWith = opts.failWith || null;

    const keyOf = (k) => `${k.PK}|${k.SK}`;

    function evaluateCondition(condOpts, existing) {
        if (!condOpts || !condOpts.conditionExpression) return true;
        const expr = condOpts.conditionExpression;
        if (expr === 'attribute_not_exists(#pk)') return existing === undefined;
        if (expr === '#b.#v = :ev') {
            if (!existing) return false;
            const expected = condOpts.expressionAttributeValues[':ev'];
            return existing.body.version === expected;
        }
        throw new Error(`fake-sync-driver: condición no soportada: ${expr}`);
    }

    function maybeFail(op) {
        if (failWith) {
            const err = failWith instanceof Error ? failWith : new Error(String(failWith));
            calls.push({ op, failed: true });
            throw err;
        }
    }

    return {
        kind: 'fake-sync',
        _items: items,
        _calls: calls,
        _setFailure(err) { failWith = err; },
        _clearFailure() { failWith = null; },
        _raw(pk, sk) { return items.get(`${pk}|${sk}`); },
        _seed(item) { items.set(keyOf(item), JSON.parse(JSON.stringify(item))); },

        getItem(spec, key) {
            maybeFail('getItem');
            calls.push({ op: 'getItem', key });
            const found = items.get(keyOf(key));
            return { item: found ? JSON.parse(JSON.stringify(found)) : null };
        },

        putItem(spec, item, condOpts = {}) {
            maybeFail('putItem');
            calls.push({ op: 'putItem', version: item.body && item.body.version, condOpts });
            const k = keyOf(item);
            const existing = items.get(k);
            if (!evaluateCondition(condOpts, existing)) {
                const { ConditionalCheckFailedError } = require('../../provisioner-infra');
                throw new ConditionalCheckFailedError('ConditionalCheckFailedException (fake)');
            }
            items.set(k, JSON.parse(JSON.stringify(item)));
            return { ok: true };
        },

        deleteItem(spec, key, condOpts = {}) {
            maybeFail('deleteItem');
            calls.push({ op: 'deleteItem', key, condOpts });
            const k = keyOf(key);
            const existing = items.get(k);
            if (!evaluateCondition(condOpts, existing)) {
                const { ConditionalCheckFailedError } = require('../../provisioner-infra');
                throw new ConditionalCheckFailedError('ConditionalCheckFailedException (fake)');
            }
            items.delete(k);
            return { ok: true };
        },
    };
}

module.exports = { createFakeSyncDynamoDriver };
