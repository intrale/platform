package ext.business

import kotlinx.serialization.json.Json

/**
 * Actual desktop — usa cache in-memory. El feature de zonas con mapa interactivo
 * es Android-only en split 1 #2420; el desktop solo necesita compilar.
 */
@Suppress("UNUSED_PARAMETER")
actual fun createDeliveryZonesCache(json: Json): CommDeliveryZonesCache =
    InMemoryDeliveryZonesCache()
