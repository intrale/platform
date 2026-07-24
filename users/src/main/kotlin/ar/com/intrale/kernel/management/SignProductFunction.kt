package ar.com.intrale.kernel.management

import ar.com.intrale.Config
import ar.com.intrale.ExceptionResponse
import ar.com.intrale.JwtValidator
import ar.com.intrale.RequestValidationException
import ar.com.intrale.Response
import ar.com.intrale.kernel.authz.OperatorProductAuthz
import ar.com.intrale.kernel.audit.KernelActionsAudit
import ar.com.intrale.kernel.mailbox.KernelCommandMailbox
import ar.com.intrale.kernel.projection.KernelProjection
import ar.com.intrale.kernel.store.KernelProductState
import ar.com.intrale.kernel.store.KernelStore
import com.google.gson.Gson
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/**
 * Firma un producto operativo del kernel. Solo valido desde estado APPROVED.
 * Tag Kodein: `kernel/sign`.
 */
class SignProductFunction(
    config: Config,
    logger: Logger,
    authz: OperatorProductAuthz,
    mailbox: KernelCommandMailbox,
    audit: KernelActionsAudit,
    store: KernelStore,
    projection: KernelProjection,
    jwtValidator: JwtValidator
) : KernelManagementFunction(config, logger, authz, mailbox, audit, store, projection, jwtValidator) {

    override val action: String = "sign"

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        if (textBody.isEmpty()) return RequestValidationException("Request body not found")
        val body = runCatching { Gson().fromJson(textBody, KernelCommandRequest::class.java) }.getOrNull()
            ?: return RequestValidationException("JSON invalido")
        validateCommand(body)?.let { return it }

        return runMutation(headers, body.kernelProductId!!, body.idempotencyKey!!, body.reason) { identity ->
            val current = store.get(body.kernelProductId)
                ?: return@runMutation ExceptionResponse("Producto no encontrado", HttpStatusCode.NotFound)
            if (current.state != KernelProductState.APPROVED) {
                return@runMutation ExceptionResponse(
                    "Solo se puede firmar un producto en estado APPROVED (actual: ${current.state})",
                    HttpStatusCode.Conflict
                )
            }
            val updated = store.transition(body.kernelProductId, KernelProductState.SIGNED, action, identity.subject)
                ?: return@runMutation ExceptionResponse("Producto no encontrado", HttpStatusCode.NotFound)
            KernelCommandAckResponse(
                idempotencyKey = body.idempotencyKey,
                kernelProductId = body.kernelProductId,
                commandStatus = "CONFIRMED",
                action = action,
                newState = updated.state.name
            )
        }
    }
}
