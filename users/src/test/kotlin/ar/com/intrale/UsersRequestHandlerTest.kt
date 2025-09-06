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

class UsersRequestHandlerTest {
    private class HelloFunction : Function {
        override suspend fun execute(business: String, function: String, headers: Map<String, String>, textBody: String): Response {
            return Response(HttpStatusCode.Created)
        }
    }

    @Test
    fun executesExistingFunction() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<UsersConfig>() with singleton { testConfig("biz") }
            bind<Function>(tag = "hello") with singleton { HelloFunction() }
        }
        val handler = UsersRequestHandler()
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
            bind<UsersConfig>() with singleton { testConfig("biz") }
        }
        val handler = UsersRequestHandler()
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
        val handler = UsersRequestHandler()
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
            bind<UsersConfig>() with singleton { testConfig("biz") }
            bind<Function>(tag = "hello") with singleton { HelloFunction() }
        }
        val handler = UsersRequestHandler()
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
            bind<UsersConfig>() with singleton { testConfig("biz") }
            bind<Function>(tag = "hello") with singleton { HelloFunction() }
        }
        val handler = UsersRequestHandler()
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("function" to "hello")
            headers = emptyMap()
            body = java.util.Base64.getEncoder().encodeToString("{}".toByteArray())
        }
        val response = handler.handle(module, request, null)
        assertEquals(400, response.statusCode)
    }

   /* @Test
    fun nullBodyReturnsValidationError() {
        val module = DI.Module(name = "test") {
            bind<org.slf4j.Logger>() with singleton { LoggerFactory.getLogger("test") }
            bind<UsersConfig>() with singleton { testConfig("biz") }
            bind<Function>(tag = "hello") with singleton { HelloFunction() }
        }
        val handler = UsersRequestHandler()
        val request = APIGatewayProxyRequestEvent().apply {
            httpMethod = "POST"
            pathParameters = mapOf("business" to "biz", "function" to "hello")
            headers = emptyMap()
            body = null
            path = "/biz/hello"
        }
        val response = handler.handle(module, request, null)
        assertEquals(500, response.statusCode)
    }*/
}
