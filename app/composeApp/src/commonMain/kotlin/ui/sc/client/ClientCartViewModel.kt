package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientAddress
import asdo.client.PaymentMethod
import asdo.client.ToDoGetClientProfile
import asdo.client.ToDoGetPaymentMethods
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

data class ClientCartUiState(
    val addresses: List<ClientAddress> = emptyList(),
    val selectedAddressId: String? = null,
    val paymentMethods: List<PaymentMethod> = emptyList(),
    val selectedPaymentMethodId: String? = null,
    val loadingPaymentMethods: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null
)

class ClientCartViewModel(
    private val getClientProfile: ToDoGetClientProfile = DIManager.di.direct.instance(),
    private val getPaymentMethods: ToDoGetPaymentMethods = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ClientCartViewModel>()

    var state by mutableStateOf(ClientCartUiState())
        private set

    init {
        initInputState()
    }

    override fun getState(): Any = state

    override fun initInputState() {
        // No form inputs on cart screen
    }

    suspend fun loadAddresses() {
        logger.info { "Cargando direcciones para el carrito" }
        state = state.copy(loading = true, error = null)
        getClientProfile.execute()
            .onSuccess { data ->
                val defaultId = data.profile.defaultAddressId
                    ?: data.addresses.firstOrNull { it.isDefault }?.id
                    ?: data.addresses.firstOrNull()?.id

                val normalized = data.addresses.map { address ->
                    address.copy(isDefault = address.isDefault || address.id == defaultId)
                }

                state = state.copy(
                    addresses = normalized,
                    selectedAddressId = defaultId,
                    loading = false,
                    error = null
                )
                ClientCartStore.selectAddress(defaultId)
            }
            .onFailure { throwable ->
                logger.error(throwable) { "No se pudieron cargar las direcciones" }
                state = state.copy(
                    loading = false,
                    error = throwable.message ?: "No se pudieron cargar las direcciones"
                )
            }
    }

    suspend fun loadPaymentMethods() {
        logger.info { "Cargando medios de pago habilitados" }
        state = state.copy(loadingPaymentMethods = true)
        getPaymentMethods.execute()
            .onSuccess { methods ->
                val enabledMethods = methods.filter { it.enabled }
                val selectedId = enabledMethods.firstOrNull()?.id
                state = state.copy(
                    paymentMethods = enabledMethods,
                    selectedPaymentMethodId = selectedId,
                    loadingPaymentMethods = false
                )
                ClientCartStore.selectPaymentMethod(selectedId)
                logger.info { "Medios de pago cargados: ${enabledMethods.size}" }
            }
            .onFailure { throwable ->
                logger.error(throwable) { "No se pudieron cargar los medios de pago" }
                state = state.copy(
                    loadingPaymentMethods = false,
                    error = throwable.message ?: "No se pudieron cargar los medios de pago"
                )
            }
    }

    fun selectAddress(addressId: String) {
        state = state.copy(selectedAddressId = addressId, error = null)
        ClientCartStore.selectAddress(addressId)
    }

    fun selectPaymentMethod(paymentMethodId: String) {
        logger.info { "Medio de pago seleccionado: $paymentMethodId" }
        state = state.copy(selectedPaymentMethodId = paymentMethodId, error = null)
        ClientCartStore.selectPaymentMethod(paymentMethodId)
    }
}
