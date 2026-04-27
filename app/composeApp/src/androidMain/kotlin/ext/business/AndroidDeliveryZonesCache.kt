package ext.business

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import ar.com.intrale.shared.business.DeliveryZoneDTO
import kotlinx.coroutines.flow.first
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

/**
 * Implementacion Android de `CommDeliveryZonesCache` usando
 * `androidx.datastore:datastore-preferences:1.1.1` (CA-5-L de #2420).
 *
 * Multi-tenant: la key del preference incluye `businessId` para que el cache
 * de un negocio no contamine al de otro. `clear()` borra toda la entrada
 * (logout / cambio de negocio activo).
 *
 * Serializacion: JSON via kotlinx-serialization. La lista vacia significa
 * "este negocio nunca tuvo zonas guardadas" (el caller distingue de error).
 */
private val Context.deliveryZonesDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "delivery_zones_cache"
)

class AndroidDeliveryZonesCache(
    private val context: Context,
    private val json: Json
) : CommDeliveryZonesCache {

    private val logger = LoggerFactory.default.newLogger<AndroidDeliveryZonesCache>()
    private val zonesSerializer = ListSerializer(DeliveryZoneDTO.serializer())

    private fun keyFor(businessId: String) = stringPreferencesKey("zones_$businessId")

    override suspend fun read(businessId: String): List<DeliveryZoneDTO> {
        return try {
            val prefs = context.deliveryZonesDataStore.data.first()
            val raw = prefs[keyFor(businessId)] ?: return emptyList()
            json.decodeFromString(zonesSerializer, raw)
        } catch (e: Exception) {
            // Cache corrupto -> tratamos como empty y NO interrumpimos el flujo.
            logger.warning { "Cache de zonas ilegible para business=$businessId: ${e.message}" }
            emptyList()
        }
    }

    override suspend fun write(businessId: String, zones: List<DeliveryZoneDTO>) {
        try {
            val raw = json.encodeToString(zonesSerializer, zones)
            context.deliveryZonesDataStore.edit { prefs ->
                prefs[keyFor(businessId)] = raw
            }
        } catch (e: Exception) {
            // No fatal — log warning. Si la escritura falla solo se pierde el
            // refresh del cache, el flujo principal sigue.
            logger.warning { "No se pudo escribir cache de zonas business=$businessId: ${e.message}" }
        }
    }

    override suspend fun clear() {
        try {
            context.deliveryZonesDataStore.edit { prefs ->
                prefs.clear()
            }
            logger.info { "Cache de zonas de delivery limpiado (logout/cambio de negocio)" }
        } catch (e: Exception) {
            logger.warning { "No se pudo limpiar cache de zonas: ${e.message}" }
        }
    }
}
