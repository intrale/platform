package asdo.signup

import ar.com.intrale.shared.auth.SignUpResponse
import ar.com.intrale.shared.ExceptionResponse

data class SignUpStatusCode(val value: Int, val description: String?)

data class DoSignUpResult(val statusCode: SignUpStatusCode)

data class DoSignUpException(val statusCode: SignUpStatusCode, override val message: String?): Throwable(message)

fun SignUpResponse.toDoSignUpResult() = DoSignUpResult(
    SignUpStatusCode(statusCode.value, statusCode.description)
)

fun ExceptionResponse.toDoSignUpException() = DoSignUpException(
    SignUpStatusCode(statusCode.value, statusCode.description),
    message ?: "Error desconocido durante el registro"
)

fun Throwable.toDoSignUpException() = DoSignUpException(
    SignUpStatusCode(500, "Internal Server Error"),
    message ?: "Error desconocido durante la operación"
)
