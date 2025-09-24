package compose

import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
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

    private val allowedControlCharacters = setOf('\n', '\r', '\t')
    private val base64Alphabet = (
        ('A'..'Z') + ('a'..'z') + ('0'..'9') + listOf('+', '/', '=')
    ).toSet()

    private fun ByteArray.decodeUtf8OrNull(): String? {
        return try {
            StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(this))
                .toString()
        } catch (_: CharacterCodingException) {
            null
        }
    }

    private fun looksLikeBase64Candidate(value: String): Boolean {
        if (value.isBlank()) return false

        val collapsed = value.trim().replace("\n", "").replace("\r", "")
        if (collapsed.length < 8) return false
        if (collapsed.length % 4 != 0) return false
        if (!collapsed.all { it in base64Alphabet }) return false

        val hasExplicitPadding = '=' in collapsed
        val longEnough = collapsed.length >= 16

        return hasExplicitPadding || longEnough
    }

    private fun decodedLooksPrintable(bytes: ByteArray): Boolean {
        if (bytes.isEmpty()) return false

        val printable = bytes.count { byte ->
            val value = byte.toInt()
            value >= 32 || value == 10 || value == 13 || value == 9 || value < 0
        }
        return printable.toDouble() / bytes.size >= 0.85
    }

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

                        val key = parts[1]
                        val encodedValue = parts[2]
                        val decodedBytes = try {
                            decoder.decode(encodedValue)
                        } catch (failure: IllegalArgumentException) {
                            errors += ResourceValidationError(
                                file = file,
                                lineNumber = index + 1,
                                reason = "Base64 inválido (${failure.message}).",
                            )
                            return@forEachIndexed
                        }

                        val decodedText = decodedBytes.decodeUtf8OrNull()
                        if (decodedText == null) {
                            errors += ResourceValidationError(
                                file = file,
                                lineNumber = index + 1,
                                reason = "El valor asociado a '$key' no está codificado en UTF-8 legible.",
                            )
                            return@forEachIndexed
                        }

                        val invalidControls = decodedText.filter { char ->
                            char.isISOControl() && char !in allowedControlCharacters
                        }
                        if (invalidControls.isNotEmpty()) {
                            errors += ResourceValidationError(
                                file = file,
                                lineNumber = index + 1,
                                reason = "La clave '$key' contiene caracteres no imprimibles tras decodificar.",
                            )
                        }

                        val candidate = decodedText.trim()
                        if (looksLikeBase64Candidate(candidate)) {
                            val stripped = candidate.replace("\n", "").replace("\r", "")
                            val decodedCandidate = runCatching { decoder.decode(stripped) }.getOrNull()
                            if (decodedCandidate != null && decodedLooksPrintable(decodedCandidate)) {
                                val readableText = decodedCandidate.decodeUtf8OrNull()
                                if (readableText != null && readableText.any { it.isLetterOrDigit() }) {
                                    errors += ResourceValidationError(
                                        file = file,
                                        lineNumber = index + 1,
                                        reason = "La clave '$key' parece contener Base64 incrustado. Valor sospechoso: '${candidate.take(32)}'",
                                    )
                                }
                            }
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
