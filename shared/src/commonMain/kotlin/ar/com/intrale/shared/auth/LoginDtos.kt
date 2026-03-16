package ar.com.intrale.shared.auth

import ar.com.intrale.shared.StatusCodeDTO
import kotlinx.serialization.Serializable

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
    val newPassword: String? = null,
    val name: String? = null,
    val familyName: String? = null
)

@Serializable
data class LoginResponse(
    val statusCode: StatusCodeDTO,
    val idToken: String,
    val accessToken: String,
    val refreshToken: String
)
