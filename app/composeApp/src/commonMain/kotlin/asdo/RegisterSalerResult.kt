package asdo

import ext.ExceptionResponse
import ext.RegisterSalerResponse

data class RegisterSalerStatusCode(val value: Int, val description: String?)

data class DoRegisterSalerResult(val statusCode: RegisterSalerStatusCode)

data class DoRegisterSalerException(
    val statusCode: RegisterSalerStatusCode,
    override val message: String?
) : Throwable(message)

fun RegisterSalerResponse.toDoRegisterSalerResult() = DoRegisterSalerResult(
    RegisterSalerStatusCode(statusCode.value, statusCode.description)
)

fun ExceptionResponse.toDoRegisterSalerException() = DoRegisterSalerException(
    RegisterSalerStatusCode(statusCode.value, statusCode.description),
    message ?: "Error desconocido durante el registro de vendedor"
)

fun Throwable.toDoRegisterSalerException() = DoRegisterSalerException(
    RegisterSalerStatusCode(500, "Internal Server Error"),
    message ?: "Error desconocido durante la operación"
)
