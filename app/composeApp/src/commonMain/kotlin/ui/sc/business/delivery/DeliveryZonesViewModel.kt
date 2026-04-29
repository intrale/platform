package ui.sc.business.delivery

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.viewModelScope
import asdo.business.delivery.Coordinate
import asdo.business.delivery.DeliveryZoneDraft
import asdo.business.delivery.DoSaveDeliveryZoneException
import asdo.business.delivery.MAX_ZONE_COST_CENTS
import asdo.business.delivery.MAX_ZONE_NAME_LENGTH
import asdo.business.delivery.MAX_ZONE_RADIUS_METERS
import asdo.business.delivery.MIN_ZONE_RADIUS_METERS
import asdo.business.delivery.ToDoSaveDeliveryZone
import asdo.business.delivery.sanitizeZoneName
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

/**
 * ViewModel del editor de zonas de entrega circulares (#2447).
 *
 * Responsable de:
 * - Estado del editor (centro, radio, sheet, validaciones).
 * - Save con debounce anti-doble POST (Mutex + flag `isSaving`).
 * - Cleanup en logout (cancela coroutine de save in-flight + limpia editor).
 * - Tope client-side de 10 zonas (CA-14).
 *
 * Inyecta `ToDoSaveDeliveryZone` (entregado por #2446).
 *
 * @param toDoSaveDeliveryZone caso de uso de save (puede ser fake en tests).
 * @param businessId id del negocio actual; null sin sesión.
 * @param dispatcher dispatcher para corrutinas del save (override en tests).
 * @param externalScope scope opcional para tests (default: viewModelScope).
 */
class DeliveryZonesViewModel(
    private val toDoSaveDeliveryZone: ToDoSaveDeliveryZone,
    private val businessId: String?,
    loggerFactory: LoggerFactory = LoggerFactory.default,
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    externalScope: CoroutineScope? = null,
) : ViewModel() {

    private val logger = loggerFactory.newLogger<DeliveryZonesViewModel>()

    private val scope: CoroutineScope = externalScope ?: viewModelScope
    private val saveMutex = Mutex()
    private var saveJob: Job? = null

    private val _events = MutableSharedFlow<DeliveryZonesEvent>(extraBufferCapacity = 8)
    val events: Flow<DeliveryZonesEvent> get() = _events.asSharedFlow()

    var state by mutableStateOf(DeliveryZonesUIState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    // region Editor lifecycle

    /** Abre el editor circular si no se alcanzó el tope. */
    fun openEditor() {
        if (state.isAtLimit) {
            logger.warning { "Intento de abrir editor con tope de zonas alcanzado" }
            state = state.copy(snackbarMessage = "Limite de 10 zonas alcanzado")
            return
        }
        if (state.editor != null) return
        logger.info { "Abriendo editor circular" }
        state = state.copy(editor = ZoneEditorUIState())
    }

    /** Cierra el editor descartando cambios. Cancela save in-flight si lo hay. */
    fun closeEditor() {
        logger.info { "Cerrando editor" }
        saveJob?.cancel()
        saveJob = null
        state = state.copy(editor = null)
    }

    // endregion

    // region Map interactions

    fun onMapTap(coordinate: Coordinate) {
        val editor = state.editor ?: return
        if (editor.isSaving) return
        logger.debug { "Centro colocado por tap" }
        state = state.copy(
            editor = editor.copy(
                center = coordinate,
                radiusMeters = if (editor.center == null) ZoneEditorUIState.DEFAULT_RADIUS_METERS else editor.radiusMeters,
                isDragging = false,
            )
        )
    }

    fun onCenterDragStart() {
        val editor = state.editor ?: return
        state = state.copy(editor = editor.copy(isDragging = true))
    }

    fun onCenterDrag(coordinate: Coordinate) {
        val editor = state.editor ?: return
        state = state.copy(editor = editor.copy(center = coordinate))
    }

    fun onRadiusChange(meters: Int) {
        val editor = state.editor ?: return
        val clamped = meters.coerceIn(0, MAX_ZONE_RADIUS_METERS)
        state = state.copy(editor = editor.copy(radiusMeters = clamped))
    }

    // endregion

    // region Sheet (form) interactions

    fun openSheet() {
        val editor = state.editor ?: return
        if (!editor.canOpenSheet) return
        state = state.copy(editor = editor.copy(sheetVisible = true))
    }

    fun dismissSheet() {
        val editor = state.editor ?: return
        state = state.copy(editor = editor.copy(sheetVisible = false))
    }

    fun onNameChange(input: String) {
        val editor = state.editor ?: return
        // Truncar al límite para feedback inmediato; validar la versión sanitizada.
        val truncated = input.take(MAX_ZONE_NAME_LENGTH * 2)
        val sanitized = sanitizeZoneName(truncated)
        val error = if (sanitized != null) null else "Nombre invalido"
        state = state.copy(
            editor = editor.copy(
                nameInput = truncated,
                nameError = error,
            )
        )
    }

    fun onCostChange(input: String) {
        val editor = state.editor ?: return
        val digits = input.filter { it.isDigit() }
        val cents = digits.toLongOrNull() ?: 0L
        val error = when {
            cents < 0 -> "Costo invalido"
            cents > MAX_ZONE_COST_CENTS -> "Costo supera el maximo"
            else -> null
        }
        state = state.copy(
            editor = editor.copy(
                costCentsInput = digits,
                costError = error,
            )
        )
    }

    fun onEstimatedMinutesChange(minutes: Int?) {
        val editor = state.editor ?: return
        val error = if (minutes == null) "Tiempo requerido" else null
        state = state.copy(
            editor = editor.copy(
                estimatedMinutes = minutes,
                timeError = error,
            )
        )
    }

    // endregion

    // region Save

    /**
     * Guarda la zona actual con debounce anti-doble POST (CA-11).
     * Usa Mutex.withLock para garantizar exclusión mutua.
     * Setea isSaving en estado para que el CTA quede disabled.
     */
    fun saveZone() {
        val editor = state.editor ?: return
        if (!editor.canSave) {
            logger.debug { "saveZone bloqueado: estado invalido" }
            return
        }
        val business = businessId
        if (business.isNullOrBlank()) {
            logger.error { "saveZone sin businessId" }
            state = state.copy(
                editor = editor.copy(saveError = "Sin negocio seleccionado")
            )
            return
        }
        if (state.isAtLimit) {
            logger.warning { "saveZone bloqueado por tope client-side" }
            state = state.copy(
                editor = editor.copy(saveError = "Limite de 10 zonas alcanzado")
            )
            return
        }
        // Cancela una previa por las dudas.
        saveJob?.cancel()
        saveJob = scope.launch(dispatcher) {
            // tryLock determinístico para el debounce.
            if (!saveMutex.tryLock()) {
                logger.debug { "Debounce activado: tryLock fallo" }
                return@launch
            }
            try {
                state = state.copy(
                    editor = state.editor?.copy(isSaving = true, saveError = null)
                )
                val draft = DeliveryZoneDraft(
                    businessId = business,
                    name = sanitizeZoneName(editor.nameInput).orEmpty(),
                    center = requireNotNull(editor.center),
                    radiusMeters = editor.radiusMeters,
                    costCents = editor.costCentsInput.toLongOrNull() ?: 0L,
                    estimatedMinutes = requireNotNull(editor.estimatedMinutes),
                )
                val result = toDoSaveDeliveryZone.execute(draft)
                result
                    .onSuccess { zone ->
                        logger.info { "Zona guardada: ${zone.id}" }
                        state = state.copy(
                            zones = state.zones + zone,
                            editor = null,
                            snackbarMessage = "Zona ${zone.name} creada",
                        )
                        _events.emit(DeliveryZonesEvent.ZoneCreated(zone.name))
                    }
                    .onFailure { error ->
                        logger.error(error) { "Error guardando zona" }
                        val message = when (error) {
                            is DoSaveDeliveryZoneException.LimitReached -> "Limite de 10 zonas alcanzado"
                            is DoSaveDeliveryZoneException.ValidationFailed -> error.message ?: "Datos invalidos"
                            is DoSaveDeliveryZoneException.Generic -> error.message ?: "Error al guardar"
                            else -> error.message ?: "Error al guardar"
                        }
                        state = state.copy(
                            editor = state.editor?.copy(
                                isSaving = false,
                                saveError = message,
                            )
                        )
                    }
            } finally {
                runCatching { saveMutex.unlock() }
                saveJob = null
            }
        }
    }

    // endregion

    // region Logout

    /** Limpia estado y cancela save in-flight ante logout (CA-16). */
    fun onLogout() {
        logger.info { "Logout: limpiando estado del editor" }
        saveJob?.cancel()
        saveJob = null
        state = DeliveryZonesUIState()
        // Nota: NO cancelamos `scope` enteramente — viewModelScope se cancela al destruir
        // el VM por el lifecycle owner. Cancelar saveJob alcanza para CA-16.
    }

    // endregion

    /** Acepta una lista pre-cargada de zonas (typical desde la lista). */
    fun setZones(zones: List<asdo.business.delivery.DeliveryZone>) {
        state = state.copy(zones = zones)
    }

    /** Limpia el snackbar message tras consumirlo en la UI. */
    fun consumeSnackbar() {
        state = state.copy(snackbarMessage = null)
    }
}

/** Eventos one-shot para que la UI los observe (snackbar, navegación, etc). */
sealed interface DeliveryZonesEvent {
    data class ZoneCreated(val zoneName: String) : DeliveryZonesEvent
}

/** Helper para tests: provee un scope supervisado independiente del viewModelScope. */
fun isolatedTestScope(): CoroutineScope = CoroutineScope(SupervisorJob())
