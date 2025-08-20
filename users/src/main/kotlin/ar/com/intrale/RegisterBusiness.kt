package ar.com.intrale

import aws.sdk.kotlin.runtime.auth.credentials.StaticCredentialsProvider
import aws.sdk.kotlin.services.cognitoidentityprovider.CognitoIdentityProviderClient
import aws.sdk.kotlin.services.cognitoidentityprovider.getUser
import aws.smithy.kotlin.runtime.auth.awscredentials.Credentials
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.Validation.Companion.invoke
import io.konform.validation.ValidationResult
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import net.datafaker.Faker
import org.apache.commons.codec.binary.Base32
import org.slf4j.Logger
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable
import software.amazon.awssdk.enhanced.dynamodb.TableSchema
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import java.security.SecureRandom
import kotlin.math.log
import io.ktor.http.HttpStatusCode
import java.util.UUID
import java.text.Normalizer

class RegisterBusiness (val config: UsersConfig, val logger: Logger, val tableBusiness: DynamoDbTable<Business>) :
    Function {


    fun requestValidation(body:RegisterBusinessRequest): Response? {
        val validation = Validation<RegisterBusinessRequest> {
            RegisterBusinessRequest::name required {
                minLength(7)
            }
            RegisterBusinessRequest::emailAdmin required {
                pattern(".+@.+\\..+") hint "El campo emailAdmin debe tener formato de email. Valor actual: '{value}'"
            }
            RegisterBusinessRequest::description required {}
        }
        val validationResult: ValidationResult<Any> = try {
            validation(body)
        } catch (e: Exception) {
            e.printStackTrace()
            return RequestValidationException(e.message ?: "Unknown error")
        }
        if (!validationResult.isValid) {
            val errorsMessage = validationResult.errors.joinToString(" ") {
                "${it.dataPath.substring(1)} ${it.message}"
            }
            return RequestValidationException(errorsMessage)
        }
        return null
    }

    override suspend fun execute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        logger.debug("starting register business $function")

        // Validacion del request
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = Gson().fromJson(textBody, RegisterBusinessRequest::class.java)
        val response = requestValidation(body)
        if (response != null) return response

        val existing = tableBusiness.getItem(Business().apply { name = body.name })
        if (existing != null && existing.state == BusinessState.PENDING && existing.emailAdmin == body.emailAdmin) {
            return ExceptionResponse("Negocio pendiente con mismo nombre y administrador", HttpStatusCode.BadRequest)
        }

        var slug = slugify(body.name)
        if (tableBusiness.scan().items().any { it.publicId == slug }) {
            slug += "-" + UUID.randomUUID().toString().take(8)
        }

        val newBusiness = Business(
            businessId = UUID.randomUUID().toString(),
            publicId = slug,
            name = body.name,
            description = body.description,
            emailAdmin = body.emailAdmin,
            autoAcceptDeliveries = body.autoAcceptDeliveries,
        )
        logger.debug("persisting business $newBusiness")
        tableBusiness.putItem(newBusiness)
        logger.debug("return register business $function")
        return Response()
    }

    private fun slugify(value: String): String {
        val normalized = Normalizer.normalize(value.lowercase(), Normalizer.Form.NFD)
        return normalized.replace("\\p{InCombiningDiacriticalMarks}+".toRegex(), "")
            .replace("[^a-z0-9]+".toRegex(), "-")
            .trim('-')
    }
}