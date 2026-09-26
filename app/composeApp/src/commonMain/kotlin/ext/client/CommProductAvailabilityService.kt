// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

package ext.client

import ar.com.intrale.shared.client.ProductAvailabilityResponseDTO

/**
 * Interfaz del servicio de consulta de disponibilidad de productos.
 */
interface CommProductAvailabilityService {
    suspend fun checkAvailability(productIds: List<String>): Result<ProductAvailabilityResponseDTO>
}
