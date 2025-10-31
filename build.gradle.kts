import org.gradle.api.GradleException

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
        val script = project.rootProject.file("tools/verify_no_legacy_strings.sh")
        if (!script.exists()) {
            throw GradleException("Falta tools/verify_no_legacy_strings.sh")
        }
        if (!script.canExecute()) {
            script.setExecutable(true)
        }
        val proc = ProcessBuilder(script.absolutePath)
            .directory(project.rootDir)
            .inheritIO()
            .start()
        val exit = proc.waitFor()
        if (exit != 0) {
            throw GradleException("Uso legacy de strings detectado (ver log).")
        }
    }
}

tasks.matching { it.name == "check" }.configureEach {
    dependsOn("verifyNoLegacyStrings")
}
