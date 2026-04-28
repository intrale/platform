package ext.client

import ar.com.intrale.shared.client.ListBusinessZonesResponse

/**
 * Service publico que consume `GET /{business}/zones` (issue #2415).
 *
 * Es publico por diseno: el cliente final necesita ver las zonas de
 * cobertura para decidir si pedir o no. No requiere Bearer token, no
 * envia headers de autorizacion (Security A01).
 *
 * IMPORTANTE: NO confundir con `CommBusinessDeliveryZoneService` (admin
 * de zonas, segurizado) — aclaracion del analisis Guru en el issue
 * #2423.
 */
interface CommListBusinessZonesService {
    suspend fun listZones(businessId: String): Result<ListBusinessZonesResponse>
}
