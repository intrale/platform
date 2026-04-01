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
 * Fake del servicio de analisis de sentimiento para tests.
 */
class FakeSentimentAnalysisService(
    private var classificationResult: SentimentResult = SentimentResult(
        sentiment = "POSITIVE",
        themes = listOf("buena atencion", "productos frescos"),
        confidence = 0.92
    ),
    private var summaryResult: WeeklySummaryResult = WeeklySummaryResult(
        summary = "3 clientes elogiaron la atencion, 1 menciono entrega lenta",
        confidence = 0.88
    )
) : SentimentAnalysisService {

    var lastReviewText: String? = null
    var lastSummaryReviews: List<ClassifiedReview>? = null

    fun setClassificationResult(result: SentimentResult) {
        classificationResult = result
    }

    fun setSummaryResult(result: WeeklySummaryResult) {
        summaryResult = result
    }

    override suspend fun classifyReview(reviewText: String): SentimentResult {
        lastReviewText = reviewText
        return classificationResult
    }

    override suspend fun generateWeeklySummary(
        reviews: List<ClassifiedReview>,
        businessName: String
    ): WeeklySummaryResult {
        lastSummaryReviews = reviews
        return summaryResult
    }
}

class ReviewSentimentFunctionTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("pizzeria")
    private val cognito = mockk<CognitoIdentityProviderClient>()
    private val tableBusiness = InMemoryDynamoDbTable<Business>(
        "business",
        TableSchema.fromBean(Business::class.java)
    ) { it.name ?: "" }
    private val tableProfiles = InMemoryDynamoDbTable<UserBusinessProfile>(
        "profiles",
        TableSchema.fromBean(UserBusinessProfile::class.java)
    ) { it.compositeKey ?: "" }

    private val fakeSentimentService = FakeSentimentAnalysisService()
    private val reviewRepository = ReviewSentimentRepository()
    private val gson = Gson()

    private val function = ReviewSentimentFunction(
        config = config,
        logger = logger,
        cognito = cognito,
        tableBusiness = tableBusiness,
        tableProfiles = tableProfiles,
        sentimentService = fakeSentimentService,
        reviewRepository = reviewRepository
    )

    private fun seedBusinessAdmin() {
        tableBusiness.putItem(Business().apply { name = "pizzeria" })
        tableProfiles.putItem(UserBusinessProfile().apply {
            email = "admin@test.com"
            business = "pizzeria"
            profile = PROFILE_BUSINESS_ADMIN
            state = BusinessState.APPROVED
        })
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = "admin"
            userAttributes = listOf(AttributeType { name = EMAIL_ATT_NAME; value = "admin@test.com" })
        }
    }

    @Test
    fun `POST con review valida clasifica sentimiento y devuelve review clasificada`() = runBlocking {
        seedBusinessAdmin()

        val body = SubmitReviewRequest(reviewText = "Excelente atencion y productos muy frescos!", rating = 5)

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/review-sentiment",
            headers = mapOf("X-Http-Method" to "POST", "Authorization" to "valid-token"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.Created, response.statusCode)
        assertTrue(response is SubmitReviewResponse)
        val submitResponse = response as SubmitReviewResponse
        assertEquals("POSITIVE", submitResponse.review["sentiment"])
        assertEquals("Excelente atencion y productos muy frescos!", fakeSentimentService.lastReviewText)
    }

    @Test
    fun `POST con review vacia devuelve error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val body = SubmitReviewRequest(reviewText = "")

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/review-sentiment",
            headers = mapOf("X-Http-Method" to "POST", "Authorization" to "valid-token"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con review demasiado larga devuelve error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val body = SubmitReviewRequest(reviewText = "a".repeat(2001))

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/review-sentiment",
            headers = mapOf("X-Http-Method" to "POST", "Authorization" to "valid-token"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST con rating invalido devuelve error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val body = SubmitReviewRequest(reviewText = "Bueno", rating = 6)

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/review-sentiment",
            headers = mapOf("X-Http-Method" to "POST", "Authorization" to "valid-token"),
            textBody = gson.toJson(body)
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST a negocio inexistente devuelve NotFound`() = runBlocking {
        // No seed business
        val body = SubmitReviewRequest(reviewText = "Genial")

        val response = function.securedExecute(
            business = "no-existe",
            function = "business/review-sentiment",
            headers = mapOf("X-Http-Method" to "POST", "Authorization" to "valid-token"),
            textBody = gson.toJson(body)
        )

        assertEquals(HttpStatusCode.NotFound, response.statusCode)
    }

    @Test
    fun `GET dashboard devuelve distribucion de sentimiento y temas`() = runBlocking {
        seedBusinessAdmin()

        // Insertar reviews
        reviewRepository.saveReview(ClassifiedReview(
            business = "pizzeria", reviewText = "Excelente!",
            sentiment = "POSITIVE", themes = listOf("buena atencion")
        ))
        reviewRepository.saveReview(ClassifiedReview(
            business = "pizzeria", reviewText = "Regular",
            sentiment = "NEUTRAL", themes = listOf("precio alto")
        ))
        reviewRepository.saveReview(ClassifiedReview(
            business = "pizzeria", reviewText = "Muy malo",
            sentiment = "NEGATIVE", themes = listOf("entrega lenta")
        ))

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/review-sentiment",
            headers = mapOf("X-Http-Method" to "GET", "Authorization" to "valid-token"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ReviewSentimentDashboardResponse)
        val dashboard = response as ReviewSentimentDashboardResponse
        assertEquals(1, dashboard.distribution["POSITIVE"])
        assertEquals(1, dashboard.distribution["NEUTRAL"])
        assertEquals(1, dashboard.distribution["NEGATIVE"])
        assertEquals(3, dashboard.topThemes.size)
        assertEquals(3, dashboard.recentReviews.size)
    }

    @Test
    fun `GET dashboard sin reviews devuelve distribucion vacia`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/review-sentiment",
            headers = mapOf("X-Http-Method" to "GET", "Authorization" to "valid-token"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ReviewSentimentDashboardResponse)
        val dashboard = response as ReviewSentimentDashboardResponse
        assertEquals(0, dashboard.distribution["POSITIVE"])
        assertEquals(0, dashboard.distribution["NEUTRAL"])
        assertEquals(0, dashboard.distribution["NEGATIVE"])
        assertTrue(dashboard.topThemes.isEmpty())
        assertTrue(dashboard.recentReviews.isEmpty())
    }

    @Test
    fun `GET by-theme devuelve reviews filtradas por tema`() = runBlocking {
        seedBusinessAdmin()

        reviewRepository.saveReview(ClassifiedReview(
            business = "pizzeria", reviewText = "Entrega lenta!",
            sentiment = "NEGATIVE", themes = listOf("entrega lenta")
        ))
        reviewRepository.saveReview(ClassifiedReview(
            business = "pizzeria", reviewText = "La entrega fue lentisima",
            sentiment = "NEGATIVE", themes = listOf("entrega lenta")
        ))
        reviewRepository.saveReview(ClassifiedReview(
            business = "pizzeria", reviewText = "Todo bien",
            sentiment = "POSITIVE", themes = listOf("buena atencion")
        ))

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/review-sentiment/by-theme",
            headers = mapOf("X-Http-Method" to "GET", "X-Theme" to "entrega lenta", "Authorization" to "valid-token"),
            textBody = ""
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is ReviewsByThemeResponse)
        val byTheme = response as ReviewsByThemeResponse
        assertEquals("entrega lenta", byTheme.theme)
        assertEquals(2, byTheme.reviews.size)
    }

    @Test
    fun `GET by-theme sin header X-Theme devuelve error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/review-sentiment/by-theme",
            headers = mapOf("X-Http-Method" to "GET", "Authorization" to "valid-token"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }

    @Test
    fun `POST sin body devuelve error de validacion`() = runBlocking {
        seedBusinessAdmin()

        val response = function.securedExecute(
            business = "pizzeria",
            function = "business/review-sentiment",
            headers = mapOf("X-Http-Method" to "POST", "Authorization" to "valid-token"),
            textBody = ""
        )

        assertTrue(response is RequestValidationException)
    }
}
