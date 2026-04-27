package ext.business

import kotlinx.serialization.json.Json

/**
 * Actual Android — produce un cache con DataStore Preferences (CA-5-L de #2420).
 *
 * Requiere que `AppContextHolder.init(...)` se haya llamado desde MainActivity
 * antes del primer acceso. Si no, lanza error claro de inicializacion.
 */
actual fun createDeliveryZonesCache(json: Json): CommDeliveryZonesCache =
    AndroidDeliveryZonesCache(AppContextHolder.requireContext(), json)
