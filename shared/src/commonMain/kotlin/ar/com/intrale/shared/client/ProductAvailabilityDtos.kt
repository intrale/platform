package ar.com.intrale.shared.client

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

/**
 * Motivo por el cual un producto no esta disponible para pedido.
 */
@Serializable
enum class SkipReason {
    /** Producto existe pero sin stock */
    OUT_OF_STOCK,
    /** Producto descontinuado (status != PUBLISHED) */
    DISCONTINUED,
    /** Producto no disponible (isAvailable = false, pero publicado) */
    UNAVAILABLE,
    /** ID no existe en el catalogo del negocio */
    UNKNOWN_PRODUCT
}

@Serializable
data class ProductAvailabilityRequestDTO(
    val productIds: List<String> = emptyList()
)

@Serializable
data class ProductAvailabilityItemDTO(
    val productId: String,
    val available: Boolean,
    val reason: SkipReason? = null
)

@Serializable
data class ProductAvailabilityResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val items: List<ProductAvailabilityItemDTO> = emptyList()
)
