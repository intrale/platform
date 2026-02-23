plugins {
    alias(libs.plugins.kotlin.jvm)
}

kotlin { jvmToolchain(21) }

tasks.withType<Test> {
    useJUnitPlatform()
    // Solo correr si se invoca explicitamente (:qa:test)
    enabled = gradle.startParameter.taskNames.any { it.contains("qa") }
    environment("QA_BASE_URL", System.getenv("QA_BASE_URL") ?: "http://localhost:8080")
    environment("RECORDINGS_DIR", layout.projectDirectory.dir("recordings").asFile.absolutePath)
    systemProperty("junit.jupiter.execution.timeout.default", "120s")
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}

dependencies {
    testImplementation(libs.playwright)
    testImplementation(libs.junit5.api)
    testRuntimeOnly(libs.junit5.engine)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.logback.classic)
}
