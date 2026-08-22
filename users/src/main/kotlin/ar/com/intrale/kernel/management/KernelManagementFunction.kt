package ar.com.intrale.kernel.management

import ar.com.intrale.Config
import ar.com.intrale.ForbiddenException
import ar.com.intrale.JwtValidator
import ar.com.intrale.RequestValidationException
import ar.com.intrale.Response
import ar.com.intrale.SecuredFunction
import ar.com.intrale.UnauthorizedException
import ar.com.intrale.kernel.OperatorIdentity
import ar.com.intrale.kernel.resolveOperatorIdentity
import ar.com.intrale.kernel.authz.OperatorProductAuthz
import ar.com.intrale.kernel.audit.KernelActionsAudit
import ar.com.intrale.kernel.mailbox.CommandStatus
import ar.com.intrale.kernel.mailbox.KernelCommandMailbox
import ar.com.intrale.kernel.projection.KernelProjection
import ar.com.intrale.kernel.store.KernelStore
import com.google.gson.Gson
import io.konform.validation.Validation
import io.konform.validation.ValidationResult
import io.konform.validation.jsonschema.minLength
import io.konform.validation.jsonschema.pattern
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/** Formato inequivoco del identificador de producto operativo del kernel. */
internal val KERNEL_PRODUCT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$"

/** Request de una mutacion de autoridad (aprobar/rechazar/firmar). */
data class KernelCommandRequest(
    val kernelProductId: String? = null,
    val idempotencyKey: String? = null,
    val reason: String? = null
)

/** Request de alta de proyecto. */
data class KernelProjectCreateRequest(
    val kernelProductId: String? = null,
    val label: String? = null,
    val idempotencyKey: String? = null
)

/** Snapshot minimo persistido en el buzon para poder replayar la respuesta original. */
internal data class AckSnapshot(
    val commandStatus: String,
    val action: String,
    val statusCode: Int
)

/**
 * Respuesta de reconocimiento de un comando de gestion. Incluye `code` estable
 * (para copy accionable de la app) y el `commandStatus` del ciclo de vida del buzon.
 * `replayed=true` indica que la respuesta proviene de un anti-replay (no se re-ejecuto).
 */
class KernelCommandAckResponse(
    val idempotencyKey: String,
    val kernelProductId: String,
    val commandStatus: String,
    val action: String,
    val newState: String? = null,
    val replayed: Boolean = false,
    val code: String = "OK",
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Base de los handlers de gestion del kernel. Hereda [SecuredFunction] (JWT Cognito:
 * 401 sin token / token invalido ya cubierto por la clase base) y aporta el flujo
 * comun de una mutacion de autoridad:
 *
 *   1. Resolver la identidad del operador desde el JWT ya validado (401 si falta).
 *   2. Authz por producto DERIVADA DE LA IDENTIDAD (SEC-1): 403 si cross-product.
 *   3. Anti-replay atomico del buzon (SEC-3): replay devuelve la respuesta original.
 *   4. Audit log-ANTES-de-mutar (SEC-7).
 *   5. Mutacion + registro de la respuesta para replays.
 */
abstract class KernelManagementFunction(
    override val config: Config,
    override val logger: Logger,
    protected val authz: OperatorProductAuthz,
    protected val mailbox: KernelCommandMailbox,
    protected val audit: KernelActionsAudit,
    protected val store: KernelStore,
    protected val projection: KernelProjection,
    override val jwtValidator: JwtValidator
) : SecuredFunction(config, logger, jwtValidator) {

    /** Nombre estable de la accion (para audit y ack). */
    abstract val action: String

    protected val gson = Gson()

    private val commandValidation = Validation<KernelCommandRequest> {
        KernelCommandRequest::kernelProductId required {
            pattern(KERNEL_PRODUCT_ID_PATTERN) hint "kernelProductId con formato invalido"
        }
        KernelCommandRequest::idempotencyKey required {
            minLength(8)
        }
    }

    protected fun validateCommand(body: KernelCommandRequest): Response? {
        val result: ValidationResult<Any> = try {
            commandValidation(body)
        } catch (e: Exception) {
            return RequestValidationException(e.message ?: "Error de validacion")
        }
        if (!result.isValid) {
            val msg = result.errors.joinToString(" ") { "${it.dataPath.removePrefix(".")} ${it.message}" }
            return RequestValidationException(msg)
        }
        return null
    }

    /**
     * Flujo comun de una mutacion. [mutate] ejecuta la transicion de estado y
     * devuelve la [Response]; recibe la identidad ya autorizada.
     */
    protected fun runMutation(
        headers: Map<String, String>,
        kernelProductId: String,
        idempotencyKey: String,
        reason: String?,
        mutate: (OperatorIdentity) -> Response
    ): Response {
        // 1. Identidad derivada del JWT (nunca del body).
        val identity = headers.resolveOperatorIdentity() ?: return UnauthorizedException()

        // 2. Authz por producto (SEC-1 / A01): cross-product => 403.
        if (!authz.canOperate(identity, kernelProductId)) {
            logger.warn("kernel authz denegada: subject no autorizado para producto solicitado (accion=$action)")
            return ForbiddenException(code = "CROSS_PRODUCT_FORBIDDEN")
        }

        // 3. Anti-replay atomico (SEC-3 / A07): check-and-set.
        val existing = mailbox.reserve(idempotencyKey, kernelProductId, identity.subject)
        if (existing != null) {
            val body = existing.responseBody
            return if (body != null) {
                val snap = runCatching { gson.fromJson(body, AckSnapshot::class.java) }.getOrNull()
                if (snap != null) {
                    KernelCommandAckResponse(
                        idempotencyKey = idempotencyKey,
                        kernelProductId = kernelProductId,
                        commandStatus = snap.commandStatus,
                        action = snap.action,
                        replayed = true,
                        status = HttpStatusCode.fromValue(snap.statusCode)
                    )
                } else {
                    KernelCommandAckResponse(idempotencyKey, kernelProductId, existing.status.name, action, replayed = true)
                }
            } else {
                // Duplicado aun en proceso: devolvemos el estado sin re-ejecutar.
                KernelCommandAckResponse(idempotencyKey, kernelProductId, existing.status.name, action, replayed = true)
            }
        }

        // 4. Audit log-ANTES-de-mutar (SEC-7).
        audit.appendChained(
            actor = identity.subject,
            kernelProductId = kernelProductId,
            action = action,
            origin = identity.origin,
            reason = reason
        )

        // 5. Mutacion (exactamente una vez) + persistir respuesta para replays.
        val response = mutate(identity)
        val commandStatus = if (response.statusCode == HttpStatusCode.OK) CommandStatus.CONFIRMED else CommandStatus.REJECTED
        val snapshot = AckSnapshot(commandStatus.name, action, (response.statusCode ?: HttpStatusCode.OK).value)
        mailbox.complete(idempotencyKey, commandStatus, snapshot.statusCode, gson.toJson(snapshot))
        return response
    }
}
