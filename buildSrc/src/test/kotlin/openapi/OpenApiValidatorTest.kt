package openapi

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OpenApiValidatorTest {

    // Los paths en openapi.yaml tienen 2 espacios de indentación bajo "paths:"
    private val minimalOpenApi = """
        paths:
          /{business}/signin:
            post:
              summary: Sign in
          /{business}/signup:
            post:
              summary: Sign up
    """.trimIndent()

    private val minimalModules = """
        bind<Function>(tag="signin") {
            singleton { SignIn() }
        }
        bind<Function>(tag="signup") {
            singleton { SignUp() }
        }
    """.trimIndent()

    @Test
    fun `extractPathTags extrae paths con business`() {
        val tags = OpenApiValidator.extractPathTags(minimalOpenApi)
        assertEquals(setOf("signin", "signup"), tags)
    }

    @Test
    fun `extractBindingTags extrae tags de bind Function`() {
        val tags = OpenApiValidator.extractBindingTags(minimalModules)
        assertEquals(setOf("signin", "signup"), tags)
    }

    @Test
    fun `extractBindingTags maneja espacios entre Function y parentesis`() {
        val modules = """bind<Function> (tag="signup") { singleton { SignUp() } }"""
        assertEquals(setOf("signup"), OpenApiValidator.extractBindingTags(modules))
    }

    @Test
    fun `extractPathTags ignora paths sin business`() {
        val openapi = """
            paths:
              /health:
                get:
                  summary: Health check
              /{business}/signin:
                post:
                  summary: Sign in
        """.trimIndent()
        val tags = OpenApiValidator.extractPathTags(openapi)
        assertEquals(setOf("signin"), tags)
    }

    @Test
    fun `validate OK cuando spec y bindings coinciden`() {
        val result = OpenApiValidator.validate(minimalOpenApi, minimalModules)
        assertTrue(result.errors.isEmpty(), "No debe haber errores: ${result.errors}")
        assertEquals(2, result.pathsFound)
        assertEquals(2, result.bindingsFound)
    }

    @Test
    fun `findBindingsWithoutPath detecta binding sin path`() {
        val bindings = setOf("signin", "signup", "endpointHuerfano")
        val paths = setOf("signin", "signup")
        val missing = OpenApiValidator.findBindingsWithoutPath(bindings, paths)
        assertEquals(setOf("endpointHuerfano"), missing)
    }

    @Test
    fun `findPathsWithoutBinding detecta path sin binding`() {
        val paths = setOf("signin", "signup", "pathHuerfano")
        val bindings = setOf("signin", "signup")
        val missing = OpenApiValidator.findPathsWithoutBinding(paths, bindings)
        assertEquals(setOf("pathHuerfano"), missing)
    }

    @Test
    fun `prefijo cubre sub-rutas con path params`() {
        val paths = setOf(
            "delivery/orders",
            "delivery/orders/{orderId}",
            "delivery/orders/active",
            "delivery/orders/{orderId}/state",
            "delivery/orders/{orderId}/status",
        )
        val bindings = setOf("delivery/orders")
        val huerfanos = OpenApiValidator.findPathsWithoutBinding(paths, bindings)
        assertTrue(huerfanos.isEmpty(), "Todos los paths deben tener binding: $huerfanos")
    }

    @Test
    fun `prefijo no provoca falsos positivos entre tags similares`() {
        val paths = setOf("client/profile", "client/profile-extra")
        val bindings = setOf("client/profile")
        // "client/profile-extra" NO empieza con "client/profile/" — no debe matchear
        val huerfanos = OpenApiValidator.findPathsWithoutBinding(paths, bindings)
        assertEquals(setOf("client/profile-extra"), huerfanos)
    }

    @Test
    fun `validate falla cuando binding no tiene path`() {
        val openapi = """
            paths:
              /{business}/signin:
        """.trimIndent()
        val modules = """
            bind<Function>(tag="signin") {}
            bind<Function>(tag="noExisteEnSpec") {}
        """.trimIndent()
        val result = OpenApiValidator.validate(openapi, modules)
        assertTrue(result.errors.isNotEmpty(), "Debe reportar error")
        assertTrue(
            result.errors.any { error -> error.items.any { "noExisteEnSpec" in it } },
            "Debe mencionar el binding huerfano",
        )
    }

    @Test
    fun `validate falla cuando path no tiene binding`() {
        val openapi = """
            paths:
              /{business}/signin:
              /{business}/sinBinding:
        """.trimIndent()
        val modules = """
            bind<Function>(tag="signin") {}
        """.trimIndent()
        val result = OpenApiValidator.validate(openapi, modules)
        assertTrue(result.errors.isNotEmpty(), "Debe reportar error")
        assertTrue(
            result.errors.any { error -> error.items.any { "sinBinding" in it } },
            "Debe mencionar el path huerfano",
        )
    }

    @Test
    fun `validate informa cantidad de paths y bindings encontrados`() {
        val openapi = """
            paths:
              /{business}/signin:
              /{business}/signup:
              /{business}/delivery/orders:
              /{business}/delivery/orders/{orderId}:
        """.trimIndent()
        val modules = """
            bind<Function>(tag="signin") {}
            bind<Function>(tag="signup") {}
            bind<Function>(tag="delivery/orders") {}
        """.trimIndent()
        val result = OpenApiValidator.validate(openapi, modules)
        assertEquals(4, result.pathsFound)
        assertEquals(3, result.bindingsFound)
        assertTrue(result.errors.isEmpty())
    }
}
