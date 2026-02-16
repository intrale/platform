package ar.com.intrale

import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import aws.smithy.kotlin.runtime.auth.awscredentials.Credentials
import aws.smithy.kotlin.runtime.auth.awscredentials.Credentials.Companion.invoke
import net.datafaker.Faker
import org.slf4j.Logger
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient

import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.*


class TestDynamoDB(override val config: UsersConfig, val faker: Faker, override val logger: Logger, override val jwtValidator: JwtValidator = CognitoJwtValidator(config)) :
    SecuredFunction(config=config, logger=logger, jwtValidator=jwtValidator) {
    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {


        val dynamoDbClient: DynamoDbClient = DynamoDbClient.builder()
            .region(Region.of(config.region))
            .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(config.accessKeyId, config.secretAccessKey)))
            .build()


        val enhancedClient = DynamoDbEnhancedClient.builder()
            .dynamoDbClient(dynamoDbClient)
            .build()

        return Response();

    }
}