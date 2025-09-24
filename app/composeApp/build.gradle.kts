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
        applicationId = "ar.com.intrale"
        minSdk = libs.versions.android.minSdk.get().toInt()
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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

    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-hdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-mdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-xhdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-xxhdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/androidMain/res/mipmap-xxxhdpi"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/composeApp/src/wasmJsMain/resources"))
    outputs.dir(rootProject.layout.projectDirectory.dir("app/iosApp/iosApp/Assets.xcassets/AppIcon.appiconset"))
}

tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn(syncBrandingIcons)
}

tasks.matching { it.name.endsWith("ProcessResources") }.configureEach {
    dependsOn(syncBrandingIcons)
}
