package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientAddress
import asdo.client.CreateOrderInput
import asdo.client.CreateOrderItemInput
import asdo.client.CreateOrderOutput
import asdo.client.ToDoCreateOrder
import asdo.client.ToDoGetClientProfile
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

data class ClientCheckoutUiState(
    val items: List<ClientCartItem> = emptyList(),
    val subtotal: Double = 0.0,
    val shipping: Double = 0.0,
    val total: Double = 0.0,
    val addresses: List<ClientAddress> = emptyList(),
    val selectedAddressId: String? = null,
    val selectedPaymentMethod: String = "cash",
    val notes: String = "",
    val addressLoading: Boolean = false,
    val submitting: Boolean = false,
    val orderResult: CreateOrderOutput? = null,
    val error: String? = null
)

class ClientCheckoutViewModel(
    private val createOrder: ToDoCreateOrder = DIManager.di.direct.instance(),
    private val getClientProfile: ToDoGetClientProfile = DIManager.di.direct.instance(),
    loggerFactory: LoggerFactory = LoggerFactory.default
) : ViewModel() {

    private val logger = loggerFactory.newLogger<ClientCheckoutViewModel>()

    var state by mutableStateOf(ClientCheckoutUiState())
        private set

    init {
        initInputState()
    }

    override fun getState(): Any = state

    override fun initInputState() {
        // No form inputs with validation
    }

    fun loadCartData() {
        val cartItems = ClientCartStore.items.value.values.toList()
        val subtotal = cartItems.sumOf { it.product.unitPrice * it.quantity }
        val shipping = 0.0
        state = state.copy(
            items = cartItems,
            subtotal = subtotal,
            shipping = shipping,
            total = subtotal + shipping,
            selectedAddressId = ClientCartStore.selectedAddressId.value
        )
    }

    suspend fun loadAddresses() {
        logger.info { "Cargando direcciones para checkout" }
        state = state.copy(addressLoading = true)
        getClientProfile.execute()
            .onSuccess { data ->
                val defaultId = data.profile.defaultAddressId
                    ?: data.addresses.firstOrNull { it.isDefault }?.id
                    ?: data.addresses.firstOrNull()?.id

                val selectedId = state.selectedAddressId ?: defaultId

                state = state.copy(
                    addresses = data.addresses,
                    selectedAddressId = selectedId,
                    addressLoading = false
                )
            }
            .onFailure { throwable ->
                logger.error(throwable) { "No se pudieron cargar las direcciones" }
                state = state.copy(addressLoading = false, error = throwable.message)
            }
    }

    fun selectAddress(addressId: String) {
        state = state.copy(selectedAddressId = addressId, error = null)
    }

    fun selectPaymentMethod(method: String) {
        state = state.copy(selectedPaymentMethod = method, error = null)
    }

    fun updateNotes(notes: String) {
        state = state.copy(notes = notes, error = null)
    }

    suspend fun confirmOrder(): Boolean {
        if (state.items.isEmpty()) {
            state = state.copy(error = "empty_cart")
            return false
        }

        logger.info { "Confirmando pedido con ${state.items.size} productos" }
        state = state.copy(submitting = true, error = null)

        val input = CreateOrderInput(
            items = state.items.map { cartItem ->
                CreateOrderItemInput(
                    productId = cartItem.product.id,
                    productName = cartItem.product.name,
                    quantity = cartItem.quantity,
                    unitPrice = cartItem.product.unitPrice
                )
            },
            addressId = state.selectedAddressId,
            notes = state.notes.takeIf { it.isNotBlank() },
            paymentMethod = state.selectedPaymentMethod
        )

        val result = createOrder.execute(input)

        return result.fold(
            onSuccess = { output ->
                logger.info { "Pedido creado exitosamente: ${output.shortCode}" }
                state = state.copy(
                    submitting = false,
                    orderResult = output,
                    error = null
                )
                ClientCartStore.clear()
                true
            },
            onFailure = { throwable ->
                logger.error(throwable) { "Error al crear pedido" }
                state = state.copy(
                    submitting = false,
                    error = throwable.message ?: "error"
                )
                false
            }
        )
    }
}
