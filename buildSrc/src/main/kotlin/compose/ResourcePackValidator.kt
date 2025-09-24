package compose

import java.io.File
import java.util.Base64

data class ResourceValidationError(
    val file: File,
    val lineNumber: Int,
    val reason: String,
)

data class ResourcePackValidationResult(
    val validatedFiles: Int,
    val errors: List<ResourceValidationError>,
)

object ResourcePackValidator {

    fun validate(resourceRoot: File): ResourcePackValidationResult {
        if (!resourceRoot.exists()) {
            return ResourcePackValidationResult(
                validatedFiles = 0,
                errors = listOf(
                    ResourceValidationError(
                        file = resourceRoot,
                        lineNumber = 0,
                        reason = "Directorio de recursos inexistente. Ejecutá la tarea de compose.resources antes de compilar.",
                    )
                ),
            )
        }

        val decoder = Base64.getDecoder()
        val errors = mutableListOf<ResourceValidationError>()
        var validatedFiles = 0

        resourceRoot.walkTopDown()
            .filter { it.isFile && it.extension == "cvr" }
            .forEach { file ->
                validatedFiles += 1
                file.useLines { lines ->
                    lines.forEachIndexed { index, rawLine ->
                        val line = rawLine.trim()
                        if (line.isEmpty() || line.startsWith("version:")) return@forEachIndexed

                        val parts = line.split('|', limit = 3)
                        if (parts.size != 3) {
                            errors += ResourceValidationError(
                                file = file,
                                lineNumber = index + 1,
                                reason = "Formato inválido: se esperaban 3 columnas y se encontraron ${parts.size}.",
                            )
                            return@forEachIndexed
                        }

                        val encodedValue = parts[2]
                        try {
                            decoder.decode(encodedValue)
                        } catch (failure: IllegalArgumentException) {
                            errors += ResourceValidationError(
                                file = file,
                                lineNumber = index + 1,
                                reason = "Base64 inválido (${failure.message}).",
                            )
                        }
                    }
                }
            }

        if (validatedFiles == 0) {
            errors += ResourceValidationError(
                file = resourceRoot,
                lineNumber = 0,
                reason = "No se encontraron archivos .cvr para validar.",
            )
        }

        return ResourcePackValidationResult(validatedFiles = validatedFiles, errors = errors)
    }

    fun detectForbiddenBase64(uiRoot: File): List<ResourceValidationError> {
        if (!uiRoot.exists()) return emptyList()

        val forbiddenPattern = Regex("kotlin\\.io\\.encoding\\.Base64")
        val violations = mutableListOf<ResourceValidationError>()

        uiRoot.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .forEach { file ->
                file.useLines { lines ->
                    lines.forEachIndexed { index, rawLine ->
                        if (forbiddenPattern.containsMatchIn(rawLine)) {
                            violations += ResourceValidationError(
                                file = file,
                                lineNumber = index + 1,
                                reason = "Uso prohibido de kotlin.io.encoding.Base64 en la capa UI.",
                            )
                        }
                    }
                }
            }

        return violations
    }
}
