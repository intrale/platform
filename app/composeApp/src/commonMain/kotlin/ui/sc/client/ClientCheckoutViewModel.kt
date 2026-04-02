package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientAddress
import asdo.client.CreateClientOrderItem
import asdo.client.CreateClientOrderParams
import asdo.client.PaymentMethod
import asdo.client.PaymentMethodType
import asdo.client.PaymentStatus
import asdo.client.ToDoCheckPaymentStatus
import asdo.client.ToDoCreateClientOrder
import kotlinx.coroutines.delay
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class CheckoutStatus {
    Review, Loading, Success, Error,
    /** Esperando que el usuario complete el pago en la pasarela externa */
    AwaitingPayment,
    /** Verificando el estado del pago contra el backend */
    CheckingPayment,
    /** El pago fue aprobado */
    PaymentApproved,
    /** El pago fue rechazado */
    PaymentRejected
}

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
    val businessClosedInfo: String = "",
    val paymentUrl: String? = null,
    val paymentFailureReason: String? = null
) {
    val canConfirm: Boolean
        get() = status == CheckoutStatus.Review &&
                items.isNotEmpty() &&
                selectedAddress != null &&
                selectedPaymentMethod != null &&
                !businessClosed

    /**
     * Indica si el medio de pago seleccionado requiere pasarela externa.
     */
    val requiresExternalPayment: Boolean
        get() = selectedPaymentMethod?.type?.requiresExternalPayment == true
}

class ClientCheckoutViewModel(
    private val toDoCreateClientOrder: ToDoCreateClientOrder = DIManager.di.direct.instance(),
    private val toDoCheckPaymentStatus: ToDoCheckPaymentStatus = DIManager.di.direct.instance(),
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

                if (result.requiresPayment && !result.paymentUrl.isNullOrBlank()) {
                    // El pedido requiere pago via pasarela externa (Mercado Pago)
                    logger.info { "Pago requerido, paymentUrl disponible para orderId=${result.orderId}" }
                    state = state.copy(
                        status = CheckoutStatus.AwaitingPayment,
                        orderId = result.orderId,
                        shortCode = result.shortCode,
                        paymentUrl = result.paymentUrl
                    )
                } else {
                    // Pago no requerido (efectivo, transferencia) — éxito directo
                    ClientCartStore.clear()
                    state = state.copy(
                        status = CheckoutStatus.Success,
                        orderId = result.orderId,
                        shortCode = result.shortCode
                    )
                }
            }
            .onFailure { throwable ->
                logger.error(throwable) { "Error al crear pedido" }
                state = state.copy(
                    status = CheckoutStatus.Error,
                    errorMessage = throwable.message ?: "Error desconocido"
                )
            }
    }

    /**
     * Abre la URL de pago en el navegador externo.
     * El callback onOpenUrl se provee desde la capa UI (expect/actual).
     * Retorna true si se pudo abrir.
     */
    fun openPaymentUrl(openUrl: (String) -> Boolean): Boolean {
        val url = state.paymentUrl
        if (url.isNullOrBlank()) {
            logger.warning { "No hay paymentUrl disponible" }
            return false
        }
        logger.info { "Abriendo URL de pago: $url" }
        return openUrl(url)
    }

    /**
     * Polling del estado de pago.
     * Se ejecuta en un loop con delay hasta que el pago sea terminal.
     */
    suspend fun pollPaymentStatus() {
        val orderId = state.orderId ?: return
        logger.info { "Iniciando polling de estado de pago para orderId=$orderId" }
        state = state.copy(status = CheckoutStatus.CheckingPayment)

        var attempts = 0
        val maxAttempts = 60 // ~5 minutos con 5s de intervalo
        val pollInterval = 5000L

        while (attempts < maxAttempts) {
            toDoCheckPaymentStatus.execute(orderId)
                .onSuccess { result ->
                    logger.info { "Estado de pago: ${result.paymentStatus} para orderId=$orderId" }
                    when (result.paymentStatus) {
                        PaymentStatus.APPROVED -> {
                            ClientCartStore.clear()
                            state = state.copy(
                                status = CheckoutStatus.PaymentApproved,
                                shortCode = state.shortCode
                            )
                            return
                        }
                        PaymentStatus.REJECTED -> {
                            state = state.copy(
                                status = CheckoutStatus.PaymentRejected,
                                paymentFailureReason = result.failureReason
                            )
                            return
                        }
                        PaymentStatus.CANCELLED -> {
                            state = state.copy(
                                status = CheckoutStatus.PaymentRejected,
                                paymentFailureReason = "Pago cancelado"
                            )
                            return
                        }
                        PaymentStatus.REFUNDED -> {
                            state = state.copy(
                                status = CheckoutStatus.PaymentRejected,
                                paymentFailureReason = "Pago reembolsado"
                            )
                            return
                        }
                        else -> {
                            // PENDING / IN_PROCESS — seguir esperando
                        }
                    }
                }
                .onFailure { throwable ->
                    logger.warning(throwable) { "Error al consultar estado de pago (intento $attempts)" }
                    // No abortar por error de red, seguir intentando
                }

            attempts++
            delay(pollInterval)
        }

        // Timeout — volver a AwaitingPayment para que el usuario pueda reintentar
        logger.warning { "Timeout de polling de pago para orderId=$orderId" }
        state = state.copy(status = CheckoutStatus.AwaitingPayment)
    }

    /**
     * Permite reintentar el pago cuando fue rechazado.
     * Vuelve al estado AwaitingPayment con la misma paymentUrl.
     */
    fun retryPayment() {
        state = state.copy(
            status = CheckoutStatus.AwaitingPayment,
            paymentFailureReason = null
        )
    }

    fun retryConfirm() {
        state = state.copy(status = CheckoutStatus.Review, errorMessage = null)
    }
}
