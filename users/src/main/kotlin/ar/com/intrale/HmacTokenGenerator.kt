package ar.com.intrale

import com.google.gson.Gson
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.security.MessageDigest
import java.time.Clock
import java.time.Duration
import java.util.Base64
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class InvitationClaims(
    val businessId: String,
    val roleSuggested: String,
    val exp: Long,
    val jti: String,
    val iat: Long,
    val iss: String
)

data class NewInvitationClaims(
    val businessId: String,
    val roleSuggested: String,
    val validity: Duration = Duration.ofHours(24)
)

class HmacTokenGenerator(
    private val key: ByteArray,
    private val clock: Clock,
    private val gson: Gson = Gson()
) {
    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()

    init {
        require(key.size >= 32) { "La clave HMAC debe tener al menos 32 bytes" }
    }

    fun generate(claims: NewInvitationClaims): String {
        require(!claims.validity.isNegative && !claims.validity.isZero) {
            "La vigencia del token debe ser positiva"
        }
        require(claims.validity <= MAX_VALIDITY) {
            "La vigencia del token no puede superar 24 horas"
        }
        val issuedAt = clock.instant().epochSecond
        val completeClaims = InvitationClaims(
            businessId = claims.businessId,
            roleSuggested = claims.roleSuggested,
            exp = issuedAt + claims.validity.seconds,
            jti = UUID.randomUUID().toString(),
            iat = issuedAt,
            iss = ISSUER
        )
        val payload = gson.toJson(completeClaims).toByteArray(Charsets.UTF_8)
        val payloadPart = encoder.encodeToString(payload)
        val macPart = encoder.encodeToString(sign(payloadPart.toByteArray(Charsets.UTF_8)))
        logger.debug("Token de invitación generado jti={} mac={}", completeClaims.jti, macPart.take(8))
        return "$payloadPart.$macPart"
    }

    fun verify(token: String): Result<InvitationClaims> = runCatching {
        val parts = token.split('.')
        require(parts.size == 2) { "Formato de token inválido" }
        val expectedMac = sign(parts[0].toByteArray(Charsets.UTF_8))
        val receivedMac = decoder.decode(parts[1])
        require(MessageDigest.isEqual(expectedMac, receivedMac)) { "Firma de token inválida" }
        val claims = gson.fromJson(
            decoder.decode(parts[0]).toString(Charsets.UTF_8),
            InvitationClaims::class.java
        )
        require(claims.iss == ISSUER) { "Issuer de token inválido" }
        require(claims.exp > clock.instant().epochSecond) { "Token expirado" }
        claims
    }.onFailure { exception ->
        logger.warn("Falló la validación de un token de invitación: {}", exception.message)
    }

    private fun sign(value: ByteArray): ByteArray =
        Mac.getInstance(ALGORITHM).run {
            init(SecretKeySpec(key, ALGORITHM))
            doFinal(value)
        }

    companion object {
        const val ISSUER = "intrale-invite-v1"
        const val ALGORITHM = "HmacSHA256"
        private val MAX_VALIDITY: Duration = Duration.ofHours(24)
    }
}
