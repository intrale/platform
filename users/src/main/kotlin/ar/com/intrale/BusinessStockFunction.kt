package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import com.google.gson.Gson
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Endpoint de gestion de stock para negocios.
 * Ruta: /{business}/business/stock
 *
 * GET — Lista de inventario ordenada por stock (mas bajo primero)
 * GET /alerts — Productos por debajo del stock minimo
 * PUT /{productId} — Ajuste manual de stock (correccion, merma, reposicion)
 * POST /deduct — Deduccion de stock (usado internamente al completar pedidos)
 */
class BusinessStockFunction(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    private val productRepository: ProductRepository,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    private val gson = Gson()

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("Iniciando business/stock para negocio=$business, function=$function")

        val authorized = requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN)
            ?: requireApprovedProfile(cognito, headers, tableProfiles, business, PROFILE_SALER)
            ?: return UnauthorizedException()

        val method = headers["X-Http-Method"]?.uppercase() ?: HttpMethod.Get.value.uppercase()
        val subPath = function.removePrefix("business/stock").trimStart('/')

        return when {
            method == HttpMethod.Get.value.uppercase() && subPath == "alerts" -> handleGetAlerts(business)
            method == HttpMethod.Get.value.uppercase() -> handleGetInventory(business)
            method == HttpMethod.Put.value.uppercase() && subPath.isNotBlank() -> handleAdjustStock(business, subPath, textBody)
            method == HttpMethod.Post.value.uppercase() && subPath == "deduct" -> handleDeductStock(business, textBody)
            else -> RequestValidationException("Metodo no soportado para stock: $method $subPath")
        }
    }

    /**
     * GET /business/stock — Lista de inventario ordenada por stock disponible (ascendente)
     */
    private fun handleGetInventory(business: String): Response {
        logger.info("Listando inventario del negocio {}", business)
        val products = productRepository.listProductsByStock(business)
        val payloads = products.map { it.toPayload() }
        return StockInventoryResponse(products = payloads)
    }

    /**
     * GET /business/stock/alerts — Productos por debajo del stock minimo
     */
    private fun handleGetAlerts(business: String): Response {
        logger.info("Consultando alertas de stock bajo del negocio {}", business)
        val lowStock = productRepository.listLowStockProducts(business)
        val alerts = lowStock.map { product ->
            StockAlertPayload(
                productId = product.id,
                productName = product.name,
                currentStock = product.stockQuantity ?: 0,
                minStock = product.minStock ?: 0,
                isOutOfStock = (product.stockQuantity ?: 0) == 0
            )
        }
        return StockAlertListResponse(alerts = alerts)
    }

    /**
     * PUT /business/stock/{productId} — Ajuste manual de stock
     * Body: { "type": "SET|ADD|SUBTRACT", "quantity": 10, "reason": "Reposicion de proveedor" }
     */
    private fun handleAdjustStock(business: String, productId: String, textBody: String): Response {
        val request = try {
            gson.fromJson(textBody, StockAdjustmentRequest::class.java)
        } catch (e: Exception) {
            return RequestValidationException("Body invalido para ajuste de stock")
        }

        if (request.quantity < 0) {
            return RequestValidationException("La cantidad debe ser mayor o igual a cero")
        }

        val updated = when (request.type.uppercase()) {
            "SET" -> {
                logger.info("Ajuste SET de stock: producto=$productId cantidad=${request.quantity} motivo=${request.reason}")
                productRepository.setStock(business, productId, request.quantity)
            }
            "ADD" -> {
                logger.info("Ajuste ADD de stock: producto=$productId cantidad=+${request.quantity} motivo=${request.reason}")
                productRepository.adjustStock(business, productId, request.quantity)
            }
            "SUBTRACT" -> {
                logger.info("Ajuste SUBTRACT de stock: producto=$productId cantidad=-${request.quantity} motivo=${request.reason}")
                productRepository.adjustStock(business, productId, -request.quantity)
            }
            else -> return RequestValidationException("Tipo de ajuste invalido: ${request.type}. Usar SET, ADD o SUBTRACT")
        }

        if (updated == null) {
            return ExceptionResponse("Producto no encontrado", status = HttpStatusCode.NotFound)
        }

        // Verificar si quedo por debajo del minimo
        val belowMinimum = updated.minStock != null
            && updated.stockQuantity != null
            && updated.stockQuantity <= updated.minStock

        return StockAdjustmentResponse(
            product = updated.toPayload(),
            belowMinimum = belowMinimum,
            message = if (belowMinimum) "Stock por debajo del minimo configurado (${updated.minStock})" else null
        )
    }

    /**
     * POST /business/stock/deduct — Deduccion por pedido
     * Body: { "items": [{ "productId": "xxx", "quantity": 2 }] }
     */
    private fun handleDeductStock(business: String, textBody: String): Response {
        val request = try {
            gson.fromJson(textBody, StockDeductionRequest::class.java)
        } catch (e: Exception) {
            return RequestValidationException("Body invalido para deduccion de stock")
        }

        if (request.items.isEmpty()) {
            return RequestValidationException("La lista de items no puede estar vacia")
        }

        val deductionItems = request.items.map { StockDeductionItem(it.productId, it.quantity) }
        val result = productRepository.deductStockBatch(business, deductionItems)

        logger.info(
            "Deduccion de stock: negocio=$business, productos=${result.updatedProducts.size}, " +
                "alertas=${result.lowStockAlerts.size}, errores=${result.errors.size}"
        )

        return StockDeductionResponse(
            updatedProducts = result.updatedProducts.map { it.toPayload() },
            lowStockAlerts = result.lowStockAlerts.map { product ->
                StockAlertPayload(
                    productId = product.id,
                    productName = product.name,
                    currentStock = product.stockQuantity ?: 0,
                    minStock = product.minStock ?: 0,
                    isOutOfStock = (product.stockQuantity ?: 0) == 0
                )
            },
            errors = result.errors
        )
    }
}

// --- Request DTOs ---

data class StockAdjustmentRequest(
    val type: String = "SET",
    val quantity: Int = 0,
    val reason: String? = null
)

data class StockDeductionRequest(
    val items: List<StockDeductionRequestItem> = emptyList()
)

data class StockDeductionRequestItem(
    val productId: String = "",
    val quantity: Int = 0
)

// --- Response DTOs ---

data class StockAlertPayload(
    val productId: String,
    val productName: String,
    val currentStock: Int,
    val minStock: Int,
    val isOutOfStock: Boolean
)

class StockInventoryResponse(
    val products: List<ProductPayload>,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class StockAlertListResponse(
    val alerts: List<StockAlertPayload>,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class StockAdjustmentResponse(
    val product: ProductPayload,
    val belowMinimum: Boolean = false,
    val message: String? = null,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

class StockDeductionResponse(
    val updatedProducts: List<ProductPayload>,
    val lowStockAlerts: List<StockAlertPayload> = emptyList(),
    val errors: List<String> = emptyList(),
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)
