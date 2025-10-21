package ar.com.intrale.i18nscan

import com.google.devtools.ksp.processing.KSPLogger
import com.google.devtools.ksp.symbol.KSFile
import java.nio.file.Path
import java.nio.file.Paths

private const val CONTEXT_FQN = "android.content.Context.getString"
private const val RESOURCES_FQN = "android.content.res.Resources.getString"
private const val CONTEXT_CLASS = "android.content.Context"
private const val RESOURCES_CLASS = "android.content.res.Resources"

private val STRING_RESOURCE_FQNS = setOf(
    "org.jetbrains.compose.resources.stringResource",
    "androidx.compose.ui.res.stringResource"
)

private val STRING_RESOURCE_PACKAGES = setOf(
    "org.jetbrains.compose.resources",
    "androidx.compose.ui.res"
)

private val CALL_REGEX = Regex("""([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*\(""")
private val GET_STRING_REGEX = Regex("""([A-Za-z_][A-Za-z0-9_\\.]*)\\.getString\s*\(""")
private val R_STRING_REGEX = Regex("""\b([A-Za-z_][A-Za-z0-9_]*\.)*R\.string\.[A-Za-z_][A-Za-z0-9_]*""")

internal class ForbiddenStringsScanner(private val logger: KSPLogger) {

    private val projectDir: Path = Paths.get(System.getProperty("user.dir")).toAbsolutePath().normalize()

    fun scan(file: KSFile) {
        val sourcePath = Paths.get(file.filePath)
        val sourceFile = sourcePath.toFile()
        if (!sourceFile.exists()) {
            return
        }

        val rawContent = runCatching { sourceFile.readText() }.getOrNull() ?: return
        val sanitized = stripComments(rawContent)
        val lines = sanitized.lines()
        val importInfo = parseImports(lines)
        val hasContextReference = importInfo.hasContextReference || sanitized.contains(CONTEXT_CLASS)
        val hasResourcesReference = importInfo.hasResourcesReference || sanitized.contains(RESOURCES_CLASS)
        val relativePath = resolveRelativePath(sourcePath)
        val reported = mutableSetOf<String>()

        lines.forEachIndexed { index, originalLine ->
            val trimmed = originalLine.trimStart()
            if (trimmed.startsWith("import ")) {
                return@forEachIndexed
            }

            val lineNumber = index + 1

            detectStringResourceCalls(originalLine, importInfo) { symbol ->
                report(relativePath, lineNumber, symbol, reported)
            }

            detectGetStringCalls(originalLine, importInfo, hasContextReference, hasResourcesReference) { symbol ->
                report(relativePath, lineNumber, symbol, reported)
            }

            detectRStringAccess(originalLine) { symbol ->
                report(relativePath, lineNumber, symbol, reported)
            }
        }
    }

    private fun detectStringResourceCalls(line: String, imports: ImportInfo, onViolation: (String) -> Unit) {
        CALL_REGEX.findAll(line).forEach { matchResult ->
            val candidate = matchResult.groupValues[1]
            resolveStringResource(candidate, imports)?.let(onViolation)
        }
    }

    private fun resolveStringResource(candidate: String, imports: ImportInfo): String? {
        val trimmed = candidate.trim('.').takeIf { it.isNotEmpty() } ?: return null

        if (trimmed in STRING_RESOURCE_FQNS) {
            return trimmed
        }

        if (!trimmed.contains('.')) {
            imports.aliasMap[trimmed]?.let { target ->
                if (target in STRING_RESOURCE_FQNS) {
                    return target
                }
            }

            if (trimmed == "stringResource") {
                imports.packageAliases.values.forEach { base ->
                    val candidateFqn = "$base.$trimmed"
                    if (candidateFqn in STRING_RESOURCE_FQNS) {
                        return candidateFqn
                    }
                }
                if ("androidx.compose.ui.res" in imports.starImports) {
                    return "androidx.compose.ui.res.stringResource"
                }
                if ("org.jetbrains.compose.resources" in imports.starImports) {
                    return "org.jetbrains.compose.resources.stringResource"
                }
            }

            return null
        }

        val segments = trimmed.split('.')
        if (trimmed in STRING_RESOURCE_FQNS) {
            return trimmed
        }

        val first = segments.first()
        val remainder = segments.drop(1).joinToString(".")

        if (remainder == "stringResource") {
            imports.packageAliases[first]?.let { base ->
                val candidateFqn = "$base.$remainder"
                if (candidateFqn in STRING_RESOURCE_FQNS) {
                    return candidateFqn
                }
            }
            imports.aliasMap[first]?.let { target ->
                val candidateFqn = "$target.$remainder"
                if (candidateFqn in STRING_RESOURCE_FQNS) {
                    return candidateFqn
                }
            }
        }

        return null
    }

    private fun detectGetStringCalls(
        line: String,
        imports: ImportInfo,
        hasContextReference: Boolean,
        hasResourcesReference: Boolean,
        onViolation: (String) -> Unit
    ) {
        GET_STRING_REGEX.findAll(line).forEach { matchResult ->
            val qualifier = matchResult.groupValues[1].trim('.')
            resolveGetString(qualifier, imports, hasContextReference, hasResourcesReference)?.let(onViolation)
        }
    }

    private fun resolveGetString(
        qualifier: String,
        imports: ImportInfo,
        hasContextReference: Boolean,
        hasResourcesReference: Boolean
    ): String? {
        if (qualifier.isEmpty()) {
            return null
        }

        when (qualifier) {
            CONTEXT_CLASS -> return CONTEXT_FQN
            RESOURCES_CLASS -> return RESOURCES_FQN
        }

        imports.aliasMap[qualifier]?.let { target ->
            if (target == CONTEXT_CLASS) {
                return CONTEXT_FQN
            }
            if (target == RESOURCES_CLASS) {
                return RESOURCES_FQN
            }
        }

        imports.packageAliases[qualifier]?.let { target ->
            val candidate = "$target.getString"
            if (candidate == CONTEXT_FQN || candidate == RESOURCES_FQN) {
                return candidate
            }
        }

        val lowered = qualifier.lowercase()
        return when {
            lowered == "resources" -> RESOURCES_FQN
            lowered.endsWith(".resources") -> RESOURCES_FQN
            lowered.contains("resources.") && hasResourcesReference -> RESOURCES_FQN
            hasResourcesReference && lowered.endsWith("resources") -> RESOURCES_FQN
            hasContextReference -> CONTEXT_FQN
            else -> null
        }
    }

    private fun detectRStringAccess(line: String, onViolation: (String) -> Unit) {
        R_STRING_REGEX.findAll(line).forEach { matchResult ->
            val symbol = matchResult.value
            onViolation(symbol)
        }
    }

    private fun report(path: String, lineNumber: Int, symbol: String, reported: MutableSet<String>) {
        val key = "$path:$lineNumber:$symbol"
        if (!reported.add(key)) {
            return
        }

        val message = buildString {
            appendLine("Uso de API de strings PROHIBIDA: $symbol")
            appendLine("   ➡️ Migra a: L10n.t(S.AlgunaClave)")
            appendLine("   Si necesitás interpolación: L10n.t(S.XYZ, args = mapOf(\"clave\" to valor))")
            append("   $path:$lineNumber")
        }

        logger.error(message)
    }

    private fun stripComments(source: String): String {
        val chars = source.toCharArray()
        var index = 0
        var inBlock = false

        while (index < chars.size) {
            val current = chars[index]
            if (inBlock) {
                if (current == '*' && index + 1 < chars.size && chars[index + 1] == '/') {
                    chars[index] = ' '
                    chars[index + 1] = ' '
                    index += 2
                    inBlock = false
                    continue
                }
                if (current != '\n') {
                    chars[index] = ' '
                }
                index++
                continue
            }

            if (current == '/' && index + 1 < chars.size) {
                val next = chars[index + 1]
                if (next == '/') {
                    while (index < chars.size && chars[index] != '\n') {
                        chars[index] = ' '
                        index++
                    }
                    continue
                }
                if (next == '*') {
                    chars[index] = ' '
                    chars[index + 1] = ' '
                    index += 2
                    inBlock = true
                    continue
                }
            }

            index++
        }

        sanitizeStrings(chars)
        return String(chars)
    }

    private fun sanitizeStrings(chars: CharArray) {
        var index = 0
        while (index < chars.size) {
            val current = chars[index]
            if (current == '"') {
                if (index + 2 < chars.size && chars[index + 1] == '"' && chars[index + 2] == '"') {
                    index += 3
                    while (index + 2 < chars.size) {
                        if (chars[index] == '"' && chars[index + 1] == '"' && chars[index + 2] == '"') {
                            index += 3
                            break
                        }
                        if (chars[index] != '\n') {
                            chars[index] = ' '
                        }
                        index++
                    }
                    continue
                } else {
                    index++
                    while (index < chars.size) {
                        val value = chars[index]
                        if (value == '\\') {
                            chars[index] = ' '
                            if (index + 1 < chars.size && chars[index + 1] != '\n') {
                                index++
                                chars[index] = ' '
                            }
                            index++
                            continue
                        }
                        if (value == '"') {
                            index++
                            break
                        }
                        if (value != '\n') {
                            chars[index] = ' '
                        }
                        index++
                    }
                    continue
                }
            } else if (current == '\'') {
                index++
                while (index < chars.size) {
                    val value = chars[index]
                    if (value == '\\') {
                        chars[index] = ' '
                        if (index + 1 < chars.size && chars[index + 1] != '\n') {
                            index++
                            chars[index] = ' '
                        }
                        index++
                        continue
                    }
                    if (value == '\'') {
                        index++
                        break
                    }
                    if (value != '\n') {
                        chars[index] = ' '
                    }
                    index++
                }
                continue
            }

            index++
        }
    }

    private fun parseImports(lines: List<String>): ImportInfo {
        val aliasMap = mutableMapOf<String, String>()
        val packageAliases = mutableMapOf<String, String>()
        val starImports = mutableSetOf<String>()
        var hasContextReference = false
        var hasResourcesReference = false

        lines.forEach { rawLine ->
            val trimmed = rawLine.trim()
            if (!trimmed.startsWith("import ")) {
                return@forEach
            }

            val declaration = trimmed.removePrefix("import").trim()
            if (declaration.isEmpty()) {
                return@forEach
            }

            val parts = declaration.split(" as ").map { it.trim() }
            val target = parts[0]
            val alias = parts.getOrNull(1)?.takeIf { it.isNotEmpty() }
            val isStar = target.endsWith(".*")
            val normalizedTarget = if (isStar) target.removeSuffix(".*") else target

            if (alias != null) {
                aliasMap[alias] = normalizedTarget
                if (normalizedTarget in STRING_RESOURCE_PACKAGES) {
                    packageAliases[alias] = normalizedTarget
                }
                if (normalizedTarget == CONTEXT_CLASS) {
                    hasContextReference = true
                }
                if (normalizedTarget == RESOURCES_CLASS) {
                    hasResourcesReference = true
                }
            } else if (!isStar) {
                val simpleName = normalizedTarget.substringAfterLast('.')
                aliasMap[simpleName] = normalizedTarget
            }

            if (isStar) {
                starImports += normalizedTarget
                if (normalizedTarget == "android.content") {
                    hasContextReference = true
                }
                if (normalizedTarget == "android.content.res") {
                    hasResourcesReference = true
                }
            }

            if (normalizedTarget == CONTEXT_CLASS) {
                hasContextReference = true
            }
            if (normalizedTarget == RESOURCES_CLASS) {
                hasResourcesReference = true
            }
        }

        return ImportInfo(
            aliasMap = aliasMap,
            packageAliases = packageAliases,
            starImports = starImports,
            hasContextReference = hasContextReference,
            hasResourcesReference = hasResourcesReference
        )
    }

    private fun resolveRelativePath(sourcePath: Path): String {
        val normalized = sourcePath.toAbsolutePath().normalize()
        val relative = if (normalized.startsWith(projectDir)) {
            projectDir.relativize(normalized).toString()
        } else {
            normalized.toString()
        }
        return relative.replace('\\', '/')
    }
}

private data class ImportInfo(
    val aliasMap: Map<String, String>,
    val packageAliases: Map<String, String>,
    val starImports: Set<String>,
    val hasContextReference: Boolean,
    val hasResourcesReference: Boolean
)
