// =============================================================================
// wave-weight.js — Ponderación del avance de ola por tamaño, con conservación
// de peso ante splits (#5836).
//
// PROBLEMA QUE RESUELVE
// --------------------
// El avance de ola se calculaba por conteo plano de issues:
//
//     totalPct = (cerrados*100 + Σ%activos) / wave.issues.length
//
// Cada issue pesaba 1, sin importar su `size:*`, y un issue partido en N hijos
// pasaba a ocupar `1 + N` posiciones del denominador (el padre queda abierto y
// dentro de la ola hasta que cierran todos los hijos). Resultado medido el
// 2026-08-11 en la ola 9.4: 18 altas por splits hundieron el indicador de 57%
// a 52% sin que se perdiera una sola unidad de trabajo. El denominador se
// infló solo, y la práctica que queremos incentivar (partir issues grandes)
// quedaba penalizada.
//
// MODELO: EL PESO FLUYE HACIA ABAJO, NO SE CREA AL PARTIR
// -------------------------------------------------------
// Un split NO agrega trabajo: reparte el que ya existía en piezas más chicas.
// Por eso el peso de un subárbol de split es SIEMPRE el peso propio de su raíz,
// distribuido entre las hojas en proporción a su `size:*` declarado:
//
//     raíz (size:grande → 5)
//     ├── hijo A (size:medium → 2)   ─┐  declaran 2+2+1 = 5 unidades
//     ├── hijo B (size:medium → 2)    │  → cada uno recibe 5 * (propio/5)
//     └── hijo C (size:simple → 1)   ─┘  → el subárbol sigue pesando 5
//
// El padre pasa a pesar 0 (CA-3: su trabajo está íntegramente cubierto por los
// hijos) y su avance es, implícitamente, el agregado ponderado de ellos. La
// regla se aplica recursivamente, así que una cascada padre → hijos → nietos
// tampoco multiplica el peso: sólo las hojas aportan (CA-4).
//
// Esta conservación es lo que hace que CA-1 valga EXACTO, no por aproximación:
// partir un issue sin cerrar ni abrir nada más deja el denominador idéntico,
// porque la suma de los pesos de los hijos es el peso que tenía el padre.
//
// El "cambio requerido 3" del issue (conservación de peso) se implementa acá
// como NORMALIZACIÓN, no como validación: si los hijos declaran más peso que
// el padre, no se infla el denominador — se reparte proporcionalmente y el
// exceso se reporta en `inflations` para el histórico, en vez de aparecer como
// un retroceso de la ola.
//
// DECISIONES DE IMPLEMENTACIÓN (validadas empíricamente en fase `validacion`)
// ---------------------------------------------------------------------------
//   - Parentesco por TÍTULO `[Split de #N]`, no por `blockDependencies`.
//     Medición del guru sobre la ola viva: `.partial-pause.json` →
//     `authorization_ttls` tiene CERO entradas, así que implementar CA-3/CA-4
//     sobre esa fuente detectaría CERO padres y el doble conteo persistiría en
//     producción. El título es durable y hoy resuelve 24 padres dentro de la
//     ola. Se reusa `parentOfSplitOrphan` de `split-orphan-reconciler.js`.
//   - `size:large` y `size:grande` COLAPSAN a L. Ambos conviven en la ola (10 y
//     6 issues): tratarlos como buckets distintos pesaría mal a 16 issues. Se
//     reusa `mapSizeToCanonical` de `eta-wave.js` (SIZE_VOCAB), que ya los
//     unifica. La higiene del label duplicado es #5839, independiente.
//   - Peso default = M (medium). NO es un caso borde: 36 de 116 issues de la
//     ola (31%) no tienen ningún `size:*`, así que el default gobierna casi un
//     tercio del denominador. Empatarlo con `medium` evita sesgar el
//     denominador hacia abajo (acordado por PO, UX y guru).
//
// REGLAS
// ------
// - Función PURA: no toca disco, no toca red, sin side-effects.
// - No throw: input inválido → degradación a pesos default, nunca excepción.
//   Si `eta-wave` o `split-orphan-reconciler` no se pueden requerir, se cae a
//   una copia local del vocabulario y a "sin parentesco" (el pipeline no puede
//   morir por esto).
// - Tolerante a ciclos y a profundidad patológica: un ciclo A→B→A no cuelga el
//   cálculo ni desaparece del denominador.
// =============================================================================

'use strict';

// Carga best-effort de los dos módulos que ya resuelven estas dos cosas.
// Si alguno falta, degradamos sin romper (el avance de ola no puede tumbar el
// dashboard ni el commander).
let etaWave = null;
try { etaWave = require('./eta-wave'); } catch { etaWave = null; }
let splitReconciler = null;
try { splitReconciler = require('./split-orphan-reconciler'); } catch { splitReconciler = null; }

// ─── Constantes ────────────────────────────────────────────────────────────

// Pesos por tamaño canónico. Los valores 1/2/5 vienen del issue: la escala es
// deliberadamente super-lineal porque un `grande` no cuesta 3 `simples`, y así
// cerrar un `size:grande` mueve la aguja más que cerrar un `size:simple` (CA-2).
const WEIGHT_BY_SIZE = { S: 1, M: 2, L: 5 };

// Peso de un issue SIN ningún label `size:*`. Explícito y documentado a pedido
// del issue: empata con `medium` para no sesgar el denominador. Cubre el 31%
// de la ola, así que el renderer lo hace visible en vez de esconderlo.
const DEFAULT_WEIGHT = WEIGHT_BY_SIZE.M;

// Cota de profundidad del árbol de splits. La cascada real medida tiene 5
// niveles (#5340 → #5440 → #5793 → #5800 → #5803); 32 es holgura amplia y a la
// vez backstop contra una genealogía patológica.
const MAX_SPLIT_DEPTH = 32;

// Fallback local del vocabulario de tamaños, usado SÓLO si `eta-wave` no cargó.
// Duplicado consciente y acotado: preferimos degradar a pesar bien que romper.
const FALLBACK_SIZE_VOCAB = {
    S: ['s', 'simple', 'small', 'size:simple', 'size:small'],
    M: ['m', 'medio', 'medium', 'size:medio', 'size:medium'],
    L: ['l', 'grande', 'large', 'size:grande', 'size:large'],
};

// Regex de parentesco, alineada con `split-orphan-reconciler.SPLIT_TITLE_RE`.
// Sólo se usa si ese módulo no cargó.
const FALLBACK_SPLIT_TITLE_RE = /^\s*\[\s*split\s+(?:de|of)\s+#(\d+)\s*\]/i;

// Decimales a los que se cuantiza el peso TOTAL antes de publicarlo.
//
// El reparto proporcional divide y multiplica en punto flotante, así que la
// conservación del peso es exacta en aritmética real pero no en IEEE-754: un
// padre de peso 5 repartido entre 3 hijos vuelve a sumar 4.999999999999999.
// El error es irrelevante para el porcentaje (que se redondea a entero), pero
// NO es inocuo aguas abajo: `classifyProgressDelta` decide "el denominador
// creció" con una comparación `> 0`, y un residuo de +4e-15 alcanzaría para
// que un split perfectamente neutro se reporte como "caída por altas".
// Cuantizar acá corta el problema en la fuente, donde el peso se publica.
const WEIGHT_PRECISION = 6;

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Cuantiza a WEIGHT_PRECISION decimales, matando el ruido de punto flotante. */
function quantize(n) {
    if (!Number.isFinite(n)) return 0;
    const f = 10 ** WEIGHT_PRECISION;
    return Math.round(n * f) / f;
}

function toPositiveInt(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Normaliza una etiqueta suelta a su tamaño canónico, o null si no es un
 * tamaño reconocible.
 *
 * A diferencia de `mapSizeToCanonical` (que hace fallback a M para CUALQUIER
 * valor), acá necesitamos distinguir "declaró medium" de "no declaró nada":
 * el segundo caso alimenta el contador `sinSize` que el operador ve en el
 * reporte. Por eso filtramos primero contra el vocabulario y sólo delegamos
 * cuando ya sabemos que el valor ES un tamaño.
 *
 * @param {*} raw
 * @returns {'S'|'M'|'L'|null}
 */
function canonicalSizeOfLabel(raw) {
    if (raw == null) return null;
    const norm = String(typeof raw === 'string' ? raw : (raw && raw.name) || '')
        .trim()
        .toLowerCase();
    if (!norm) return null;

    // Sólo consideramos labels que son explícitamente de tamaño. Un label
    // suelto como "s" o "l" en GitHub sería ambiguo con otras taxonomías, así
    // que acá exigimos el prefijo `size:` (que es el que usa el proyecto).
    if (!norm.startsWith('size:')) return null;

    for (const [canonical, vocab] of Object.entries(FALLBACK_SIZE_VOCAB)) {
        if (vocab.includes(norm)) return canonical;
    }
    // Un `size:*` desconocido (ej. `size:xl`) SÍ es una declaración de tamaño,
    // pero no sabemos cuál: delegamos en el mapper canónico de eta-wave, que
    // hace fallback a M. Reusar acá mantiene una sola fuente de verdad.
    if (etaWave && typeof etaWave.mapSizeToCanonical === 'function') {
        const mapped = etaWave.mapSizeToCanonical(norm);
        if (mapped && WEIGHT_BY_SIZE[mapped.canonical] !== undefined) return mapped.canonical;
    }
    return 'M';
}

/**
 * Peso propio de un issue, derivado de sus labels `size:*`.
 *
 * Si declara varios tamaños (no debería, pero pasa), gana el mayor: es la
 * lectura conservadora — no queremos subestimar trabajo por un label residual.
 *
 * @param {{labels?:Array}} issue
 * @returns {{weight:number, size:('S'|'M'|'L'|null)}} size null = sin declarar
 */
function ownWeightOf(issue) {
    const labels = issue && Array.isArray(issue.labels) ? issue.labels : [];
    let best = null;
    for (const l of labels) {
        const c = canonicalSizeOfLabel(l);
        if (!c) continue;
        if (best === null || WEIGHT_BY_SIZE[c] > WEIGHT_BY_SIZE[best]) best = c;
    }
    if (best === null) return { weight: DEFAULT_WEIGHT, size: null };
    return { weight: WEIGHT_BY_SIZE[best], size: best };
}

/**
 * Padre declarado de un issue por su título canónico `[Split de #N]`, o null.
 *
 * Delega en `split-orphan-reconciler.parentOfSplitOrphan` (fuente única, ya
 * sanitiza entero > 0 y excluye auto-referencia). El fallback local sólo actúa
 * si ese módulo no cargó.
 *
 * @param {{id:number, title?:string}} issue
 * @returns {number|null}
 */
function declaredParentOf(issue) {
    if (!issue) return null;
    const child = toPositiveInt(issue.id);
    if (!child) return null;
    const title = typeof issue.title === 'string' ? issue.title : '';
    if (!title) return null;

    if (splitReconciler && typeof splitReconciler.parentOfSplitOrphan === 'function') {
        const p = splitReconciler.parentOfSplitOrphan({ number: child, title });
        return toPositiveInt(p);
    }
    const m = FALLBACK_SPLIT_TITLE_RE.exec(title);
    if (!m) return null;
    const parent = toPositiveInt(m[1]);
    if (!parent || parent === child) return null;   // auto-referencia → sin padre
    return parent;
}

// ─── API principal ─────────────────────────────────────────────────────────

/**
 * Calcula el peso efectivo de cada issue de la ola, conservando el peso ante
 * splits.
 *
 * @param {Array<{id:number, title?:string, labels?:Array}>} issues
 * @returns {{
 *   weights: Map<number, number>,       // peso efectivo (0 para padres cubiertos)
 *   totalWeight: number,
 *   sizes: Map<number, ('S'|'M'|'L'|null)>,
 *   coveredParents: number[],           // padres que ceden su peso a los hijos
 *   sinSize: number,                    // issues sin `size:*` (peso default)
 *   inflations: Array<{parent:number, declared:number, own:number}>,
 *   maxDepth: number,
 * }}
 */
function computeWaveWeights(issues) {
    const list = Array.isArray(issues) ? issues : [];

    // Índice por id, descartando entradas sin id válido.
    const byId = new Map();
    for (const it of list) {
        const id = toPositiveInt(it && it.id);
        if (id === null) continue;
        if (!byId.has(id)) byId.set(id, it);
    }

    const weights = new Map();
    const sizes = new Map();
    const own = new Map();
    let sinSize = 0;

    for (const [id, it] of byId) {
        const { weight, size } = ownWeightOf(it);
        own.set(id, weight);
        sizes.set(id, size);
        if (size === null) sinSize += 1;
        weights.set(id, weight);   // valor provisorio; se recalcula al distribuir
    }

    // Parentesco: sólo cuenta si el padre TAMBIÉN está en la ola. Un hijo cuyo
    // padre quedó fuera es una raíz a todos los efectos (su peso es propio).
    const parentOf = new Map();
    const childrenOf = new Map();
    for (const [id, it] of byId) {
        const parent = declaredParentOf({ id, title: it && it.title });
        if (parent === null || parent === id || !byId.has(parent)) continue;
        parentOf.set(id, parent);
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(id);
    }

    // Guard de ciclos: un nodo cuya cadena de ancestros se muerde la cola (o
    // excede la profundidad) se trata como raíz. Sin esto, un ciclo A→B→A haría
    // que ni A ni B fueran alcanzables desde ninguna raíz y su peso
    // desaparecería del denominador — justo el bug que este issue combate.
    const roots = [];
    for (const id of byId.keys()) {
        if (!parentOf.has(id)) { roots.push(id); continue; }
        const seen = new Set([id]);
        let cur = parentOf.get(id);
        let depth = 0;
        let cyclic = false;
        while (cur !== undefined && cur !== null) {
            if (seen.has(cur) || depth > MAX_SPLIT_DEPTH) { cyclic = true; break; }
            seen.add(cur);
            cur = parentOf.get(cur);
            depth += 1;
        }
        if (cyclic) {
            // Romper el ciclo por acá: este nodo pasa a ser raíz.
            const p = parentOf.get(id);
            parentOf.delete(id);
            const sib = childrenOf.get(p);
            if (sib) {
                const idx = sib.indexOf(id);
                if (idx >= 0) sib.splice(idx, 1);
                if (sib.length === 0) childrenOf.delete(p);
            }
            roots.push(id);
        }
    }

    // Distribución BFS desde las raíces. Cada nodo recibe un "budget" (el peso
    // que su subárbol debe totalizar) y lo reparte entre sus hijos en
    // proporción al peso propio declarado por cada uno.
    const coveredParents = [];
    const inflations = [];
    const visited = new Set();
    let maxDepth = 0;

    const queue = roots.map((id) => ({ id, budget: own.get(id) || DEFAULT_WEIGHT, depth: 0 }));
    while (queue.length > 0) {
        const node = queue.shift();
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        if (node.depth > maxDepth) maxDepth = node.depth;

        const kids = (childrenOf.get(node.id) || []).filter((k) => !visited.has(k));

        // Hoja (o tope de profundidad): se queda con todo el budget.
        if (kids.length === 0 || node.depth >= MAX_SPLIT_DEPTH) {
            weights.set(node.id, node.budget);
            continue;
        }

        // Nodo interno: cede su peso a los hijos (CA-3) y no aporta peso propio.
        weights.set(node.id, 0);
        coveredParents.push(node.id);

        const declared = kids.reduce((acc, k) => acc + (own.get(k) || 0), 0);
        // "Conservación de peso" (cambio requerido 3): si los hijos declaran más
        // peso del que tenía el padre, el padre estaba subestimado. NO inflamos
        // el denominador — repartimos proporcionalmente y dejamos registro para
        // el histórico, así el operador ve una re-estimación y no un retroceso.
        if (declared > (own.get(node.id) || 0)) {
            inflations.push({
                parent: node.id,
                declared,
                own: own.get(node.id) || 0,
            });
        }

        for (const k of kids) {
            const share = declared > 0
                ? (own.get(k) || 0) / declared
                : 1 / kids.length;          // todos sin peso → reparto parejo
            queue.push({ id: k, budget: node.budget * share, depth: node.depth + 1 });
        }
    }

    // Nodos jamás alcanzados (defensivo: no debería quedar ninguno tras el
    // guard de ciclos). Conservan su peso propio para no evaporarse del total.
    for (const id of byId.keys()) {
        if (!visited.has(id)) weights.set(id, own.get(id) || DEFAULT_WEIGHT);
    }

    let totalWeight = 0;
    for (const w of weights.values()) totalWeight += w;

    return {
        weights,
        totalWeight: quantize(totalWeight),
        sizes,
        coveredParents,
        sinSize,
        inflations,
        maxDepth,
    };
}

/**
 * Avance ponderado de la ola: Σ(peso_i × pct_i) / Σ(peso_i).
 *
 * Los issues con peso 0 (padres cubiertos por sus hijos) no aportan ni al
 * numerador ni al denominador: su avance ES el agregado de los hijos, contarlo
 * aparte sería doble conteo.
 *
 * @param {Array<{id:number, pct:number, isClosed?:boolean}>} issues
 * @param {Map<number, number>} weights
 * @returns {{totalPct:number, totalWeight:number, closedWeight:number}}
 */
function weightedProgress(issues, weights) {
    const list = Array.isArray(issues) ? issues : [];
    const w = weights instanceof Map ? weights : new Map();

    let num = 0;
    let den = 0;
    let closedWeight = 0;

    for (const it of list) {
        const id = toPositiveInt(it && it.id);
        if (id === null) continue;
        const weight = w.has(id) ? w.get(id) : 0;
        if (!Number.isFinite(weight) || weight <= 0) continue;

        const rawPct = Number(it.pct);
        const pct = it && it.isClosed ? 100 : (Number.isFinite(rawPct) ? rawPct : 0);
        const clamped = Math.max(0, Math.min(100, pct));

        num += weight * clamped;
        den += weight;
        if (it && it.isClosed) closedWeight += weight;
    }

    return {
        totalPct: den > 0 ? Math.round(num / den) : 0,
        totalWeight: quantize(den),
        closedWeight: quantize(closedWeight),
    };
}

module.exports = {
    computeWaveWeights,
    weightedProgress,
    // Constantes públicas
    WEIGHT_BY_SIZE,
    DEFAULT_WEIGHT,
    MAX_SPLIT_DEPTH,
    WEIGHT_PRECISION,
    // Helpers expuestos para tests
    _internal: {
        canonicalSizeOfLabel,
        ownWeightOf,
        declaredParentOf,
        toPositiveInt,
        quantize,
    },
};
