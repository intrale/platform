#!/usr/bin/env node
/**
 * Generador de la spec OpenAPI SERVIDA en runtime (users/src/main/resources/openapi.yaml).
 * Issue #4300 (CA-2). Fuente de verdad de la enumeración: users/.../Modules.kt (bind<Function>(tag=...)).
 *
 * Uso (desde la raíz del repo):
 *   node users/openapi/gen-openapi.js
 *
 * Anti-drift: users:OpenApiCoverageTest verifica que todo tag de Modules.kt esté cubierto aquí.
 * NOTA: docs/api/openapi.yaml es una spec de diseño (vista REST idealizada, usada por skills del
 * pipeline); este artefacto es la spec tag-fiel que sirve el Lambda en /openapi.yaml.
 */
const fs = require("fs");
const cp = require("child_process");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const MODULES = path.join(REPO, "users/src/main/kotlin/ar/com/intrale/Modules.kt");
const OUT = path.join(REPO, "users/src/main/resources/openapi.yaml");

const mod = fs.readFileSync(MODULES, "utf8");
const bindRe = /bind<Function>\s*\(tag="([^"]+)"\)\s*\{\s*singleton\s*\{\s*([A-Za-z0-9_]+)/g;
let m, bindings = [];
while ((m = bindRe.exec(mod))) bindings.push([m[1], m[2]]);

function isSecured(cls) {
  let files = [];
  try {
    files = cp.execSync(
      `grep -rl "class ${cls}" "${REPO}/users/src/main/kotlin" "${REPO}/backend/src/main/kotlin" --include=*.kt`
    ).toString().trim().split("\n").filter(Boolean);
  } catch (e) { return false; }
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    const idx = t.search(new RegExp("class\\s+" + cls + "\\b"));
    if (idx < 0) continue;
    const window = t.slice(idx, idx + 500);
    if (/:\s*SecuredFunction|,\s*SecuredFunction|SecuredFunction\s*\(/.test(window)) return true;
  }
  return false;
}

const secured = {};
for (const [tag, cls] of bindings) secured[tag] = isSecured(cls);

// [tag, verbo, grupo, summary] — verbo/summary son declarativos (el borde HTTP no los conoce).
const ENDPOINTS = [
  ["signup", "post", "Autenticación", "Registrar un nuevo usuario"],
  ["signupPlatformAdmin", "post", "Autenticación", "Registrar un administrador de plataforma"],
  ["signupDelivery", "post", "Autenticación", "Registrar un usuario repartidor"],
  ["signin", "post", "Autenticación", "Iniciar sesión y obtener token"],
  ["validate", "post", "Autenticación", "Validar sesión / token del usuario"],
  ["recovery", "post", "Autenticación", "Iniciar recuperación de contraseña"],
  ["confirm", "post", "Autenticación", "Confirmar recuperación de contraseña"],
  ["confirmSignUp", "post", "Autenticación", "Confirmar registro de usuario"],
  ["changePassword", "post", "Autenticación", "Cambiar la contraseña del usuario"],
  ["2fasetup", "post", "Autenticación", "Configurar segundo factor (2FA)"],
  ["2faverify", "post", "Autenticación", "Verificar segundo factor (2FA)"],
  ["profiles", "post", "Perfiles", "Consultar perfiles del usuario"],
  ["assignProfile", "post", "Perfiles", "Asignar un perfil a un usuario"],
  ["registerSaler", "post", "Perfiles", "Registrar un vendedor"],
  ["registerBusiness", "post", "Negocios", "Registrar un nuevo negocio"],
  ["reviewBusiness", "post", "Negocios", "Revisar el registro de un negocio"],
  ["requestJoinBusiness", "post", "Negocios", "Solicitar unirse a un negocio"],
  ["reviewJoinBusiness", "post", "Negocios", "Revisar una solicitud de unión a un negocio"],
  ["searchBusinesses", "get", "Negocios", "Buscar negocios disponibles"],
  ["business/config", "post", "Negocios", "Gestionar la configuración del negocio"],
  ["business/schedules", "post", "Negocios", "Gestionar los horarios del negocio"],
  ["business/delivery-zone", "post", "Negocios", "Gestionar la zona de reparto del negocio"],
  ["business/fonts", "post", "Negocios", "Gestionar las tipografías del negocio"],
  ["business/orders", "post", "Negocios", "Consultar los pedidos del negocio"],
  ["business/categories", "post", "Negocios", "Gestionar las categorías del negocio"],
  ["business/payment-methods", "post", "Negocios", "Gestionar los medios de pago del negocio"],
  ["business/anomalies", "post", "Negocios", "Consultar anomalías de pedidos del negocio"],
  ["business/products", "post", "Productos", "Gestionar los productos del negocio"],
  ["business/products/analyze-photo", "post", "Productos", "Analizar la foto de un producto"],
  ["products", "get", "Productos", "Listar productos disponibles"],
  ["products/suggestions", "get", "Productos", "Obtener sugerencias de productos"],
  ["products/search-history", "post", "Productos", "Gestionar el historial de búsqueda de productos"],
  ["client/products/availability", "post", "Productos", "Consultar disponibilidad de productos"],
  ["client/profile", "post", "Clientes", "Gestionar el perfil del cliente"],
  ["client/addresses", "post", "Clientes", "Gestionar las direcciones del cliente"],
  ["client/orders", "post", "Clientes", "Consultar los pedidos del cliente"],
  ["client/order-detail", "post", "Clientes", "Consultar el detalle de un pedido del cliente"],
  ["client/payment-methods", "post", "Clientes", "Gestionar los medios de pago del cliente"],
  ["delivery/profile", "post", "Reparto", "Gestionar el perfil del repartidor"],
  ["delivery/orders", "post", "Reparto", "Consultar los pedidos del repartidor"],
  ["configAutoAcceptDeliveries", "post", "Reparto", "Configurar la auto-aceptación de entregas"],
  ["zones", "get", "Zonas", "Listar zonas de reparto"],
  ["zones/check", "get", "Zonas", "Verificar cobertura de una zona"],
  ["auto-response", "post", "Automatización", "Generar respuesta automática"],
  ["business/auto-response-config", "post", "Automatización", "Configurar respuestas automáticas del negocio"],
];

// El generador debe cubrir EXACTAMENTE los tags de Modules.kt.
const declaredTags = Object.keys(secured).sort();
const listedTags = ENDPOINTS.map(e => e[0]).sort();
const missing = declaredTags.filter(t => !listedTags.includes(t));
const extra = listedTags.filter(t => !declaredTags.includes(t));
if (missing.length || extra.length) {
  console.error("MISMATCH — actualizar ENDPOINTS. missing=", missing, "extra=", extra);
  process.exit(1);
}

const groups = [...new Set(ENDPOINTS.map(e => e[2]))];
const esc = s => s.replace(/'/g, "''");
let y = "";
y += "# Especificación OpenAPI SERVIDA por el backend (/openapi.yaml) — issue #4300.\n";
y += "# NO editar a mano: regenerar con `node users/openapi/gen-openapi.js`.\n";
y += "# Fuente de verdad de la enumeración: users/src/main/kotlin/ar/com/intrale/Modules.kt.\n";
y += "# Cobertura verificada por users:OpenApiCoverageTest.\n";
y += "openapi: 3.0.3\n";
y += "info:\n";
y += "  title: Intrale API\n";
y += "  version: '1.0'\n";
y += "  description: >-\n";
y += "    Contrato uniforme de los endpoints del backend Ktor de Intrale. Todas las funciones se\n";
y += "    invocan sobre la ruta dinámica `/{business}/{function...}` y devuelven el patrón\n";
y += "    `Response(statusCode, responseHeaders)`. El verbo HTTP real lo resuelve el backend por el\n";
y += "    header `X-Http-Method`. Ver docs/engineering/api-contract-standard.md.\n";
y += "servers:\n";
y += "  - url: http://localhost:8080\n";
y += "    description: Entorno local / no productivo (destino por defecto de \"Try It Out\")\n";
y += "tags:\n";
for (const g of groups) y += `  - name: ${g}\n`;
y += "paths:\n";
y += "  /health:\n";
y += "    get:\n";
y += "      tags: [Salud]\n";
y += "      summary: Health check del servicio\n";
y += "      responses:\n";
y += "        '200':\n";
y += "          description: Servicio operativo\n";
y += "          content:\n";
y += "            application/json:\n";
y += "              schema: { $ref: '#/components/schemas/HealthResponse' }\n";

for (const [tag, verb, group, summary] of ENDPOINTS) {
  const isSec = secured[tag] === true;
  const opId = tag.replace(/[^A-Za-z0-9]+/g, "_");
  y += `  /{business}/${tag}:\n`;
  y += `    ${verb}:\n`;
  y += `      tags: [${group}]\n`;
  y += `      operationId: ${verb}_${opId}\n`;
  y += `      summary: '${esc(summary)}'\n`;
  y += `      description: >-\n`;
  y += `        Endpoint \`${tag}\`.${isSec ? " Requiere JWT válido (bearerAuth, validado por SecuredFunction/Cognito)." : " Endpoint público (no requiere autenticación)."}\n`;
  if (isSec) y += `      security:\n        - bearerAuth: []\n`;
  y += `      parameters:\n`;
  y += `        - name: business\n          in: path\n          required: true\n          description: Identificador del negocio (multitenant).\n          schema: { type: string }\n          example: intrale\n`;
  y += `        - name: X-Http-Method\n          in: header\n          required: false\n          description: Verbo lógico resuelto por el backend sobre la ruta catch-all.\n          schema: { type: string, enum: [POST, GET, PUT, DELETE] }\n`;
  if (verb === "post") {
    y += `      requestBody:\n`;
    y += `        required: false\n`;
    y += `        content:\n`;
    y += `          application/json:\n`;
    y += `            schema: { type: object, description: 'Cuerpo JSON del request (recibido como textBody por la función).' }\n`;
    y += `            example: {}\n`;
  }
  y += `      responses:\n`;
  y += `        '200':\n          description: Operación exitosa\n          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/Response' }\n`;
  y += `        '400':\n          description: Request inválido (RequestValidationException)\n          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/ExceptionResponse' }\n`;
  if (isSec) {
    y += `        '401':\n          description: Token ausente o inválido (UnauthorizedException)\n          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/ExceptionResponse' }\n`;
  }
  y += `        '500':\n          description: Error interno (ExceptionResponse)\n          content:\n            application/json:\n              schema: { $ref: '#/components/schemas/ExceptionResponse' }\n`;
}

y += "components:\n";
y += "  securitySchemes:\n";
y += "    bearerAuth:\n";
y += "      type: http\n";
y += "      scheme: bearer\n";
y += "      bearerFormat: JWT\n";
y += "      description: >-\n";
y += "        Token JWT de Cognito enviado en el header `Authorization`. La UI lo mantiene sólo en\n";
y += "        memoria del navegador; nunca se persiste ni se registra en logs.\n";
y += "  schemas:\n";
y += "    Response:\n";
y += "      type: object\n";
y += "      description: Patrón base de respuesta del backend.\n";
y += "      properties:\n";
y += "        statusCode: { type: integer, example: 200 }\n";
y += "        responseHeaders: { type: object, additionalProperties: { type: string } }\n";
y += "    ExceptionResponse:\n";
y += "      type: object\n";
y += "      description: Respuesta de error uniforme.\n";
y += "      properties:\n";
y += "        statusCode: { type: integer, example: 400 }\n";
y += "        message: { type: string, example: 'Descripción del error' }\n";
y += "    HealthResponse:\n";
y += "      type: object\n";
y += "      properties:\n";
y += "        status: { type: string, example: UP }\n";

fs.writeFileSync(OUT, y);
console.log(`OK: ${OUT} (${y.length} bytes, ${ENDPOINTS.length} endpoints, ${Object.values(secured).filter(Boolean).length} secured)`);
