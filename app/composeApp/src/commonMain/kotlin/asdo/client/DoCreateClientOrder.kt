package asdo.client

import ar.com.intrale.shared.client.CreateClientOrderItemDTO
import ar.com.intrale.shared.client.CreateClientOrderRequestDTO
import ext.client.CommClientOrdersService
import ext.client.toClientException
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger

class DoCreateClientOrder(
    private val service: CommClientOrdersService
) : ToDoCreateClientOrder {

    private val logger = LoggerFactory.default.newLogger<DoCreateClientOrder>()

    override suspend fun execute(params: CreateClientOrderParams): Result<CreateClientOrderResult> = runCatching {
        // Validacion de coords (Security A03 - CA-9). NO logueamos lat/lng (CA-10).
        params.lat?.let { require(it in -90.0..90.0) { "Latitud invalida" } }
        params.lng?.let { require(it in -180.0..180.0) { "Longitud invalida" } }

        logger.info {
            "Creando pedido con ${params.items.size} items, businessId=${params.businessId}, zoneId=${params.zoneId}"
        }
        // Tamper-proofing (Security A04 - CA-8): el DTO NO incluye `shippingCost`.
        // El backend recalcula y persiste server-side. El cliente jamas envia
        // un valor de confianza para el costo de envio.
        val request = CreateClientOrderRequestDTO(
            items = params.items.map { item ->
                CreateClientOrderItemDTO(
                    productId = item.productId,
                    productName = item.productName,
                    quantity = item.quantity,
                    unitPrice = item.unitPrice
                )
            },
            addressId = params.addressId,
            paymentMethodId = params.paymentMethodId,
            notes = params.notes,
            businessId = params.businessId,
            lat = params.lat,
            lng = params.lng,
            zoneId = params.zoneId
        )
        val response = service.createOrder(request).getOrThrow()
        // shippingCost autoritativo: el backend lo recalculo y persistio (CA-13).
        logger.info {
            "Pedido creado: orderId=${response.orderId}, shortCode=${response.shortCode}, " +
                "shippingCost=${response.shippingCost}, zoneName=${response.zoneName}"
        }
        CreateClientOrderResult(
            orderId = response.orderId,
            shortCode = response.shortCode,
            status = response.status,
            shippingCost = response.shippingCost,
            zoneName = response.zoneName
        )
    }.recoverCatching { throwable ->
        logger.error(throwable) { "Fallo al crear pedido" }
        throw throwable.toClientException()
    }
}
