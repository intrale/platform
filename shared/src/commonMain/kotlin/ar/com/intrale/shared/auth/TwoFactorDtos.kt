package ar.com.intrale.shared.auth

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class TwoFactorVerifyRequest(val code: String)

@Serializable
data class TwoFactorVerifyResponse(val statusCode: StatusCodeDTO)

@Serializable
data class TwoFactorSetupResponse(
    val statusCode: StatusCodeDTO,
    val otpAuthUri: String
)
