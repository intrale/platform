package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ToDoListBusinessZones
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

/**
 * ViewModel de la pantalla `ZonesMapScreen` (issue #2423).
 *
 * - `loadZones(businessId)` dispara el caso de uso `ToDoListBusinessZones`
 *   y mapea Result -> phase (Loaded / Empty / Error).
 * - El bounding box viene calculado por `BoundingBoxCalculator` dentro
 *   del Do, no se recomputa aca.
 * - No persiste lat/lng del usuario ni los recibe por argumento (CA-9
 *   Security A09).
 */
class ZonesMapViewModel(
    private val listZones: ToDoListBusinessZones = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default,
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ZonesMapViewModel>()

    var state by mutableStateOf(ZonesMapUIState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // Sin formularios en esta pantalla.
    }

    suspend fun loadZones(businessId: String) {
        state = state.copy(phase = ZonesMapPhase.Loading, errorMessage = null)
        listZones.execute(businessId)
            .onSuccess { result ->
                state = if (result.zones.isEmpty()) {
                    state.copy(
                        phase = ZonesMapPhase.Empty,
                        zones = emptyList(),
                        boundingBox = null,
                        errorMessage = null,
                    )
                } else {
                    state.copy(
                        phase = ZonesMapPhase.Loaded,
                        zones = result.zones,
                        boundingBox = result.boundingBox,
                        errorMessage = null,
                    )
                }
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error consultando zonas para businessId=$businessId" }
                state = state.copy(
                    phase = ZonesMapPhase.Error,
                    zones = emptyList(),
                    boundingBox = null,
                    errorMessage = throwable.message ?: "Error inesperado",
                )
            }
    }

    fun toggleListExpanded() {
        state = state.copy(showsListExpanded = !state.showsListExpanded)
    }

    /** UX-5: cambio explicito a vista de lista textual cuando el mapa falla. */
    fun forceListView() {
        state = state.copy(showsListExpanded = true)
    }
}
