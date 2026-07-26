package ar.com.intrale

import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.ReturnValue
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import java.security.MessageDigest
import java.time.Clock
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

sealed interface RateLimitState {
    data class Allowed(val remaining: Int) : RateLimitState
    data class Denied(val retryAfterSeconds: Long) : RateLimitState
}

class RateLimitService(
    private val dynamoDbClient: DynamoDbClient,
    private val clock: Clock
) {
    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")

    /**
     * Incrementa el contador interno de forma atómica.
     *
     * El consumer no debe propagar `Denied` ni sus detalles al caller externo: debe responder
     * igual que en el happy path para evitar enumeración de direcciones (CWE-204).
     */
    fun tryIncrement(email: String, limit: Int = 10): Result<RateLimitState> = runCatching {
        require(limit > 0) { "El límite debe ser positivo" }
        val normalizedEmail = email.trim().lowercase()
        require(normalizedEmail.isNotEmpty()) { "El email no puede estar vacío" }
        val now = clock.instant()
        val request = UpdateItemRequest.builder()
            .tableName(TABLE_NAME)
            .key(
                mapOf(
                    "email" to AttributeValue.fromS(normalizedEmail),
                    "hour-bucket" to AttributeValue.fromS(HOUR_FORMATTER.format(now))
                )
            )
            .updateExpression("ADD #c :inc SET #e = if_not_exists(#e, :exp)")
            .conditionExpression("attribute_not_exists(#c) OR #c < :limit")
            .expressionAttributeNames(mapOf("#c" to "count", "#e" to "expires"))
            .expressionAttributeValues(
                mapOf(
                    ":inc" to AttributeValue.fromN("1"),
                    ":exp" to AttributeValue.fromN((now.epochSecond + BUCKET_TTL_SECONDS).toString()),
                    ":limit" to AttributeValue.fromN(limit.toString())
                )
            )
            .returnValues(ReturnValue.ALL_NEW)
            .build()
        try {
            val count = dynamoDbClient.updateItem(request).attributes()["count"]?.n()?.toInt()
                ?: error("DynamoDB no devolvió el contador actualizado")
            logger.debug("Rate limit actualizado para email={} remaining={}", normalizedEmail.toLogHash(), limit - count)
            RateLimitState.Allowed((limit - count).coerceAtLeast(0))
        } catch (_: ConditionalCheckFailedException) {
            val retryAfter = BUCKET_TTL_SECONDS - (now.epochSecond % BUCKET_TTL_SECONDS)
            logger.warn("Rate limit alcanzado para email={}", normalizedEmail.toLogHash())
            RateLimitState.Denied(retryAfter)
        }
    }

    private fun String.toLogHash(): String {
        val domain = substringAfter('@', "invalid")
        val digest = MessageDigest.getInstance("SHA-256").digest(toByteArray(Charsets.UTF_8))
        return digest.take(4).joinToString("") { "%02x".format(it) } + "@$domain"
    }

    companion object {
        const val TABLE_NAME = "invite_rate_limits"
        const val BUCKET_TTL_SECONDS = 3600L
        private val HOUR_FORMATTER = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH")
            .withZone(ZoneOffset.UTC)
    }
}
