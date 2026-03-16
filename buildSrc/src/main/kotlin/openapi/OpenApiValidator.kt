package openapi

import java.io.File

data class OpenApiValidationError(
    val message: String,
    val items: List<String> = emptyList(),
)

data class OpenApiValidationResult(
    val errors: List<OpenApiValidationError>,
    val pathsFound: Int,
    val bindingsFound: Int,
)

/**
 * Valida la consistencia entre el spec OpenAPI y los bindings de Kodein.
 *
 * Lógica de matching:
 * - Un binding con tag "delivery/orders" cubre todos los paths que empiecen con
 *   "delivery/orders" o "delivery/orders/", incluyendo sub-rutas y path params.
 * - Paths sin {business} (como /health) se ignoran — son rutas especiales del servidor.
 */
object OpenApiValidator {

    private val PATH_REGEX = Regex("""^  /\{business\}/([^:\s]+)\s*:""", RegexOption.MULTILINE)
    private val BINDING_REGEX = Regex("""bind<Function>\s*\(tag\s*=\s*"([^"]+)"\)""")

    fun extractPathTags(content: String): Set<String> =
        PATH_REGEX.findAll(content).map { it.groupValues[1].trim() }.toSet()

    fun extractBindingTags(content: String): Set<String> =
        BINDING_REGEX.findAll(content).map { it.groupValues[1] }.toSet()

    /**
     * Retorna los bindings que no tienen ningún path en openapi.yaml que los cubra.
     * Un binding "foo/bar" cubre paths "foo/bar" y "foo/bar/..." (sub-rutas).
     */
    fun findBindingsWithoutPath(bindings: Set<String>, paths: Set<String>): Set<String> =
        bindings.filterTo(mutableSetOf()) { tag ->
            paths.none { path -> path == tag || path.startsWith("$tag/") }
        }

    /**
     * Retorna los paths que no tienen ningún binding en Kodein que los cubra.
     */
    fun findPathsWithoutBinding(paths: Set<String>, bindings: Set<String>): Set<String> =
        paths.filterTo(mutableSetOf()) { path ->
            bindings.none { tag -> path == tag || path.startsWith("$tag/") }
        }

    fun validate(openapiContent: String, modulesContent: String): OpenApiValidationResult {
        val paths = extractPathTags(openapiContent)
        val bindings = extractBindingTags(modulesContent)
        val errors = mutableListOf<OpenApiValidationError>()

        val bindingsWithoutPath = findBindingsWithoutPath(bindings, paths)
        if (bindingsWithoutPath.isNotEmpty()) {
            errors.add(
                OpenApiValidationError(
                    message = "Bindings en Kodein sin path en openapi.yaml",
                    items = bindingsWithoutPath.sorted(),
                ),
            )
        }

        val pathsWithoutBinding = findPathsWithoutBinding(paths, bindings)
        if (pathsWithoutBinding.isNotEmpty()) {
            errors.add(
                OpenApiValidationError(
                    message = "Paths en openapi.yaml sin binding en Kodein",
                    items = pathsWithoutBinding.sorted(),
                ),
            )
        }

        return OpenApiValidationResult(
            errors = errors,
            pathsFound = paths.size,
            bindingsFound = bindings.size,
        )
    }

    fun validate(openapiFile: File, modulesFile: File): OpenApiValidationResult =
        validate(openapiFile.readText(), modulesFile.readText())
}
