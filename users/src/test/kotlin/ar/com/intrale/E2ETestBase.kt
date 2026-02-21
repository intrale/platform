package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.model.AttributeType
import aws.sdk.kotlin.services.cognitoidentityprovider.model.GetUserResponse
import io.ktor.server.testing.*
import io.mockk.coEvery
import io.mockk.mockk
import net.datafaker.Faker
import org.kodein.di.*
import org.kodein.di.ktor.di
import org.slf4j.LoggerFactory
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

/**
 * Base abstracta para tests E2E.
 * Levanta el servidor Ktor con DI real, tablas in-memory, JWT local y Cognito mock.
 */
abstract class E2ETestBase {

    protected val jwtValidator = LocalJwtValidator()
    protected val tableBusiness = InMemoryDynamoDbTable.forBusiness()
    protected val tableUsers = InMemoryDynamoDbTable.forUser()
    protected val tableProfiles = InMemoryDynamoDbTable.forProfile()
    protected val cognito: CognitoIdentityProviderClient = mockk(relaxed = true)
    protected val logger = LoggerFactory.getLogger("ar.com.intrale.e2e")

    protected fun e2eModule(): DI.Module {
        val config = UsersConfig(
            region = "us-east-1",
            accessKeyId = "key",
            secretAccessKey = "secret",
            awsCognitoUserPoolId = "pool",
            awsCognitoClientId = "test-client-id",
            tableBusiness = tableBusiness
        )
        return DI.Module("e2e", allowSilentOverride = true) {
            bind<UsersConfig>() { singleton { config } }
            bind<Config>() { singleton { config } }
            bind<JwtValidator>() { singleton { jwtValidator } }
            bind<org.slf4j.Logger>() { singleton { logger } }
            bind<CognitoIdentityProviderClient>() { singleton { cognito } }
            bind<DynamoDbTable<Business>>() { singleton { tableBusiness } }
            bind<DynamoDbTable<User>>() { singleton { tableUsers } }
            bind<DynamoDbTable<UserBusinessProfile>>() { singleton { tableProfiles } }
            bind<Faker>() { singleton { Faker() } }
            bind<ClientProfileRepository>() { singleton { ClientProfileRepository() } }
            bind<ClientOrderRepository>() { singleton { ClientOrderRepository() } }

            // Funciones no seguras
            bind<Function>(tag = "signup") {
                singleton { SignUp(instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "signupPlatformAdmin") {
                singleton { SignUpPlatformAdmin(instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "signupDelivery") {
                singleton { SignUpDelivery(instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "signin") {
                singleton { SignIn(instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "validate") {
                singleton { Validate(instance(), instance(), instance()) }
            }
            bind<Function>(tag = "recovery") {
                singleton { PasswordRecovery(instance(), instance(), instance()) }
            }
            bind<Function>(tag = "confirm") {
                singleton { ConfirmPasswordRecovery(instance(), instance(), instance()) }
            }
            bind<Function>(tag = "registerBusiness") {
                singleton { RegisterBusiness(instance(), instance(), instance()) }
            }
            bind<Function>(tag = "searchBusinesses") {
                singleton { SearchBusinesses(instance<DynamoDbTable<Business>>(), instance()) }
            }

            // Funciones seguras (con JwtValidator inyectado)
            bind<Function>(tag = "changePassword") {
                singleton { ChangePassword(instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "profiles") {
                singleton { Profiles(instance(), instance(), instance()) }
            }
            bind<Function>(tag = "2fasetup") {
                singleton { TwoFactorSetup(instance(), instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "2faverify") {
                singleton { TwoFactorVerify(instance(), instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "reviewBusiness") {
                singleton {
                    ReviewBusinessRegistration(
                        instance(), instance(), instance("2faverify"),
                        instance("signup"), instance(),
                        instance(), instance(), instance(), instance()
                    )
                }
            }
            bind<Function>(tag = "assignProfile") {
                singleton { AssignProfile(instance(), instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "registerSaler") {
                singleton { RegisterSaler(instance(), instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "requestJoinBusiness") {
                singleton { RequestJoinBusiness(instance(), instance(), instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "reviewJoinBusiness") {
                singleton { ReviewJoinBusiness(instance(), instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "configAutoAcceptDeliveries") {
                singleton { ConfigAutoAcceptDeliveries(instance(), instance(), instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "client/profile") {
                singleton { ClientProfileFunction(instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "client/addresses") {
                singleton { ClientAddressesFunction(instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "client/orders") {
                singleton { ClientOrders(instance(), instance(), instance(), instance()) }
            }
            bind<Function>(tag = "client/order-detail") {
                singleton { ClientOrderDetail(instance(), instance(), instance(), instance()) }
            }
        }
    }

    protected fun e2eTest(block: suspend ApplicationTestBuilder.(io.ktor.client.HttpClient) -> Unit) =
        testApplication {
            application {
                di { import(e2eModule()) }
                configureDynamicRouting()
            }
            block(client)
        }

    // --- Helpers de seeding ---

    protected fun seedBusiness(
        name: String,
        publicId: String = name,
        state: BusinessState = BusinessState.APPROVED,
        emailAdmin: String = "admin@$name.com",
        autoAcceptDeliveries: Boolean = false
    ) {
        tableBusiness.putItem(
            Business(
                businessId = java.util.UUID.randomUUID().toString(),
                publicId = publicId,
                name = name,
                emailAdmin = emailAdmin,
                state = state,
                autoAcceptDeliveries = autoAcceptDeliveries
            )
        )
    }

    protected fun seedPlatformAdmin(email: String, business: String) {
        tableProfiles.putItem(
            UserBusinessProfile().apply {
                this.email = email
                this.business = business
                this.profile = PROFILE_PLATFORM_ADMIN
                this.state = BusinessState.APPROVED
            }
        )
    }

    protected fun seedBusinessAdmin(email: String, business: String) {
        tableProfiles.putItem(
            UserBusinessProfile().apply {
                this.email = email
                this.business = business
                this.profile = PROFILE_BUSINESS_ADMIN
                this.state = BusinessState.APPROVED
            }
        )
    }

    protected fun seedClientProfile(email: String, business: String, profile: String, state: BusinessState = BusinessState.APPROVED) {
        tableProfiles.putItem(
            UserBusinessProfile().apply {
                this.email = email
                this.business = business
                this.profile = profile
                this.state = state
            }
        )
    }

    protected fun tokenFor(email: String): String = jwtValidator.generateToken(email)

    protected fun configureCognitoGetUser(email: String) {
        coEvery { cognito.getUser(any()) } returns GetUserResponse {
            username = email
            userAttributes = listOf(
                AttributeType { name = EMAIL_ATT_NAME; value = email }
            )
        }
    }

    protected fun resetTables() {
        tableBusiness.items.clear()
        tableUsers.items.clear()
        tableProfiles.items.clear()
    }
}
