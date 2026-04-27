package ext.business

import ar.com.intrale.shared.business.DeliveryZoneDTO

/**
 * Implementacion in-memory de `CommDeliveryZonesCache` — usada en targets que no
 * son Android (desktop, iOS, web), o como fake en tests del ViewModel.
 *
 * El estado se mantiene en una map por proceso. NO persiste entre sesiones.
 * Para los targets no-Android del split 1 (#2420) esto es suficiente; el flujo
 * offline real solo se evalua en QA Android.
 */
class InMemoryDeliveryZonesCache : CommDeliveryZonesCache {

    private val store: MutableMap<String, List<DeliveryZoneDTO>> = mutableMapOf()

    override suspend fun read(businessId: String): List<DeliveryZoneDTO> =
        store[businessId].orEmpty()

    override suspend fun write(businessId: String, zones: List<DeliveryZoneDTO>) {
        store[businessId] = zones
    }

    override suspend fun clear() {
        store.clear()
    }
}
