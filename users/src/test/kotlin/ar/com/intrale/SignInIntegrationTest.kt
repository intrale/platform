package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.*
import io.ktor.http.HttpStatusCode
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClientExtension
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.Key
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.enhanced.dynamodb.model.Page
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable
import software.amazon.awssdk.core.pagination.sync.SdkIterable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DummySignInTableIntg : DynamoDbTable<UserBusinessProfile> {
    val items = mutableListOf<UserBusinessProfile>()
    override fun mapperExtension(): DynamoDbEnhancedClientExtension? = null
    override fun tableSchema(): TableSchema<UserBusinessProfile> = TableSchema.fromBean(UserBusinessProfile::class.java)
    override fun tableName(): String = "profiles"
    override fun keyFrom(item: UserBusinessProfile): Key = Key.builder().partitionValue(item.compositeKey).build()
    override fun index(indexName: String) = throw UnsupportedOperationException()
    override fun putItem(item: UserBusinessProfile) { items.add(item) }
    override fun scan(): PageIterable<UserBusinessProfile> =
        PageIterable.create(SdkIterable { mutableListOf(Page.create(items)).iterator() })
    override fun getItem(key: Key): UserBusinessProfile? = items.find { it.compositeKey == key.partitionKeyValue().s() }
}

class SignInIntegrationTest {
    private val logger = NOPLogger.NOP_LOGGER
    private val config = testConfig("biz")

    private fun approvedProfile(email: String = "user@test.com", business: String = "biz"): DummySignInTableIntg =
        DummySignInTableIntg().apply {
            items.add(UserBusinessProfile().apply {
                this.email = email
                this.business = business
                this.profile = PROFILE_CLIENT
                this.state = BusinessState.APPROVED
            })
        }

    private fun cognitoWithTokens(
        id: String = "id-token",
        access: String = "access-token",
        refresh: String = "refresh-token"
    ): CognitoIdentityProviderClient {
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } returns AdminInitiateAuthResponse {
            authenticationResult = AuthenticationResultType {
                idToken = id
                accessToken = access
                refreshToken = refresh
            }
        }
        coEvery { cognito.close() } returns Unit
        return cognito
    }

    // --- Casos exitosos ---

    @Test
    fun `ingreso exitoso retorna tokens`() = runBlocking {
        val table = approvedProfile()
        val cognito = cognitoWithTokens()
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\"}"
        )

        assertEquals(HttpStatusCode.OK, resp.statusCode)
        assertTrue(resp is SignInResponse)
        assertEquals("id-token", (resp as SignInResponse).idToken)
        assertEquals("access-token", resp.accessToken)
        assertEquals("refresh-token", resp.refreshToken)
        coVerify(exactly = 1) { cognito.adminInitiateAuth(any()) }
    }

    @Test
    fun `cambio de contrasena requerido completa flujo y retorna tokens`() = runBlocking {
        val table = approvedProfile()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } returnsMany listOf(
            AdminInitiateAuthResponse { challengeName = ChallengeNameType.NewPasswordRequired; session = "sess" },
            AdminInitiateAuthResponse { authenticationResult = AuthenticationResultType { idToken = "id"; accessToken = "access"; refreshToken = "refresh" } }
        )
        coEvery { cognito.adminRespondToAuthChallenge(any()) } returns AdminRespondToAuthChallengeResponse {}
        coEvery { cognito.adminUpdateUserAttributes(any()) } returns AdminUpdateUserAttributesResponse {}
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"old\",\"newPassword\":\"new\",\"name\":\"John\",\"familyName\":\"Doe\"}"
        )

        assertEquals(HttpStatusCode.OK, resp.statusCode)
        coVerify(exactly = 2) { cognito.adminInitiateAuth(any()) }
        coVerify(exactly = 1) { cognito.adminRespondToAuthChallenge(any()) }
        coVerify(exactly = 1) { cognito.adminUpdateUserAttributes(any()) }
    }

    // --- Validacion de request ---

    @Test
    fun `body vacio retorna error de validacion`() = runBlocking {
        val table = DummySignInTableIntg()
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = ""
        )

        assertEquals(HttpStatusCode.BadRequest, resp.statusCode)
        assertEquals("Request body not found", (resp as RequestValidationException).message)
    }

    @Test
    fun `email faltante retorna error de validacion`() = runBlocking {
        val table = DummySignInTableIntg()
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"password\":\"pass\"}"
        )

        assertEquals(HttpStatusCode.BadRequest, resp.statusCode)
        assertTrue(resp is RequestValidationException)
    }

    @Test
    fun `password faltante retorna error de validacion`() = runBlocking {
        val table = DummySignInTableIntg()
        val cognito = mockk<CognitoIdentityProviderClient>(relaxed = true)
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\"}"
        )

        assertEquals(HttpStatusCode.BadRequest, resp.statusCode)
        assertTrue(resp is RequestValidationException)
    }

    // --- Challenge NEW_PASSWORD_REQUIRED sin campos requeridos ---

    @Test
    fun `challenge sin newPassword retorna error de validacion`() = runBlocking {
        val table = DummySignInTableIntg()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } returns AdminInitiateAuthResponse {
            challengeName = ChallengeNameType.NewPasswordRequired; session = "sess"
        }
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\"}"
        )

        assertEquals(HttpStatusCode.BadRequest, resp.statusCode)
        assertEquals("newPassword is required", (resp as RequestValidationException).message)
    }

    @Test
    fun `challenge sin name retorna error de validacion`() = runBlocking {
        val table = DummySignInTableIntg()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } returns AdminInitiateAuthResponse {
            challengeName = ChallengeNameType.NewPasswordRequired; session = "sess"
        }
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\",\"newPassword\":\"new\"}"
        )

        assertEquals(HttpStatusCode.BadRequest, resp.statusCode)
        assertEquals("name is required", (resp as RequestValidationException).message)
    }

    @Test
    fun `challenge sin familyName retorna error de validacion`() = runBlocking {
        val table = DummySignInTableIntg()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } returns AdminInitiateAuthResponse {
            challengeName = ChallengeNameType.NewPasswordRequired; session = "sess"
        }
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\",\"newPassword\":\"new\",\"name\":\"John\"}"
        )

        assertEquals(HttpStatusCode.BadRequest, resp.statusCode)
        assertEquals("familyName is required", (resp as RequestValidationException).message)
    }

    // --- Autorizacion por pertenencia al negocio ---

    @Test
    fun `usuario sin perfil en el negocio retorna no autorizado`() = runBlocking {
        val table = DummySignInTableIntg()
        val cognito = cognitoWithTokens()
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\"}"
        )

        assertEquals(HttpStatusCode.Unauthorized, resp.statusCode)
        assertTrue(resp is UnauthorizedException)
    }

    @Test
    fun `usuario con perfil en otro negocio retorna no autorizado`() = runBlocking {
        val table = approvedProfile(business = "otro-negocio")
        val cognito = cognitoWithTokens()
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\"}"
        )

        assertEquals(HttpStatusCode.Unauthorized, resp.statusCode)
        assertTrue(resp is UnauthorizedException)
    }

    @Test
    fun `usuario con estado PENDING retorna no autorizado`() = runBlocking {
        val table = DummySignInTableIntg().apply {
            items.add(UserBusinessProfile().apply {
                email = "user@test.com"
                business = "biz"
                profile = PROFILE_CLIENT
                state = BusinessState.PENDING
            })
        }
        val cognito = cognitoWithTokens()
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\"}"
        )

        assertEquals(HttpStatusCode.Unauthorized, resp.statusCode)
        assertTrue(resp is UnauthorizedException)
    }

    // --- Errores de Cognito ---

    @Test
    fun `credenciales invalidas retornan no autorizado`() = runBlocking {
        val table = DummySignInTableIntg()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } throws NotAuthorizedException { }
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"bad\"}"
        )

        assertEquals(HttpStatusCode.Unauthorized, resp.statusCode)
        assertTrue(resp is UnauthorizedException)
    }

    @Test
    fun `excepcion generica de Cognito retorna error interno`() = runBlocking {
        val table = DummySignInTableIntg()
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } throws RuntimeException("Cognito unavailable")
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\"}"
        )

        assertEquals(HttpStatusCode.InternalServerError, resp.statusCode)
        assertTrue(resp is ExceptionResponse)
        assertEquals("Cognito unavailable", (resp as ExceptionResponse).message)
    }
}
