package ext.business

import ar.com.intrale.shared.business.DeliveryZoneDTO

/**
 * Servicio de comunicacion del backend para zonas de delivery (split 1 read-only #2420).
 *
 * Solo expone GET. Las mutaciones (POST/PUT/DELETE) llegan en split 2 (#2421).
 */
interface CommDeliveryZonesService {
    suspend fun list(businessId: String): Result<List<DeliveryZoneDTO>>
}
