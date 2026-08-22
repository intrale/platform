package ar.com.intrale.kernel

import ar.com.intrale.ForbiddenException
import ar.com.intrale.LocalJwtValidator
import ar.com.intrale.UsersConfig
import ar.com.intrale.testConfig
import ar.com.intrale.kernel.audit.KernelActionsAudit
import ar.com.intrale.kernel.authz.OperatorProductAuthz
import ar.com.intrale.kernel.mailbox.KernelCommandMailbox
import ar.com.intrale.kernel.management.ApproveProductFunction
import ar.com.intrale.kernel.management.CreateProjectFunction
import ar.com.intrale.kernel.management.KernelCommandAckResponse
import ar.com.intrale.kernel.management.KernelProductStatusFunction
import ar.com.intrale.kernel.management.RejectProductFunction
import ar.com.intrale.kernel.management.SignProductFunction
import ar.com.intrale.kernel.projection.KernelProjection
import ar.com.intrale.kernel.store.KernelProductState
import ar.com.intrale.kernel.store.KernelStore
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.runBlocking
import org.slf4j.helpers.NOPLogger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class KernelManagementFunctionsTest {

    private val logger = NOPLogger.NOP_LOGGER
    private val config: UsersConfig = testConfig("intrale")

    /** Contenedor de dependencias compartidas del kernel para un test. */
    private class Kernel {
        val authz = OperatorProductAuthz()
        val mailbox = KernelCommandMailbox()
        val audit = KernelActionsAudit()
        val store = KernelStore()
        val projection = KernelProjection(store, authz)
        val validator = LocalJwtValidator()
    }

    private fun approveFn(k: Kernel) =
        ApproveProductFunction(config, logger, k.authz, k.mailbox, k.audit, k.store, k.projection, k.validator)

    private fun rejectFn(k: Kernel) =
        RejectProductFunction(config, logger, k.authz, k.mailbox, k.audit, k.store, k.projection, k.validator)

    private fun signFn(k: Kernel) =
        SignProductFunction(config, logger, k.authz, k.mailbox, k.audit, k.store, k.projection, k.validator)

    private fun createFn(k: Kernel) =
        CreateProjectFunction(config, logger, k.authz, k.mailbox, k.audit, k.store, k.projection, k.validator)

    private fun statusFn(k: Kernel) =
        KernelProductStatusFunction(config, logger, k.authz, k.mailbox, k.audit, k.store, k.projection, k.validator)

    private fun auth(token: String) = mapOf("Authorization" to token, "X-Http-Method" to "POST")

    private fun body(kernelProductId: String, idempotencyKey: String, reason: String? = null): String {
        val r = if (reason != null) ",\"reason\":\"$reason\"" else ""
        return "{\"kernelProductId\":\"$kernelProductId\",\"idempotencyKey\":\"$idempotencyKey\"$r}"
    }

    @Test
    fun `approve sin JWT retorna 401`() = runBlocking {
        val k = Kernel()
        val response = approveFn(k).execute(
            business = "intrale",
            function = "kernel/approve",
            headers = mapOf("X-Http-Method" to "POST"),
            textBody = body("kp-alpha", "idem-approve-1")
        )
        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }

    @Test
    fun `approve con token invalido retorna 401`() = runBlocking {
        val k = Kernel()
        val response = approveFn(k).execute(
            business = "intrale",
            function = "kernel/approve",
            headers = auth("token-corrupto"),
            textBody = body("kp-alpha", "idem-approve-1")
        )
        assertEquals(HttpStatusCode.Unauthorized, response.statusCode)
    }

    @Test
    fun `approve cross-product retorna 403 y no muta (SEC-1 bloqueante)`() = runBlocking {
        val k = Kernel()
        // op-a es dueño de alpha; beta pertenece a otro operador.
        k.store.create("kp-alpha", "Alpha", "op-a@intrale.com")
        k.authz.grant("op-a@intrale.com", "kp-alpha")
        k.store.create("kp-beta", "Beta", "op-b@intrale.com")
        k.authz.grant("op-b@intrale.com", "kp-beta")

        val token = k.validator.generateToken("op-a@intrale.com")
        val response = approveFn(k).execute(
            business = "intrale",
            function = "kernel/approve",
            headers = auth(token),
            textBody = body("kp-beta", "idem-cross-1")
        )

        assertEquals(HttpStatusCode.Forbidden, response.statusCode)
        assertTrue(response is ForbiddenException)
        // No se ejecuto mutacion sobre beta:
        assertEquals(KernelProductState.DRAFT, k.store.get("kp-beta")?.state)
        // No se registro audit de la accion denegada:
        assertEquals(0, k.audit.entries("kp-beta").size)
    }

    @Test
    fun `approve autorizado transiciona a APPROVED`() = runBlocking {
        val k = Kernel()
        k.store.create("kp-alpha", "Alpha", "op-a@intrale.com")
        k.authz.grant("op-a@intrale.com", "kp-alpha")

        val token = k.validator.generateToken("op-a@intrale.com")
        val response = approveFn(k).execute(
            business = "intrale",
            function = "kernel/approve",
            headers = auth(token),
            textBody = body("kp-alpha", "idem-approve-ok")
        )

        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertTrue(response is KernelCommandAckResponse)
        assertEquals("APPROVED", (response as KernelCommandAckResponse).newState)
        assertEquals(KernelProductState.APPROVED, k.store.get("kp-alpha")?.state)
        // Audit log-antes-de-mutar registrado exactamente una vez:
        assertEquals(1, k.audit.entries("kp-alpha").size)
    }

    @Test
    fun `replay por idempotency-key NO re-ejecuta la mutacion (SEC-3 bloqueante)`() = runBlocking {
        val k = Kernel()
        k.store.create("kp-alpha", "Alpha", "op-a@intrale.com")
        k.authz.grant("op-a@intrale.com", "kp-alpha")
        val token = k.validator.generateToken("op-a@intrale.com")
        val fn = approveFn(k)

        val first = fn.execute("intrale", "kernel/approve", auth(token), body("kp-alpha", "idem-replay-1"))
        assertEquals(HttpStatusCode.OK, first.statusCode)
        assertEquals(false, (first as KernelCommandAckResponse).replayed)
        assertEquals(1, k.audit.entries("kp-alpha").size)

        // Segundo envio con el MISMO idempotencyKey.
        val replay = fn.execute("intrale", "kernel/approve", auth(token), body("kp-alpha", "idem-replay-1"))
        assertEquals(HttpStatusCode.OK, replay.statusCode)
        assertTrue((replay as KernelCommandAckResponse).replayed)
        // La mutacion NO se re-ejecuto: audit sigue en 1 (no hay segunda entrada).
        assertEquals(1, k.audit.entries("kp-alpha").size)
    }

    @Test
    fun `project-create da de alta y otorga ownership al creador`() = runBlocking {
        val k = Kernel()
        val token = k.validator.generateToken("op-c@intrale.com")
        val response = createFn(k).execute(
            business = "intrale",
            function = "kernel/project-create",
            headers = auth(token),
            textBody = "{\"kernelProductId\":\"kp-nuevo\",\"label\":\"Nuevo\",\"idempotencyKey\":\"idem-create-1\"}"
        )

        assertEquals(HttpStatusCode.Created, response.statusCode)
        assertTrue(k.store.exists("kp-nuevo"))
        assertTrue(k.authz.canOperate(OperatorIdentity("op-c@intrale.com", "op-c@intrale.com"), "kp-nuevo"))
    }

    @Test
    fun `sign solo es valido desde estado APPROVED`() = runBlocking {
        val k = Kernel()
        k.store.create("kp-alpha", "Alpha", "op-a@intrale.com")
        k.authz.grant("op-a@intrale.com", "kp-alpha")
        val token = k.validator.generateToken("op-a@intrale.com")

        // DRAFT -> sign => Conflict
        val conflict = signFn(k).execute("intrale", "kernel/sign", auth(token), body("kp-alpha", "idem-sign-x"))
        assertEquals(HttpStatusCode.Conflict, conflict.statusCode)

        // approve -> sign => OK SIGNED
        approveFn(k).execute("intrale", "kernel/approve", auth(token), body("kp-alpha", "idem-appr-y"))
        val signed = signFn(k).execute("intrale", "kernel/sign", auth(token), body("kp-alpha", "idem-sign-y"))
        assertEquals(HttpStatusCode.OK, signed.statusCode)
        assertEquals(KernelProductState.SIGNED, k.store.get("kp-alpha")?.state)
    }

    @Test
    fun `reject autorizado transiciona a REJECTED`() = runBlocking {
        val k = Kernel()
        k.store.create("kp-alpha", "Alpha", "op-a@intrale.com")
        k.authz.grant("op-a@intrale.com", "kp-alpha")
        val token = k.validator.generateToken("op-a@intrale.com")

        val response = rejectFn(k).execute(
            "intrale", "kernel/reject", auth(token), body("kp-alpha", "idem-reject-1", "no cumple")
        )
        assertEquals(HttpStatusCode.OK, response.statusCode)
        assertEquals(KernelProductState.REJECTED, k.store.get("kp-alpha")?.state)
    }

    @Test
    fun `product-status cross-product retorna 403`() = runBlocking {
        val k = Kernel()
        k.store.create("kp-beta", "Beta", "op-b@intrale.com")
        k.authz.grant("op-b@intrale.com", "kp-beta")
        val token = k.validator.generateToken("op-a@intrale.com")

        val response = statusFn(k).execute(
            business = "intrale",
            function = "kernel/product-status",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-kernelProductId" to "kp-beta"),
            textBody = ""
        )
        assertEquals(HttpStatusCode.Forbidden, response.statusCode)
    }

    @Test
    fun `product-status autorizado retorna la proyeccion`() = runBlocking {
        val k = Kernel()
        k.store.create("kp-alpha", "Alpha", "op-a@intrale.com")
        k.authz.grant("op-a@intrale.com", "kp-alpha")
        val token = k.validator.generateToken("op-a@intrale.com")

        val response = statusFn(k).execute(
            business = "intrale",
            function = "kernel/product-status",
            headers = mapOf("Authorization" to token, "X-Http-Method" to "GET", "X-Query-kernelProductId" to "kp-alpha"),
            textBody = ""
        )
        assertEquals(HttpStatusCode.OK, response.statusCode)
    }

    @Test
    fun `input invalido retorna 400`() = runBlocking {
        val k = Kernel()
        k.authz.grant("op-a@intrale.com", "kp-alpha")
        val token = k.validator.generateToken("op-a@intrale.com")
        // idempotencyKey corto (< 8) -> validacion Konform falla.
        val response = approveFn(k).execute(
            "intrale", "kernel/approve", auth(token), body("kp-alpha", "short")
        )
        assertEquals(HttpStatusCode.BadRequest, response.statusCode)
    }
}
