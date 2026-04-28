package ui.sc.client

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.client.ClientAddress
import asdo.client.CreateClientOrderItem
import asdo.client.CreateClientOrderParams
import asdo.client.DoCheckAddressResult
import asdo.client.PaymentMethod
import asdo.client.ToDoCheckAddress
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
    val businessClosedInfo: String = "",
    /**
     * Issue #2424 CA-2/CA-3/CA-4/CA-5: contexto del costo de envio.
     *
     * - `zoneId`/`zoneName` provienen de la verificacion de Hija A (#2422).
     * - `shippingCostKnown == false` significa que el negocio NO tiene zonas
     *   configuradas (CA-5): NO se renderiza la fila de envio en el desglose.
     * - `shippingCostKnown == true` y `shipping == 0.0` significa "Envio gratis"
     *   (CA-4): la fila se renderiza con el texto "Envio gratis".
     * - `shippingCostKnown == true` y `shipping > 0` muestra el desglose normal.
     */
    val shippingCostKnown: Boolean = false,
    val zoneId: String? = null,
    val zoneName: String? = null,
    val businessId: String? = null,
    val verifiedLat: Double? = null,
    val verifiedLng: Double? = null,
    /** Loading state durante recalculo on-change de direccion (CA-6). */
    val recalculatingShipping: Boolean = false,
    /** Snackbar de error suave durante recalculo (CA-6). */
    val recheckError: String? = null,
    /**
     * shippingCost autoritativo del backend (CA-13). Cuando el backend recalcula
     * y difiere del valor mostrado en checkout, este campo guarda el valor del
     * response para mostrar en la pantalla de detalle.
     */
    val authoritativeShippingCost: Double? = null
) {
    val canConfirm: Boolean
        get() = status == CheckoutStatus.Review &&
                items.isNotEmpty() &&
                selectedAddress != null &&
                selectedPaymentMethod != null &&
                !businessClosed &&
                !recalculatingShipping
    /**
     * Si la fila de envio debe mostrarse (CA-3, CA-4, CA-5).
     * - `false` cuando shippingCostKnown == false (negocio sin zonas).
     * - `true` cuando hay valor (incluyendo 0.0 = envio gratis).
     */
    val showShippingRow: Boolean
        get() = shippingCostKnown
    val isFreeShipping: Boolean
        get() = shippingCostKnown && shipping == 0.0
}

class ClientCheckoutViewModel(
    private val toDoCreateClientOrder: ToDoCreateClientOrder = DIManager.di.direct.instance(),
    private val toDoCheckAddress: ToDoCheckAddress? = null,
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

    /**
     * Carga el checkout desde el carrito + verificacion de zona vigente
     * (issue #2424 CA-2). El `shippingCost`, `zoneName` y `zoneId` provienen
     * del [DoCheckAddressResult] obtenido en la fase pre-carrito (Hija A).
     *
     * Si [zoneCheckResult] es `null`, asume negocio sin zonas (CA-5):
     * `showShippingRow = false`.
     */
    fun loadFromCart(
        items: List<ClientCartItem>,
        address: ClientAddress?,
        paymentMethod: PaymentMethod?,
        zoneCheckResult: DoCheckAddressResult? = null
    ) {
        logger.info {
            "Cargando checkout con ${items.size} items, zoneName=${zoneCheckResult?.zoneName}, " +
                "shippingCost=${zoneCheckResult?.shippingCost}"
        }
        val subtotal = items.sumOf { it.product.unitPrice * it.quantity }
        // shippingCost == null  -> negocio sin zonas (CA-5).
        // shippingCost == 0.0   -> envio gratis (CA-4).
        // shippingCost > 0      -> aplicar al total (CA-2).
        val shipping = zoneCheckResult?.shippingCost ?: 0.0
        val shippingKnown = zoneCheckResult?.shippingCost != null
        state = state.copy(
            items = items,
            selectedAddress = address,
            selectedPaymentMethod = paymentMethod,
            subtotal = subtotal,
            shipping = shipping,
            total = subtotal + shipping,
            shippingCostKnown = shippingKnown,
            zoneId = zoneCheckResult?.zoneId,
            zoneName = zoneCheckResult?.zoneName,
            businessId = zoneCheckResult?.businessId,
            verifiedLat = zoneCheckResult?.lat,
            verifiedLng = zoneCheckResult?.lng
        )
    }

    fun updateNotes(notes: String) {
        state = state.copy(notes = notes)
    }

    /**
     * Cambia la direccion seleccionada y re-invoca `ToDoCheckAddress` para
     * recalcular el `shippingCost` (issue #2424 CA-6).
     *
     * Mientras la request esta en curso, `recalculatingShipping = true` y
     * `canConfirm = false`. La UI muestra shimmer en lugar de spinner.
     * Si la request falla, mantiene el `shippingCost` previo y emite
     * `recheckError` para snackbar (NO reemplaza la cifra vieja por error).
     */
    suspend fun changeAddress(address: ClientAddress) {
        val toDoCheckAddress = this.toDoCheckAddress
        val businessId = state.businessId
        if (toDoCheckAddress == null || businessId == null) {
            // Sin contexto suficiente, solo actualizamos la direccion sin recalcular.
            logger.warning {
                "Cambio de direccion sin re-verificacion: toDoCheckAddress=${toDoCheckAddress != null}, businessId=$businessId"
            }
            state = state.copy(selectedAddress = address)
            return
        }

        // Recalcular shippingCost a partir del addressId (las coords reales las
        // tiene el ToDoCheckAddress consultando el perfil + /zones/check).
        // Pasamos lat/lng = 0.0 como hint cuando no las conocemos aqui.
        val lat = state.verifiedLat ?: 0.0
        val lng = state.verifiedLng ?: 0.0
        state = state.copy(
            selectedAddress = address,
            recalculatingShipping = true,
            recheckError = null
        )
        toDoCheckAddress.execute(
            businessId = businessId,
            addressId = address.id,
            lat = lat,
            lng = lng
        ).onSuccess { result ->
            logger.info {
                // CA-10: NO logueamos lat/lng. Si logueamos zoneName y shippingCost.
                "Recalculo OK: zoneName=${result.zoneName}, shippingCost=${result.shippingCost}"
            }
            // Persistir la nueva verificacion en el store para futuros adds.
            ClientCartStore.setZoneCheckResult(result)
            val subtotal = state.subtotal
            val newShipping = result.shippingCost ?: 0.0
            val shippingKnown = result.shippingCost != null
            state = state.copy(
                shipping = newShipping,
                total = subtotal + newShipping,
                shippingCostKnown = shippingKnown,
                zoneId = result.zoneId,
                zoneName = result.zoneName,
                verifiedLat = result.lat,
                verifiedLng = result.lng,
                recalculatingShipping = false,
                recheckError = null
            )
        }.onFailure { throwable ->
            logger.error(throwable) { "Recalculo fallo, mantenemos shippingCost previo" }
            state = state.copy(
                recalculatingShipping = false,
                recheckError = throwable.message
                    ?: "No pudimos actualizar el envio. Reintenta o segui con la direccion anterior."
            )
        }
    }

    /**
     * Limpia el snackbar de error de recalculo.
     */
    fun dismissRecheckError() {
        state = state.copy(recheckError = null)
    }

    suspend fun confirmOrder() {
        if (!state.canConfirm) {
            logger.warning { "No se puede confirmar: canConfirm=false" }
            return
        }

        logger.info { "Confirmando pedido con ${state.items.size} items" }
        state = state.copy(status = CheckoutStatus.Loading, errorMessage = null)

        // Validacion de coords (Security A03 - CA-9). NO logueamos lat/lng (CA-10).
        val lat = state.verifiedLat
        val lng = state.verifiedLng
        if (lat != null && (lat < -90.0 || lat > 90.0)) {
            logger.error { "Latitud fuera de rango, abortando submit" }
            state = state.copy(
                status = CheckoutStatus.Error,
                errorMessage = "Direccion no valida, verifica de nuevo"
            )
            return
        }
        if (lng != null && (lng < -180.0 || lng > 180.0)) {
            logger.error { "Longitud fuera de rango, abortando submit" }
            state = state.copy(
                status = CheckoutStatus.Error,
                errorMessage = "Direccion no valida, verifica de nuevo"
            )
            return
        }

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
            notes = state.notes.takeIf { it.isNotBlank() },
            // Tamper-proofing (CA-8): NO se envia shippingCost. El backend
            // recalcula desde businessId + coords + zoneId (hint).
            businessId = state.businessId,
            lat = lat,
            lng = lng,
            zoneId = state.zoneId
        )

        toDoCreateClientOrder.execute(params)
            .onSuccess { result ->
                logger.info {
                    "Pedido creado: ${result.orderId} (shortCode=${result.shortCode}, " +
                        "shippingCost=${result.shippingCost}, zoneName=${result.zoneName})"
                }
                ClientCartStore.clear()
                // CA-13: el shippingCost del response es la fuente autoritativa.
                state = state.copy(
                    status = CheckoutStatus.Success,
                    orderId = result.orderId,
                    shortCode = result.shortCode,
                    authoritativeShippingCost = result.shippingCost
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
