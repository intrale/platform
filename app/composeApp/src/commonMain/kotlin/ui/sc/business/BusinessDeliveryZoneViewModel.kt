package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.shared.business.BusinessDeliveryZoneType
import ar.com.intrale.shared.business.UpdateBusinessDeliveryZoneRequest
import asdo.business.ToDoGetBusinessDeliveryZone
import asdo.business.ToDoUpdateBusinessDeliveryZone
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

sealed interface BusinessDeliveryZoneStatus {
    data object Idle : BusinessDeliveryZoneStatus
    data object Loading : BusinessDeliveryZoneStatus
    data object Loaded : BusinessDeliveryZoneStatus
    data object Saving : BusinessDeliveryZoneStatus
    data object Saved : BusinessDeliveryZoneStatus
    data object MissingBusiness : BusinessDeliveryZoneStatus
    data class Error(val message: String) : BusinessDeliveryZoneStatus
}

data class BusinessDeliveryZoneUiState(
    val type: BusinessDeliveryZoneType = BusinessDeliveryZoneType.RADIUS,
    val radiusKm: String = "5.0",
    val postalCodes: List<String> = emptyList(),
    val postalCodeInput: String = "",
    val status: BusinessDeliveryZoneStatus = BusinessDeliveryZoneStatus.Idle
)

class BusinessDeliveryZoneViewModel(
    private val toDoGetDeliveryZone: ToDoGetBusinessDeliveryZone = DIManager.di.direct.instance(),
    private val toDoUpdateDeliveryZone: ToDoUpdateBusinessDeliveryZone = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<BusinessDeliveryZoneViewModel>()

    var state by mutableStateOf(BusinessDeliveryZoneUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    fun updateType(type: BusinessDeliveryZoneType) { state = state.copy(type = type) }
    fun updateRadiusKm(value: String) { state = state.copy(radiusKm = value) }
    fun updatePostalCodeInput(value: String) { state = state.copy(postalCodeInput = value) }

    fun addPostalCode() {
        val code = state.postalCodeInput.trim()
        if (code.isNotBlank() && !state.postalCodes.contains(code)) {
            state = state.copy(
                postalCodes = state.postalCodes + code,
                postalCodeInput = ""
            )
        }
    }

    fun removePostalCode(code: String) {
        state = state.copy(postalCodes = state.postalCodes.filter { it != code })
    }

    suspend fun loadDeliveryZone(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = BusinessDeliveryZoneStatus.MissingBusiness)
            return
        }
        state = state.copy(status = BusinessDeliveryZoneStatus.Loading)
        toDoGetDeliveryZone.execute(businessId)
            .onSuccess { dto ->
                state = state.copy(
                    type = dto.type,
                    radiusKm = dto.radiusKm.toString(),
                    postalCodes = dto.postalCodes,
                    status = BusinessDeliveryZoneStatus.Loaded
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar zona de entrega" }
                state = state.copy(status = BusinessDeliveryZoneStatus.Error(error.message ?: "Error al cargar zona"))
            }
    }

    suspend fun saveDeliveryZone(businessId: String?): Result<Unit> {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = BusinessDeliveryZoneStatus.MissingBusiness)
            return Result.failure(IllegalStateException("businessId requerido"))
        }
        val radius = state.radiusKm.toDoubleOrNull() ?: 0.0
        state = state.copy(status = BusinessDeliveryZoneStatus.Saving)
        val request = UpdateBusinessDeliveryZoneRequest(
            type = state.type,
            radiusKm = radius,
            postalCodes = state.postalCodes
        )
        return toDoUpdateDeliveryZone.execute(businessId, request)
            .map { dto ->
                state = state.copy(
                    type = dto.type,
                    radiusKm = dto.radiusKm.toString(),
                    postalCodes = dto.postalCodes,
                    status = BusinessDeliveryZoneStatus.Saved
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al guardar zona de entrega" }
                state = state.copy(status = BusinessDeliveryZoneStatus.Error(error.message ?: "Error al guardar zona"))
            }
    }
}
