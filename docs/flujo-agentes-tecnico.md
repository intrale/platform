# Flujo de Agentes — Documentacion Tecnica

Documento de referencia para el grafo de flujo de agentes renderizado por `dashboard-server.js` (funcion `buildFlowTree`). Cubre el pipeline completo: recoleccion de datos, layout por capas, ruteo A*, y renderizado SVG.

**Archivo fuente:** `.claude/dashboard-server.js`

---

## 1. Arquitectura general (pipeline)

El grafo de flujo se construye en cuatro fases secuenciales:

```
collectData()          buildFlowTree()
     |                      |
     v                      v
 Recoleccion  -->  Layout  -->  Ruteo A*  -->  Renderizado SVG
 de datos          por capas    de edges       de nodos + edges
```

1. **Recoleccion de datos** (`collectData`): lee sesiones, sprint-plan, agent-registry. Construye `agentNodes` (Set de nombres canonicos) y `agentTransitions` (array de objetos `{from, to, ts, _session, _synthetic}`).
2. **Layout por capas** (dentro de `buildFlowTree`): asigna cada nodo a una capa semantica (0-6), ordena nodos dentro de cada capa con barycenter para minimizar cruces, y calcula posiciones (x, y).
3. **Ruteo A*** (funcion `gridRoute`): traza paths para cada edge evitando colisiones con nodos y edges previos.
4. **Renderizado SVG**: genera nodos (circulos con iconos), edges (paths con flechas animadas), labels de secuencia, y halos pulsantes.

---

## 2. Recoleccion de datos (`collectData`, lineas ~548-747)

### 2.1 Fuentes de datos

- **Sesiones activas** (`sessions`): archivos JSON en `.claude/sessions/`. Cada sesion tiene `agent_name`, `branch`, `agent_transitions`, `skills_invoked`, `tool_counts`.
- **Sprint plan** (`scripts/sprint-plan.json`): define `agentes`, `_queue`, `_completed`, `_incomplete`. Cada entrada tiene `issue`, `numero`, `skill`.
- **Agent registry** (`.claude/hooks/agent-registry.json`): fuente de verdad para agentes activos. Agentes con status distinto de `done`/`zombie` se incluyen en el flujo.

### 2.2 Filtrado por sprint

Solo se incluyen sesiones relacionadas con el sprint activo:

1. Se recopilan todos los issue numbers del sprint desde `sprint-plan.json` (agentes + queue + completed + incomplete) y desde `agent-registry.json`.
2. Sesiones cuyo branch matchea un issue del sprint se incluyen.
3. Sesiones "Main" (sin branch `agent/`) se incluyen siempre.
4. Sesiones con issues ajenos al sprint se excluyen.

### 2.3 Construccion de transiciones

Para cada sesion incluida:

1. **Resolucion del nombre raiz**: si la sesion es un agente de sprint (`branch` empieza con `agent/`), se resuelve el nombre raiz:
   - Se normaliza `agent_name` con `normalizeSkillName`.
   - Si el resultado matchea `/^Agente\s+\d+/i`, se usa directamente.
   - Si no, se busca el `numero` en sprint-plan por issue number.
   - Fallback: `"Agente " + issueNum`.

2. **Transiciones reales** (`s.agent_transitions`): cada transicion `{from, to}` se normaliza con `normalizeSkillName`. Si el `from` es `"Claude"` o `"Main"` y existe un `agentRootName`, se reemplaza por el nombre del agente raiz.

3. **Skills invocados** (`s.skills_invoked`): se mapean via `AGENT_MAP_DASHBOARD` y se agregan como nodos (sin edge explicito, solo presencia).

4. **Nodo del agente mismo**: se agrega al set de nodos.

### 2.4 Transiciones sinteticas

#### Main → skills
Si una sesion Main no tiene `agent_transitions` pero tiene `skills_invoked` o `tool_counts.Agent > 0`:
- Se genera un edge `Main → skill1 → skill2 → ...` encadenando los skills invocados.
- Si solo uso Agent tool sin skills explicitos, se generan edges `Main → Agente N` para cada agente del sprint.

#### Start → agentes
Si existe un sprint plan, se inyecta el nodo `"Start"` y se crean edges `Start → Agente N` para cada historia del sprint (agentes + queue + completed + incomplete).

#### Completados → Done
Para issues en `_completed` del sprint-plan:
- Se busca el ultimo skill real en la cadena de transiciones del agente (excluyendo `Done`, `Error`, `Start`, y nodos raiz `Agente N`).
- Se genera un edge `ultimoSkill → Done`.

#### Incompletos → Error
Para issues en `_incomplete`:
- Mismo mecanismo que completados, pero el edge va a `Error`.
- Si no hay transiciones, se genera `Claude → Error`.

### 2.5 Mapa de issues por agente

Se construye `agentIssueMap` que mapea `agentNodeName → issueNumber` para mostrar el `#issue` como link debajo del nombre del nodo.

### 2.6 Agentes en cola

El set `queuedAgents` contiene agentes listados en `_queue` del sprint-plan. Se renderizan grisados (opacity 0.4) en el grafo.

---

## 3. Deduplicacion de nodos (`normalizeSkillName`)

La funcion `normalizeSkillName` (linea 862) canonicaliza nombres de skills/agentes para evitar nodos duplicados. Cadena de resolucion:

1. **Null/vacio** → retorna `"Claude"`.
2. **Patron `Agente (#NNNN)`** → busca en sprint-plan el `numero` correspondiente al issue. Retorna `"Agente N"`. Fallback: `"Agente " + issueNum`.
3. **Match directo en `AGENT_ICON_MAP`** → retorna el nombre tal cual (ya es canonico).
4. **Limpieza**: remueve `/` inicial, convierte a lowercase.
5. **Busqueda en `SKILL_TO_AGENT`** → mapeo slash-command a nombre canonico (ej: `"/backend-dev"` → `"BackendDev"`).
6. **Busqueda en `AGENT_MAP_DASHBOARD`** → segundo diccionario de mapeo.
7. **Busqueda en `SKILL_NAME_ALIASES`** → diccionario exhaustivo de variantes (incluye formas con/sin slash, con/sin guion, lowercase, sub-skills de Doc).
8. **Match case-insensitive** contra valores de `SKILL_TO_AGENT` y keys de `AGENT_ICON_MAP`.
9. **Fallback**: retorna el nombre original sin modificar.

### Aliases notables

| Entrada | Nombre canonico |
|---------|----------------|
| `/doc`, `/historia`, `/refinar`, `/priorizar` | `Doc` |
| `/delivery`, `delivery-manager` | `DeliveryManager` |
| `/ux`, `ux` | `UX Specialist` |
| `/scrum`, `scrum` | `Scrum Master` |
| `/backend-dev`, `backend-dev` | `BackendDev` |
| `claude` | `Claude` (luego renombrado a `Main` en `buildFlowTree`) |

---

## 4. Filtrado de nodos

### 4.1 INFRA_SKILLS_FILTER

Skills de infraestructura excluidos del grafo visual:

```javascript
const INFRA_SKILLS_FILTER = new Set(["Ops", "Checkup", "Cleanup", "Monitor", "Cost"]);
```

Estos skills se invocan automaticamente y no aportan al flujo de desarrollo.

### 4.2 Nodos sin edges

Se filtran nodos que aparecen en `agentNodes` pero no tienen ningun edge en `edgeList` despues de la construccion (nodos que estan en `nodeSet` pero no en `nodesWithEdges`).

### 4.3 Agentes raiz no resueltos

En la construccion de `edgeList`, se descartan agentes cuyo `agentNum` es `"0"` (roots no resueltos, tipicamente `"Main"` tratado como root sin match de patron `Agente N`). Excepcion: `"Main"` si se incluye explicitamente.

```javascript
if (!agentMatch && rootName !== "Main") continue; // Skip unresolved roots
```

### 4.4 Nodos huerfanos post-filtrado

Despues de construir `edgeList`, se recorren los nodos y se eliminan los que no aparecen en ningun edge:

```javascript
const nodesInEdges = new Set();
for (const e of edgeList) { nodesInEdges.add(e.from); nodesInEdges.add(e.to); }
for (let i = nodes.length - 1; i >= 0; i--) {
    if (!nodesInEdges.has(nodes[i])) nodes.splice(i, 1);
}
```

---

## 5. Sistema de capas semanticas (SKILL_LAYER)

Cada nodo se asigna a una capa fija segun su rol en el pipeline de desarrollo:

| Capa | Rol | Nodos |
|------|-----|-------|
| **0** | Inicio | `Start` |
| **1** | Agentes raiz | `Agente 1`, `Agente 2`, ... (todo nodo que matchea `/^Agente\s+/i`) |
| **2** | Discovery y planificacion | `PO`, `UX`, `Guru`, `Doc`, `Planner`, `Historia`, `Refinar`, `Priorizar` |
| **3** | Desarrollo | `BackendDev`, `AndroidDev`, `WebDev`, `Hotfix`, `Perf` |
| **4** | Gates y validacion | `Tester`, `QA`, `Security`, `Review`, `Auth` |
| **5** | Delivery y ops | `Delivery`, `DeliveryManager`, `Builder`, `Ops`, `Scrum`, `Checkup`, `Cleanup`, `Monitor`, `Cost` |
| **6** (terminal) | Resultados | `Done`, `Error` |

La capa terminal se calcula dinamicamente como `max(todas las capas) + 1`.

Skills desconocidos (no listados en `SKILL_LAYER`) default a capa 3 (desarrollo) si su capa BFS era <= 1.

### Asignacion inicial vs override

Primero se ejecuta un BFS desde nodos raiz (sin edges entrantes) para asignar capas por distancia. Luego se aplica el override semantico forzando las capas de la tabla anterior. El BFS solo sobrevive para nodos no cubiertos por el override.

---

## 6. Ordenamiento barycenter

El algoritmo minimiza cruces de edges ordenando nodos dentro de cada capa. Se ejecutan **4 sweeps** (iteraciones), cada uno con:

### Forward sweep (izquierda a derecha)
Para cada capa `L` (desde la segunda):
1. Para cada nodo en `L`, calcular el **baricentro**: promedio de las posiciones (indice) de sus vecinos en la capa `L-1`.
2. Ordenar los nodos de `L` por baricentro ascendente.
3. Actualizar `nodeOrder[n] = nuevoIndice`.

### Backward sweep (derecha a izquierda)
Identico pero usando vecinos de la capa `L+1` como referencia.

Si un nodo no tiene vecinos en la capa adyacente, conserva su posicion original (`nodeOrder[n]`).

---

## 7. Espaciado y posicionamiento

### 7.1 Constantes de spacing

| Constante | Valor | Descripcion |
|-----------|-------|-------------|
| `nodeR` | 56 | Radio base del nodo circular (px) |
| `colSpacing` | 300 / 240 / 200 | Distancia horizontal entre capas. 300 si <= 5 capas, 240 si <= 8, 200 si mas |
| `minRowSpacing` | `nodeR * 2 + 80 = 192` | Minimo entre centros de nodos verticalmente |
| `rowSpacing` | max(`minRowSpacing`, 260/230/200) | Espaciado vertical real. 260 si <= 3 nodos/capa, 230 si <= 5, 200 si mas |
| `padding` | 70 | Margen externo del SVG |

### 7.2 Dimensiones del SVG

```
mainZoneW = numLayers * colSpacing + padding * 2
svgW = max(900, mainZoneW)
agentZoneH = max(500, maxNodesInLayer * rowSpacing + padding * 2)
mainZoneH = 200 si hay nodos Main-only, 0 si no
svgH = agentZoneH + mainZoneH
```

### 7.3 Posicionamiento de nodos por capa

Para cada capa, los nodos se centran verticalmente en la `agentZoneH`:

```
layerRowSpacing = count <= 1 ? rowSpacing : max(minRowSpacing, agentZoneH / (count + 1))
totalH = (count - 1) * layerRowSpacing
startY = agentZoneH / 2 - totalH / 2
posicion[i] = { x: padding + col * colSpacing + colSpacing/2, y: startY + i * layerRowSpacing }
```

### 7.4 Zona periferica Main

Los nodos usados **exclusivamente** por la sesion Main (no por ningun agente de sprint) se posicionan en una zona separada debajo del flujo principal:

- Separacion: 40px debajo de `agentZoneH`.
- Espaciado horizontal: `min(200, (svgW - padding*2) / cantidadNodosMain)`.
- Y fijo: `agentZoneH + 100`.
- Linea divisoria punteada entre ambas zonas.

Un nodo es "Main-only" si todos sus edges (entrantes y salientes) pertenecen al `agentRoot === "Main"`.

---

## 8. Anillos concentricos para skills multi-agente

Cuando un skill es usado por multiples agentes de sprint, se renderizan anillos concentricos de color alrededor del nodo para indicar que agentes pasaron por el.

### Determinacion de anillos

```javascript
const passingAgents = [...new Set(
    edgeList.filter(e => e.to === name || e.from === name)
           .map(e => e.agentRoot)
           .filter(r => r && r !== "Main")
)];
const passingColors = passingAgents.map(a => agentColorMap[a]).filter(unique);
```

### Renderizado

| Condicion | Renderizado |
|-----------|-------------|
| `passingColors.length > 1` | Anillos concentricos: uno por agente |
| `passingColors.length === 1` | Borde simple con color del agente |
| Sin agentes (nodo raiz/special) | Borde solido con color propio |

Parametros de anillos:

| Constante | Valor | Descripcion |
|-----------|-------|-------------|
| `ringWidth` | 3 | Grosor de cada anillo |
| `ringGap` | 2 | Espacio entre anillos |
| `ringStep` | 5 | Incremento total por anillo (`ringWidth + ringGap`) |

El radio de cada anillo es `effectiveR + (indice * ringStep)`.

### Impacto en layout

El radio expandido por anillos afecta:
- **Block radius en la grilla A***: `visualR + baseBlockMargin` donde `visualR = baseR + (rings-1) * ringStep`.
- **Puntos de inicio/fin de edges**: `fromVisualR` y `toVisualR` incluyen el radio expandido.

---

## 9. Ruteo A* por grilla

### 9.1 Configuracion de la grilla

| Constante | Valor | Descripcion |
|-----------|-------|-------------|
| `gridCell` | `max(8, round(nodeR * 0.3))` = ~17px | Tamano de celda |
| `gridW` | `ceil(svgW / gridCell)` | Ancho de la grilla en celdas |
| `gridH` | `ceil(svgH / gridCell)` | Alto de la grilla en celdas |

La grilla usa un `Uint8Array` por fila. Valores de celda:

| Valor | Significado |
|-------|-------------|
| 0 | Libre |
| 1 | Bloque duro (nodo) — intransitable |
| 2+ | Edge previo — penalizado, acumulativo |
| 3 | Zona soft (margen alrededor de nodos) — costosa pero transitable |

### 9.2 Marcado de nodos en la grilla

Para cada nodo se marca:

1. **Bloque duro circular** (valor 1): todas las celdas dentro de `blockRadius = visualR + baseBlockMargin` (donde `baseBlockMargin = 25`).
2. **Zona soft** (valor 3): celdas entre `blockRadius` y `blockRadius + softMargin` (donde `softMargin = 30`).
3. **Zona de label** (valor 1, rectangular): debajo del nodo, ancho ~85px por lado, alto `blockRadius + labelExtraBelow` (donde `labelExtraBelow = 55`).

### 9.3 Algoritmo A*

Funcion `gridRoute(sx, sy, tx, ty)`:

1. Convierte coordenadas SVG a celdas de grilla.
2. Libera temporalmente las celdas de start/target (estan dentro de nodos).
3. **Direcciones**: 8 (cardinales + diagonales). Costo diagonal: 1.41, cardinal: 1.
4. **Heuristica**: distancia Manhattan (`|dx| + |dy|`).
5. **Penalizaciones**:
   - **Edge previo**: `cellVal * 1.5` (nudge leve para separar edges paralelos).
   - **Cambio de direccion**: 0.5 (desalienta zigzag).
6. **maxIter**: `min(15000, gridW * gridH * 3)`.
7. Si encuentra path, lo reconstruye y retorna array de puntos `{x, y}`.

### 9.4 Fallback cuando A* falla

Si no encuentra path (maxIter agotado o camino bloqueado):

```javascript
const midX = (sx + tx) / 2;
const midY = (sy + ty) / 2;
const detourY = midY < svgH / 2 ? midY - 80 : midY + 80;
return [{ x: sx, y: sy }, { x: midX, y: detourY }, { x: tx, y: ty }];
```

Genera una curva de desvio: punto medio desplazado 80px hacia afuera del centro del SVG.

### 9.5 Marcado de edges en la grilla

Despues de trazar un path, se marcan las celdas ocupadas con un ancho de 5 celdas (kernel de -2 a +2 en ambos ejes). Cada celda recibe `+2` acumulativo (cap a 255), sin sobreescribir bloques duros (valor 1).

### 9.6 Simplificacion de path

`simplifyPath` elimina puntos colineales (cross-product < 0.1).

### 9.7 Esquinas redondeadas

`pathToSvg` convierte el path a SVG `d=""` con arcos cuadraticos (`Q`) en cada esquina. Radio de redondeo: `gridCell * 0.6` (~10px).

---

## 10. Evasion de colision de labels de edges

Cada edge tiene un label de secuencia (formato `"agentNum.stepNum"`, ej: `"1.3"`, `"2.1"`).

### Posicionamiento

El label se coloca en el punto medio del path ruteado (no del segmento recto start-end):

```javascript
if (route.length >= 3) {
    const midIdx = Math.floor(route.length / 2);
    lx = route[midIdx].x;
    ly = route[midIdx].y;
} else {
    lx = (x1 + x2) / 2;
    ly = (y1 + y2) / 2;
}
```

### Deteccion de colision

Se mantiene un array `placedLabels` con las posiciones de todos los labels ya colocados.

Para cada nuevo label, se verifica contra todos los previos:

```
labelCollisionR = labelR * 2.5   (donde labelR = 14 o 16 segun largo del texto)
```

Si la distancia euclidiana entre el nuevo label y algun previo es menor que `labelCollisionR`:
- Se calcula el vector **perpendicular** a la direccion del edge.
- Se desplaza el label en esa direccion por `labelCollisionR - distancia + 8` px.

### Renderizado del label

Circulo de fondo (`fill: var(--bg)`, borde del color del agente) + texto centrado con el numero de secuencia.

---

## 11. Puntos de inicio y fin de edges

Los puntos de start/end se calculan offset del borde visual de cada nodo:

```javascript
const fromVisualR = (isRobotFrom ? nodeR + 4 : nodeR) + (fromRings > 1 ? (fromRings - 1) * ringStep : 0);
const toVisualR   = (isRobotTo   ? nodeR + 4 : nodeR) + (toRings   > 1 ? (toRings   - 1) * ringStep : 0);

x1 = from.x + ux * (fromVisualR + 8)   // 8px gap desde el borde del nodo origen
y1 = from.y + uy * (fromVisualR + 8)
x2 = to.x   - ux * (toVisualR   + 12)  // 12px gap desde el borde del nodo destino (espacio para flecha)
y2 = to.y   - uy * (toVisualR   + 12)
```

Donde `ux, uy` es el vector unitario de `from` a `to`.

### Edges paralelos

Si hay multiples edges entre el mismo par de nodos, se desplazan perpendicularmente:

```javascript
const perpOff = pairCount > 1 ? (pairIdx - (pairCount - 1) / 2) * 12 : 0;
```

Separacion de 12px entre edges paralelos.

---

## 12. Pulsacion inteligente (smart pulsation)

Solo pulsan los nodos que estan **activamente en uso**:

### Nodos raiz (agentes)
Pulsan si la sesion del agente tiene `status === "active"`. Se determina recorriendo las sesiones y normalizando `agent_name`.

### Nodos de skill
Pulsan si **algun agente activo** paso por ese skill:

```javascript
if (isActive || (isSkillNode && passingAgents.some(a => activeAgents.has(a)))) {
    // Renderizar halo pulsante
}
```

### Animacion

Halo pulsante: circulo adicional con radio oscilante y opacidad oscilante:

```xml
<circle r="${effectiveR + 8}">
  <animate attributeName="r" values="${effectiveR+4};${effectiveR+14};${effectiveR+4}" dur="2s" repeatCount="indefinite"/>
  <animate attributeName="stroke-opacity" values="0.8;0.1;0.8" dur="2s" repeatCount="indefinite"/>
</circle>
```

Los edges tambien se animan con `stroke-dasharray: 8 6` y `stroke-dashoffset: 28`, animando a 0 en 1.2s (`flow-dash`).

La clase `node-active` en nodos agente aplica pulsacion de opacidad: `opacity: 1 → 0.5 → 1` en 2s.

---

## 13. Sistema de colores

### 13.1 Colores por agente (`agentColorMap`)

Se asignan ciclicamente desde el array `rootColors` (20 colores distintos):

```javascript
const rootColors = [
    "#f87171", "#60a5fa", "#4ade80", "#fbbf24", "#a78bfa",
    "#f472b6", "#fb923c", "#22d3ee", "#e879f9", "#84cc16",
    "#f59e0b", "#06b6d4", "#ec4899", "#14b8a6", "#8b5cf6",
    "#ef4444", "#3b82f6", "#10b981", "#f97316", "#6366f1",
];
```

Solo se asignan a nodos que matchean `/^Agente\s+/i` (nodos raiz de sprint). El orden de asignacion es el orden de aparicion en el array `nodes`.

### 13.2 Colores fijos

| Nodo | Color | Hex |
|------|-------|-----|
| `Start` | Gris neutro | `#6C7086` |
| `Main` | Gris claro | `#9ca3af` |
| `Done` | Verde | `#4ade80` |
| `Error` | Rojo | `#f87171` |

### 13.3 Colores de skills

Todos los nodos de skill usan un color neutral uniforme:

```javascript
const fillColor = isSkillNode ? "#8b95a5" : color;
```

El borde del skill toma el color del agente que paso por el (un solo agente) o muestra anillos concentricos (multiples agentes).

### 13.4 Colores de edges

- **Start → Agente N**: color del agente destino.
- **Agente N → Skill**: color del agente raiz (`agentRoot`).
- **Skill → Skill**: color del agente raiz que origino la cadena.
- **Cualquier → Done/Error**: color del agente raiz.

### 13.5 Agentes en cola

Los agentes en `queuedAgents` (del `_queue` del sprint-plan) se renderizan con `opacity: 0.4` y color `#6C7086` en lugar de su color asignado.

### 13.6 Marcadores de flecha (arrowheads)

Se generan markers SVG dinamicos, uno por cada color unico usado en edges:

```xml
<marker id="fa-{hex}" markerWidth="7" markerHeight="5" refX="6" refY="2.5" orient="auto">
    <polygon points="0 0, 7 2.5, 0 5" fill="{color}" opacity="0.85"/>
</marker>
```

---

## 14. Visibilidad y toggles (`data-flow-root`)

Cada nodo y edge tiene un atributo `data-flow-root` para control de visibilidad desde la UI:

| Valor | Nodos incluidos | Visibilidad default |
|-------|----------------|---------------------|
| `"sprint"` | Start, Done, Error, Agente N | Siempre visible |
| `"agent"` | Skills usados por agentes de sprint | Visible por default |
| `"main"` | Main y skills usados solo por Main | Oculto por default |

---

## 15. Resumen de constantes clave

| Constante | Valor | Ubicacion |
|-----------|-------|-----------|
| `nodeR` | 56 | Radio base de nodo |
| `effectiveR` (robot) | 60 (`nodeR + 4`) | Agentes raiz con icono robot |
| `ringStep` | 5 | Incremento por anillo concentrico |
| `ringWidth` | 3 | Grosor de anillo |
| `ringGap` | 2 | Espacio entre anillos |
| `colSpacing` | 300/240/200 | Segun cantidad de capas |
| `minRowSpacing` | 192 | Minimo entre centros verticales |
| `rowSpacing` | 260/230/200 | Segun cantidad de nodos/capa |
| `padding` | 70 | Margen SVG |
| `gridCell` | ~17 (`max(8, round(56*0.3))`) | Tamano de celda A* |
| `baseBlockMargin` | 25 | Margen hard alrededor de nodos |
| `softMargin` | 30 | Zona penalizada alrededor de nodos |
| `labelExtraBelow` | 55 | Extension del bloque debajo del nodo (label) |
| `edgePenalty` | `cellVal * 1.5` | Penalizacion por edge previo |
| `turnPenalty` | 0.5 | Penalizacion por cambio de direccion |
| `maxIter` | `min(15000, gridW*gridH*3)` | Iteraciones maximas A* |
| `labelCollisionR` | `labelR * 2.5` (~35px) | Radio de colision entre labels |
| Barycenter sweeps | 4 | Iteraciones de optimizacion de orden |
| `rootColors` | 20 colores | Pool de colores para agentes |
| `INFRA_SKILLS_FILTER` | Ops, Checkup, Cleanup, Monitor, Cost | Skills excluidos del grafo |
