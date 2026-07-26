package ar.com.intrale

import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals

class RateLimitServiceTest {
    private val instant = Instant.parse("2026-04-24T15:30:15Z")

    @Test
    fun `primer incremento normaliza email y devuelve nueve restantes`() {
        val client = mockk<DynamoDbClient>()
        val request = slot<UpdateItemRequest>()
        every { client.updateItem(capture(request)) } returns responseWithCount(1)
        val service = RateLimitService(client, Clock.fixed(instant, ZoneOffset.UTC))

        val result = service.tryIncrement("  Leo+test@X.com  ").getOrThrow()

        assertEquals(RateLimitState.Allowed(9), result)
        assertEquals("leo+test@x.com", request.captured.key()["email"]?.s())
        assertEquals("2026-04-24T15", request.captured.key()["hour-bucket"]?.s())
        assertEquals("attribute_not_exists(#c) OR #c < :limit", request.captured.conditionExpression())
        assertEquals("ADD #c :inc SET #e = if_not_exists(#e, :exp)", request.captured.updateExpression())
        assertEquals((instant.epochSecond + 3600).toString(), request.captured.expressionAttributeValues()[":exp"]?.n())
    }

    @Test
    fun `incremento sucesivo devuelve restantes decrecientes`() {
        val client = mockk<DynamoDbClient>()
        every { client.updateItem(any<UpdateItemRequest>()) } returns responseWithCount(7)
        val service = RateLimitService(client, Clock.fixed(instant, ZoneOffset.UTC))

        assertEquals(RateLimitState.Allowed(3), service.tryIncrement("leo@x.com").getOrThrow())
    }

    @Test
    fun `llamada once devuelve denegado con segundos hasta próxima hora`() {
        val client = mockk<DynamoDbClient>()
        every { client.updateItem(any<UpdateItemRequest>()) } throws
            ConditionalCheckFailedException.builder().message("limit").build()
        val service = RateLimitService(client, Clock.fixed(instant, ZoneOffset.UTC))

        assertEquals(RateLimitState.Denied(1785), service.tryIncrement("leo@x.com").getOrThrow())
    }

    @Test
    fun `rollover de hora genera bucket independiente`() {
        val client = mockk<DynamoDbClient>()
        val requests = mutableListOf<UpdateItemRequest>()
        every { client.updateItem(capture(requests)) } returns responseWithCount(1)

        RateLimitService(client, Clock.fixed(instant, ZoneOffset.UTC))
            .tryIncrement("leo@x.com").getOrThrow()
        RateLimitService(client, Clock.fixed(Instant.parse("2026-04-24T16:00:00Z"), ZoneOffset.UTC))
            .tryIncrement("leo@x.com").getOrThrow()

        assertEquals(listOf("2026-04-24T15", "2026-04-24T16"), requests.map { it.key()["hour-bucket"]?.s() })
    }

    private fun responseWithCount(count: Int): UpdateItemResponse =
        UpdateItemResponse.builder()
            .attributes(mapOf("count" to AttributeValue.fromN(count.toString())))
            .build()
}
