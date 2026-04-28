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
    val error: String? = null,
    /**
     * Modal bloqueante de pre-carrito (issue #2424 CA-1). Cuando es true, la
     * pantalla muestra el modal "Veamos si te llega" y redirige al flujo de
     * verificacion de direccion (Hija A #2422). Se mantiene one-shot por
     * intento bloqueado para no spamear con bulk-add.
     */
    val requireZoneCheck: Boolean = false,
    /**
     * Producto que estaba intentando agregarse cuando se bloqueo, para que el
     * flujo de verificacion pueda re-intentar el add post-verificacion.
     */
    val pendingProduct: ClientProduct? = null
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

    /**
     * Intenta agregar un producto al carrito (issue #2424 CA-1).
     *
     * - Si el negocio NO tiene zonas configuradas (zoneCheckResult.shippingCost == null
     *   despues de una verificacion previa), el flujo de bloqueo NO se activa
     *   (CA-5, CA-14 parcial).
     * - Si NO hay verificacion previa (`lastZoneCheckResult == null`), bloquea
     *   el add y dispara `requireZoneCheck = true` para que la UI muestre el
     *   modal y redirija al flujo de Hija A.
     * - Si hay verificacion vigente, agrega el producto sin friccion (CA-1
     *   one-shot por sesion).
     */
    fun requestAddToCart(product: ClientProduct, businessHasZones: Boolean = true) {
        if (!businessHasZones) {
            // CA-5: negocio sin zonas configuradas, flujo bloqueante deshabilitado.
            logger.info { "Negocio sin zonas, agregando producto sin verificacion" }
            ClientCartStore.add(product)
            return
        }
        val zoneCheck = ClientCartStore.lastZoneCheckResult.value
        if (zoneCheck == null) {
            logger.info { "Bloqueando addToCart: no hay verificacion de direccion previa" }
            state = state.copy(requireZoneCheck = true, pendingProduct = product)
            return
        }
        // Verificacion vigente, agregar normalmente.
        ClientCartStore.add(product)
    }

    /**
     * Cancela el modal bloqueante sin agregar el producto (CA-1 secondary CTA).
     */
    fun dismissZoneCheckRequest() {
        state = state.copy(requireZoneCheck = false, pendingProduct = null)
    }

    /**
     * Llamado cuando la pantalla de verificacion (Hija A) confirmo direccion.
     * Si habia un producto pendiente, lo agrega ahora.
     */
    fun onZoneCheckCompleted() {
        val pending = state.pendingProduct
        state = state.copy(requireZoneCheck = false, pendingProduct = null)
        if (pending != null && ClientCartStore.lastZoneCheckResult.value != null) {
            ClientCartStore.add(pending)
        }
    }
}
