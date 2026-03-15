package ext.business

import ext.dto.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class BusinessOrderDTO(
    val id: String = "",
    val shortCode: String? = null,
    val clientEmail: String = "",
    val status: String = "PENDING",
    val total: Double = 0.0,
    val createdAt: String? = null
)

@Serializable
data class BusinessOrdersListResponseDTO(
    val statusCode: StatusCodeDTO? = null,
    val orders: List<BusinessOrderDTO>? = null
)

class BusinessExceptionResponse(
    val statusCode: StatusCodeDTO = StatusCodeDTO(500, "Internal Server Error"),
    override val message: String = "Error al obtener pedidos del negocio"
) : Throwable(message)

fun Throwable.toBusinessException(): BusinessExceptionResponse =
    BusinessExceptionResponse(
        statusCode = StatusCodeDTO(500, "Internal Server Error"),
        message = message ?: "Error desconocido al obtener pedidos del negocio"
    )
