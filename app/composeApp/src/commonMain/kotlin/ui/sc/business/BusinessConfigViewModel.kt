package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.business.ToDoGetBusinessConfig
import asdo.business.ToDoUpdateBusinessConfig
import ar.com.intrale.shared.business.UpdateBusinessConfigRequest
import io.konform.validation.Validation
import io.konform.validation.jsonschema.minLength
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

sealed interface BusinessConfigStatus {
    data object Idle : BusinessConfigStatus
    data object Loading : BusinessConfigStatus
    data object Loaded : BusinessConfigStatus
    data object Saving : BusinessConfigStatus
    data object Saved : BusinessConfigStatus
    data object MissingBusiness : BusinessConfigStatus
    data class Error(val message: String) : BusinessConfigStatus
}

data class BusinessConfigUiState(
    val name: String = "",
    val address: String = "",
    val phone: String = "",
    val email: String = "",
    val logoUrl: String = "",
    val status: BusinessConfigStatus = BusinessConfigStatus.Idle
)

class BusinessConfigViewModel(
    private val toDoGetBusinessConfig: ToDoGetBusinessConfig = DIManager.di.direct.instance(),
    private val toDoUpdateBusinessConfig: ToDoUpdateBusinessConfig = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<BusinessConfigViewModel>()

    var state by mutableStateOf(BusinessConfigUiState())
        private set

    override fun getState(): Any = state

    init {
        validation = Validation<BusinessConfigUiState> {
            BusinessConfigUiState::name {
                minLength(1) hint "El nombre es obligatorio"
            }
        } as Validation<Any>
        initInputState()
    }

    override fun initInputState() {
        inputsStates = mutableMapOf(
            entry("name"),
            entry("address"),
            entry("phone"),
            entry("email"),
            entry("logoUrl")
        )
    }

    fun updateName(value: String) { state = state.copy(name = value) }
    fun updateAddress(value: String) { state = state.copy(address = value) }
    fun updatePhone(value: String) { state = state.copy(phone = value) }
    fun updateEmail(value: String) { state = state.copy(email = value) }
    fun updateLogoUrl(value: String) { state = state.copy(logoUrl = value) }

    suspend fun loadConfig(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = BusinessConfigStatus.MissingBusiness)
            return
        }
        state = state.copy(status = BusinessConfigStatus.Loading)
        toDoGetBusinessConfig.execute(businessId)
            .onSuccess { config ->
                state = state.copy(
                    name = config.name,
                    address = config.address,
                    phone = config.phone,
                    email = config.email,
                    logoUrl = config.logoUrl,
                    status = BusinessConfigStatus.Loaded
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar configuracion del negocio" }
                state = state.copy(
                    status = BusinessConfigStatus.Error(
                        error.message ?: "Error al cargar configuracion"
                    )
                )
            }
    }

    suspend fun saveConfig(businessId: String?): Result<Unit> {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = BusinessConfigStatus.MissingBusiness)
            return Result.failure(IllegalStateException("businessId requerido"))
        }
        if (!isValid()) {
            return Result.failure(IllegalStateException("Validacion fallida"))
        }
        state = state.copy(status = BusinessConfigStatus.Saving)
        val request = UpdateBusinessConfigRequest(
            name = state.name,
            address = state.address,
            phone = state.phone,
            email = state.email,
            logoUrl = state.logoUrl
        )
        return toDoUpdateBusinessConfig.execute(businessId, request)
            .map { config ->
                state = state.copy(
                    name = config.name,
                    address = config.address,
                    phone = config.phone,
                    email = config.email,
                    logoUrl = config.logoUrl,
                    status = BusinessConfigStatus.Saved
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al guardar configuracion del negocio" }
                state = state.copy(
                    status = BusinessConfigStatus.Error(
                        error.message ?: "Error al guardar configuracion"
                    )
                )
            }
    }
}
