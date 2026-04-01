package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Fake del servicio de evaluacion de calidad de fotos para tests.
 */
class FakePhotoQualityService(
    private var defaultResult: PhotoQualityResult = PhotoQualityResult(
        overallScore = 0.85,
        quality = PhotoQualityLevel.GOOD,
        issues = emptyList(),
        recommendations = emptyList()
    )
) : PhotoQualityService {
    var lastImageBase64: String? = null
    var lastMediaType: String? = null
    var lastProductName: String? = null

    fun setResult(result: PhotoQualityResult) {
        defaultResult = result
    }

    override suspend fun evaluatePhoto(
        imageBase64: String,
        mediaType: String,
        productName: String?
    ): PhotoQualityResult {
        lastImageBase64 = imageBase64
        lastMediaType = mediaType
        lastProductName = productName
        return defaultResult
    }
}

class PhotoQualityFunctionTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "profiles",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey ?: "" }
    private val fakeService = FakePhotoQualityService()
    private val repository = PhotoQualityRepository()
    private val productRepository = ProductRepository()
    private val gson = Gson()

    private val function = PhotoQualityFunction(
        config, logger, cognito, tableProfiles,
        fakeService, repository, productRepository
    )

    private fun seedBusinessAdmin() {
        tableProfiles.putItem(UserBusinessProfile().apply {
            email = "admin@biz.com"
            business = "biz"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@biz.com" })
        }
    }

    @Test
    fun `POST evalua foto y retorna calidad buena`() = runBlocking {
        seedBusinessAdmin()

        val body = PhotoQualityRequest(
            imageBase64 = "dGVzdA==",
            mediaType = "image/jpeg",
            productName = "Pizza Muzzarella"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PhotoQualityResponse)
        val pqr = response as PhotoQualityResponse
        assertEquals(0.85, pqr.overallScore)
        assertEquals("GOOD", pqr.quality)
        assertEquals("dGVzdA==", fakeService.lastImageBase64)
        assertEquals("Pizza Muzzarella", fakeService.lastProductName)
    }

    @Test
    fun `POST con productId valido usa el nombre del producto`() = runBlocking {
        seedBusinessAdmin()
        productRepository.saveProduct("biz", ProductRecord(
            id = "prod-1",
            name = "Empanada de carne",
            basePrice = 500.0,
            unit = "unidad",
            status = "PUBLISHED"
        ))

        val body = PhotoQualityRequest(
            productId = "prod-1",
            imageBase64 = "dGVzdA==",
            mediaType = "image/jpeg"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PhotoQualityResponse)
        assertEquals("Empanada de carne", fakeService.lastProductName)

        // Verificar que se guardo en el repositorio
        val saved = repository.getByProduct("biz", "prod-1")
        assertTrue(saved != null)
        assertEquals(0.85, saved.overallScore)
    }

    @Test
    fun `POST con productId invalido retorna NotFound`() = runBlocking {
        seedBusinessAdmin()

        val body = PhotoQualityRequest(
            productId = "no-existe",
            imageBase64 = "dGVzdA==",
            mediaType = "image/jpeg"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `POST sin imagen retorna error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val body = PhotoQualityRequest(imageBase64 = "", mediaType = "image/jpeg")

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con tipo de imagen no soportado retorna error`() = runBlocking {
        seedBusinessAdmin()

        val body = PhotoQualityRequest(
            imageBase64 = "dGVzdA==",
            mediaType = "image/bmp"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST sin body retorna error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con foto mejorable retorna sugerencias`() = runBlocking {
        seedBusinessAdmin()
        fakeService.setResult(PhotoQualityResult(
            overallScore = 0.5,
            quality = PhotoQualityLevel.IMPROVABLE,
            issues = listOf("Foto oscura"),
            recommendations = listOf("Proba con mas luz natural")
        ))

        val body = PhotoQualityRequest(
            imageBase64 = "dGVzdA==",
            mediaType = "image/jpeg"
        )

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "POST"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is PhotoQualityResponse)
        val pqr = response as PhotoQualityResponse
        assertEquals("IMPROVABLE", pqr.quality)
        assertEquals(1, pqr.issues.size)
        assertEquals("Foto oscura", pqr.issues.first())
        assertEquals(1, pqr.recommendations.size)
    }

    @Test
    fun `GET lista evaluaciones del negocio`() = runBlocking {
        seedBusinessAdmin()

        // Guardar algunas evaluaciones
        repository.save("biz", PhotoQualityRecord(
            id = "1", productId = "prod-1", overallScore = 0.9, quality = "GOOD"
        ))
        repository.save("biz", PhotoQualityRecord(
            id = "2", productId = "prod-2", overallScore = 0.3, quality = "BAD",
            issues = listOf("Borrosa"), recommendations = listOf("Usar tripode")
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is PhotoQualityListResponse)
        val list = response as PhotoQualityListResponse
        assertEquals(2, list.assessments.size)
        assertEquals(1, list.totalLowQuality)
    }

    @Test
    fun `GET con filtro low retorna solo evaluaciones de baja calidad`() = runBlocking {
        seedBusinessAdmin()

        repository.save("biz", PhotoQualityRecord(
            id = "1", productId = "prod-1", overallScore = 0.9, quality = "GOOD"
        ))
        repository.save("biz", PhotoQualityRecord(
            id = "2", productId = "prod-2", overallScore = 0.3, quality = "BAD"
        ))
        repository.save("biz", PhotoQualityRecord(
            id = "3", productId = "prod-3", overallScore = 0.5, quality = "IMPROVABLE"
        ))

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf(
                "Authorization" to "token",
                "X-Http-Method" to "GET",
                "X-Query-Filter" to "low"
            ),
            textBody = ""
        )

        assertTrue(response is PhotoQualityListResponse)
        val list = response as PhotoQualityListResponse
        assertEquals(2, list.assessments.size)
        assertTrue(list.assessments.all { it.quality == "BAD" || it.quality == "IMPROVABLE" })
    }

    @Test
    fun `usuario no autorizado recibe UnauthorizedException`() = runBlocking {
        coEvery { cognito.getUser(any()) } throws RuntimeException("Unauthorized")

        val response = function.securedExecute(
            business = "biz",
            function = "business/photo-quality",
            headers = mapOf("Authorization" to "token", "X-Http-Method" to "GET"),
            textBody = ""
        )

        assertTrue(response is UnauthorizedException)
    }
}
