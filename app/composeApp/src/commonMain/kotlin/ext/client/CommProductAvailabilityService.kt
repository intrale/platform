package ext.client

import ar.com.intrale.shared.client.ProductAvailabilityResponseDTO

/**
 * Interfaz del servicio de consulta de disponibilidad de productos.
 */
interface CommProductAvailabilityService {
    suspend fun checkAvailability(productIds: List<String>): Result<ProductAvailabilityResponseDTO>
}
