package ar.com.intrale.kernel

import ar.com.intrale.kernel.authz.OperatorProductAuthz
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OperatorProductAuthzTest {

    private fun identity(sub: String) = OperatorIdentity(subject = sub, email = sub)

    @Test
    fun `canOperate es verdadero solo para el producto otorgado`() {
        val authz = OperatorProductAuthz()
        authz.grant("op-a@intrale.com", "kp-alpha")

        assertTrue(authz.canOperate(identity("op-a@intrale.com"), "kp-alpha"))
    }

    @Test
    fun `canOperate cross-product es falso (SEC-1)`() {
        val authz = OperatorProductAuthz()
        authz.grant("op-a@intrale.com", "kp-alpha")

        // Operador de alpha intenta operar beta -> denegado.
        assertFalse(authz.canOperate(identity("op-a@intrale.com"), "kp-beta"))
    }

    @Test
    fun `identidad sin grants no puede operar nada`() {
        val authz = OperatorProductAuthz()
        assertFalse(authz.canOperate(identity("desconocido@intrale.com"), "kp-alpha"))
    }

    @Test
    fun `revoke elimina el permiso`() {
        val authz = OperatorProductAuthz()
        authz.grant("op-a@intrale.com", "kp-alpha")
        authz.revoke("op-a@intrale.com", "kp-alpha")
        assertFalse(authz.canOperate(identity("op-a@intrale.com"), "kp-alpha"))
    }

    @Test
    fun `isUnclaimed refleja si algun operador reclamo el producto`() {
        val authz = OperatorProductAuthz()
        assertTrue(authz.isUnclaimed("kp-nuevo"))
        authz.grant("op-a@intrale.com", "kp-nuevo")
        assertFalse(authz.isUnclaimed("kp-nuevo"))
    }

    @Test
    fun `authorizedProducts lista solo los productos del operador`() {
        val authz = OperatorProductAuthz()
        authz.grant("op-a@intrale.com", "kp-alpha")
        authz.grant("op-a@intrale.com", "kp-beta")
        authz.grant("op-b@intrale.com", "kp-gamma")

        val products = authz.authorizedProducts("op-a@intrale.com")
        assertTrue(products.containsAll(setOf("kp-alpha", "kp-beta")))
        assertFalse(products.contains("kp-gamma"))
    }
}
