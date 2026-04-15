package ext.client

import ar.com.intrale.shared.client.ProductAvailabilityItemDTO
import ar.com.intrale.shared.client.ProductAvailabilityResponseDTO

/**
 * Interfaz para consultar la disponibilidad de productos en batch.
 */
interface CommClientProductsAvailabilityService {
    suspend fun checkAvailability(productIds: List<String>): Result<List<ProductAvailabilityItemDTO>>
}
