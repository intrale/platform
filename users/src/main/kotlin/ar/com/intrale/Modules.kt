package ar.com.intrale

import aws.sdk.kotlin.runtime.auth.credentials.StaticCredentialsProvider
import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.smithy.kotlin.runtime.auth.awscredentials.Credentials
import com.typesafe.config.Config
import com.typesafe.config.ConfigFactory
import net.datafaker.Faker
import org.kodein.di.DI
import org.kodein.di.bind
import org.kodein.di.instance
import org.kodein.di.singleton
import org.kodein.di.provider
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import ar.com.intrale.ChangePassword
import ar.com.intrale.RequestJoinBusiness
import ar.com.intrale.ConfigAutoAcceptDeliveries

private const val LOCAL_APP_AVAILABLE_BUSINESSES = "AVAILABLE_BUISNESS"
private const val LOCAL_AWS_REGION = "REGION_VALUE"
private const val LOCAL_AWS_ACCESS_KEY_ID = "ACCESS_KEY_ID"
private const val LOCAL_AWS_SECRET_ACCESS_KEY = "SECRET_ACCESS_KEY"
private const val LOCAL_AWS_COGNITO_USER_POOL_ID = "USER_POOL_ID"
private const val LOCAL_AWS_COGNITO_CLIENT_ID = "CLIENT_ID"
private const val LOCAL_DYNAMODB_ENDPOINT = "DYNAMODB_ENDPOINT"
private const val LOCAL_COGNITO_ENDPOINT  = "COGNITO_ENDPOINT"
private const val LOCAL_MODE              = "LOCAL_MODE"

private const val APP_AVAILABLE_BUSINESSES = "app.availableBusinesses"
private const val AWS_REGION = "aws.region"
private const val AWS_ACCESS_KEY_ID = "aws.accessKeyId"
private const val AWS_SECRET_ACCESS_KEY = "aws.secretAccessKey"
private const val AWS_COGNITO_USER_POOL_ID = "aws.cognito.userPoolId"
private const val AWS_COGNITO_CLIENT_ID = "aws.cognito.clientId"

val appModule = DI.Module("appModule") {

    bind<CognitoIdentityProviderClient> {
        singleton {
            val config = instance<UsersConfig>()

            CognitoIdentityProviderClient {
                region = config.region
                credentialsProvider = StaticCredentialsProvider(Credentials(
                    accessKeyId = config.accessKeyId,
                    secretAccessKey = config.secretAccessKey
                ))
                System.getenv(LOCAL_COGNITO_ENDPOINT)?.let {
                    endpointUrl = aws.smithy.kotlin.runtime.net.url.Url.parse(it)
                }
            }
        }
    }

    bind <DynamoDbClient> {
        singleton {
            val configFactory = ConfigFactory.load()

            DynamoDbClient.builder()
                .region(Region.of(System.getenv(LOCAL_AWS_REGION) ?: configFactory.stringValue(AWS_REGION)))
                .credentialsProvider(
                    software.amazon.awssdk.auth.credentials.StaticCredentialsProvider.create(
                        AwsBasicCredentials.create(
                            System.getenv(LOCAL_AWS_ACCESS_KEY_ID) ?: configFactory.stringValue(AWS_ACCESS_KEY_ID),
                            System.getenv(LOCAL_AWS_SECRET_ACCESS_KEY) ?: configFactory.stringValue(AWS_SECRET_ACCESS_KEY))
                    )
                )
                .apply {
                    System.getenv(LOCAL_DYNAMODB_ENDPOINT)?.let {
                        endpointOverride(java.net.URI.create(it))
                    }
                }
                .build()
        }
    }

    bind <DynamoDbEnhancedClient> {
        singleton {
            DynamoDbEnhancedClient.builder()
                .dynamoDbClient(instance())
                .build()
        }
    }

    bind <DynamoDbTable<Business>>{
        singleton {
            instance<DynamoDbEnhancedClient>().table("business", TableSchema.fromBean(Business::class.java))
        }
    }

    bind <DynamoDbTable<User>>{
        singleton {
            instance<DynamoDbEnhancedClient>().table("users", TableSchema.fromBean(User::class.java))
        }
    }

    bind <DynamoDbTable<UserBusinessProfile>>{
        singleton {
            instance<DynamoDbEnhancedClient>().table("userbusinessprofile", TableSchema.fromBean(UserBusinessProfile::class.java))
        }
    }

    bind<UsersConfig> {
        singleton {
            val configFactory = ConfigFactory.load()
            UsersConfig(
                region = System.getenv(LOCAL_AWS_REGION) ?: configFactory.stringValue(AWS_REGION),
                accessKeyId = System.getenv(LOCAL_AWS_ACCESS_KEY_ID) ?: configFactory.stringValue(AWS_ACCESS_KEY_ID),
                secretAccessKey = System.getenv(LOCAL_AWS_SECRET_ACCESS_KEY) ?: configFactory.stringValue(AWS_SECRET_ACCESS_KEY),
                awsCognitoUserPoolId = System.getenv(LOCAL_AWS_COGNITO_USER_POOL_ID) ?: configFactory.stringValue(AWS_COGNITO_USER_POOL_ID),
                awsCognitoClientId = System.getenv(LOCAL_AWS_COGNITO_CLIENT_ID) ?: configFactory.stringValue(AWS_COGNITO_CLIENT_ID),
                tableBusiness = instance()
            )
        }
    }

    bind<Faker> {
        singleton  {
            Faker()
        }
    }

    bind <Logger> {
        singleton { LoggerFactory.getLogger("AppLogger") }
    }

    bind<JwtValidator> {
        singleton {
            if (System.getenv(LOCAL_MODE)?.lowercase() == "true") {
                LocalJwtValidator(instance<UsersConfig>())
            } else {
                CognitoJwtValidator(instance<UsersConfig>())
            }
        }
    }

    bind<ClientProfileRepository> {
        singleton { ClientProfileRepository() }
    }

    bind<Function> (tag="signup") {
        singleton  { SignUp(instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="signupPlatformAdmin") {
        singleton  { SignUpPlatformAdmin(instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="signupDelivery") {
        singleton  { SignUpDelivery(instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="registerSaler") {
        singleton  { RegisterSaler(instance(), instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="signin") {
        singleton {  SignIn(instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="validate") {
        singleton {  Validate(instance(), instance(), instance()) }
    }
    bind<Function> (tag="recovery") {
        singleton {  PasswordRecovery(instance(), instance(), instance()) }
    }
    bind<Function> (tag="confirm") {
        singleton {  ConfirmPasswordRecovery(instance(), instance(), instance()) }
    }
    bind<Function> (tag="changePassword") {
        singleton {  ChangePassword(instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="profiles") {
        singleton {  Profiles(instance(), instance(), instance()) }
    }
    bind<Function> (tag="2fasetup") {
        singleton {  TwoFactorSetup(instance(), instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="2faverify") {
        singleton {  TwoFactorVerify(instance(), instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="registerBusiness") {
        singleton {  RegisterBusiness(instance(), instance(), instance()) }
    }
    bind<Function> (tag="reviewBusiness") {
        singleton {  ReviewBusinessRegistration(instance(), instance(), instance("2faverify"),
            instance("signup"), instance(),
            instance(), instance(),instance(), instance()) }
    }
    bind<Function> (tag="assignProfile") {
        singleton { AssignProfile(instance(), instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="requestJoinBusiness") {
        singleton { RequestJoinBusiness(instance(), instance(), instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="reviewJoinBusiness") {
        singleton { ReviewJoinBusiness(instance(), instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="searchBusinesses") {
        singleton { SearchBusinesses(instance<DynamoDbTable<Business>>(), instance()) }
    }
    bind<Function> (tag="configAutoAcceptDeliveries") {
        singleton { ConfigAutoAcceptDeliveries(instance(), instance(), instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="client/profile") {
        singleton { ClientProfileFunction(instance(), instance(), instance(), instance()) }
    }
    bind<Function> (tag="client/addresses") {
        singleton { ClientAddressesFunction(instance(), instance(), instance(), instance()) }
    }
}

private fun Config.stringValue(path: String): String = getValue(path).unwrapped().toString()
