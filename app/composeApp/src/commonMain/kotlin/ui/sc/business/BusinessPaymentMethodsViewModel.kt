package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.UpdateBusinessPaymentMethodsRequest
import asdo.business.ToDoGetBusinessPaymentMethods
import asdo.business.ToDoUpdateBusinessPaymentMethods
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

sealed interface BusinessPaymentMethodsStatus {
    data object Idle : BusinessPaymentMethodsStatus
    data object Loading : BusinessPaymentMethodsStatus
    data object Loaded : BusinessPaymentMethodsStatus
    data object Saving : BusinessPaymentMethodsStatus
    data object Saved : BusinessPaymentMethodsStatus
    data object MissingBusiness : BusinessPaymentMethodsStatus
    data class Error(val message: String) : BusinessPaymentMethodsStatus
}

data class PaymentMethodUiItem(
    val id: String,
    val name: String,
    val type: String,
    val enabled: Boolean,
    val isCashOnDelivery: Boolean,
    val description: String?
)

data class BusinessPaymentMethodsUiState(
    val methods: List<PaymentMethodUiItem> = emptyList(),
    val status: BusinessPaymentMethodsStatus = BusinessPaymentMethodsStatus.Idle
)

class BusinessPaymentMethodsViewModel(
    private val toDoGetPaymentMethods: ToDoGetBusinessPaymentMethods = DIManager.di.direct.instance(),
    private val toDoUpdatePaymentMethods: ToDoUpdateBusinessPaymentMethods = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<BusinessPaymentMethodsViewModel>()

    var state by mutableStateOf(BusinessPaymentMethodsUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    fun toggleMethod(id: String) {
        state = state.copy(
            methods = state.methods.map { m ->
                if (m.id == id) m.copy(enabled = !m.enabled) else m
            }
        )
    }

    suspend fun loadPaymentMethods(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = BusinessPaymentMethodsStatus.MissingBusiness)
            return
        }
        state = state.copy(status = BusinessPaymentMethodsStatus.Loading)
        toDoGetPaymentMethods.execute(businessId)
            .onSuccess { dtos ->
                state = state.copy(
                    methods = dtos.map { it.toUiItem() },
                    status = BusinessPaymentMethodsStatus.Loaded
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar medios de pago" }
                state = state.copy(
                    status = BusinessPaymentMethodsStatus.Error(
                        error.message ?: "Error al cargar medios de pago"
                    )
                )
            }
    }

    suspend fun savePaymentMethods(businessId: String?): Result<Unit> {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = BusinessPaymentMethodsStatus.MissingBusiness)
            return Result.failure(IllegalStateException("businessId requerido"))
        }
        state = state.copy(status = BusinessPaymentMethodsStatus.Saving)
        val request = UpdateBusinessPaymentMethodsRequest(
            paymentMethods = state.methods.map { m ->
                BusinessPaymentMethodDTO(
                    id = m.id,
                    name = m.name,
                    type = m.type,
                    enabled = m.enabled,
                    isCashOnDelivery = m.isCashOnDelivery,
                    description = m.description
                )
            }
        )
        return toDoUpdatePaymentMethods.execute(businessId, request)
            .map { dtos ->
                state = state.copy(
                    methods = dtos.map { it.toUiItem() },
                    status = BusinessPaymentMethodsStatus.Saved
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al guardar medios de pago" }
                state = state.copy(
                    status = BusinessPaymentMethodsStatus.Error(
                        error.message ?: "Error al guardar medios de pago"
                    )
                )
            }
    }

    private fun BusinessPaymentMethodDTO.toUiItem() = PaymentMethodUiItem(
        id = id,
        name = name,
        type = type,
        enabled = enabled,
        isCashOnDelivery = isCashOnDelivery,
        description = description
    )
}
