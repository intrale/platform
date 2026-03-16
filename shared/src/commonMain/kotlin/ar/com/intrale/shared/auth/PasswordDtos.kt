package ar.com.intrale.shared.auth

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class PasswordRecoveryRequest(val email: String)

@Serializable
data class ConfirmPasswordRecoveryRequest(
    val email: String,
    val code: String,
    val password: String
)

@Serializable
data class PasswordRecoveryResponse(val statusCode: StatusCodeDTO)

@Serializable
data class ChangePasswordRequest(val oldPassword: String, val newPassword: String)

@Serializable
data class ChangePasswordResponse(val statusCode: StatusCodeDTO)
