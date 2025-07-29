package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.*
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
    private val config = UsersConfig(setOf("biz"), "us-east-1", "key", "secret", "pool", "client")

    //TODO: Revisar porque no funciona el test de ingreso exitoso
    /*@Test
    fun `ingreso exitoso`() = runBlocking {
        val table = DummySignInTableIntg().apply {
            items.add(UserBusinessProfile().apply {
                email = "user@test.com"
                business = "biz"
                profile = PROFILE_CLIENT
                state = BusinessState.APPROVED
            })
        }
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } returns AdminInitiateAuthResponse {
            authenticationResult = AuthenticationResultType {
                idToken = "id"
                accessToken = "access"
                refreshToken = "refresh"
            }
        }
        coEvery { cognito.adminGetUser(any()) } returns AdminGetUserResponse {
            username = "user@test.com"
            userAttributes = listOf(AttributeType { name = BUSINESS_ATT_NAME; value = "biz" })
        }
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"pass\"}"
        )

        assertEquals(io.ktor.http.HttpStatusCode.OK, resp.statusCode)
        coVerify(exactly = 1) { cognito.adminInitiateAuth(any()) }
        coVerify(exactly = 1) { cognito.adminGetUser(any()) }
    }*/

    @Test
    fun `cambio de contrasena requerido`() = runBlocking {
        val table = DummySignInTableIntg().apply {
            items.add(UserBusinessProfile().apply {
                email = "user@test.com"
                business = "biz"
                profile = PROFILE_CLIENT
                state = BusinessState.APPROVED
            })
        }
        val cognito = mockk<CognitoIdentityProviderClient>()
        coEvery { cognito.adminInitiateAuth(any()) } returnsMany listOf(
            AdminInitiateAuthResponse { challengeName = ChallengeNameType.NewPasswordRequired; session = "sess" },
            AdminInitiateAuthResponse { authenticationResult = AuthenticationResultType { idToken = "id"; accessToken = "access"; refreshToken = "refresh" } }
        )
        coEvery { cognito.adminRespondToAuthChallenge(any()) } returns AdminRespondToAuthChallengeResponse {}
        coEvery { cognito.adminUpdateUserAttributes(any()) } returns AdminUpdateUserAttributesResponse {}
        coEvery { cognito.adminGetUser(any()) } returns AdminGetUserResponse {
            username = "user@test.com"
            userAttributes = listOf(AttributeType { name = BUSINESS_ATT_NAME; value = "biz" })
        }
        coEvery { cognito.close() } returns Unit
        val signIn = SignIn(config, logger, cognito, table)

        val resp = signIn.execute(
            business = "biz",
            function = "signin",
            headers = emptyMap(),
            textBody = "{\"email\":\"user@test.com\",\"password\":\"old\",\"newPassword\":\"new\",\"name\":\"John\",\"familyName\":\"Doe\"}"
        )

        assertEquals(io.ktor.http.HttpStatusCode.OK, resp.statusCode)
        coVerify(exactly = 2) { cognito.adminInitiateAuth(any()) }
        coVerify(exactly = 1) { cognito.adminRespondToAuthChallenge(any()) }
        coVerify(exactly = 1) { cognito.adminUpdateUserAttributes(any()) }
    }

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

        assertEquals(io.ktor.http.HttpStatusCode.Unauthorized, resp.statusCode)
    }
}
