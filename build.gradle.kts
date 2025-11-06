import org.gradle.api.GradleException
import java.io.File
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.gradle.kotlin.dsl.findByType
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinMultiplatformExtension

data class LegacyMatch(
    val path: String,
    val line: Int,
    val pattern: String,
    val snippet: String,
)

private val targetJavaVersion = JavaLanguageVersion.of(21)

allprojects {
    extensions.findByType<JavaPluginExtension>()?.apply {
        toolchain.languageVersion.set(targetJavaVersion)
    }

    extensions.findByType<KotlinJvmProjectExtension>()?.apply {
        jvmToolchain(targetJavaVersion.asInt())
    }

    extensions.findByType<KotlinMultiplatformExtension>()?.apply {
        jvmToolchain(targetJavaVersion.asInt())
    }
}

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.ktor) apply false
    alias(libs.plugins.shadow) apply false

    alias(libs.plugins.ksp) apply false

    // Plugins for Multiplatform projects
    alias(libs.plugins.androidApplication) apply false
    alias(libs.plugins.androidLibrary) apply false
    alias(libs.plugins.composeHotReload) apply false
    alias(libs.plugins.composeMultiplatform) apply false
    alias(libs.plugins.composeCompiler) apply false
    alias(libs.plugins.kotlinMultiplatform) apply false
}

tasks.register("verifyNoLegacyStrings") {
    group = "verification"
    description = "Falla si hay usos legacy de string resources"
    doLast {
        val rootDir = project.rootDir
        val includeExtensions = setOf("kt", "kts", "java")
        val excludedSegments = setOf(
            ".git",
            ".gradle",
            "build",
            "generated",
            "node_modules",
            "ios",
            "wasm",
            "desktop",
            "tools",
            "forbidden-strings-processor",
        )
        val excludedTestSegments = setOf(
            "test",
            "tests",
            "androidTest",
            "desktopTest",
            "iosX64Test",
            "wasmJsTest",
        )
        val patternChecks = listOf(
            "stringResource(...)" to Regex("""\bstringResource\s*\("""),
            "Res.string" to Regex("""\bRes\.string\b"""),
            "R.string" to Regex("""\bR\.string\."""),
            "getString(...)" to Regex("""\bgetString\s*\("""),
            "Resources.getString(...)" to Regex("""\bResources\.getString\s*\("""),
            "LocalContext.current.getString(...)" to Regex("""\bLocalContext\.current\.getString\s*\("""),
        )
        val excludedFilePrefixes = listOf(
            "app/composeApp/src/commonMain/kotlin/ui/rs/",
        )

        val excludedFiles = setOf(
            "build.gradle.kts",
        )

        fun File.relativePath(): String =
            runCatching { relativeTo(rootDir).invariantSeparatorsPath }.getOrElse { name }

        fun shouldSkipDir(dir: File): Boolean {
            if (!dir.isDirectory || dir == rootDir) return false
            val relative = dir.relativePath()
            if (relative.isEmpty()) return false
            val segments = relative.split('/')
            return segments.any { segment ->
                segment in excludedSegments ||
                    segment in excludedTestSegments ||
                    segment.equals("test", ignoreCase = true) ||
                    segment.equals("tests", ignoreCase = true) ||
                    segment.endsWith("Test") ||
                    segment.endsWith("Tests")
            }
        }

        val matches = mutableListOf<LegacyMatch>()

        rootDir.walkTopDown()
            .onEnter { dir -> !shouldSkipDir(dir) }
            .filter { file ->
                file.isFile && includeExtensions.contains(file.extension.lowercase())
            }
            .forEach { file ->
                val relativePath = file.relativePath()
                if (relativePath in excludedFiles) return@forEach
                if (excludedFilePrefixes.any { prefix -> relativePath.startsWith(prefix) }) return@forEach
                file.useLines { sequence ->
                    sequence.forEachIndexed { index, line ->
                        patternChecks.forEach { (label, regex) ->
                            if (regex.containsMatchIn(line)) {
                                val snippet = line.trim().replace('\t', ' ')
                                matches += LegacyMatch(
                                    path = relativePath,
                                    line = index + 1,
                                    pattern = label,
                                    snippet = snippet.take(200),
                                )
                            }
                        }
                    }
                }
            }

        if (matches.isNotEmpty()) {
            logger.error("🚫 Se detectó uso de String Resources legacy.")
            matches.groupBy { it.path }
                .forEach { (path, entries) ->
                    logger.error("")
                    logger.error(path)
                    entries.forEach { match ->
                        logger.error("  L${match.line} | ${match.pattern} | ${match.snippet}")
                    }
                }
            logger.error("")
            logger.error("Solución: migrar a IntraleStrings (Txt + MessageKey).")
            throw GradleException("Uso legacy de strings detectado. Revisar log.")
        } else {
            logger.lifecycle("✅ Sin usos legacy de strings. Todo OK.")
        }
    }
}

tasks.matching { it.name == "check" }.configureEach {
    dependsOn("verifyNoLegacyStrings")
}

tasks.matching { it.name == "build" }.configureEach {
    dependsOn("verifyNoLegacyStrings")
}
