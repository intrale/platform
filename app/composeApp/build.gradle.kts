import ar.com.intrale.branding.SyncBrandingIconsTask
import com.codingfeline.buildkonfig.compiler.FieldSpec
import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.kotlin.gradle.ExperimentalKotlinGradlePluginApi
import org.jetbrains.kotlin.gradle.ExperimentalWasmDsl
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

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
        }
        binaries.executable()
    }
    
    sourceSets {
        val desktopMain by getting

        androidMain.dependencies {
            implementation(compose.preview)
            implementation(libs.androidx.activity.compose)
            implementation(libs.ktor.client.android)
            implementation("io.coil-kt:coil-compose:2.6.0")
            implementation("io.coil-kt:coil-svg:2.6.0")
        }
        commonMain.dependencies {
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
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.ktor.client.mock)
            implementation(libs.kotlinx.coroutines.test)
        }
        desktopMain.dependencies {
            implementation(compose.desktop.currentOs)
            implementation(libs.kotlinx.coroutinesSwing)
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
