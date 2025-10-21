package ar.com.intrale.i18nscan

import com.google.devtools.ksp.processing.KSPLogger
import com.google.devtools.ksp.processing.Resolver
import com.google.devtools.ksp.processing.SymbolProcessor
import com.google.devtools.ksp.symbol.KSAnnotated
import com.google.devtools.ksp.symbol.KSFile

private const val OPTION_ALLOW_TESTS = "forbidden.i18n.allowTests"

class ForbiddenStringsProcessor(
    private val logger: KSPLogger,
    private val options: Map<String, String>
) : SymbolProcessor {

    private val allowTests: Boolean by lazy {
        options[OPTION_ALLOW_TESTS]?.equals("true", ignoreCase = true) == true
    }

    private val scanner = ForbiddenStringsScanner(logger)

    override fun process(resolver: Resolver): List<KSAnnotated> {
        resolver.getAllFiles().forEach { file ->
            if (allowTests && file.isTestSource()) {
                return@forEach
            }
            scanner.scan(file)
        }

        return emptyList()
    }

    private fun KSFile.isTestSource(): Boolean {
        val normalizedPath = filePath.replace('\\', '/').lowercase()
        return normalizedPath.contains("/test/") ||
            normalizedPath.contains("/androidtest/") ||
            normalizedPath.contains("/iossimulatorarm64test/") ||
            normalizedPath.contains("/iosx64test/") ||
            normalizedPath.contains("/desktoptest/")
    }
}
