package ar.com.intrale.kernel.management

import ar.com.intrale.Config
import ar.com.intrale.ExceptionResponse
import ar.com.intrale.ForbiddenException
import ar.com.intrale.JwtValidator
import ar.com.intrale.Response
import ar.com.intrale.UnauthorizedException
import ar.com.intrale.kernel.resolveOperatorIdentity
import ar.com.intrale.kernel.authz.OperatorProductAuthz
import ar.com.intrale.kernel.audit.KernelActionsAudit
import ar.com.intrale.kernel.mailbox.KernelCommandMailbox
import ar.com.intrale.kernel.projection.KernelProductProjection
import ar.com.intrale.kernel.projection.KernelProjection
import ar.com.intrale.kernel.store.KernelStore
import io.ktor.http.HttpStatusCode
import org.slf4j.Logger

/** Estado por producto (read-model). Un solo producto (200/403/404) o lista de autorizados. */
class KernelProductStatusResponse(
    val product: KernelProductProjection,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/** Lista minimizada de los productos autorizados para el operador. */
class KernelProductListResponse(
    val products: List<KernelProductProjection>,
    status: HttpStatusCode = HttpStatusCode.OK
) : Response(statusCode = status)

/**
 * Consulta de estado por producto (read-model minimizado). Tag Kodein: `kernel/product-status`.
 *
 * Read-only: no muta, no usa idempotencyKey. Aplica el mismo gate de authz por
 * identidad (SEC-1): consultar un producto no autorizado devuelve 403.
 */
class KernelProductStatusFunction(
    config: Config,
    logger: Logger,
    authz: OperatorProductAuthz,
    mailbox: KernelCommandMailbox,
    audit: KernelActionsAudit,
    store: KernelStore,
    projection: KernelProjection,
    jwtValidator: JwtValidator
) : KernelManagementFunction(config, logger, authz, mailbox, audit, store, projection, jwtValidator) {

    override val action: String = "product-status"

    override suspend fun securedExecute(
        business: String,
        function: String,
        headers: Map<String, String>,
        textBody: String
    ): Response {
        val identity = headers.resolveOperatorIdentity() ?: return UnauthorizedException()

        val kernelProductId = headers["X-Query-kernelProductId"]?.takeIf { it.isNotBlank() }
        if (kernelProductId == null) {
            // Sin id -> lista minimizada de productos autorizados (sin N+1).
            return KernelProductListResponse(projection.projectFor(identity))
        }

        // Authz por identidad (SEC-1): cross-product => 403 antes de revelar existencia.
        if (!authz.canOperate(identity, kernelProductId)) {
            return ForbiddenException(code = "CROSS_PRODUCT_FORBIDDEN")
        }
        val projected = projection.projectOne(identity, kernelProductId)
            ?: return ExceptionResponse("Producto no encontrado", HttpStatusCode.NotFound)
        return KernelProductStatusResponse(projected)
    }
}
