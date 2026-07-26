package ar.com.intrale

import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HmacTokenGeneratorTest {
    private val instant = Instant.parse("2026-04-24T15:00:00Z")
    private val key = ByteArray(32) { it.toByte() }

    @Test
    fun `genera token Base64URL con claims completos y UTF-8`() {
        val generator = HmacTokenGenerator(key, Clock.fixed(instant, ZoneOffset.UTC))

        val token = generator.generate(NewInvitationClaims("José", "ADMIN"))
        val parts = token.split('.')
        val claims = generator.verify(token).getOrThrow()

        assertEquals(2, parts.size)
        assertFalse(token.any { it == '+' || it == '/' || it == '=' })
        assertEquals("José", claims.businessId)
        assertEquals("ADMIN", claims.roleSuggested)
        assertEquals(instant.epochSecond, claims.iat)
        assertEquals(instant.plus(Duration.ofHours(24)).epochSecond, claims.exp)
        assertEquals(HmacTokenGenerator.ISSUER, claims.iss)
        assertTrue(runCatching { java.util.UUID.fromString(claims.jti) }.isSuccess)
    }

    @Test
    fun `rechaza token expirado y firma alterada`() {
        val issuer = HmacTokenGenerator(key, Clock.fixed(instant, ZoneOffset.UTC))
        val token = issuer.generate(NewInvitationClaims("business", "ADMIN", Duration.ofHours(1)))
        val verifier = HmacTokenGenerator(
            key,
            Clock.fixed(instant.plus(Duration.ofHours(2)), ZoneOffset.UTC)
        )

        assertTrue(verifier.verify(token).isFailure)
        assertTrue(issuer.verify(token.dropLast(1) + if (token.last() == 'A') "B" else "A").isFailure)
    }

    @Test
    fun `rechaza vigencia mayor a veinticuatro horas`() {
        val generator = HmacTokenGenerator(key, Clock.fixed(instant, ZoneOffset.UTC))

        assertTrue(
            runCatching {
                generator.generate(NewInvitationClaims("business", "ADMIN", Duration.ofHours(25)))
            }.isFailure
        )
    }
}
