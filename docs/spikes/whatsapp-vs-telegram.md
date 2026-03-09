# Spike: WhatsApp como canal alternativo y conviviente con Telegram

**Issue:** #1281
**Fecha:** 2026-03-09
**Autor:** Agente IA (spike de investigación)
**Estado:** Completado — Decisión arquitectónica incluida

---

## Resumen ejecutivo

Este spike evalúa la viabilidad de incorporar WhatsApp como canal de notificaciones paralelo a Telegram en el sistema de hooks de Intrale Platform. Después de analizar las opciones técnicas, costos, restricciones legales y el impacto en la arquitectura existente, **la recomendación es diferir la implementación** para el sistema interno de agentes, pero planificar WhatsApp como canal de notificaciones de producto (cliente/negocio) en un sprint dedicado futuro.

---

## 1. Contexto — Infraestructura actual (Telegram)

El sistema de hooks depende exclusivamente de Telegram con los siguientes módulos:

```
.claude/hooks/
├── telegram-client.js          # Núcleo HTTP: sendMessage, editMessage, sendPhoto, sendDocument
│                               #   Retry automático, rate limiting, truncado a 4096 chars
├── telegram-commander.js       # Daemon de comandos remotos: long polling getUpdates
│                               #   Recibe /skill, texto libre, audio → ejecuta Claude
├── permission-approver.js      # Hook PermissionRequest: envía pregunta → espera respuesta
│                               #   5 reintentos escalonados, timeout configurable
├── telegram-outbox.js          # Cola asíncrona: enqueue() → drain cada 500ms
└── telegram-message-registry.js  # Deduplicación y tracking de mensajes
```

**Interfaz efectiva de telegram-client.js:**
```javascript
sendMessage(text, opts)            // texto HTML, hasta 4096 chars
editMessage(messageId, text, opts) // editar mensaje existente in-place
sendPhoto(imageBuffer, caption)    // imagen PNG/JPG como buffer
sendDocument(fileBuffer, filename) // cualquier archivo
telegramPost(method, params)       // llamada raw a la API
```

**Modelo de comunicación entrante (Telegram):** Long polling → `getUpdates` con timeout 30s. No requiere servidor HTTPS público ni URL pública.

---

## 2. Opciones de API de WhatsApp disponibles

### 2.1 WhatsApp Business Platform — Meta Cloud API (oficial)

La opción más robusta y la única recomendada para uso en producción.

**Características técnicas:**
- Endpoint base: `https://graph.facebook.com/v{version}/{phone-number-id}/messages`
- Autenticación: Bearer token (System User Access Token de larga duración)
- **Comunicación entrante: webhooks HTTPS POST** (no hay long polling)
- Validación de webhooks: HMAC-SHA256 en header `X-Hub-Signature-256`
- Mensajes de texto libre entrantes: permitidos dentro de ventana de 24h
- Mensajes proactivos fuera de la ventana: solo via templates pre-aprobados

**Requisitos de onboarding:**
1. Cuenta Meta Business Manager verificada
2. Número de teléfono dedicado (no puede ser un número personal existente)
3. Proceso de verificación del negocio en Meta (puede tomar días/semanas)
4. Aprobación individual de cada template de mensaje proactivo

**Rate limits por tier:**

| Tier | Usuarios únicos/día | Cómo alcanzarlo |
|------|---------------------|-----------------|
| 1 | 1,000 | Estado inicial |
| 2 | 10,000 | Verificación + calidad + volumen |
| 3 | 100,000 | Progresión automática |
| Custom | Millones | Aprobación especial |

**Límite de API calls:** 20-50 calls/segundo según cuenta; 300/minuto por defecto.

### 2.2 WhatsApp Business API On-Premise (deprecated)

Meta anunció el fin de soporte de la versión on-premise. **No se recomienda para nuevas implementaciones.** Era un servidor Docker autoalojado que requería infraestructura propia y tenía mayor latencia. Meta está migrando todos los clientes a Cloud API.

### 2.3 Twilio for WhatsApp

Wrapper de pago sobre la Meta Cloud API.

**Ventajas:**
- Abstracción simplificada (SDK oficial para Node.js)
- Número de sandbox para testing sin verificación de empresa
- Soporte Enterprise con SLA

**Desventajas:**
- Costo adicional: USD 0.005/mensaje sobre el costo base de Meta
- Mayor latencia (capa intermedia)
- Dependencia de un proveedor adicional
- Para volúmenes altos, el costo extra es significativo

**Veredicto:** Solo justificado si se busca un sandbox rápido para pruebas. Para producción, Meta Cloud API directa es más económica.

### 2.4 Baileys / whatsapp-web.js (no-oficiales)

Bibliotecas que emulan WhatsApp Web via WebSocket.

**Arquitectura técnica de Baileys:**
- Protocolo: WebSocket al servidor de WhatsApp Web
- Codificación: protocolo binario XMPP-style
- Cifrado: Signal Protocol (E2E) + Noise Protocol (transporte seguro)
- No requiere servidor público (similar al long polling de Telegram)
- Licencia: MIT

**Riesgos graves identificados:**

| Riesgo | Severidad |
|--------|-----------|
| Baneo de número sin previo aviso | CRÍTICO |
| Violación de ToS de Meta | CRÍTICO |
| Incidente de seguridad dic-2025: paquete npm `baileys` envenenado en PyPI/npm que robaba mensajes y cuentas | CRÍTICO |
| Inestabilidad ante cambios de protocolo de WhatsApp Web | ALTO |
| Falsos positivos de baneo (usuarios reportan baneos incluso sin bots) | ALTO |

**Veredicto: DESCARTADO.** Los riesgos legales y operativos son inaceptables para un proyecto productivo.

---

## 3. Comparativa de costos

### 3.1 Meta Cloud API — Precios por conversación (Argentina, 2026)

> **Nota:** A partir de julio 2025, Meta migró a pricing por mensaje (no por conversación). Los valores a continuación reflejan la estructura más reciente disponible.

| Categoría | Costo (USD) | Descripción |
|-----------|-------------|-------------|
| Marketing | $0.0618 | Mensajes promocionales, campañas |
| Utility | $0.0260 | Notificaciones transaccionales, actualizaciones de estado |
| Authentication | $0.0260 | OTP, verificación de identidad |
| **Service** | **Gratuito** | Respuestas dentro de ventana de 24h |

**Comparativa regional Latinoamérica:**

| País | Marketing | Utility | Auth |
|------|-----------|---------|------|
| Argentina | $0.0618 | $0.026 | $0.026 |
| Brasil | $0.0625 | $0.0068 | $0.0068 |
| Chile | $0.0889 | $0.020 | $0.020 |
| Colombia | $0.0125 | $0.0008 | $0.0008 |
| México | $0.0305 | $0.0085 | $0.0085 |
| Perú | $0.0703 | $0.020 | $0.020 |

**Tier gratuito:** Las primeras 1,000 conversaciones/mes eran gratuitas bajo el modelo anterior. Con el nuevo modelo por mensaje (julio 2025), el free tier de servicio se mantiene (mensajes dentro de ventana 24h son gratuitos), pero los mensajes proactivos siempre pagan.

### 3.2 Twilio WhatsApp

| Componente | Costo |
|------------|-------|
| Por mensaje enviado | USD 0.005 + costo Meta |
| Número WhatsApp Business | USD 15/mes |
| Sandbox (pruebas) | Gratuito |

**Total estimado Twilio (Argentina):** USD 0.0618 + 0.005 = ~USD 0.067/mensaje marketing.

### 3.3 Baileys / whatsapp-web.js

- Costo API: $0 (sin costo de Meta)
- Costo real: riesgo de baneo permanente del número, consecuencias legales, riesgo de seguridad

---

## 4. Restricciones legales y de ToS

| Restricción | Detalle |
|-------------|---------|
| Bots en cuentas personales | **Prohibido** por Meta ToS |
| Automatización con Baileys | **Prohibido**, viola ToS, riesgo de baneo |
| Número dedicado obligatorio | No se puede usar un número personal existente |
| Verificación de empresa | Requiere Meta Business Manager verificado |
| Templates proactivos | Cada template debe aprobarse individualmente por Meta |
| Ventana de 24h | Fuera de la ventana, solo templates pre-aprobados |
| Regulación de datos (GDPR/Ley 25.326 AR) | Los mensajes pasan por servidores de Meta; considerar para datos sensibles |

**Implicación clave:** Para el sistema interno de agentes (hooks, permisos, comandos), los mensajes contienen información sensible de la operación de desarrollo. Pasarlos por la infraestructura de Meta puede ser inadecuado desde el punto de vista de confidencialidad.

---

## 5. Comparativa funcional: WhatsApp vs Telegram

### 5.1 Capacidades de mensajería

| Funcionalidad | Telegram | WhatsApp Cloud API | Notas |
|--------------|----------|--------------------|-------|
| Texto libre (salida) | ✅ Ilimitado | ✅ Hasta 4096 chars | WhatsApp soporta solo texto plano o markdown limitado |
| HTML en mensajes | ✅ Soporte completo | ❌ No soportado | WhatsApp: solo bold (`*`), italic (`_`), monospace (`` ` ``) |
| Edición de mensajes | ✅ `editMessage` | ❌ No disponible | Cambio de arquitectura significativo |
| Envío de fotos | ✅ | ✅ | Ambos soportan imágenes |
| Envío de documentos | ✅ | ✅ | Ambos soportan archivos |
| Audio/voz | ✅ | ✅ | Ambos soportan audio |

### 5.2 Botones interactivos

| Capacidad | Telegram | WhatsApp |
|-----------|----------|----------|
| Máx. botones por mensaje | ~100 | **3 quick reply buttons** |
| Opciones de lista | Sin límite | 10 opciones (list message) |
| Caracteres por botón | Sin límite práctico | **25 caracteres máx.** |
| Callback (sin mensaje visible) | ✅ `callback_query` | ❌ No disponible |
| Edición de botones post-envío | ✅ `editMessageReplyMarkup` | ❌ No disponible |
| Botones fuera de ventana 24h | ✅ Siempre | ❌ Solo en templates aprobados |

**Impacto en permission-approver.js:** El sistema actual usa botones inline con callback_query de Telegram. En WhatsApp, la aprobación de permisos debería implementarse con texto libre ("si"/"no") o con 3 quick reply buttons, lo que ya es compatible con el flujo actual de `pending-questions.json`.

### 5.3 Comunicación entrante (comandos remotos)

| Aspecto | Telegram | WhatsApp |
|---------|----------|----------|
| Protocolo | Long polling (`getUpdates`) | Webhook HTTPS POST |
| Servidor público requerido | ❌ No | ✅ Sí (HTTPS con certificado válido) |
| URL estática necesaria | ❌ No | ✅ Sí |
| Latencia | Baja (timeout 30s) | Muy baja (push inmediato) |

**Impacto crítico:** El `telegram-commander.js` (daemon de comandos remotos) usa long polling, que no requiere ningún servidor público. Para replicar comandos en WhatsApp, se necesitaría exponer un endpoint HTTPS accesible desde internet.

---

## 6. Opciones para webhooks sin servidor dedicado

Para recibir mensajes de WhatsApp sin un servidor cloud dedicado:

| Opción | Costo | URL Permanente | Disponibilidad |
|--------|-------|----------------|----------------|
| **Cloudflare Tunnel** | Gratuito | ✅ Sí, nunca cambia | ✅ Sin límites de ancho de banda |
| ngrok (plan gratuito) | Gratuito | ❌ Cambia en cada reinicio | ✅ Funcional para desarrollo |
| ngrok (plan pago) | USD 8-20/mes | ✅ Sí | ✅ |
| Render.com (free) | Gratuito | ✅ Sí | ⚠️ Se duerme tras 15 min sin actividad |
| Railway.app | USD 5+/mes | ✅ Sí | ✅ |

**Recomendación:** Cloudflare Tunnel (gratuito, URL permanente, sin límites). Requiere `cloudflared` instalado y una cuenta Cloudflare gratuita.

```bash
# Setup básico Cloudflare Tunnel
cloudflared tunnel create intrale-whatsapp
cloudflared tunnel route dns intrale-whatsapp whatsapp.intrale.app
cloudflared tunnel run --url localhost:3000 intrale-whatsapp
```

---

## 7. Propuesta de arquitectura dual-channel

Si se decide implementar WhatsApp como canal paralelo, esta es la arquitectura propuesta. **Esta sección es especulativa — no es un plan de implementación inmediato.**

### 7.1 Diagrama ASCII de la capa de abstracción

```
 ┌─────────────────────────────────────────────────────────────┐
 │                    HOOKS DE INTRALE                         │
 │   notify-telegram.js  │  permission-approver.js             │
 │   stop-notify.js      │  activity-logger.js                 │
 └──────────────────┬────────────────────────────────────────┘
                    │ (actualmente llaman a telegram-client.js)
                    ↓
 ┌─────────────────────────────────────────────────────────────┐
 │              messaging-router.js (NUEVO)                    │
 │  Lee messaging-config.json → decide canal(es) destino       │
 │  Broadcast: Telegram + WhatsApp                             │
 │  Interactive-only: solo Telegram                            │
 └────────────┬─────────────────────────┬───────────────────┘
              ↓                         ↓
 ┌────────────────────┐    ┌────────────────────────────────┐
 │  telegram-client.js│    │   whatsapp-client.js (NUEVO)   │
 │  (sin cambios)     │    │   Meta Cloud API               │
 │                    │    │   HTTPS puro, sin SDK          │
 └────────────────────┘    └────────────────────────────────┘
              ↓                         ↓
 ┌────────────────────┐    ┌────────────────────────────────┐
 │   Telegram Bot API │    │   Meta Graph API               │
 │   (long polling)   │    │   (webhook HTTPS)              │
 └────────────────────┘    └────────────────────────────────┘
```

### 7.2 Qué funcionalidades son portables a WhatsApp

| Funcionalidad actual (Telegram) | ¿Portable a WhatsApp? | Observaciones |
|--------------------------------|----------------------|---------------|
| Notificaciones de texto simple | ✅ Portable | Sin HTML; adaptar formato |
| Notificaciones con código/monospace | ⚠️ Parcial | Solo `` `backtick` `` funciona |
| Envío de fotos/capturas | ✅ Portable | Igual que Telegram |
| Envío de PDFs/reportes | ✅ Portable | Igual que Telegram |
| Edición de mensajes (progress updates) | ❌ No portable | WhatsApp no soporta `editMessage`; requiere nuevos mensajes |
| Aprobación de permisos (botones inline) | ⚠️ Parcial | Máximo 3 botones, sin callback; usar texto libre |
| Comandos /skill entrantes | ⚠️ Con restricciones | Requiere servidor webhook público (Cloudflare Tunnel) |
| Audio → Claude | ✅ Portable | WhatsApp soporta audio |
| Reintentos escalonados | ✅ Portable | Implementable |

### 7.3 Interfaz propuesta para messaging-client.js

```javascript
// messaging-client.js — Interfaz abstracta para dual-channel
module.exports = {
    sendMessage(text, opts)       // opts: { channels: ['telegram', 'whatsapp'], silent, ... }
    sendPhoto(buffer, caption)    // broadcast a los canales configurados
    sendDocument(buffer, filename, caption)
    editMessage(msgId, text)      // solo Telegram (WhatsApp no soporta edición)
    sendButtons(text, buttons)    // Telegram: inline keyboard; WhatsApp: quick reply (máx 3)
}
```

### 7.4 Estructura de messaging-config.json

Ver `.claude/hooks/messaging-config.json.example` para la configuración de ejemplo.

---

## 8. Estimación de esfuerzo de implementación

### Fase 1: Notificaciones básicas (WhatsApp como canal de solo salida)

| Tarea | Estimación |
|-------|-----------|
| whatsapp-client.js (sendMessage, sendPhoto, sendDocument) | 3-4 días |
| messaging-router.js (broadcast simple) | 1 día |
| Adaptadores de formato (HTML → WhatsApp markdown) | 1 día |
| Setup Cloudflare Tunnel (para recibir mensajes opcionales) | 0.5 días |
| Tests y validación | 2 días |
| **Subtotal Fase 1** | **~1.5 sprints** |

### Fase 2: Comandos entrantes desde WhatsApp

| Tarea | Estimación |
|-------|-----------|
| Servidor webhook Node.js (escucha POST de Meta) | 2 días |
| Adaptador de mensajes entrantes WhatsApp → formato interno | 2 días |
| Integración con telegram-commander.js o equivalente | 3-4 días |
| Seguridad: validación HMAC-SHA256 de payloads Meta | 1 día |
| **Subtotal Fase 2** | **~2 sprints** |

### Fase 3: Aprobación de permisos via WhatsApp

| Tarea | Estimación |
|-------|-----------|
| Adaptar permission-approver.js para quick reply buttons (máx 3) | 1 día |
| Integrar pending-questions.json con canal WhatsApp | 1 día |
| **Subtotal Fase 3** | **~0.5 sprints** |

**Total estimado para canal dual completo:** ~4 sprints (asumiendo sprints de 1 semana)

---

## 9. Análisis de seguridad

### Vectores de riesgo identificados

| Vector | Severidad | Mitigación |
|--------|-----------|------------|
| Tokens de WhatsApp en `messaging-config.json` | ALTA | Mismo patrón que `telegram-config.json` (gitignore local, sin commit) |
| Webhook sin validación HMAC | CRÍTICA | Obligatorio validar `X-Hub-Signature-256` en cada POST |
| Exposición de endpoint webhook | MEDIA | Cloudflare Tunnel con autenticación adicional si se expone |
| Información sensible en mensajes WhatsApp | MEDIA | Los mensajes pasan por servidores Meta; evitar datos de producción críticos |
| Paquetes npm maliciosos (Baileys) | CRÍTICA | **No usar Baileys.** Incidente documentado en dic-2025. |
| Número de teléfono baneado por Meta | ALTA | Usar solo Meta Cloud API oficial, nunca bibliotecas no-oficiales |

### Validación de webhooks (obligatorio si se implementa)

```javascript
// whatsapp-webhook-server.js — validación HMAC-SHA256 obligatoria
const crypto = require('crypto');

function validateWebhookSignature(req, rawBody) {
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return false;
    const expected = 'sha256=' + crypto
        .createHmac('sha256', APP_SECRET)
        .update(rawBody)
        .digest('hex');
    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
    );
}
```

---

## 10. Decisión arquitectónica recomendada

### Decisión: DIFERIR — con plan concreto para el futuro

**Para el sistema interno de agentes (hooks, permisos, comandos):**

**NO implementar WhatsApp en el corto plazo.** Las razones:

1. **El equipo ya usa Telegram eficientemente.** El canal funciona, es gratuito, y tiene capacidades superiores (edición de mensajes, botones ilimitados, long polling sin servidor).
2. **El cambio arquitectónico es significativo.** La falta de `editMessage` y el requisito de webhook requieren refactorizar partes críticas del sistema (progress updates, permission-approver con reintentos).
3. **No hay caso de uso urgente.** El equipo de desarrollo que usa los hooks ya tiene Telegram instalado.
4. **Costo/beneficio negativo a corto plazo.** Requiere ~4 sprints de trabajo para replicar la funcionalidad actual de Telegram.

**Para notificaciones de producto a clientes y negocios:**

**SÍ implementar WhatsApp en el mediano plazo** (Fase 1 solamente). WhatsApp tiene mayor adopción en Argentina que Telegram para usuarios finales. Las notificaciones de estado de pedido, confirmación de órdenes y comunicación con delivery son casos de uso ideales para WhatsApp Business API.

Esta implementación sería un módulo separado del sistema de hooks de agentes, orientado al producto Intrale (notificaciones a clientes, negocios, repartidores).

### Roadmap recomendado

```
Sprint actual:       Spike completado (este documento) ✅

Próximos 2 sprints:  Backlog - no implementar WhatsApp para hooks de agentes

Mediano plazo        Crear issue separado: "WhatsApp Business API para
(~3-6 meses):        notificaciones de producto a usuarios finales"
                     → Alcance: Fase 1 únicamente (salida de notificaciones)
                     → API: Meta Cloud API directa
                     → Tunnel: Cloudflare (gratuito)
                     → NO reemplaza Telegram para sistema de agentes

Largo plazo          Evaluar Fase 2+3 según adopción y feedback de usuarios
(si corresponde):    Comandos desde WhatsApp solo si hay demanda validada
```

### Criterio de revisión de la decisión

Reconsiderar la implementación para hooks de agentes si:
- Meta ofrece long polling o Server-Sent Events (cambio de protocolo)
- El equipo migra completamente a WhatsApp y abandona Telegram
- Hay un requerimiento de negocio específico que lo justifique

---

## 11. Referencias técnicas

- [WhatsApp Business Platform — Meta Developers](https://developers.facebook.com/docs/whatsapp/)
- [WhatsApp Cloud API — Pricing updates July 2025](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing/)
- [WhatsApp Business API Pricing 2026 — flowcall.co](https://www.flowcall.co/blog/whatsapp-business-api-pricing-2026)
- [WhatsApp API Rate Limits — wati.io](https://www.wati.io/en/blog/whatsapp-business-api/whatsapp-api-rate-limits/)
- [WhatsApp Interactive Reply Buttons — Meta Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages/)
- [Baileys — WhiskeySockets/Baileys en GitHub](https://github.com/WhiskeySockets/Baileys)
- [Baileys ban issues — Issue #1869](https://github.com/WhiskeySockets/Baileys/issues/1869)
- [Poisoned WhatsApp npm package — The Register, dic-2025](https://www.theregister.com/2025/12/22/whatsapp_npm_package_message_steal/)
- [Cloudflare Tunnel para webhooks persistentes — tareq.co](https://tareq.co/2025/11/local-webhook-cloudflare-tunnel/)
- [ngrok WhatsApp Webhooks](https://ngrok.com/docs/integrations/webhooks/whatsapp-webhooks)
- [Guide to WhatsApp Webhooks — hookdeck.com](https://hookdeck.com/webhooks/platforms/guide-to-whatsapp-webhooks-features-and-best-practices)
- [WhatsApp Business API Pricing 2025 — latenode.com](https://latenode.com/blog/integration-api-management/whatsapp-business-api/whatsapp-business-api-pricing-for-2025-understanding-costs-and-how-to-save)

---

*Documento generado como entregable del spike #1281. No implementar código hasta que se cree un issue específico con alcance definido.*
