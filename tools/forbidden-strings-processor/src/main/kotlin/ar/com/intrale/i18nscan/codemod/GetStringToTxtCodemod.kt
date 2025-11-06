package ar.com.intrale.i18nscan.codemod

import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.isDirectory
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.readText
import kotlin.io.path.writeText

private val RESOURCE_KEY_REGEX = Regex("""(?:[A-Za-z_][A-Za-z0-9_]*\.)*R\.string\.([A-Za-z0-9_]+)""")

/**
 * Resultado de transformar un archivo Kotlin con la codemod.
 */
data class CodemodReport(
    val file: Path,
    val replacements: List<Replacement>,
    val applied: Boolean,
)

/**
 * Información detallada de cada reemplazo detectado.
 */
data class Replacement(
    val messageKey: String,
    val parameterNames: List<String>,
)

/**
 * Procesa una ruta (archivo o directorio). Cuando [apply] es `true` los cambios se
 * escriben sobre el archivo original. Con `false` solo se informa qué ocurriría.
 */
fun runCodemod(target: Path, apply: Boolean = false): List<CodemodReport> {
    if (!target.exists()) {
        return emptyList()
    }

    if (target.isDirectory()) {
        return target.listDirectoryEntries().sorted().flatMap { child ->
            runCodemod(child, apply)
        }
    }

    val originalContent = target.readText()
    val (rewritten, replacements) = transformContent(originalContent)

    if (replacements.isNotEmpty() && apply) {
        target.writeText(rewritten)
    }

    return listOf(
        CodemodReport(
            file = target,
            replacements = replacements,
            applied = apply && replacements.isNotEmpty(),
        )
    )
}

internal data class TransformResult(
    val content: String,
    val replacements: List<Replacement>,
)

/**
 * Reemplaza ocurrencias de `getString(R.string.foo, ...)` por `Txt(MessageKey.foo, params)`.
 */
internal fun transformContent(source: String): TransformResult {
    val buffer = StringBuilder(source.length)
    val replacements = mutableListOf<Replacement>()
    var index = 0

    while (index < source.length) {
        val matchIndex = source.indexOf("getString(", index)
        if (matchIndex == -1) {
            buffer.append(source.substring(index))
            break
        }

        val qualifierStart = findQualifierStart(source, matchIndex)
        buffer.append(source, index, qualifierStart)

        val parseResult = parseInvocation(source, matchIndex)
        if (parseResult == null) {
            // No pudimos interpretar la llamada, copiarla sin cambios.
            val safeEnd = safeCallEnd(source, matchIndex)
            buffer.append(source, qualifierStart, safeEnd)
            index = safeEnd
            continue
        }

        val (endIndex, keyName, arguments) = parseResult
        val replacement = buildReplacement(keyName, arguments)
        if (replacement == null) {
            // No hay forma segura de migrar esta variante automáticamente.
            buffer.append(source, qualifierStart, endIndex)
            index = endIndex
            continue
        }

        buffer.append(replacement.text)
        replacements += Replacement(
            messageKey = replacement.messageKey,
            parameterNames = replacement.parameterNames,
        )
        index = endIndex
    }

    return TransformResult(
        content = buffer.toString(),
        replacements = replacements,
    )
}

private data class InvocationParse(
    val endIndex: Int,
    val keyName: String,
    val arguments: List<String>,
)

private data class ReplacementRender(
    val text: String,
    val messageKey: String,
    val parameterNames: List<String>,
)

private fun parseInvocation(source: String, startIndex: Int): InvocationParse? {
    val openParenIndex = startIndex + "getString".length
    if (openParenIndex >= source.length || source[openParenIndex] != '(') {
        return null
    }

    val closingParenIndex = findClosingParenthesis(source, openParenIndex)
        ?: return null
    val rawArguments = source.substring(openParenIndex + 1, closingParenIndex)
    val parts = splitArguments(rawArguments)
    if (parts.isEmpty()) {
        return null
    }

    val keyCandidate = parts.first().replace("\n", " ").trim()
    val normalizedKey = keyCandidate.replace(" ", "")
    val match = RESOURCE_KEY_REGEX.matchEntire(normalizedKey) ?: return null
    val keyName = match.groupValues[1]
    val remaining = parts.drop(1)

    // Evitar escenarios con argumentos nombrados o spread operator.
    if (remaining.any { argument ->
            val trimmed = argument.trim()
            trimmed.startsWith("*") || '=' in trimmed
        }
    ) {
        return null
    }

    return InvocationParse(
        endIndex = closingParenIndex + 1,
        keyName = keyName,
        arguments = remaining,
    )
}

private fun buildReplacement(keyName: String, arguments: List<String>): ReplacementRender? {
    val messageKey = keyName.replace('.', '_')

    if (arguments.isEmpty()) {
        return ReplacementRender(
            text = "Txt(MessageKey.$messageKey)",
            messageKey = messageKey,
            parameterNames = emptyList(),
        )
    }

    val entries = mutableListOf<String>()
    val parameterNames = mutableListOf<String>()

    arguments.forEachIndexed { index, rawArgument ->
        val expression = rawArgument.trim()
        val name = deriveParamName(expression, index)
        entries += "\"$name\" to $expression"
        parameterNames += name
    }

    val mapExpression = when (entries.size) {
        1 -> "mapOf(${entries.single()})"
        else -> "mapOf(${entries.joinToString(separator = ", ")})"
    }

    return ReplacementRender(
        text = "Txt(MessageKey.$messageKey, $mapExpression)",
        messageKey = messageKey,
        parameterNames = parameterNames,
    )
}

private fun deriveParamName(expression: String, index: Int): String {
    val trimmed = expression.trim()
    if (trimmed.isEmpty()) {
        return "arg${index + 1}"
    }

    var pointer = trimmed.length - 1
    while (pointer >= 0 && !trimmed[pointer].isLetterOrDigit() && trimmed[pointer] != '_') {
        pointer--
    }

    if (pointer < 0) {
        return "arg${index + 1}"
    }

    var end = pointer
    while (pointer >= 0 && (trimmed[pointer].isLetterOrDigit() || trimmed[pointer] == '_')) {
        pointer--
    }

    val candidate = trimmed.substring(pointer + 1, end + 1)
    if (candidate.isNotEmpty() && !candidate.first().isDigit()) {
        return candidate
    }

    return "arg${index + 1}"
}

private fun findClosingParenthesis(source: String, openParenIndex: Int): Int? {
    var index = openParenIndex + 1
    var depth = 1
    var inSingleQuote = false
    var inDoubleQuote = false
    var escape = false

    while (index < source.length) {
        val char = source[index]
        if (escape) {
            escape = false
            index++
            continue
        }

        when {
            char == '\\' && (inSingleQuote || inDoubleQuote) -> escape = true
            inSingleQuote -> if (char == '\'') inSingleQuote = false
            inDoubleQuote -> if (char == '"') inDoubleQuote = false
            char == '\'' -> inSingleQuote = true
            char == '"' -> inDoubleQuote = true
            char == '(' -> depth++
            char == ')' -> {
                depth--
                if (depth == 0) {
                    return index
                }
            }
        }

        index++
    }

    return null
}

private fun splitArguments(arguments: String): List<String> {
    if (arguments.isBlank()) {
        return emptyList()
    }

    val result = mutableListOf<String>()
    var index = 0
    var start = 0
    var parenDepth = 0
    var bracketDepth = 0
    var braceDepth = 0
    var angleDepth = 0
    var inSingleQuote = false
    var inDoubleQuote = false
    var escape = false

    while (index < arguments.length) {
        val char = arguments[index]
        if (escape) {
            escape = false
            index++
            continue
        }

        when {
            char == '\\' && (inSingleQuote || inDoubleQuote) -> escape = true
            inSingleQuote -> if (char == '\'') inSingleQuote = false
            inDoubleQuote -> if (char == '"') inDoubleQuote = false
            char == '\'' -> inSingleQuote = true
            char == '"' -> inDoubleQuote = true
            char == '(' -> parenDepth++
            char == ')' && parenDepth > 0 -> parenDepth--
            char == '[' -> bracketDepth++
            char == ']' && bracketDepth > 0 -> bracketDepth--
            char == '{' -> braceDepth++
            char == '}' && braceDepth > 0 -> braceDepth--
            char == '<' -> angleDepth++
            char == '>' && angleDepth > 0 -> angleDepth--
            char == ',' && parenDepth == 0 && bracketDepth == 0 && braceDepth == 0 && angleDepth == 0 && !inSingleQuote && !inDoubleQuote -> {
                result += arguments.substring(start, index)
                start = index + 1
            }
        }

        index++
    }

    result += arguments.substring(start)

    return result.map { it.trim() }.filter { it.isNotEmpty() }
}

private fun findQualifierStart(source: String, matchIndex: Int): Int {
    var start = matchIndex
    var pointer = matchIndex - 1

    while (pointer >= 0 && source[pointer].isWhitespace()) {
        pointer--
    }

    if (pointer >= 0 && source[pointer] in setOf('.', '?', '!')) {
        start = pointer
        pointer--
        while (pointer >= 0 && (source[pointer].isLetterOrDigit() || source[pointer] == '_' || source[pointer] == '.')) {
            pointer--
        }
        start = pointer + 1
    }

    return start
}

private fun safeCallEnd(source: String, startIndex: Int): Int {
    val closingParenIndex = findClosingParenthesis(source, startIndex + "getString".length)
        ?: return startIndex + "getString".length
    return closingParenIndex + 1
}

/**
 * CLI mínima para ejecutar la codemod desde Gradle o shell scripts.
 */
fun main(args: Array<String>) {
    if (args.isEmpty()) {
        printUsage()
        return
    }

    var apply = false
    val targets = mutableListOf<Path>()

    args.forEach { arg ->
        when (arg) {
            "--apply" -> apply = true
            "--dry-run" -> apply = false
            else -> targets.add(Path.of(arg))
        }
    }

    if (targets.isEmpty()) {
        printUsage()
        return
    }

    val reports = targets.flatMap { target -> runCodemod(target, apply) }
    if (reports.isEmpty()) {
        println("Sin coincidencias")
        return
    }

    reports.forEach { report ->
        if (report.replacements.isEmpty()) {
            println("${report.file}: sin reemplazos")
        } else {
            val header = if (report.applied) "${report.file}: ${report.replacements.size} reemplazos" else "${report.file}: ${report.replacements.size} coincidencias"
            println(header)
            report.replacements.forEach { replacement ->
                val params = if (replacement.parameterNames.isEmpty()) {
                    "sin parámetros"
                } else {
                    replacement.parameterNames.joinToString(prefix = "parametros=", separator = ", ")
                }
                println("  - MessageKey.${replacement.messageKey} ($params)")
            }
        }
    }
}

private fun printUsage() {
    println("Uso: getString-codemod [--apply|--dry-run] <archivo|directorio> [...]")
    println("  --dry-run es el modo por defecto, muestra los reemplazos sin escribir cambios.")
    println("  --apply escribe las transformaciones en disco.")
}
