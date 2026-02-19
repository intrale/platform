import ar.com.intrale.branding.SyncBrandingIconsTask
import com.codingfeline.buildkonfig.compiler.FieldSpec
import compose.ValidateComposeResourcesTask
import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.compose.ExperimentalComposeLibrary
import org.jetbrains.kotlin.gradle.ExperimentalKotlinGradlePluginApi
import org.jetbrains.kotlin.gradle.ExperimentalWasmDsl
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.plugin.KotlinSourceSet
import org.jetbrains.kotlin.gradle.tasks.KotlinCompilationTask

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.composeHotReload)
    alias(libs.plugins.kotlinx.serialization)
    alias(libs.plugins.buildkonfig)
    alias(libs.plugins.ksp)
    alias(libs.plugins.kover)
}

kover {
    reports {
        variant("jvm") {
            filters {
                excludes {
                    classes(
                        // Componentes UI
                        "ui.cp.*",
                        "ui.cp.buttons.*",
                        "ui.cp.icons.*",
                        "ui.cp.inputs.*",
                        "ui.cp.menu.*",
                        // Tema
                        "ui.th.*",
                        // Router / navegación
                        "ui.ro.*",
                        // Pantallas compartidas
                        "ui.sc.shared.*",
                        // Compose resources generados
                        "ui.rs.*",
                        // Pantallas Compose (no testeables con unit tests)
                        "*Screen*",
                        "*ScreenKt*",
                        // Entry points
                        "*NavigationBar*",
                        "ui.AppKt*",
                        "ar.com.intrale.App*",
                        "ar.com.intrale.MainKt*",
                        // Pantallas Compose sin sufijo "Screen" en el nombre de clase
                        "ui.sc.auth.Login",
                        "ui.sc.auth.Login$*",
                        "ui.sc.auth.LoginKt",
                        "ui.sc.auth.LoginKt$*",
                        // Generados / singletons (root package y qualified)
                        "DIManager*",
                        "ar.com.intrale.DIManager*",
                        "ar.com.intrale.BuildKonfig*",
                        "MainKt",
                        "*ComposableSingletons*",
                        // Catálogos de strings (puro data)
                        "ar.com.intrale.strings.catalog.*",
                        // Enum de constantes
                        "ar.com.intrale.strings.model.MessageKey*",
                        // Runtime de strings (locale/brand, platform-specific)
                        "ar.com.intrale.strings.runtime.*",
                        // Config de app (platform-specific)
                        "ar.com.intrale.appconfig.*",
                        // Storage (platform-specific, depende de settings nativas)
                        "ext.storage.*",
                        // Expect/actual platform
                        "*Platform*",
                        "*Greeting*",
                    )
                }
            }
            verify {
                rule {
                    minBound(80)
                }
            }
        }
    }
}

fun sanitizePackageSuffix(raw: String): String {
    val normalized = raw
        .lowercase()
        .replace(Regex("[^a-z0-9]+"), "-")
        .trim('-')

    if (normalized.isBlank()) return ""

    return normalized
        .split("-")
        .filter { it.isNotBlank() }
        .joinToString(".") { segment ->
            val safeSegment = segment.ifEmpty { "client" }
            if (safeSegment.first().isDigit()) {
                "c$safeSegment"
            } else {
                safeSegment
            }
        }
}

val business = providers.gradleProperty("business").orElse("intrale")
val delivery = providers.gradleProperty("delivery").orElse(business)
val storeAvailable = providers.gradleProperty("storeAvailable").orElse("true")
val inferredAppType = providers.provider {
    val taskNames = gradle.startParameter.taskNames.map(String::lowercase)

    when {
        taskNames.any { it.contains("delivery") } -> "DELIVERY"
        taskNames.any { it.contains("business") } -> "BUSINESS"
        else -> "CLIENT"
    }
}

val appType = providers.gradleProperty("appType")
    .orElse(providers.environmentVariable("APP_TYPE"))
    .orElse(inferredAppType)
    .map(String::uppercase)

val localBaseUrl = providers.gradleProperty("LOCAL_BASE_URL")
    .orElse(providers.environmentVariable("LOCAL_BASE_URL"))

buildkonfig {
    packageName = "ar.com.intrale"

    defaultConfigs {
        buildConfigField(FieldSpec.Type.STRING, "BASE_URL",
            localBaseUrl.getOrElse("https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev/"))
        buildConfigField(FieldSpec.Type.STRING, "BUSINESS", business.get())
        buildConfigField(FieldSpec.Type.STRING, "DELIVERY", delivery.get())
        buildConfigField(FieldSpec.Type.STRING, "APP_TYPE", appType.get())
        buildConfigField(FieldSpec.Type.BOOLEAN, "STORE_AVAILABLE", storeAvailable.get())
    }
}

val forbiddenAllowTests = providers.gradleProperty("forbidden.i18n.allowTests").orElse("false")
val forbiddenStringsProcessor = project(":tools:forbidden-strings-processor")

ksp {
    arg("forbidden.i18n.allowTests", forbiddenAllowTests.get())
}

configurations.configureEach {
    if (name.startsWith("ksp") && name != "ksp") {
        project.dependencies.add(name, forbiddenStringsProcessor)
    }
}


kotlin {
    androidTarget {
        @OptIn(ExperimentalKotlinGradlePluginApi::class)
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_11)
        }
    }
    
    listOf(
        iosX64()
    ).forEach { iosTarget ->
        iosTarget.binaries.framework {
            baseName = "ComposeApp"
            isStatic = true
        }
    }
    
    jvm("desktop")
    
    @OptIn(ExperimentalWasmDsl::class)
    wasmJs {
        //outputModuleName.set("composeApp")
        browser {
            commonWebpackConfig {
                outputFileName = "composeApp.js"
                devServer = devServer?.copy(
                    static = listOf(
                        project.rootDir.path,
                        project.projectDir.path
                    ) as MutableList<String>?
                )
            }
            testTask {
                // Requiere Chrome headless; se deshabilita en entornos sin navegador.
                enabled = false
            }
        }
        binaries.executable()
    }
    
    sourceSets {
        val generatedCollectorsRoot = layout.buildDirectory.dir("generated/compose/resourceGenerator/kotlin")

        fun KotlinSourceSet.includeGeneratedCollectors(directoryName: String) {
            kotlin.srcDir(generatedCollectorsRoot.map { it.dir(directoryName).asFile })
        }

        val commonMain by getting {
            includeGeneratedCollectors("commonMainResourceCollectors")

            dependencies {
                implementation(compose.runtime)
                implementation(compose.foundation)
                implementation(compose.material3)
                implementation(compose.materialIconsExtended)
                implementation(compose.ui)
                implementation(compose.components.resources)
                implementation(compose.components.uiToolingPreview)
                implementation(libs.kotlinx.datetime)
                implementation(libs.androidx.lifecycle.viewmodel)
                implementation(libs.androidx.lifecycle.runtimeCompose)

                implementation(libs.androidx.navigation.compose)

                implementation(libs.bundles.ktor.common)
                implementation(libs.kodein.di)
                implementation(libs.canard)

                implementation(libs.settings.no.arg)
                implementation(libs.settings.serialization)
                implementation(libs.settings.coroutines)

                implementation(libs.konform)

            }
        }

        val androidMain by getting {
            includeGeneratedCollectors("androidMainResourceCollectors")

            dependencies {
                implementation(compose.preview)
                implementation(libs.androidx.activity.compose)
                implementation(libs.ktor.client.android)
                implementation("io.coil-kt:coil-compose:2.6.0")
                implementation("io.coil-kt:coil-svg:2.6.0")
            }
        }

        @OptIn(ExperimentalComposeLibrary::class)
        val androidInstrumentedTest by getting {
            dependencies {
                implementation(libs.androidx.testExt.junit)
                implementation(libs.androidx.espresso.core)
                implementation(compose.uiTestJUnit4)
            }
        }

        val desktopMain by getting {
            includeGeneratedCollectors("desktopMainResourceCollectors")

            dependencies {
                implementation(compose.desktop.currentOs)
                implementation(libs.kotlinx.coroutinesSwing)
                implementation(libs.ktor.client.java)
            }
        }

        val desktopTest by getting {
            dependencies {
                implementation(compose.desktop.currentOs)
            }
        }

        @OptIn(ExperimentalComposeLibrary::class)
        val commonTest by getting {
            dependencies {
                implementation(libs.kotlin.test)
                implementation(libs.ktor.client.mock)
                implementation(libs.kotlinx.coroutines.test)
                implementation(compose.uiTest)
            }
        }

        listOf(
            "iosX64Main",
            "iosArm64Main",
            "iosSimulatorArm64Main",
            "wasmJsMain"
        ).forEach { name ->
            findByName(name)?.let { sourceSet ->
                val collectorsDirectory = "${name}ResourceCollectors"
                sourceSet.kotlin.srcDir(generatedCollectorsRoot.map { it.dir(collectorsDirectory).asFile })
            }
        }
    }
}

val brandId = providers.gradleProperty("brandId").orElse("intrale").get()
val appNames = mapOf(
    "intrale" to "Intrale",
    "demo" to "Intrale Demo",
    // agrega las que uses
)
val appName = appNames[brandId] ?: "Intrale"
val clientSlug = providers.gradleProperty("clientSlug")
val clientAppName = providers.gradleProperty("clientAppName").orElse(providers.provider { appName })
val baseApplicationId = "com.intrale.app"
val clientApplicationSuffix = clientSlug.map(::sanitizePackageSuffix).getOrElse("")
val clientApplicationId = if (clientApplicationSuffix.isBlank()) {
    "$baseApplicationId.client"
} else {
    "$baseApplicationId.client.$clientApplicationSuffix"
}
val businessApplicationId = "$baseApplicationId.business"
val deliveryApplicationId = "$baseApplicationId.delivery"

android {
    namespace = "ar.com.intrale"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    flavorDimensions += "appType"

    productFlavors {
        create("client") {
            dimension = "appType"
            applicationId = clientApplicationId
            val flavorAppName = clientAppName.get()
            manifestPlaceholders += mapOf("appName" to flavorAppName)
            resValue("string", "app_name", flavorAppName)
        }

        create("business") {
            dimension = "appType"
            applicationId = businessApplicationId
            val businessAppName = "Intrale Negocios"
            manifestPlaceholders += mapOf("appName" to businessAppName)
            resValue("string", "app_name", businessAppName)
        }

        create("delivery") {
            dimension = "appType"
            applicationId = deliveryApplicationId
            val deliveryAppName = "Intrale Repartos"
            manifestPlaceholders += mapOf("appName" to deliveryAppName)
            resValue("string", "app_name", deliveryAppName)
        }
    }

    defaultConfig {
        applicationId = baseApplicationId
        minSdk = libs.versions.android.minSdk.get().toInt()
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        manifestPlaceholders += mapOf(
            "appName" to appName
        )
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    lint {
        disable += "NullSafeMutableLiveData"
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

tasks.register("forbidDirectComposeStringResource") {
    group = "verification"
    description = "Falla si existen usos directos de compose stringResource fuera de ui/util/ResStrings"

    doLast {
        val moduleRoot = project.projectDir
        val files = moduleRoot
            .walkTopDown()
            .onEnter { it.name != "build" }
            .filter { it.isFile && it.extension in listOf("kt", "kts") }
            .toList()

        val forbidden = Regex("""org\.jetbrains\.compose\.resources\.stringResource\s*\(""")
        val whitelist = Regex("""ui/util/ResStrings.*\.kt$""")

        val offenders = files.filter { file ->
            val relativePath = file.relativeTo(moduleRoot).path.replace('\\', '/')
            if (whitelist.containsMatchIn(relativePath)) {
                return@filter false
            }
            forbidden.containsMatchIn(file.readText())
        }

        if (offenders.isNotEmpty()) {
            val details = offenders.joinToString("\n") { offender ->
                val relativePath = offender.relativeTo(moduleRoot).path.replace('\\', '/')
                "- $relativePath"
            }
            error("Uso directo de compose stringResource prohibido en:\n$details")
        }
    }
}

tasks.named("preBuild").configure {
    dependsOn("forbidDirectComposeStringResource")
}

val brandingOut = layout.buildDirectory.dir("generated/branding")

val ensureBrandingOut by tasks.registering {
    outputs.dir(brandingOut)
    doLast {
        brandingOut.get().asFile.mkdirs()
    }
}

val scanNonAsciiFallbacks by tasks.registering {
    group = "verification"
    description = "Verifica que las llamadas a fb(\"…\") permanezcan en ASCII seguro"

    val sourcesDir = layout.projectDirectory.dir("src")
    inputs.dir(sourcesDir)
    inputs.files(brandingOut).skipWhenEmpty()

    dependsOn(ensureBrandingOut)

    doLast {
        val violations = mutableListOf<String>()
        sourcesDir.asFileTree.matching { include("**/*.kt") }.forEach { file ->
            val content = file.readText()
            var index = content.indexOf("fb(\"")
            while (index != -1) {
                var cursor = index + 4
                val literal = StringBuilder()
                var escaped = false
                while (cursor < content.length) {
                    val ch = content[cursor]
                    if (!escaped && ch == '\\') {
                        escaped = true
                        literal.append(ch)
                    } else if (!escaped && ch == '"') {
                        break
                    } else {
                        literal.append(ch)
                        escaped = false
                    }
                    cursor += 1
                }

                if (cursor >= content.length || content[cursor] != '"') {
                    break
                }

                val offending = literal.firstOrNull { it.code > 127 }
                if (offending != null) {
                    val line = content.take(index).count { it == '\n' } + 1
                    val relative = file.relativeTo(project.projectDir)
                    violations += "${relative.path}:$line contiene U+%04X en fb(\"…\")".format(offending.code)
                }

                index = content.indexOf("fb(\"", cursor + 1)
            }
        }

        if (violations.isNotEmpty()) {
            val message = buildString {
                appendLine("Se detectaron literales no ASCII en fb(\"…\"): ")
                violations.forEach { appendLine(" - $it") }
            }
            throw org.gradle.api.GradleException(message)
        }
    }
}

tasks.named("check") {
    dependsOn(scanNonAsciiFallbacks)
}

dependencies {
    add("androidMainImplementation", platform(libs.androidx.compose.bom))
    add("androidInstrumentedTestImplementation", platform(libs.androidx.compose.bom))
    debugImplementation(platform(libs.androidx.compose.bom))
    debugImplementation(compose.uiTooling)
}

compose.desktop {
    application {
        mainClass = "MainKt"

        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
            packageName = "ar.com.intrale"
            packageVersion = "1.0.0"
        }
    }
}

compose.resources {
    publicResClass = true
    packageOfResClass = "ui.rs"
    generateResClass = always
}

val preparedComposeResources = layout.buildDirectory.dir("generated/compose/resourceGenerator/preparedResources")

val validateComposeResources by tasks.registering(ValidateComposeResourcesTask::class) {
    resourcesRoot.set(preparedComposeResources)
}

validateComposeResources.configure {
    dependsOn(
        tasks.named("generateExpectResourceCollectorsForCommonMain"),
        tasks.named("prepareComposeResourcesTaskForCommonMain"),
        tasks.named("generateResourceAccessorsForCommonMain")
    )
    dependsOn(tasks.matching { it.name.startsWith("prepareComposeResourcesTaskFor") })
    dependsOn(tasks.matching { it.name.startsWith("convertXmlValueResourcesFor") })
    dependsOn(tasks.matching { it.name.startsWith("copyNonXmlValueResourcesFor") })
}

tasks.matching { task ->
    task.name == "compileCommonMainKotlinMetadata" || task.name == "compileKotlinMetadata"
}.configureEach {
    dependsOn(
        "generateExpectResourceCollectorsForCommonMain",
        "prepareComposeResourcesTaskForCommonMain",
        "generateResourceAccessorsForCommonMain",
        validateComposeResources
    )
}

tasks.withType(KotlinCompilationTask::class).configureEach {
    dependsOn(validateComposeResources)
}

tasks.named("check").configure {
    dependsOn(validateComposeResources)
    dependsOn("koverVerifyJvm")
}

// Desactivar koverVerify genérico — falla con ConcurrentModificationException por los Android
// product flavors. Se usa koverVerifyJvm (desktop) que cubre commonTest.
tasks.matching { it.name == "koverVerify" }.configureEach {
    enabled = false
}

tasks.named("assemble").configure {
    dependsOn(validateComposeResources)
}

val syncBrandingIcons by tasks.registering(SyncBrandingIconsTask::class) {
    description = "Genera los íconos oficiales a partir de los archivos Base64"
    packDirectory.set(rootProject.layout.projectDirectory.dir("docs/branding/icon-pack"))
    projectRoot.set(rootProject.layout.projectDirectory)

    outputs.dir(brandingOut)
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-hdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-mdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-xhdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-xxhdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-xxxhdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/wasmJsMain/resources"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/iosApp/iosApp/Assets.xcassets/AppIcon.appiconset"))

    dependsOn(ensureBrandingOut)

    doFirst {
        delete(brandingOut)
        brandingOut.get().asFile.mkdirs()
    }
}

scanNonAsciiFallbacks.configure {
    dependsOn(syncBrandingIcons)
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(syncBrandingIcons)
}

tasks.matching { it.name.endsWith("ProcessResources") }.configureEach {
    dependsOn(syncBrandingIcons)
}

tasks.matching { it.name == "validateComposeResources" }.configureEach {
    onlyIf {
        val dir = layout.buildDirectory.dir("generated/compose/resourceGenerator/preparedResources").get().asFile
        dir.exists() && dir.listFiles()?.any { it.extension == "cvr" } == true
    }
}
