package asdo.signup

import ext.signup.ConfirmSignUpResponse
import ext.auth.ExceptionResponse

data class ConfirmSignUpStatusCode(val value: Int, val description: String?)

data class DoConfirmSignUpResult(val statusCode: ConfirmSignUpStatusCode)

data class DoConfirmSignUpException(val statusCode: ConfirmSignUpStatusCode, override val message: String?) : Throwable(message)

fun ConfirmSignUpResponse.toDoConfirmSignUpResult() = DoConfirmSignUpResult(
    ConfirmSignUpStatusCode(statusCode.value, statusCode.description)
)

fun ExceptionResponse.toDoConfirmSignUpException() = DoConfirmSignUpException(
    ConfirmSignUpStatusCode(statusCode.value, statusCode.description),
    message ?: "Error desconocido durante la confirmación de registro"
)

fun Throwable.toDoConfirmSignUpException() = DoConfirmSignUpException(
    ConfirmSignUpStatusCode(500, "Internal Server Error"),
    message ?: "Error desconocido durante la operación"
)
