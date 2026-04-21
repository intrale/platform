package ext.client

import ar.com.intrale.shared.delivery.DeliveryTimeEstimationDTO
import ar.com.intrale.shared.delivery.DeliveryTimeRecordDTO

/**
 * Servicio para estimar tiempo de entrega de pedidos.
 * Utiliza datos dinamicos (carga del negocio, hora, distancia, historico) para generar
 * estimaciones realistas y actualizarlas en tiempo real.
 */
interface CommDeliveryTimeEstimationService {

    /**
     * Obtiene la estimacion de tiempo para un pedido existente.
     */
    suspend fun getEstimation(orderId: String): Result<DeliveryTimeEstimationDTO>

    /**
     * Calcula una estimacion preliminar antes de crear el pedido
     * (usado en checkout para mostrar "Tu pedido llegara en ~X minutos").
     */
    suspend fun calculateEstimation(
        deliveryLatitude: Double? = null,
        deliveryLongitude: Double? = null,
        deliveryAddress: String? = null
    ): Result<DeliveryTimeEstimationDTO>

    /**
     * Registra el tiempo real de entrega para mejorar futuras predicciones.
     */
    suspend fun recordActualTime(record: DeliveryTimeRecordDTO): Result<Unit>
}
