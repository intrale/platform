package ext.business

import ar.com.intrale.shared.StatusCodeDTO

class BusinessExceptionResponse(
    val statusCode: StatusCodeDTO = StatusCodeDTO(500, "Internal Server Error"),
    override val message: String = "Error al obtener pedidos del negocio"
) : Throwable(message)

fun Throwable.toBusinessException(): BusinessExceptionResponse =
    BusinessExceptionResponse(
        statusCode = StatusCodeDTO(500, "Internal Server Error"),
        message = message ?: "Error desconocido al obtener pedidos del negocio"
    )
