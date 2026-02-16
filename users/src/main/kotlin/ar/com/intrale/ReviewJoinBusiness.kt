package ar.com.intrale

import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import io.konform.validation.Validation
import io.konform.validation.jsonschema.pattern
import org.slf4j.Logger
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable

class ReviewJoinBusiness(
    override val config: UsersConfig,
    override val logger: Logger,
    private val cognito: CognitoIdentityProviderClient,
    private val tableProfiles: DynamoDbTable<UserBusinessProfile>,
    override val jwtValidator: JwtValidator = CognitoJwtValidator(config)
) : SecuredFunction(config = config, logger = logger, jwtValidator = jwtValidator) {

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting review join business $function")

        val body = parseBody<ReviewJoinBusinessRequest>(textBody)
            ?: return RequestValidationException("Request body not found")
        val validationError = validateRequest(body, Validation {
            ReviewJoinBusinessRequest::email required {
                pattern(EMAIL_REGEX) hint EMAIL_VALIDATION_HINT
            }
            ReviewJoinBusinessRequest::decision required {
                pattern(Regex("^(APPROVED|REJECTED)$", RegexOption.IGNORE_CASE)) hint "Debe ser APPROVED o REJECTED"
            }
        })
        if (validationError != null) return validationError

        val (_, _) = requireApprovedProfile(
            cognito, headers, tableProfiles, business, PROFILE_BUSINESS_ADMIN
        ) ?: return UnauthorizedException()

        val key = UserBusinessProfile().apply {
            this.email = body.email
            this.business = business
            this.profile = PROFILE_DELIVERY
        }
        val existing = tableProfiles.getItem(key) ?: return ExceptionResponse("Request not found")
        existing.state = if (body.decision.uppercase() == "APPROVED") BusinessState.APPROVED else BusinessState.REJECTED
        tableProfiles.updateItem(existing)

        logger.debug("return review join business $function")
        return Response()
    }
}
