package ui.sc.delivery

import DIManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import asdo.delivery.DeliveryOrderDetail
import asdo.delivery.DeliveryOrderStatus
import asdo.delivery.ToDoGetDeliveryOrderDetail
import asdo.delivery.ToDoUpdateDeliveryOrderStatus
import ext.delivery.toDeliveryException
import org.kodein.di.direct
import org.kodein.di.instance
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.ViewModel

enum class DeliveryOrderDetailStatus { Idle, Loading, Loaded, Error }

data class DeliveryOrderDetailUiState(
    val status: DeliveryOrderDetailStatus = DeliveryOrderDetailStatus.Idle,
    val detail: DeliveryOrderDetail? = null,
    val errorMessage: String? = null,
    val updatingStatus: Boolean = false,
    val statusUpdateSuccess: Boolean = false,
    val statusUpdateError: String? = null
)

class DeliveryOrderDetailViewModel(
    private val getOrderDetail: ToDoGetDeliveryOrderDetail = DIManager.di.direct.instance(),
    private val updateOrderStatus: ToDoUpdateDeliveryOrderStatus = DIManager.di.direct.instance()
) : ViewModel() {

    private val logger = LoggerFactory.default.newLogger<DeliveryOrderDetailViewModel>()

    var state by mutableStateOf(DeliveryOrderDetailUiState())
        private set

    override fun getState(): Any = state

    override fun initInputState() {
        // no-op
    }

    suspend fun loadDetail() {
        val orderId = DeliveryOrderSelectionStore.selectedOrderId.value
        if (orderId == null) {
            logger.warning { "No hay pedido seleccionado para ver detalle" }
            state = state.copy(
                status = DeliveryOrderDetailStatus.Error,
                errorMessage = "No se selecciono un pedido"
            )
            return
        }
        state = state.copy(status = DeliveryOrderDetailStatus.Loading, errorMessage = null)
        getOrderDetail.execute(orderId)
            .onSuccess { detail ->
                logger.info { "Detalle del pedido $orderId cargado correctamente" }
                state = state.copy(status = DeliveryOrderDetailStatus.Loaded, detail = detail)
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                logger.error(throwable) { "Error al cargar detalle del pedido $orderId" }
                state = state.copy(
                    status = DeliveryOrderDetailStatus.Error,
                    errorMessage = deliveryError.message ?: "Error al cargar detalle"
                )
            }
    }

    suspend fun updateStatus(newStatus: DeliveryOrderStatus) {
        val orderId = state.detail?.id ?: return
        state = state.copy(updatingStatus = true, statusUpdateSuccess = false, statusUpdateError = null)
        updateOrderStatus.execute(orderId, newStatus)
            .onSuccess { result ->
                logger.info { "Estado del pedido $orderId actualizado a ${result.newStatus}" }
                state = state.copy(
                    updatingStatus = false,
                    statusUpdateSuccess = true,
                    detail = state.detail?.copy(status = result.newStatus)
                )
            }
            .onFailure { throwable ->
                val deliveryError = throwable.toDeliveryException()
                logger.error(throwable) { "Error al actualizar estado del pedido $orderId" }
                state = state.copy(
                    updatingStatus = false,
                    statusUpdateError = deliveryError.message ?: "Error al actualizar estado"
                )
            }
    }

    fun clearStatusFeedback() {
        state = state.copy(statusUpdateSuccess = false, statusUpdateError = null)
    }
}
