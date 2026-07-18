// =============================================================================
// product-registry.js — Binding server-side `productId → operadores autorizados`
// Issue #4780 (Ola Puente P6, split de #4691 §4.7) — Telegram Commander
// product-aware.
//
// QUÉ RESUELVE (SR-1 / SR-6 · A01/A07)
// ------------------------------------
// El Commander pasa de "un chat autorizado global" a "N productos, cada uno con
// operadores autorizados". La autorización de acciones (sobre todo destructivas)
// debe keyear en la IDENTIDAD del operador (`from.id`), NO en `chat.id`: en un
// grupo cualquier miembro manda mensajes con el mismo `chat.id`. El mapeo
// `producto → identidades autorizadas` se resuelve SIEMPRE server-side (config),
// nunca leyendo el `productId` "de confianza" del texto del usuario.
//
// MODELO DE SEGURIDAD (los SR de `security`/`guru` son CA no negociables)
// ----------------------------------------------------------------------
// [SR-1/A07] Autz por `from.id`, contra el set de operadores del producto.
// [SR-5/A01] Fail-closed: producto inexistente y operador no autorizado son
//   INDISTINGUIBLES desde afuera (`isAuthorized` devuelve `false` en ambos, sin
//   revelar cuál de los dos). El caller nunca filtra existencia/estado de
//   productos ajenos.
// [SR-6/CA-5.1] Default sin `productId` resuelve a UN producto (`Intrale`) y
//   SIGUE validando authz — nunca un wildcard que conceda todos los productos.
// [A03/A04] El `productId` es un input NO confiable: se valida como slug
//   conservador (`PRODUCT_ID_RE`) y se usa sólo como clave de un Map en memoria,
//   jamás para construir un path en disco.
//
// Fuente del binding: `config.yaml → commander_products` (server-side). Mientras
// la BD gestionada del descriptor (§4.6 DynamoDB, Ola Puente P4+) sea futura,
// este split mantiene el mapeo en config. El operador actual (`CHAT_ID` /
// `telegram.leo_operator_chat_id`) mapea al producto default `Intrale`.
// =============================================================================
'use strict';

// Producto default retro-compatible. Sin `productId` explícito → este producto
// (SR-6 / CA-5.1). El Commander mono-producto histórico opera Intrale.
const DEFAULT_PRODUCT_ID = 'Intrale';

// Slug conservador para el `productId` (input no confiable — A03/A04). Se usa
// como clave de Map, nunca como componente de path. Alfanumérico + `._-`.
const PRODUCT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Valida un `productId` no confiable. Devuelve el string canónico o `null` si
 * no matchea el slug (fail-closed: un id inválido no resuelve ningún producto).
 *
 * @param {*} productId
 * @returns {string|null}
 */
function normalizeProductId(productId) {
    if (typeof productId !== 'string') return null;
    const s = productId.trim();
    return PRODUCT_ID_RE.test(s) ? s : null;
}

/**
 * Construye el registry desde una config server-side. Estructura esperada:
 *
 *   {
 *     default_product: 'Intrale',                 // opcional; default DEFAULT_PRODUCT_ID
 *     products: {
 *       Intrale:      { name: 'Intrale',      operators: ['123456789'] },
 *       'Comercios-AR': { name: 'Comercios-AR', operators: ['111', '222'] },
 *     }
 *   }
 *
 * Compat: si `products` está vacío/ausente pero se pasa `defaultOperators`
 * (p.ej. el `CHAT_ID`/operador único histórico), se sintetiza el producto
 * default `Intrale` con esos operadores — así el mono-producto sigue operando
 * idéntico sin tocar config (SR-6).
 *
 * @param {object} [opts]
 * @param {object} [opts.config]            binding server-side (ver arriba).
 * @param {string[]} [opts.defaultOperators] operadores del producto default si
 *                                           no hay `products` en config.
 * @returns {object} registry con { isAuthorized, resolveProduct, productName,
 *                                  listProductsFor, defaultProductId, hasProduct }
 */
function createProductRegistry(opts = {}) {
    const config = opts.config && typeof opts.config === 'object' ? opts.config : {};
    const defaultProductId = normalizeProductId(config.default_product) || DEFAULT_PRODUCT_ID;

    // Map<productId, { name, operators: Set<string> }>. Sólo memoria.
    const products = new Map();

    function addProduct(rawId, def) {
        const id = normalizeProductId(rawId);
        if (!id) return; // id inválido → se descarta (fail-closed, no rompe el resto)
        const name = typeof def?.name === 'string' && def.name.trim().length > 0
            ? def.name.trim()
            : id;
        const ops = Array.isArray(def?.operators)
            ? def.operators
                .filter((o) => o !== null && o !== undefined && String(o).trim().length > 0)
                .map((o) => String(o).trim())
            : [];
        products.set(id, { name, operators: new Set(ops) });
    }

    const declared = config.products && typeof config.products === 'object' ? config.products : {};
    for (const [id, def] of Object.entries(declared)) {
        addProduct(id, def);
    }

    // Compat mono-producto: sin `products` declarados, sintetizar el default con
    // los operadores heredados (CHAT_ID / leo_operator_chat_id).
    if (products.size === 0 && Array.isArray(opts.defaultOperators) && opts.defaultOperators.length > 0) {
        addProduct(defaultProductId, {
            name: defaultProductId,
            operators: opts.defaultOperators,
        });
    }

    /**
     * ¿Existe el producto server-side? SÓLO para uso interno del caller que ya
     * validó autz — NO exponer el resultado a un cliente no autorizado (SR-5,
     * evita oráculo de enumeración).
     */
    function hasProduct(productId) {
        const id = normalizeProductId(productId);
        return id !== null && products.has(id);
    }

    /**
     * Resuelve el `productId` efectivo de una petición. Si `requested` es
     * null/vacío → producto default (SR-6). Si viene un id, se normaliza; un id
     * inválido devuelve `null` (fail-closed). NUNCA infiere el producto de otro
     * lado que no sea el argumento explícito (que el caller obtiene de un canal
     * confiable, p.ej. el nonce server-side de confirmación — SR-2).
     *
     * @param {*} requested
     * @returns {string|null} productId canónico, o null si `requested` inválido.
     */
    function resolveProduct(requested) {
        if (requested === null || requested === undefined || requested === '') {
            return defaultProductId;
        }
        return normalizeProductId(requested);
    }

    /**
     * ¿`fromId` está autorizado a operar `productId`? (SR-1 / A07)
     *
     * Fail-closed en TODOS los caminos ambiguos, con resultado INDISTINGUIBLE
     * (SR-5): devuelve `false` — sin distinguir causa — cuando:
     *   - `fromId` es null/undefined/vacío.
     *   - `productId` es inválido (no matchea el slug).
     *   - el producto NO existe server-side.
     *   - el producto existe pero `fromId` no está en su set de operadores.
     *   - el producto existe pero tiene el set de operadores VACÍO.
     *
     * @param {string|number} fromId identidad del operador (`msg.from.id`).
     * @param {*} productId
     * @returns {boolean}
     */
    function isAuthorized(fromId, productId) {
        if (fromId === null || fromId === undefined || String(fromId).trim() === '') return false;
        const id = normalizeProductId(productId);
        if (id === null) return false;
        const prod = products.get(id);
        if (!prod) return false;
        if (prod.operators.size === 0) return false;
        return prod.operators.has(String(fromId).trim());
    }

    /**
     * Nombre humano del producto para el copy de respuestas (UX-1: nombrar
     * SIEMPRE el producto). SÓLO debe llamarse DESPUÉS de `isAuthorized` true —
     * de lo contrario filtraría el nombre de un producto ajeno (SR-5). Si el
     * producto no existe devuelve `null`.
     *
     * @param {*} productId
     * @returns {string|null}
     */
    function productName(productId) {
        const id = normalizeProductId(productId);
        if (id === null) return null;
        const prod = products.get(id);
        return prod ? prod.name : null;
    }

    /**
     * Lista los productos que `fromId` puede operar (para menús/estado). NO
     * revela productos ajenos — sólo aquellos donde el operador está autorizado.
     *
     * @param {string|number} fromId
     * @returns {Array<{ productId: string, name: string }>}
     */
    function listProductsFor(fromId) {
        const out = [];
        if (fromId === null || fromId === undefined) return out;
        const key = String(fromId).trim();
        for (const [id, prod] of products.entries()) {
            if (prod.operators.has(key)) out.push({ productId: id, name: prod.name });
        }
        return out;
    }

    return {
        isAuthorized,
        resolveProduct,
        productName,
        listProductsFor,
        hasProduct,
        defaultProductId,
        // sólo diagnóstico/tests — cantidad, nunca nombres a un cliente.
        _size: products.size,
    };
}

/**
 * Extrae el binding `commander_products` de un objeto config.yaml ya parseado.
 * Aislado para testear la lectura de config sin acoplar al loader del pulpo.
 *
 * @param {object} pipelineConfig config.yaml parseado (o {}).
 * @returns {object} sub-config del registry ({} si ausente).
 */
function extractRegistryConfig(pipelineConfig) {
    if (!pipelineConfig || typeof pipelineConfig !== 'object') return {};
    const cp = pipelineConfig.commander_products;
    return cp && typeof cp === 'object' ? cp : {};
}

module.exports = {
    createProductRegistry,
    extractRegistryConfig,
    normalizeProductId,
    DEFAULT_PRODUCT_ID,
    PRODUCT_ID_RE,
};
