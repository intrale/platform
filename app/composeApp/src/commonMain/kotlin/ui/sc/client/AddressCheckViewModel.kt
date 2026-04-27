package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ToDoCheckAddress
import asdo.client.ZoneCheckCoordinates
import asdo.client.ZoneCheckException
import asdo.client.ZoneCheckResult
import ext.location.CommLocationProvider
import ext.location.LocationOutcome
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.datetime.Clock
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

/**
 * Pasos visuales del flujo de verificación. La UI los consume para decidir
 * qué pantalla mostrar — la state machine vive acá, no en el composable.
 */
enum class AddressCheckStep {
    Idle,                  // Sin verificación iniciada (banner inicial)
    Rationale,             // Bottom sheet abierto, decidiendo GPS vs manual
    Locating,              // Permiso concedido + esperando GPS
    ManualInput,           // Fallback manual o post rationale
    Loading,               // Llamada al backend en curso
    ResultPositive,        // inZone=true
    ResultNegative,        // inZone=false
    ResultError,           // Error de red / servidor
}

/**
 * Estado de UI de la pantalla de verificación de zona — issue #2422.
 *
 * Privacidad (CA-5 / CA-7):
 * - NO contiene `ZoneCheckCoordinates` ni lat/lng en la data class. Las
 *   coordenadas viven exclusivamente en variables locales del ViewModel
 *   durante la llamada a `DoCheckAddress`, y se descartan al terminar.
 * - El campo `lastQueryAddress` solo guarda el texto que el usuario
 *   ingresó manualmente, NO la coordenada resultante del Geocoder.
 */
data class AddressCheckUIState(
    val step: AddressCheckStep = AddressCheckStep.Idle,
    val rationaleVisible: Boolean = false,
    val manualAddressInput: String = "",
    val manualAddressError: String? = null,
    val isSlowConnectionVisible: Boolean = false,
    val cartBlockedVisible: Boolean = false,
    val placeholderToastVisible: Boolean = false,
    val lastResult: ZoneCheckResult? = null,
    val lastErrorMessage: String? = null,
    val lastQueryAddress: String = "",
)

/**
 * ViewModel del flujo de verificación de zona — issue #2422.
 *
 * Responsabilidades:
 * - Orquestar permiso runtime + rationale + Geocoder + DoCheckAddress.
 * - Exponer flags para que la UI muestre cada estado (loading, slow toast,
 *   resultado positivo/negativo/error).
 * - Publicar el resultado final en [AddressCheckStore] para que el
 *   catálogo levante el banner verificado y desbloquee el carrito.
 *
 * Privacidad (CA-5 / CA-7):
 * - Nunca loggea `latitude`, `longitude`, `Address` ni el objeto
 *   `Location` completo. Solo metadatos.
 * - Guarda los lat/lng en variables locales temporales dentro de las
 *   funciones suspend; al terminar el método salen del scope.
 *
 * El permiso runtime de Android lo maneja la pantalla con
 * `ActivityResultContracts.RequestPermission()`; este ViewModel solo
 * sabe si el resultado fue concedido o no, sin acoplar a `android.*`.
 */
class AddressCheckViewModel(
    private val checkAddress: ToDoCheckAddress = DIManager.di.direct.instance(),
    private val locationProvider: CommLocationProvider = DIManager.di.direct.instance(),
    private val clock: Clock = Clock.System,
    private val coroutineScope: CoroutineScope? = null,
    loggerFactory: LoggerFactory = LoggerFactory.default,
) : ViewModel() {

    private val logger = loggerFactory.newLogger<AddressCheckViewModel>()

    var state by mutableStateOf(AddressCheckUIState())
        private set

    private var slowConnectionJob: Job? = null

    init {
        initInputState()
    }

    override fun getState(): Any = state

    override fun initInputState() {
        // Sin inputs Konform en la pantalla — la validación de coords la
        // hace DoCheckAddress; el campo de dirección manual es free-text.
    }

    // region ── Banner & rationale

    fun openRationale() {
        logger.info { "Abriendo rationale del permiso de ubicación" }
        state = state.copy(
            step = AddressCheckStep.Rationale,
            rationaleVisible = true,
            lastErrorMessage = null,
        )
    }

    fun dismissRationale() {
        logger.info { "Rationale descartado por el usuario" }
        state = state.copy(
            step = AddressCheckStep.Idle,
            rationaleVisible = false,
        )
    }

    fun chooseManualEntry() {
        logger.info { "Usuario eligió ingreso manual de dirección" }
        state = state.copy(
            step = AddressCheckStep.ManualInput,
            rationaleVisible = false,
            manualAddressError = null,
        )
    }

    fun onPermissionRequestRequested() {
        // La UI tomó la elección "Usar mi ubicación"; cierra el sheet y
        // queda esperando el resultado del diálogo nativo de permisos.
        logger.info { "Solicitud de permiso de ubicación delegada al sistema" }
        state = state.copy(
            step = AddressCheckStep.Locating,
            rationaleVisible = false,
        )
    }

    // endregion

    // region ── Permission outcome / location request

    /**
     * Llamar después de que el usuario respondió al diálogo nativo
     * `ActivityResultContracts.RequestPermission()`.
     */
    suspend fun onPermissionResult(granted: Boolean) {
        if (!granted) {
            logger.info { "Permiso denegado granted=false; fallback a manual" }
            state = state.copy(
                step = AddressCheckStep.ManualInput,
            )
            return
        }
        requestCurrentLocation()
    }

    private suspend fun requestCurrentLocation() {
        state = state.copy(step = AddressCheckStep.Locating)
        when (val outcome = locationProvider.requestCoarseLocation()) {
            is LocationOutcome.Coordinates -> {
                runZoneCheck(outcome.latitude, outcome.longitude)
            }
            is LocationOutcome.PermissionDenied,
            is LocationOutcome.Unavailable,
            is LocationOutcome.NotFound,
            is LocationOutcome.Error -> {
                logger.info { "No se pudo obtener ubicación; fallback a manual" }
                state = state.copy(step = AddressCheckStep.ManualInput)
            }
        }
    }

    // endregion

    // region ── Manual input

    fun onManualAddressChange(value: String) {
        state = state.copy(
            manualAddressInput = value,
            manualAddressError = null,
        )
    }

    suspend fun submitManualAddress() {
        val query = state.manualAddressInput.trim()
        if (query.isBlank()) {
            state = state.copy(
                manualAddressError = MIN_QUERY_ERROR
            )
            return
        }
        state = state.copy(
            step = AddressCheckStep.Locating,
            manualAddressError = null,
            lastQueryAddress = query,
        )
        when (val outcome = locationProvider.geocodeAddress(query)) {
            is LocationOutcome.Coordinates -> runZoneCheck(outcome.latitude, outcome.longitude)
            is LocationOutcome.NotFound -> {
                logger.info { "Geocoder sin resultados hasResult=false" }
                state = state.copy(
                    step = AddressCheckStep.ManualInput,
                    manualAddressError = NOT_FOUND_ERROR,
                )
            }
            else -> {
                logger.info { "Geocoder no disponible" }
                state = state.copy(
                    step = AddressCheckStep.ManualInput,
                    manualAddressError = NOT_AVAILABLE_ERROR,
                )
            }
        }
    }

    // endregion

    // region ── Zone check + slow connection toast + retry

    private suspend fun runZoneCheck(latitude: Double, longitude: Double) {
        state = state.copy(
            step = AddressCheckStep.Loading,
            isSlowConnectionVisible = false,
        )
        scheduleSlowConnectionToast()
        val coordinates = ZoneCheckCoordinates(latitude = latitude, longitude = longitude)
        val result = checkAddress.execute(coordinates)
        cancelSlowConnectionToast()
        result
            .onSuccess { ok ->
                handleResult(ok)
            }
            .onFailure { throwable ->
                handleFailure(throwable)
            }
    }

    private fun handleResult(result: ZoneCheckResult) {
        val now = clock.now().toEpochMilliseconds()
        AddressCheckStore.markVerified(result, now)
        state = if (result.inZone) {
            logger.info { "Verificación OK inZone=true" }
            state.copy(
                step = AddressCheckStep.ResultPositive,
                lastResult = result,
                lastErrorMessage = null,
            )
        } else {
            logger.info { "Verificación OK inZone=false" }
            state.copy(
                step = AddressCheckStep.ResultNegative,
                lastResult = result,
                lastErrorMessage = null,
            )
        }
    }

    private fun handleFailure(throwable: Throwable) {
        val message = when (throwable) {
            is ZoneCheckException.Invalid -> INVALID_COORDS
            is ZoneCheckException.OutOfRange -> GENERIC_ERROR
            is ZoneCheckException.Network -> GENERIC_ERROR
            is ZoneCheckException.Server -> GENERIC_ERROR
            else -> GENERIC_ERROR
        }
        logger.warning(throwable) { "Verificación falló message=$message" }
        state = state.copy(
            step = AddressCheckStep.ResultError,
            lastErrorMessage = message,
        )
    }

    private fun scheduleSlowConnectionToast() {
        cancelSlowConnectionToast()
        val scope = coroutineScope ?: CoroutineScope(viewModelDispatcher())
        slowConnectionJob = scope.launch {
            delay(SLOW_TOAST_DELAY_MS)
            state = state.copy(isSlowConnectionVisible = true)
        }
    }

    private fun cancelSlowConnectionToast() {
        slowConnectionJob?.cancel()
        slowConnectionJob = null
        state = state.copy(isSlowConnectionVisible = false)
    }

    /**
     * Reintenta verificar usando la última dirección manual (si la hay).
     * Si no hay dirección guardada, vuelve al input manual.
     */
    suspend fun retry() {
        val last = state.lastQueryAddress
        if (last.isNotBlank()) {
            state = state.copy(
                manualAddressInput = last,
                manualAddressError = null,
                lastErrorMessage = null,
            )
            submitManualAddress()
        } else {
            state = state.copy(step = AddressCheckStep.ManualInput, lastErrorMessage = null)
        }
    }

    // endregion

    // region ── Result actions

    fun acceptPositiveResult() {
        logger.info { "Usuario aceptó resultado positivo" }
        state = AddressCheckUIState() // limpia flujo, banner verificado se mantiene en store
    }

    fun tryAnotherAddress() {
        logger.info { "Usuario probará otra dirección" }
        AddressCheckStore.reset()
        state = state.copy(
            step = AddressCheckStep.ManualInput,
            manualAddressInput = "",
            manualAddressError = null,
            lastErrorMessage = null,
            lastResult = null,
        )
    }

    fun showZonesPlaceholder() {
        // Hija B aún no entrega la pantalla del mapa: stub con toast amable.
        logger.info { "Acción 'Ver zonas' es placeholder hasta Hija B" }
        state = state.copy(placeholderToastVisible = true)
    }

    fun dismissZonesPlaceholder() {
        state = state.copy(placeholderToastVisible = false)
    }

    fun showCartBlocked() {
        logger.info { "Carrito bloqueado por falta de verificación" }
        state = state.copy(cartBlockedVisible = true)
    }

    fun dismissCartBlocked() {
        state = state.copy(cartBlockedVisible = false)
    }

    // endregion

    private fun viewModelDispatcher() = Dispatchers.Default

    companion object {
        const val SLOW_TOAST_DELAY_MS: Long = 5_000L
        const val MIN_QUERY_ERROR: String = "manual_required"
        const val NOT_FOUND_ERROR: String = "manual_not_found"
        const val NOT_AVAILABLE_ERROR: String = "manual_unavailable"
        const val INVALID_COORDS: String = "invalid_coords"
        const val GENERIC_ERROR: String = "generic_error"
    }
}
