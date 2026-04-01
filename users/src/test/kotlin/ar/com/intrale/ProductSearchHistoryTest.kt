package ar.com.intrale

import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ProductSearchHistoryTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("la-carne")
    private val searchHistoryRepository = SearchHistoryRepository()
    private val jwtValidator = LocalJwtValidator()
    private val token = jwtValidator.generateToken("cliente@lacarne.com")
    private val gson = Gson()

    private val function = ProductSearchHistory(
        config = config,
        logger = logger,
        searchHistoryRepository = searchHistoryRepository,
        jwtValidator = jwtValidator
    )

    @Test
    fun `GET retorna historial vacio cuando no hay busquedas`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is SearchHistoryResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response.history.isEmpty())
    }

    @Test
    fun `POST agrega busqueda al historial y retorna historial actualizado`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "POST"),
            textBody = gson.toJson(AddSearchHistoryRequest(query = "asado"))
        )

        assertTrue(response is SearchHistoryResponse)
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(1, response.history.size)
        assertEquals("asado", response.history.first().query)
    }

    @Test
    fun `POST con query vacia retorna error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "POST"),
            textBody = gson.toJson(AddSearchHistoryRequest(query = ""))
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST sin body retorna error de validacion`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "POST"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `DELETE limpia el historial y retorna 204`() = runBlocking {
        // Agregar algunas búsquedas
        searchHistoryRepository.addSearch("cliente@lacarne.com", "la-carne", "asado")
        searchHistoryRepository.addSearch("cliente@lacarne.com", "la-carne", "chorizo")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "DELETE"),
            textBody = ""
        )

        assertTrue(response is NoContentResponse)
        assertEquals(HttpStatusCode.NoContent, response.statusCode)

        // Verificar que el historial está vacío
        val history = searchHistoryRepository.getHistory("cliente@lacarne.com", "la-carne")
        assertTrue(history.isEmpty())
    }

    @Test
    fun `GET despues de POST retorna historial con busquedas`() = runBlocking {
        // POST varias búsquedas
        function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "POST"),
            textBody = gson.toJson(AddSearchHistoryRequest(query = "chorizo"))
        )
        function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "POST"),
            textBody = gson.toJson(AddSearchHistoryRequest(query = "asado"))
        )

        // GET historial
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is SearchHistoryResponse)
        assertEquals(2, response.history.size)
        assertEquals("asado", response.history[0].query)
        assertEquals("chorizo", response.history[1].query)
    }

    @Test
    fun `metodo PUT no soportado retorna error`() = runBlocking {
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "PUT"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `GET sin token retorna UnauthorizedException`() = runBlocking {
        val response = function.execute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf("X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }

    @Test
    fun `X-Debug-User no permite acceder al historial de otro usuario`() = runBlocking {
        // Generar token válido pero SIN claim email — solo tiene subject
        val tokenSinEmail = jwtValidator.generateTokenWithoutEmail("user@test.com")

        val response = function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf(
                "Authorization" to tokenSinEmail,
                "X-Http-Method" to "GET",
                "X-Debug-User" to "victima@empresa.com"
            ),
            textBody = ""
        )

        // El header X-Debug-User NO debe permitir impersonación.
        // Sin email en el token y sin fallback a X-Debug-User, debe retornar
        // historial del subject (user@test.com), NO de victima@empresa.com
        assertTrue(response is SearchHistoryResponse)
        val historyResponse = response as SearchHistoryResponse
        // El historial debe estar vacío porque user@test.com no tiene búsquedas,
        // confirmando que NO se usó el email de X-Debug-User (victima@empresa.com)
        assertTrue(historyResponse.history.isEmpty())
    }

    @Test
    fun `token sin email ni subject retorna UnauthorizedException incluso con X-Debug-User`() = runBlocking {
        // Token con email inválido que no se puede decodificar correctamente
        val response = function.securedExecute(
            business = "la-carne",
            function = "products/search-history",
            headers = mapOf(
                "Authorization" to "Bearer invalid.token.here",
                "X-Http-Method" to "GET",
                "X-Debug-User" to "victima@empresa.com"
            ),
            textBody = ""
        )

        // X-Debug-User NO debe servir como fallback — debe retornar Unauthorized
        assertTrue(response is UnauthorizedException)
    }
}
