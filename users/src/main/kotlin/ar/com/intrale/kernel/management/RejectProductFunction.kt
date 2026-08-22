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

/** Rechaza un producto operativo del kernel. Tag Kodein: `kernel/reject`. */
class RejectProductFunction(
    config: Config,
    logger: Logger,
    authz: OperatorProductAuthz,
    mailbox: KernelCommandMailbox,
    audit: KernelActionsAudit,
    store: KernelStore,
    projection: KernelProjection,
    jwtValidator: JwtValidator
) : KernelManagementFunction(config, logger, authz, mailbox, audit, store, projection, jwtValidator) {

    override val action: String = "reject"

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
            val updated = store.transition(body.kernelProductId, KernelProductState.REJECTED, action, identity.subject)
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
