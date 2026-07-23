package ar.com.intrale.kernel.management

import ar.com.intrale.Config
import ar.com.intrale.ExceptionResponse
import ar.com.intrale.JwtValidator
import ar.com.intrale.RequestValidationException
import ar.com.intrale.Response
import ar.com.intrale.UnauthorizedException
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

/**
 * Alta de un producto operativo del kernel. Tag Kodein: `kernel/project-create`.
 *
 * A diferencia de las mutaciones, el alta NO puede gatearse por `canOperate`
 * (el producto aun no tiene grants). Politica de bootstrap segura (SEC-1):
 *   - solo se puede crear un `kernelProductId` que NO exista y NO este reclamado
 *     por ningun operador (evita takeover cross-product), y
 *   - al crear, el operador queda como owner (recibe el grant).
 * Sigue exigiendo JWT valido (base), anti-replay atomico y audit log-antes-de-mutar.
 * Rate-limit por identidad (A04) queda documentado como mejora no bloqueante.
 */
class CreateProjectFunction(
    config: Config,
    logger: Logger,
    authz: OperatorProductAuthz,
    mailbox: KernelCommandMailbox,
    audit: KernelActionsAudit,
    store: KernelStore,
    projection: KernelProjection,
    jwtValidator: JwtValidator
) : KernelManagementFunction(config, logger, authz, mailbox, audit, store, projection, jwtValidator) {

    override val action: String = "project-create"

    private val validation = Validation<KernelProjectCreateRequest> {
        KernelProjectCreateRequest::kernelProductId required {
            pattern(KERNEL_PRODUCT_ID_PATTERN) hint "kernelProductId con formato invalido"
        }
        KernelProjectCreateRequest::label required {
            minLength(2)
        }
        KernelProjectCreateRequest::idempotencyKey required {
            minLength(8)
        }
    }

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = runCatching { Gson().fromJson(textBody, KernelProjectCreateRequest::class.java) }.getOrNull()
            ?: return RequestValidationException("JSON invalido")
        val result: ValidationResult<Any> = try {
            validation(body)
        } catch (e: Exception) {
            return RequestValidationException(e.message ?: "Error de validacion")
        }
        if (!result.isValid) {
            return RequestValidationException(
                result.errors.joinToString(" ") { "${it.dataPath.removePrefix(".")} ${it.message}" }
            )
        }

        val kernelProductId = body.kernelProductId!!
        val idempotencyKey = body.idempotencyKey!!

        val identity = headers.resolveOperatorIdentity() ?: return UnauthorizedException()

        // Anti-replay atomico (SEC-3): replay del mismo key no re-crea.
        val existing = mailbox.reserve(idempotencyKey, kernelProductId, identity.subject)
        if (existing != null) {
            return KernelCommandAckResponse(
                idempotencyKey = idempotencyKey,
                kernelProductId = kernelProductId,
                commandStatus = existing.status.name,
                action = action,
                replayed = true
            )
        }

        // Politica de bootstrap: no pisar un producto ya existente/reclamado (SEC-1).
        if (store.exists(kernelProductId) || !authz.isUnclaimed(kernelProductId)) {
            return rejectConflict(idempotencyKey)
        }

        // Audit log-ANTES-de-mutar (SEC-7).
        audit.appendChained(
            actor = identity.subject,
            kernelProductId = kernelProductId,
            action = action,
            origin = identity.origin,
            reason = "label=${body.label}"
        )

        val created = store.create(kernelProductId, body.label!!, identity.subject)
            ?: return rejectConflict(idempotencyKey)
        // El creador queda como owner del producto.
        authz.grant(identity.subject, kernelProductId)

        val ack = KernelCommandAckResponse(
            idempotencyKey = idempotencyKey,
            kernelProductId = kernelProductId,
            commandStatus = "CONFIRMED",
            action = action,
            newState = created.state.name,
            status = HttpStatusCode.Created
        )
        mailbox.complete(
            idempotencyKey, CommandStatus.CONFIRMED, ack.statusCode!!.value,
            gson.toJson(AckSnapshot(CommandStatus.CONFIRMED.name, action, ack.statusCode!!.value))
        )
        return ack
    }

    private fun rejectConflict(idempotencyKey: String): Response {
        val conflict = ExceptionResponse("El producto ya existe", HttpStatusCode.Conflict)
        mailbox.complete(
            idempotencyKey, CommandStatus.REJECTED, conflict.statusCode!!.value,
            gson.toJson(AckSnapshot(CommandStatus.REJECTED.name, action, conflict.statusCode!!.value))
        )
        return conflict
    }
}
