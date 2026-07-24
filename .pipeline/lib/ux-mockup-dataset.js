// =============================================================================
// ux-mockup-dataset.js — Dataset sintético para mockups por flavor
// Issue #3408 · CA-UX-3 + CA-S2 (zero PII, contexto argentino)
//
// Qué hace:
//   Expone tres bancos de datos sintéticos hardcodeados (`client`, `business`,
//   `delivery`), cada uno con ~20 items realistas inventados, listos para
//   alimentar el prompt del LLM cuando un mockup necesita representar
//   listados. Cero PII real. Toda la data está hecha a propósito ficticia y
//   marcada como "demo" (teléfonos `+54 11 0000-XXXX`, dominios ejemplo.com,
//   precios redondos, etc.).
//
// Por qué este archivo:
//   El generator (#3381) NO debe construir el prompt usando texto literal del
//   body del issue (CA-S2 — prompt injection / PII zero-leak). En su lugar,
//   cuando el cambio del issue menciona listados/items, el skill `/ux` toma
//   muestras de este dataset y las inyecta como datos representativos del
//   flavor en el prompt.
//
// Tests: lib/__tests__/ux-mockup-dataset.test.js
// =============================================================================

'use strict';

// -----------------------------------------------------------------------------
// Banco: client (vidriera / catálogo / carrito / pedidos del consumidor final)
// -----------------------------------------------------------------------------

const CLIENT_PRODUCTS = Object.freeze([
  { name: 'Café tostado 250g', price: 2450, category: 'Almacén' },
  { name: 'Yerba mate orgánica 500g', price: 3200, category: 'Almacén' },
  { name: 'Aceite de oliva 500ml', price: 4100, category: 'Almacén' },
  { name: 'Pan integral artesanal', price: 1800, category: 'Panadería' },
  { name: 'Medialunas x6', price: 2100, category: 'Panadería' },
  { name: 'Queso cremoso 500g', price: 3650, category: 'Fiambres' },
  { name: 'Jamón cocido 200g', price: 2890, category: 'Fiambres' },
  { name: 'Pizza muzzarella congelada', price: 2750, category: 'Congelados' },
  { name: 'Helado 1kg', price: 5200, category: 'Heladería' },
  { name: 'Empanadas x12', price: 6800, category: 'Rotisería' },
  { name: 'Milanesa de pollo x4', price: 4500, category: 'Rotisería' },
  { name: 'Ensalada caprese', price: 3200, category: 'Rotisería' },
  { name: 'Vino malbec 750ml', price: 4900, category: 'Bebidas' },
  { name: 'Cerveza artesanal 473ml', price: 1850, category: 'Bebidas' },
  { name: 'Gaseosa 2.25L', price: 1450, category: 'Bebidas' },
  { name: 'Galletitas dulces x3', price: 2200, category: 'Almacén' },
  { name: 'Manteca 200g', price: 1900, category: 'Lácteos' },
  { name: 'Leche entera 1L', price: 1250, category: 'Lácteos' },
  { name: 'Yogur natural 1kg', price: 2400, category: 'Lácteos' },
  { name: 'Banana x kg', price: 1600, category: 'Verdulería' },
]);

const CLIENT_STORES = Object.freeze([
  'Almacén Don Mario',
  'Pizzería La Vecindad',
  'Verdulería El Trébol',
  'Panadería La Espiga',
  'Carnicería La Estancia',
  'Rotisería Mi Barrio',
  'Heladería Frizz',
  'Vinoteca Tres Tintos',
  'Café Esquina Pampa',
  'Mercadito San Andrés',
]);

// -----------------------------------------------------------------------------
// Banco: business (pedidos entrantes / gestión / métricas del comerciante)
// -----------------------------------------------------------------------------

const BUSINESS_ORDERS = Object.freeze([
  { id: '#A-1024', customer: 'Cliente Demo 01', items: 3, total: 8450, status: 'Pendiente' },
  { id: '#A-1025', customer: 'Cliente Demo 02', items: 1, total: 2450, status: 'Confirmado' },
  { id: '#A-1026', customer: 'Cliente Demo 03', items: 5, total: 12300, status: 'En preparación' },
  { id: '#A-1027', customer: 'Cliente Demo 04', items: 2, total: 4900, status: 'Listo' },
  { id: '#A-1028', customer: 'Cliente Demo 05', items: 4, total: 9750, status: 'En camino' },
  { id: '#A-1029', customer: 'Cliente Demo 06', items: 2, total: 5600, status: 'Entregado' },
  { id: '#A-1030', customer: 'Cliente Demo 07', items: 6, total: 14200, status: 'Pendiente' },
  { id: '#A-1031', customer: 'Cliente Demo 08', items: 1, total: 1850, status: 'Cancelado' },
  { id: '#A-1032', customer: 'Cliente Demo 09', items: 3, total: 7100, status: 'En preparación' },
  { id: '#A-1033', customer: 'Cliente Demo 10', items: 2, total: 4300, status: 'Confirmado' },
]);

const BUSINESS_METRICS = Object.freeze([
  { label: 'Pedidos del día', value: '24' },
  { label: 'Facturación hoy', value: '$72.450' },
  { label: 'Ticket promedio', value: '$3.018' },
  { label: 'Clientes nuevos', value: '5' },
  { label: 'Tasa de conversión', value: '12,4 %' },
  { label: 'Productos sin stock', value: '3' },
  { label: 'Tiempo promedio de preparación', value: '14 min' },
  { label: 'Reseñas pendientes', value: '7' },
]);

const BUSINESS_CATALOG_ACTIONS = Object.freeze([
  'Agregar producto',
  'Importar catálogo',
  'Editar precios',
  'Pausar producto',
  'Actualizar stock',
  'Ver reseñas',
  'Configurar horarios',
  'Promociones activas',
]);

// -----------------------------------------------------------------------------
// Banco: delivery (rutas / paradas / estados del repartidor)
// -----------------------------------------------------------------------------

const DELIVERY_STOPS = Object.freeze([
  { id: '#R-2031', address: 'Av. Corrientes 1234, Dpto B', distance: '1,2 km', eta: '8 min', status: 'Próxima' },
  { id: '#R-2032', address: 'Av. Rivadavia 4567', distance: '2,5 km', eta: '12 min', status: 'En ruta' },
  { id: '#R-2033', address: 'Calle Falsa 123, PB', distance: '3,1 km', eta: '18 min', status: 'En ruta' },
  { id: '#R-2034', address: 'Av. Pueyrredón 890, 4°A', distance: '4,0 km', eta: '22 min', status: 'Asignada' },
  { id: '#R-2035', address: 'Av. Santa Fe 2345', distance: '5,2 km', eta: '28 min', status: 'Asignada' },
  { id: '#R-2036', address: 'Av. Cabildo 1567', distance: '6,8 km', eta: '34 min', status: 'Asignada' },
  { id: '#R-2037', address: 'Av. Las Heras 3210', distance: '7,1 km', eta: '38 min', status: 'Asignada' },
  { id: '#R-2038', address: 'Av. Belgrano 4500, PB', distance: '8,4 km', eta: '45 min', status: 'Asignada' },
]);

const DELIVERY_ROUTES = Object.freeze([
  { id: '#RUTA-101', stops: 5, totalKm: '12,4 km', estTime: '1h 15min' },
  { id: '#RUTA-102', stops: 8, totalKm: '21,2 km', estTime: '2h 05min' },
  { id: '#RUTA-103', stops: 3, totalKm: '7,5 km', estTime: '0h 45min' },
  { id: '#RUTA-104', stops: 6, totalKm: '15,8 km', estTime: '1h 30min' },
]);

const DELIVERY_STATUSES = Object.freeze([
  'Asignada',
  'Próxima',
  'En ruta',
  'Llegando',
  'En el comercio',
  'Retirado',
  'Entregando',
  'Entregado',
  'Reprogramada',
  'Cancelada',
]);

// -----------------------------------------------------------------------------
// Constantes generales — contactos demo / locales / texto auxiliar
// -----------------------------------------------------------------------------

const DEMO_PHONES = Object.freeze([
  '+54 11 0000-0001',
  '+54 11 0000-0002',
  '+54 11 0000-0003',
  '+54 11 0000-0004',
  '+54 11 0000-0005',
]);

const DEMO_EMAILS = Object.freeze([
  'demo01@ejemplo.com',
  'demo02@ejemplo.com',
  'demo03@ejemplo.com',
]);

const ADDRESSES_AR = Object.freeze([
  'Av. Corrientes 1234',
  'Av. Rivadavia 4567',
  'Av. Santa Fe 2345',
  'Av. Cabildo 1567',
  'Av. Pueyrredón 890',
  'Av. Las Heras 3210',
  'Av. Belgrano 4500',
]);

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

const BANCOS = Object.freeze({
  client: Object.freeze({
    products: CLIENT_PRODUCTS,
    stores: CLIENT_STORES,
    phones: DEMO_PHONES,
    emails: DEMO_EMAILS,
    addresses: ADDRESSES_AR,
  }),
  business: Object.freeze({
    orders: BUSINESS_ORDERS,
    metrics: BUSINESS_METRICS,
    catalogActions: BUSINESS_CATALOG_ACTIONS,
    phones: DEMO_PHONES,
    addresses: ADDRESSES_AR,
  }),
  delivery: Object.freeze({
    stops: DELIVERY_STOPS,
    routes: DELIVERY_ROUTES,
    statuses: DELIVERY_STATUSES,
    addresses: ADDRESSES_AR,
  }),
});

const FLAVORS_VALIDOS = Object.freeze(['client', 'business', 'delivery']);

/**
 * Devuelve el banco completo para un flavor dado, o null si el flavor es
 * desconocido. Lo expuesto es inmutable (Object.freeze recursivo).
 *
 * @param {'client'|'business'|'delivery'} flavor
 * @returns {object|null}
 */
function getBanco(flavor) {
  if (typeof flavor !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(BANCOS, flavor)) return null;
  return BANCOS[flavor];
}

/**
 * Devuelve una muestra de N items del banco del flavor, para el "tipo" de
 * dato pedido (`products`, `orders`, `stops`, etc.). Si el tipo no existe en
 * ese flavor, devuelve `[]`. Para mantener determinismo (testabilidad), el
 * sample es secuencial desde el inicio del array — NO random.
 *
 * Para inyección en el prompt LLM, el ordenamiento determinista importa para
 * que el mismo issue genere mockups idénticos en reruns (CA-UX-11 del
 * generator usa temperature 0.3).
 *
 * @param {'client'|'business'|'delivery'} flavor
 * @param {string} tipo — `products`, `orders`, `stops`, `metrics`, etc.
 * @param {number} [n=5]
 * @returns {Array}
 */
function sample(flavor, tipo, n) {
  const banco = getBanco(flavor);
  if (!banco) return [];
  const arr = banco[tipo];
  if (!Array.isArray(arr)) return [];
  const count = (typeof n === 'number' && n > 0 && Number.isFinite(n))
    ? Math.min(Math.floor(n), arr.length)
    : Math.min(5, arr.length);
  return arr.slice(0, count);
}

/**
 * Indica si una descripción del cambio sugiere un "listado" — sirve al skill
 * `/ux` para decidir si debe inyectar dataset al prompt o no.
 *
 * Heurística simple, parseable, anti-ReDoS: palabras clave fijas en una
 * pasada lineal sobre lowercase.
 *
 * @param {string} text
 * @returns {boolean}
 */
function mentionsListado(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  // Limitar longitud para evitar pasadas costosas sobre inputs gigantes.
  const t = text.slice(0, 8192).toLowerCase();
  const KEYS = [
    'lista', 'listado', 'listas', 'listados',
    'tabla', 'grid', 'feed',
    'pedidos', 'pedido',
    'productos', 'producto', 'catálogo', 'catalogo',
    'paradas', 'rutas',
    'historial', 'movimientos',
    'items', 'ítems',
    'búsqueda', 'busqueda', 'resultados',
  ];
  for (const k of KEYS) {
    if (t.indexOf(k) !== -1) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
  // bancos completos
  BANCOS,
  FLAVORS_VALIDOS,
  // bancos individuales (para tests)
  CLIENT_PRODUCTS,
  CLIENT_STORES,
  BUSINESS_ORDERS,
  BUSINESS_METRICS,
  BUSINESS_CATALOG_ACTIONS,
  DELIVERY_STOPS,
  DELIVERY_ROUTES,
  DELIVERY_STATUSES,
  DEMO_PHONES,
  DEMO_EMAILS,
  ADDRESSES_AR,
  // API
  getBanco,
  sample,
  mentionsListado,
};
