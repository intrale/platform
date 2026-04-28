package ar.com.intrale.shared.client

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class ClientOrderItemDTO(
    val id: String? = null,
    val productId: String = "",
    val productName: String = "",
    val name: String = "",
    val quantity: Int = 0,
    val unitPrice: Double = 0.0,
    val subtotal: Double = 0.0
)

@Serializable
data class ClientOrderDTO(
    val id: String? = null,
    val publicId: String = "",
    val shortCode: String? = null,
    val businessName: String = "",
    val status: String = "",
    val items: List<ClientOrderItemDTO> = emptyList(),
    val total: Double = 0.0,
    val deliveryAddress: ClientAddressDTO? = null,
    val notes: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val promisedAt: String? = null,
    val itemCount: Int = 0,
    val assignedDeliveryPersonEmail: String? = null,
    val statusHistory: List<ClientOrderStatusEventDTO> = emptyList(),
    // Costo de envio congelado al momento del pedido (issue #2424 CA-7).
    // Se persiste server-side; el cliente NUNCA recalcula. null si el negocio
    // no tenia zonas configuradas.
    val shippingCost: Double? = null,
    val zoneName: String? = null
)

@Serializable
data class ClientOrderStatusEventDTO(
    val status: String = "",
    val timestamp: String = "",
    val message: String? = null
)

@Serializable
data class ClientOrderDetailDTO(
    val id: String? = null,
    val publicId: String = "",
    val shortCode: String = "",
    val businessName: String = "",
    val status: String = "",
    val createdAt: String = "",
    val promisedAt: String? = null,
    val total: Double = 0.0,
    val itemCount: Int = 0,
    val items: List<ClientOrderItemDTO> = emptyList(),
    val address: ClientAddressDTO? = null,
    val paymentMethod: String? = null,
    val statusHistory: List<ClientOrderStatusEventDTO> = emptyList(),
    val businessMessage: String? = null,
    val businessPhone: String? = null,
    // Costo de envio congelado al momento del pedido (issue #2424 CA-7).
    // Es la fuente de verdad para todas las pantallas del cliente
    // (historial, detalle, notificaciones); el cliente NUNCA recalcula.
    val shippingCost: Double? = null,
    val zoneName: String? = null
)

@Serializable
data class ClientOrdersResponse(
    val statusCode: StatusCodeDTO? = null,
    val orders: List<ClientOrderDTO>? = null
)

@Serializable
data class ClientOrderDetailResponse(
    val statusCode: StatusCodeDTO? = null,
    val order: ClientOrderDetailDTO? = null
)

@Serializable
data class ClientOrderRequest(
    val orderId: String? = null
)

/**
 * Request de creacion de pedido (issue #2424).
 *
 * Tamper-proofing (Security A04 - CA-8): este DTO NUNCA debe contener un campo
 * `shippingCost` ni cualquier otra cifra de precio que el cliente pueda
 * manipular. El backend recalcula `shippingCost` server-side a partir de
 * `{businessId, lat, lng, zoneId}` y lo persiste como snapshot inmutable
 * (responsabilidad de backend issue #2415).
 *
 * Coordenadas (`lat`/`lng`) son las verificadas por la pantalla de
 * verificacion de direccion (Hija A #2422). Validar con Konform en pre-submit
 * (CA-9). NUNCA loguear coords (CA-10).
 */
@Serializable
data class CreateClientOrderRequestDTO(
    val items: List<CreateClientOrderItemDTO> = emptyList(),
    val addressId: String? = null,
    val paymentMethodId: String? = null,
    val notes: String? = null,
    val businessId: String? = null,
    val lat: Double? = null,
    val lng: Double? = null,
    // `zoneId` se envia solo como hint; el backend revalida desde coords + businessId.
    val zoneId: String? = null
)

@Serializable
data class CreateClientOrderItemDTO(
    val productId: String = "",
    val productName: String = "",
    val quantity: Int = 0,
    val unitPrice: Double = 0.0
)

@Serializable
data class CreateClientOrderResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val orderId: String = "",
    val shortCode: String = "",
    val status: String = "PENDING",
    // shippingCost autoritativo del backend (recalculado server-side).
    // Es el unico valor que la UI post-submit debe mostrar (issue #2424 CA-13).
    val shippingCost: Double? = null,
    val zoneName: String? = null
)
