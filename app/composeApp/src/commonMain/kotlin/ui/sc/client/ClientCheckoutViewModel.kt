package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientAddress
import asdo.client.CreateClientOrderItem
import asdo.client.CreateClientOrderParams
import asdo.client.PaymentMethod
import asdo.client.ToDoCreateClientOrder
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class CheckoutStatus { Review, Loading, Success, Error }

data class ClientCheckoutUiState(
    val status: CheckoutStatus = CheckoutStatus.Review,
    val items: List<ClientCartItem> = emptyList(),
    val selectedAddress: ClientAddress? = null,
    val selectedPaymentMethod: PaymentMethod? = null,
    val subtotal: Double = 0.0,
    val shipping: Double = 0.0,
    val total: Double = 0.0,
    val notes: String = "",
    val errorMessage: String? = null,
    val shortCode: String? = null,
    val orderId: String? = null,
    val businessClosed: Boolean = false,
    val businessClosedInfo: String = ""
) {
    val canConfirm: Boolean
        get() = status == CheckoutStatus.Review &&
                items.isNotEmpty() &&
                selectedAddress != null &&
                selectedPaymentMethod != null &&
                !businessClosed
}

class ClientCheckoutViewModel(
    private val toDoCreateClientOrder: ToDoCreateClientOrder = DIManager.di.direct.instance(),
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
        // No form validation needed for checkout
    }

    /**
     * Verifica si el negocio está abierto consultando el store global.
     * Si está cerrado, bloquea la confirmación del pedido.
     */
    fun checkBusinessOpenStatus() {
        val openStatus = BusinessOpenStore.state.value
        if (openStatus != null && !openStatus.isOpen) {
            logger.warning { "Negocio cerrado — bloqueando confirmación de pedido" }
            state = state.copy(
                businessClosed = true,
                businessClosedInfo = openStatus.nextOpeningInfo
            )
        } else {
            state = state.copy(businessClosed = false, businessClosedInfo = "")
        }
    }

    fun loadFromCart(
        items: List<ClientCartItem>,
        address: ClientAddress?,
        paymentMethod: PaymentMethod?
    ) {
        logger.info { "Cargando checkout con ${items.size} items" }
        val subtotal = items.sumOf { it.product.unitPrice * it.quantity }
        val shipping = 0.0
        state = state.copy(
            items = items,
            selectedAddress = address,
            selectedPaymentMethod = paymentMethod,
            subtotal = subtotal,
            shipping = shipping,
            total = subtotal + shipping
        )
    }

    fun updateNotes(notes: String) {
        state = state.copy(notes = notes)
    }

    suspend fun confirmOrder() {
        if (!state.canConfirm) {
            logger.warning { "No se puede confirmar: canConfirm=false" }
            return
        }

        logger.info { "Confirmando pedido con ${state.items.size} items" }
        state = state.copy(status = CheckoutStatus.Loading, errorMessage = null)

        val params = CreateClientOrderParams(
            items = state.items.map { cartItem ->
                CreateClientOrderItem(
                    productId = cartItem.product.id,
                    productName = cartItem.product.name,
                    quantity = cartItem.quantity,
                    unitPrice = cartItem.product.unitPrice
                )
            },
            addressId = state.selectedAddress?.id,
            paymentMethodId = state.selectedPaymentMethod?.id,
            notes = state.notes.takeIf { it.isNotBlank() }
        )

        toDoCreateClientOrder.execute(params)
            .onSuccess { result ->
                logger.info { "Pedido creado: ${result.orderId} (shortCode=${result.shortCode})" }
                ClientCartStore.clear()
                state = state.copy(
                    status = CheckoutStatus.Success,
                    orderId = result.orderId,
                    shortCode = result.shortCode
                )
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al crear pedido" }
                state = state.copy(
                    status = CheckoutStatus.Error,
                    errorMessage = throwable.message ?: "Error desconocido"
                )
            }
    }

    fun retryConfirm() {
        state = state.copy(status = CheckoutStatus.Review, errorMessage = null)
    }
}
