plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

application {
    mainClass.set("ar.com.intrale.i18nscan.codemod.GetStringToTxtCodemodKt")
}

kotlin {
    jvmToolchain(21)
}

dependencies {

    // Opcional pero recomendado: BOM para alinear artefactos Kotlin
    implementation(platform(libs.kotlin.bom))

    // Usa las libs del catálogo (no hardcodees "2.2.0" acá):
    compileOnly(libs.kotlin.stdlib)
    compileOnly(libs.kotlin.reflect)

    // KSP API alineado por catálogo
    compileOnly(libs.ksp.api)
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}

tasks.register<JavaExec>("runGetStringCodemod") {
    group = "codemod"
    description = "Ejecuta el codemod getString → Txt sobre app/composeApp/src"
    classpath = sourceSets["main"].output + sourceSets["main"].compileClasspath
    mainClass.set("ar.com.intrale.i18nscan.codemod.GetStringToTxtCodemodKt")

    val applyMode = providers.gradleProperty("codemod.apply").orElse("false")
    val targetDir = rootProject.layout.projectDirectory.dir("app/composeApp/src")

    argumentProviders.add(CommandLineArgumentProvider {
        val flag = if (applyMode.get() == "true") "--apply" else "--dry-run"
        listOf(flag, targetDir.asFile.absolutePath)
    })
}
