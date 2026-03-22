package ui.sc.business

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ar.com.intrale.shared.business.BusinessPaymentMethodDTO
import ar.com.intrale.shared.business.UpdatePaymentMethodsRequest
import asdo.business.ToDoGetBusinessPaymentMethods
import asdo.business.ToDoUpdateBusinessPaymentMethods
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

sealed interface PaymentMethodsConfigStatus {
    data object Idle : PaymentMethodsConfigStatus
    data object Loading : PaymentMethodsConfigStatus
    data object Loaded : PaymentMethodsConfigStatus
    data object Saving : PaymentMethodsConfigStatus
    data object Saved : PaymentMethodsConfigStatus
    data object MissingBusiness : PaymentMethodsConfigStatus
    data class Error(val message: String) : PaymentMethodsConfigStatus
}

data class PaymentMethodsConfigUiState(
    val methods: List<BusinessPaymentMethodDTO> = emptyList(),
    val status: PaymentMethodsConfigStatus = PaymentMethodsConfigStatus.Idle
)

class PaymentMethodsConfigViewModel(
    private val toDoGetPaymentMethods: ToDoGetBusinessPaymentMethods =
        DIManager.di.direct.instance(),
    private val toDoUpdatePaymentMethods: ToDoUpdateBusinessPaymentMethods =
        DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<PaymentMethodsConfigViewModel>()

    var state by mutableStateOf(PaymentMethodsConfigUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        inputsStates = mutableMapOf()
    }

    suspend fun loadPaymentMethods(businessId: String?) {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = PaymentMethodsConfigStatus.MissingBusiness)
            return
        }
        state = state.copy(status = PaymentMethodsConfigStatus.Loading)
        toDoGetPaymentMethods.execute()
            .onSuccess { methods ->
                state = state.copy(
                    methods = methods,
                    status = PaymentMethodsConfigStatus.Loaded
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al cargar medios de pago" }
                state = state.copy(
                    status = PaymentMethodsConfigStatus.Error(
                        error.message ?: "Error al cargar medios de pago"
                    )
                )
            }
    }

    fun togglePaymentMethod(methodId: String, enabled: Boolean) {
        state = state.copy(
            methods = state.methods.map { method ->
                if (method.id == methodId) method.copy(enabled = enabled) else method
            }
        )
    }

    suspend fun savePaymentMethods(businessId: String?): Result<Unit> {
        if (businessId.isNullOrBlank()) {
            state = state.copy(status = PaymentMethodsConfigStatus.MissingBusiness)
            return Result.failure(IllegalStateException("businessId requerido"))
        }
        state = state.copy(status = PaymentMethodsConfigStatus.Saving)
        val request = UpdatePaymentMethodsRequest(paymentMethods = state.methods)
        return toDoUpdatePaymentMethods.execute(request)
            .map { methods ->
                state = state.copy(
                    methods = methods,
                    status = PaymentMethodsConfigStatus.Saved
                )
            }
            .onFailure { error ->
                logger.error(error) { "Error al guardar medios de pago" }
                state = state.copy(
                    status = PaymentMethodsConfigStatus.Error(
                        error.message ?: "Error al guardar medios de pago"
                    )
                )
            }
    }
}
