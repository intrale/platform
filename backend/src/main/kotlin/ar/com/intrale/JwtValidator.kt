package ar.com.intrale

import com.auth0.jwt.interfaces.DecodedJWT

interface JwtValidator {
    fun validate(token: String): DecodedJWT
}
