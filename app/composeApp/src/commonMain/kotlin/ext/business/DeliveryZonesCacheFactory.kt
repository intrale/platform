package ext.business

import kotlinx.serialization.json.Json

/**
 * Factory expect/actual para construir el cache de zonas de delivery (#2420).
 *
 * - Android: produce `AndroidDeliveryZonesCache` con DataStore Preferences (CA-5-L).
 * - Otros targets: produce `InMemoryDeliveryZonesCache` (no persiste entre sesiones,
 *   suficiente para desktop/web/iOS donde el feature no es prioritario).
 *
 * El factory permite que el binding en `DIManager` sea unico (commonMain) y aun asi
 * cada plataforma elija su impl. correcta sin forzar a la commonMain a conocer Context.
 */
expect fun createDeliveryZonesCache(json: Json): CommDeliveryZonesCache
