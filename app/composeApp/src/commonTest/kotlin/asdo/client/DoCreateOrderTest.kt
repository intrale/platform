package asdo.client

import ar.com.intrale.shared.client.ClientOrderDTO
import ar.com.intrale.shared.client.ClientOrderDetailDTO
import ar.com.intrale.shared.client.CreateOrderRequestDTO
import ar.com.intrale.shared.client.CreateOrderResponseDTO
import ext.client.ClientExceptionResponse
import ext.client.CommClientOrdersService
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private val sampleCreateResponse = CreateOrderResponseDTO(
    order = ClientOrderDTO(
        id = "ord-new-1",
        publicId = "PUB-NEW",
        shortCode = "ABC123",
        businessName = "Tienda",
        status = "PENDING",
        total = 350.0,
        itemCount = 3
    )
)

private class FakeCreateOrderService(
    private val createResult: Result<CreateOrderResponseDTO> = Result.success(sampleCreateResponse)
) : CommClientOrdersService {
    override suspend fun listOrders(): Result<List<ClientOrderDTO>> = Result.success(emptyList())
    override suspend fun fetchOrderDetail(orderId: String): Result<ClientOrderDetailDTO> =
        Result.success(ClientOrderDetailDTO())
    override suspend fun createOrder(request: CreateOrderRequestDTO): Result<CreateOrderResponseDTO> = createResult
}

class DoCreateOrderTest {

    @Test
    fun `crear pedido exitoso retorna output con datos del pedido`() = runTest {
        val sut = DoCreateOrder(FakeCreateOrderService())

        val input = CreateOrderInput(
            items = listOf(
                CreateOrderItemInput(
                    productId = "prod-1",
                    productName = "Producto A",
                    quantity = 2,
                    unitPrice = 100.0
                ),
                CreateOrderItemInput(
                    productId = "prod-2",
                    productName = "Producto B",
                    quantity = 1,
                    unitPrice = 150.0
                )
            ),
            addressId = "addr-1",
            notes = "Sin cebolla",
            paymentMethod = "cash"
        )

        val result = sut.execute(input)

        assertTrue(result.isSuccess)
        val output = result.getOrThrow()
        assertEquals("ord-new-1", output.orderId)
        assertEquals("ABC123", output.shortCode)
        assertEquals("PENDING", output.status)
        assertEquals(350.0, output.total)
    }

    @Test
    fun `crear pedido fallido retorna ClientExceptionResponse`() = runTest {
        val sut = DoCreateOrder(
            FakeCreateOrderService(
                createResult = Result.failure(RuntimeException("Error de red"))
            )
        )

        val input = CreateOrderInput(
            items = listOf(
                CreateOrderItemInput(
                    productId = "prod-1",
                    productName = "Producto A",
                    quantity = 1,
                    unitPrice = 50.0
                )
            ),
            addressId = null,
            notes = null,
            paymentMethod = "cash"
        )

        val result = sut.execute(input)

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is ClientExceptionResponse)
    }

    @Test
    fun `crear pedido sin order en respuesta retorna error`() = runTest {
        val sut = DoCreateOrder(
            FakeCreateOrderService(
                createResult = Result.success(CreateOrderResponseDTO(order = null))
            )
        )

        val input = CreateOrderInput(
            items = listOf(
                CreateOrderItemInput(
                    productId = "prod-1",
                    productName = "Producto A",
                    quantity = 1,
                    unitPrice = 50.0
                )
            ),
            addressId = "addr-1",
            notes = null,
            paymentMethod = "transfer"
        )

        val result = sut.execute(input)

        assertTrue(result.isFailure)
    }
}
