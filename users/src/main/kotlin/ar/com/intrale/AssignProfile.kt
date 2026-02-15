package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class AssignProfile(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>
) : SecuredFunction(config = config, logger = logger) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting assign profile $function")

        val body = parseBody<AssignProfileRequest>(textBody)
            ?: return RequestValidationException("Request body not found")
        val validationError = validateRequest(body, Validation {
            AssignProfileRequest::email required {
                pattern(EMAIL_REGEX) hint EMAIL_VALIDATION_HINT
            }
            AssignProfileRequest::profile required {}
        })
        if (validationError != null) return validationError

        val (_, _) = requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_PLATFORM_ADMIN
        ) ?: return UnauthorizedException()

        UserBusinessProfileUtils.upsertUserBusinessProfile(
            tableProfiles,
            body.email,
            business,
            body.profile,
            BusinessState.APPROVED
        )
        logger.debug("persisting profile for ${body.email}")
        logger.debug("return assign profile $function")
        return Response()
    }
}
