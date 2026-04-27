package ui.sc.business.zones

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.shared.business.DeliveryZoneDTO
import asdo.business.delivery.ToDoListDeliveryZones
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

/**
 * Estados posibles de la pantalla de zonas de delivery (split 1 #2420).
 *
 * Distinguimos `Empty` de `Error` porque la UX cambia: empty state es educativo
 * (CTAs deshabilitados con Snackbar segun seccion 4 del UX), error es accionable
 * (boton "Reintentar" segun seccion 5).
 */
sealed interface DeliveryZonesStatus {
    data object Idle : DeliveryZonesStatus
    data object Loading : DeliveryZonesStatus
    data object Loaded : DeliveryZonesStatus
    data object Empty : DeliveryZonesStatus
    data class LoadedFromCache(val isOffline: Boolean = true) : DeliveryZonesStatus
    data object Error : DeliveryZonesStatus
    data object MissingBusiness : DeliveryZonesStatus
}

/**
 * Estado UI del feature. La lista viene ya ordenada por costo ascendente
 * (CA-3-L: "ordenadas por costo ascendente"). Sort secundario alfabetico
 * para que los empates sean estables entre renders (UX seccion 3).
 */
data class DeliveryZonesUIState(
    val zones: List<DeliveryZoneDTO> = emptyList(),
    val selectedZoneId: String? = null,
    val status: DeliveryZonesStatus = DeliveryZonesStatus.Idle,
    val errorMessage: String? = null
)

/**
 * ViewModel del feature "Zonas de delivery — visualizacion read-only" (#2420).
 *
 * Reside en commonMain para que la logica sea testeable sin Android. La parte
 * que requiere Google Maps SDK (renderizar el mapa con polygons) vive en el
 * composable `ZonesMapContent` con expect/actual — solo el actual de
 * androidBusiness importa el SDK (CA-7-L fallback en otros targets).
 */
class DeliveryZonesViewModel(
    private val toDoListZones: ToDoListDeliveryZones = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<DeliveryZonesViewModel>()

    var state by mutableStateOf(DeliveryZonesUIState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    /**
     * Carga zonas desde el backend (con fallback a cache offline en el caso de uso).
     *
     * - businessId nulo/blank -> MissingBusiness (CA-1-L: requiere negocio activo).
     * - exito con zonas -> Loaded.
     * - exito sin zonas -> Empty (CA-2-L: muestra empty state, no error).
     * - exito desde cache (modo offline) -> LoadedFromCache (banner offline en UI).
     * - failure -> Error con mensaje (CA-5-L: card de error con Reintentar).
     */
    suspend fun loadZones(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = DeliveryZonesStatus.MissingBusiness)
            return
        }
        state = state.copy(status = DeliveryZonesStatus.Loading, errorMessage = null)

        toDoListZones.execute(businessId)
            .onSuccess { output ->
                val sorted = sortByCostThenName(output.zones)
                val newStatus: DeliveryZonesStatus = when {
                    sorted.isEmpty() -> DeliveryZonesStatus.Empty
                    output.fromCache -> DeliveryZonesStatus.LoadedFromCache(isOffline = true)
                    else -> DeliveryZonesStatus.Loaded
                }
                state = state.copy(
                    zones = sorted,
                    status = newStatus,
                    errorMessage = null
                )
                logger.info { "Zonas cargadas: ${sorted.size} (fromCache=${output.fromCache})" }
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar zonas de delivery" }
                state = state.copy(
                    status = DeliveryZonesStatus.Error,
                    errorMessage = error.message ?: "Error al cargar zonas"
                )
            }
    }

    /**
     * Marca una zona como seleccionada (tap en lista o en polygon del mapa).
     * El composable observa este id para animar la camara y resaltar el polygon.
     */
    fun selectZone(zoneId: String?) {
        state = state.copy(selectedZoneId = zoneId)
    }

    fun clearError() {
        state = state.copy(errorMessage = null, status = DeliveryZonesStatus.Idle)
    }

    private fun sortByCostThenName(zones: List<DeliveryZoneDTO>): List<DeliveryZoneDTO> =
        zones.sortedWith(compareBy({ it.costCents }, { it.name }))
}
