package ext.business

import ar.com.intrale.shared.business.DeliveryZoneDTO

/**
 * Cache local de zonas de delivery — habilita el modo offline read-only (CA-5-L de #2420).
 *
 * - `read(businessId)` carga lo guardado para ese negocio (o emptyList si nunca
 *   se sincronizo, lo cual el UI distingue como empty-state vs. error).
 * - `write(businessId, zones)` reemplaza el snapshot tras un fetch exitoso.
 * - `clear()` borra todo (logout / cambio de negocio activo — multi-tenant).
 *
 * La implementacion Android usa `androidx.datastore:datastore-preferences:1.1.1`.
 * En desktop / web / iOS hay impls in-memory triviales (no son targets prioritarios
 * de este split).
 */
interface CommDeliveryZonesCache {
    suspend fun read(businessId: String): List<DeliveryZoneDTO>
    suspend fun write(businessId: String, zones: List<DeliveryZoneDTO>)
    suspend fun clear()
}
