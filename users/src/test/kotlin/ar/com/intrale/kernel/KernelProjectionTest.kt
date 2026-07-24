package ar.com.intrale.kernel

import ar.com.intrale.kernel.authz.OperatorProductAuthz
import ar.com.intrale.kernel.projection.KernelProjection
import ar.com.intrale.kernel.store.KernelProductState
import ar.com.intrale.kernel.store.KernelStore
import com.google.gson.Gson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class KernelProjectionTest {

    private fun identity(sub: String) = OperatorIdentity(subject = sub, email = sub)

    @Test
    fun `projectOne solo para productos autorizados (SEC-1)`() {
        val store = KernelStore()
        val authz = OperatorProductAuthz()
        val projection = KernelProjection(store, authz)
        store.create("kp-alpha", "Alpha", "op-a")
        authz.grant("op-a", "kp-alpha")

        assertNotNull(projection.projectOne(identity("op-a"), "kp-alpha"))
        // Otro operador no autorizado -> null (el handler traduce a 403).
        assertNull(projection.projectOne(identity("op-b"), "kp-alpha"))
    }

    @Test
    fun `la proyeccion NO expone campos internos de autoridad (SEC-5)`() {
        val store = KernelStore()
        val authz = OperatorProductAuthz()
        val projection = KernelProjection(store, authz)
        store.create("kp-alpha", "Alpha", "op-a")
        authz.grant("op-a", "kp-alpha")

        val projected = projection.projectOne(identity("op-a"), "kp-alpha")
        assertNotNull(projected)
        // El payload serializado no debe contener internals/actor/secretos.
        val json = Gson().toJson(projected)
        assertFalse(json.contains("internalNote"))
        assertFalse(json.contains("lastActor"))
        // Allowlist esperada:
        assertTrue(json.contains("kernelProductId"))
        assertTrue(json.contains("availableActions"))
    }

    @Test
    fun `projectFor devuelve solo los productos autorizados sin N+1`() {
        val store = KernelStore()
        val authz = OperatorProductAuthz()
        val projection = KernelProjection(store, authz)
        store.create("kp-alpha", "Alpha", "op-a")
        store.create("kp-beta", "Beta", "op-b")
        authz.grant("op-a", "kp-alpha")

        val list = projection.projectFor(identity("op-a"))
        assertEquals(1, list.size)
        assertEquals("kp-alpha", list[0].kernelProductId)
    }

    @Test
    fun `availableActions depende del estado`() {
        assertEquals(listOf("approve", "reject"), KernelProjection.actionsFor(KernelProductState.DRAFT))
        assertEquals(listOf("sign", "reject"), KernelProjection.actionsFor(KernelProductState.APPROVED))
        assertTrue(KernelProjection.actionsFor(KernelProductState.SIGNED).isEmpty())
    }
}
