// Copyright (c) 2026 Leonel Larreta
// SPDX-License-Identifier: LicenseRef-Proprietary

import org.gradle.api.GradleException
import java.io.File
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.jvm.toolchain.JavaLanguageVersion
import org.gradle.kotlin.dsl.findByType
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinMultiplatformExtension
import org.jetbrains.kotlin.gradle.ExperimentalWasmDsl
import org.jetbrains.kotlin.gradle.targets.wasm.binaryen.BinaryenPlugin as WasmBinaryenPlugin
import org.jetbrains.kotlin.gradle.targets.wasm.binaryen.BinaryenEnvSpec as WasmBinaryenEnvSpec

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

    // #4155 — guardarraíl: forks de test serializados dentro de cada módulo.
    // El default de Gradle para `maxParallelForks` ya es 1; lo fijamos explícito
    // para impedir que un módulo lo suba y dispare N JVMs de varios GB a la vez
    // (incidente 2026-06-24, CPU al 100%). NO excluye ningún test: cambia sólo el
    // grado de paralelismo intra-módulo. Cubre tests JVM y Android-unit (tipo
    // `Test`: :backend:test, :users:test, :app:composeApp:test*UnitTest/desktopTest,
    // :qa:test). iosTest/wasmJsTest no son tipo `Test` y no fueron el problema.
    tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
        maxParallelForks = 1
    }
}

plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.ktor) apply false
    alias(libs.plugins.shadow) apply false

    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.kover) apply false

    // Plugins for Multiplatform projects
    alias(libs.plugins.androidApplication) apply false
    alias(libs.plugins.androidLibrary) apply false
    alias(libs.plugins.composeHotReload) apply false
    alias(libs.plugins.composeMultiplatform) apply false
    alias(libs.plugins.composeCompiler) apply false
    alias(libs.plugins.kotlinMultiplatform) apply false

    // SAST: OWASP Dependency Check (modo warning — no bloquea el build)
    alias(libs.plugins.dependencyCheck)

    // Inventario de licencias (#7592): sólo se carga en el classpath; se aplica
    // por convención a los módulos de licenseeModules (ver más abajo).
    alias(libs.plugins.licensee) apply false
}

// ── Inventario de licencias de terceros (#7592) ─────────────────────────────
// licensee se usa SÓLO como extractor: resuelve las dependencias runtime de cada
// target (JVM, Android, KMP) y deja build/reports/licensee/<target>/artifacts.json.
// La política (permitidas / prohibidas / excepciones con fecha) NO vive acá: la
// evalúa scripts/licenses/ contra config/licenses/policy.json, así hay un único
// evaluador para Gradle y npm. Por eso las violaciones se ignoran en Gradle.
// ':app' es un proyecto contenedor sin código: no se inventaría.
val licenseeModules = listOf(
    ":shared",
    ":app:composeApp",
    ":backend",
    ":users",
    ":tools:forbidden-strings-processor",
    ":qa",
)

// Módulos que son enteramente herramientas de build/test (no se distribuyen).
// licensee sólo mira el classpath runtime, que en estos módulos está casi vacío:
// sus dependencias reales son compileOnly (KSP API) o de test (Playwright,
// JUnit). Para que la política también cubra el tooling (D3 de #7592), su tarea
// licensee se apunta a una configuración que junta compile + runtime + test.
val buildTestLicenseeModules = setOf(":tools:forbidden-strings-processor", ":qa")

configure(licenseeModules.map { project(it) }) {
    apply(plugin = "app.cash.licensee")
    extensions.configure<app.cash.licensee.LicenseeExtension> {
        violationAction(app.cash.licensee.ViolationAction.IGNORE)
        unusedAction(app.cash.licensee.UnusedAction.IGNORE)
    }

    if (path in buildTestLicenseeModules) {
        pluginManager.withPlugin("java") {
            val buildTestInventory = configurations.create("licenseInventoryBuildTest") {
                isCanBeConsumed = false
                isCanBeResolved = true
                isVisible = false
                description = "Dependencias de compilación, runtime y test para el inventario de licencias (#7592)"
                listOf(
                    "implementation", "compileOnly", "runtimeOnly",
                    "testImplementation", "testCompileOnly", "testRuntimeOnly",
                ).forEach { bucket -> configurations.findByName(bucket)?.let { extendsFrom(it) } }
                attributes {
                    attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
                    attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
                    attribute(LibraryElements.LIBRARY_ELEMENTS_ATTRIBUTE, objects.named(LibraryElements.JAR))
                    attribute(Bundling.BUNDLING_ATTRIBUTE, objects.named(Bundling.EXTERNAL))
                    attribute(
                        TargetJvmEnvironment.TARGET_JVM_ENVIRONMENT_ATTRIBUTE,
                        objects.named(TargetJvmEnvironment.STANDARD_JVM),
                    )
                    attribute(
                        org.jetbrains.kotlin.gradle.plugin.KotlinPlatformType.attribute,
                        org.jetbrains.kotlin.gradle.plugin.KotlinPlatformType.jvm,
                    )
                }
            }
            tasks.named<app.cash.licensee.LicenseeTask>("licensee") {
                configurationToCheck(buildTestInventory)
            }
        }
    }
}

tasks.register("licensesInventory") {
    group = "verification"
    description = "Genera los artifacts.json de licensee de todos los módulos (#7592)"
    dependsOn(licenseeModules.map { "$it:licensee" })
}

dependencyCheck {
    // failBuildOnCVSS = 11.0 → nunca falla (CVSS máximo es 10.0) — modo warning
    failBuildOnCVSS = 11.0f
    nvd {
        System.getenv("NVD_API_KEY")
            ?.takeIf { it.isNotBlank() }
            ?.let { apiKey = it }
    }
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

// Pinear binaryen v122 para evitar SIGSEGV en GitHub Actions (binaryen v123 crashea con exit 139)
// v118 incompatible con Kotlin 2.2.21 ("Cannot pass multiple pass arguments to no-inline")
// Ver: https://github.com/intrale/platform/issues/1751
// TODO: volver a versión default cuando binaryen resuelva el crash upstream
@OptIn(ExperimentalWasmDsl::class)
plugins.withType<WasmBinaryenPlugin> {
    extensions.getByType<WasmBinaryenEnvSpec>().version.set("122")
}
@OptIn(ExperimentalWasmDsl::class)
allprojects {
    plugins.withType<WasmBinaryenPlugin> {
        extensions.getByType<WasmBinaryenEnvSpec>().version.set("122")
    }
}

