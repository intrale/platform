package ar.com.intrale.shared.auth

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class SignUpRequest(val email: String)

@Serializable
data class SignUpResponse(val statusCode: StatusCodeDTO)

@Serializable
data class ConfirmSignUpRequest(val email: String, val code: String)

@Serializable
data class ConfirmSignUpResponse(val statusCode: StatusCodeDTO)

@Serializable
data class RegisterSalerRequest(val email: String)

@Serializable
data class RegisterSalerResponse(val statusCode: StatusCodeDTO)
