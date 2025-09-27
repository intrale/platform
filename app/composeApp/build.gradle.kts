import ar.com.intrale.branding.GenerateBrandResourcesTask
import ar.com.intrale.branding.SyncBrandingIconsTask
import com.codingfeline.buildkonfig.compiler.FieldSpec
import compose.ValidateComposeResourcesTask
import org.gradle.api.GradleException
import org.gradle.api.provider.ProviderFactory
import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.compose.ExperimentalComposeLibrary
import org.jetbrains.kotlin.gradle.ExperimentalKotlinGradlePluginApi
import org.jetbrains.kotlin.gradle.ExperimentalWasmDsl
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.plugin.KotlinSourceSet
import org.jetbrains.kotlin.gradle.tasks.KotlinCompilationTask
import java.util.Locale

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.composeHotReload)
    alias(libs.plugins.kotlinx.serialization)
    alias(libs.plugins.buildkonfig)
}


fun ProviderFactory.trimmedProperty(name: String): String? =
    gradleProperty(name).orNull?.trim()?.takeIf { it.isNotEmpty() }

val brandId: String = providers.trimmedProperty("brandId")
    ?: throw GradleException(
        "Falta el parámetro obligatorio -PbrandId. Ejecutá el build con -PbrandId=<identificador>."
    )

val appIdSuffix: String = providers.trimmedProperty("appIdSuffix") ?: brandId
val normalizedAppIdSuffix = appIdSuffix.trim().trimStart('.')

val brandName: String = providers.trimmedProperty("brandName") ?: brandId.replaceFirstChar { char ->
    if (char.isLowerCase()) char.titlecase(Locale.getDefault()) else char.toString()
}

val deeplinkHost: String = providers.trimmedProperty("deeplinkHost") ?: "$brandId.intrale.app"

val brandingEndpoint: String? = providers.trimmedProperty("brandingEndpoint")

val applicationIdSuffixValue = ".${normalizedAppIdSuffix}"
val escapedBrandIdForBuildConfig = brandId.replace("\"", "\\\"")

logger.lifecycle("Parámetros de branding aplicados:")
logger.lifecycle(" - brandId: $brandId")
logger.lifecycle(" - appIdSuffix: $normalizedAppIdSuffix")
logger.lifecycle(" - brandName: $brandName")
logger.lifecycle(" - deeplinkHost: $deeplinkHost")
logger.lifecycle(
    " - brandingEndpoint: ${brandingEndpoint ?: "(no definido)"}"
)

extra.apply {
    set("brandId", brandId)
    set("appIdSuffix", normalizedAppIdSuffix)
    set("brandName", brandName)
    set("deeplinkHost", deeplinkHost)
    brandingEndpoint?.let { set("brandingEndpoint", it) }
}


buildkonfig {
    packageName = "ar.com.intrale"

    defaultConfigs {
        buildConfigField(FieldSpec.Type.STRING, "BASE_URL", "https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev/")
        buildConfigField(FieldSpec.Type.STRING, "BUSINESS", "intrale")
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
                implementation(platform(libs.androidx.compose.bom.get()))
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
                implementation(platform(libs.androidx.compose.bom.get()))
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

android {
    namespace = "ar.com.intrale"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "ar.com.intrale.platform"
        minSdk = libs.versions.android.minSdk.get().toInt()
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "BRAND_ID", "\"$escapedBrandIdForBuildConfig\"")
        manifestPlaceholders += mapOf(
            "appLabel" to brandName,
            "deeplinkHost" to deeplinkHost
        )
    }
    buildFeatures {
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = applicationIdSuffixValue
        }
        getByName("release") {
            isMinifyEnabled = false
            applicationIdSuffix = applicationIdSuffixValue
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    lint {
        disable += "NullSafeMutableLiveData"
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

val brandingOut = layout.buildDirectory.dir("generated/branding")

val ensureBrandingOut by tasks.registering {
    outputs.dir(brandingOut)
    doLast {
        brandingOut.get().asFile.mkdirs()
    }
}

val generateBrandResources by tasks.registering(GenerateBrandResourcesTask::class) {
    group = "branding"
    description = "Genera recursos de marca para strings de la aplicación"
    dependsOn(ensureBrandingOut)
    brandIdentifier.set(brandId)
    appDisplayName.set(brandName)
    brandStorageDirectory.set(brandingOut.map { it.dir(brandId).dir("res") })
}

tasks.named("preBuild").configure {
    dependsOn("forbidDirectComposeStringResource", generateBrandResources)
}

androidComponents {
    onVariants { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(
            generateBrandResources,
            GenerateBrandResourcesTask::outputResDirectory
        )
    }
}

val scanNonAsciiFallbacks by tasks.registering {
    group = "verification"
    description = "Verifica que las llamadas a fb(\"…\") permanezcan en ASCII seguro"

    val sourcesDir = layout.projectDirectory.dir("src")
    inputs.dir(sourcesDir)
    inputs.files(brandingOut).skipWhenEmpty()

    dependsOn(ensureBrandingOut)
    dependsOn(generateBrandResources)
    inputs.dir(generateBrandResources.flatMap { it.outputResDirectory })

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
    debugImplementation(platform(libs.androidx.compose.bom.get()))
    debugImplementation(compose.uiTooling)
}

compose.desktop {
    application {
        mainClass = "ar.com.intrale.MainKt"

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
