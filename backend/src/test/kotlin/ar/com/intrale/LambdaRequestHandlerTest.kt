package ar.com.intrale

import com.amazonaws.services.lambda.runtime.Context
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent
import io.ktor.http.HttpStatusCode
import org.kodein.di.DI
import org.kodein.di.bind
import org.kodein.di.singleton
import org.slf4j.LoggerFactory
import kotlin.test.Test
import kotlin.test.assertEquals

class LambdaRequestHandlerTest {
    private fun cfg(vararg businesses: String) = object : Config("us-east-1", "pool", "client") {
        override fun businesses() = businesses.toSet()
    }
    private class HelloFunction : Function {
        override suspend fun execute(business: String, function: String, headers: Map<String, String>, textBody: String): Response {
            return Response(HttpStatusCode.Created)
        }
    }

    private class TestHandler(private val module: DI.Module) : LambdaRequestHandler() {
        override fun handleRequest(requestEvent: APIGatewayProxyRequestEvent?, context: Context?): com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent {
            return handle(module, requestEvent, context)
        }
    }

    @Test
    fun executesExistingFunction() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { cfg("biz") }
            bind<Function>(tag = "hello") with singleton { HelloFunction() }
        }
        val handler = TestHandler(module)
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("business" to "biz", "function" to "hello")
            headers = emptyMap()
            body = java.util.Base64.getEncoder().encodeToString("".toByteArray())
            path = "/biz/hello"
        }
        val response = handler.handle(module, request, null)
        assertEquals(201, response.statusCode)
    }

    @Test
    fun missingFunctionReturnsError() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { cfg("biz") }
        }
        val handler = TestHandler(module)
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("business" to "biz", "function" to "missing")
            headers = emptyMap()
            body = java.util.Base64.getEncoder().encodeToString("".toByteArray())
            path = "/biz/missing"
        }
        val response = handler.handle(module, request, null)
        assertEquals(500, response.statusCode)
    }

    @Test
    fun optionsReturnsOk() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
        }
        val handler = TestHandler(module)
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "OPTIONS"
        }
        val response = handler.handle(module, request, null)
        assertEquals(200, response.statusCode)
    }

    @Test
    fun unknownBusinessReturnsError() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { cfg("biz") }
            bind<Function>(tag = "hello") with singleton { HelloFunction() }
        }
        val handler = TestHandler(module)
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("business" to "other", "function" to "hello")
            headers = emptyMap()
            body = java.util.Base64.getEncoder().encodeToString("{}".toByteArray())
            path = "/other/hello"
        }
        val response = handler.handle(module, request, null)
        assertEquals(500, response.statusCode)
    }

    @Test
    fun missingBusinessReturnsError() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { cfg("biz") }
            bind<Function>(tag = "hello") with singleton { HelloFunction() }
        }
        val handler = TestHandler(module)
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("function" to "hello")
            headers = emptyMap()
            body = java.util.Base64.getEncoder().encodeToString("{}".toByteArray())
            path = "/hello"
        }
        val response = handler.handle(module, request, null)
        assertEquals(400, response.statusCode)
    }

    @Test
    fun nullBodyReturnsCreated() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { cfg("biz") }
            bind<Function>(tag = "hello") with singleton { HelloFunction() }
        }
        val handler = TestHandler(module)
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("business" to "biz", "function" to "hello")
            headers = emptyMap()
            body = null
            path = "/biz/hello"
        }
        val response = handler.handle(module, request, null)
        assertEquals(201, response.statusCode)
    }

    @Test
    fun `body no Base64 usa valor original`() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { cfg("biz") }
            bind<Function>(tag = "hello") with singleton { HelloFunction() }
        }
        val handler = TestHandler(module)
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("business" to "biz", "function" to "hello")
            headers = emptyMap()
            body = "plain text body"
            path = "/biz/hello"
        }
        val response = handler.handle(module, request, null)
        assertEquals(201, response.statusCode)
    }

    @Test
    fun `requestEvent null retorna 500 Unexpected Error`() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
        }
        val handler = TestHandler(module)
        val response = handler.handle(module, null, null)
        assertEquals(500, response.statusCode)
        assertEquals("Unexpected Error", response.body)
    }

    @Test
    fun `funcion sin function key retorna 400`() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { cfg("biz") }
        }
        val handler = TestHandler(module)
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("business" to "biz", "function" to "")
            headers = emptyMap()
            body = null
            path = "/biz/"
        }
        val response = handler.handle(module, request, null)
        assertEquals(400, response.statusCode)
    }

    @Test
    fun `ruta multi-segmento construye function key con dos segmentos`() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<Config>() with singleton { cfg("biz") }
            bind<Function>(tag = "seg1/seg2") with singleton { HelloFunction() }
        }
        val handler = TestHandler(module)
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("business" to "biz", "function" to "seg1/seg2/seg3")
            headers = emptyMap()
            body = null
            path = "/biz/seg1/seg2/seg3"
        }
        val response = handler.handle(module, request, null)
        assertEquals(201, response.statusCode)
    }
}
