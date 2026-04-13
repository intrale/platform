package ar.com.intrale.shared.client

import kotlinx.serialization.Serializable

/**
 * Motivo por el que un producto no está disponible para agregar al carrito.
 */
@Serializable
enum class SkipReason {
    /** Producto existe pero sin stock */
    OUT_OF_STOCK,
    /** Producto discontinuado (status != PUBLISHED) */
    DISCONTINUED,
    /** Producto marcado como no disponible */
    UNAVAILABLE,
    /** ID no existe en el catálogo del negocio */
    UNKNOWN_PRODUCT
}

@Serializable
data class ProductAvailabilityRequestDTO(
    val productIds: List<String> = emptyList()
)

@Serializable
data class ProductAvailabilityItemDTO(
    val productId: String,
    val name: String = "",
    val available: Boolean,
    val reason: SkipReason? = null
)

@Serializable
data class ProductAvailabilityResponseDTO(
    val items: List<ProductAvailabilityItemDTO> = emptyList()
)
