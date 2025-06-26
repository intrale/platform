import java.util.Properties

// Cargar archivo de versión
val versionPropsFile = file("version.properties")
val versionProps = Properties()

versionProps.load(versionPropsFile.inputStream())

// Obtener la versión actual
val currentVersion = versionProps.getProperty("version") ?: "1.0.0"

// Usar la versión como propiedad del proyecto
version = currentVersion

// Tarea para incrementar versión
tasks.register("incrementVersion") {
    doLast {
        val parts = currentVersion.split(".").map { it.toInt() }.toMutableList()
        parts[2] = parts[2] + 1 // incrementar el número de "patch"
        val newVersion = parts.joinToString(".")
        versionProps.setProperty("version", newVersion)
        versionProps.store(versionPropsFile.outputStream(), null)
        println("Versión actualizada a $newVersion")
    }
}

val artifactId = "backend"
group = "ar.com.intrale"

val projectRepo = "https://maven.pkg.github.com/intrale/repo"
val jetBrainsRepo = "https://packages.jetbrains.team/maven/p/ktls/maven"
val confluenceRepo = "https://packages.confluent.io/maven"

plugins {
    alias(libs.plugins.kotlinJvm)
    alias(libs.plugins.ktor)
    alias(libs.plugins.shadow)
    id("jacoco")

    `maven-publish`   // permite publicar artefactos como .jar
    `java-library`    // opcional, útil si estás creando una librería reutilizable
}

application {
    mainClass.set("$group.ApplicationKt")

    val isDevelopment: Boolean = project.ext.has("development")
    applicationDefaultJvmArgs = listOf("-Dio.ktor.development=$isDevelopment")
}

repositories {
    maven {
        name = "github"
        url = uri(projectRepo)
        credentials {
            username = System.getenv("GITHUB_ACTOR") ?: project.findProperty("gpr.user") as String?
            password = System.getenv("GITHUB_TOKEN") ?: project.findProperty("gpr.key") as String?
        }
    }
    mavenCentral()
    gradlePluginPortal()
    maven(url = uri(jetBrainsRepo))
    maven (url = uri(confluenceRepo))
}

tasks.test {
    useJUnitPlatform()
}

dependencies {

    implementation("io.ktor:ktor-server-call-logging-jvm")
    implementation("io.ktor:ktor-server-core-jvm")
    implementation("io.ktor:ktor-server-content-negotiation-jvm")
    implementation("io.ktor:ktor-serialization-gson-jvm")
    implementation("io.ktor:ktor-server-netty-jvm")

    testImplementation("io.ktor:ktor-server-test-host:2.3.12")
    testImplementation(libs.ktor.client.cio)
    testImplementation(libs.kotlin.test.junit)
    testImplementation(libs.mockk)
    testImplementation(libs.ktor.server.tests)
    testImplementation(libs.kotlin.test.junit)

    implementation(libs.logback.classic)
    implementation(libs.ktor.server.rate.limiting)

    // AWS Lambdas
    implementation(libs.aws.lambda.java.core)
    implementation(libs.aws.lambda.java.events)
    implementation(libs.aws.lambda.java.log4j)

    // AWS Cognito
    implementation(libs.cognito.identity.provider)
    implementation(libs.cognito.identity)
    implementation(libs.secretsmanager)

    // serialization
    implementation(libs.kotlinx.serialization.json)

    // Validations
    implementation(libs.konform)

    // Dependency Injection
    implementation(libs.kodein.di)
    implementation(libs.kodein.di.framework.ktor.server.jvm)

    // Faker
    implementation(libs.datafaker)

    //JWT
    implementation(libs.java.jwt)
    implementation(libs.jwks.rsa)
}

publishing {
    publications {
        create<MavenPublication>("mavenJar") {
            from(components["java"])
            groupId = "$group"
            artifactId = "$artifactId"
            version = "$version"
        }
    }
    repositories {
        maven {
            name = "github"
            url = uri(projectRepo)
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: project.findProperty("gpr.user") as String?
                password = System.getenv("GITHUB_TOKEN") ?: project.findProperty("gpr.key") as String?
            }
        }
    }
}

tasks.named("build") {
    finalizedBy("incrementVersion")
}

jacoco {
    toolVersion = "0.8.11"
}

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports {
        xml.required.set(false)
        html.required.set(true)
    }
}

/*tasks.jacocoTestCoverageVerification {
    violationRules {
        rule {
            limit {
                minimum = "0.5".toBigDecimal()
            }
        }
    }
}*/

tasks.check {
    dependsOn(tasks.jacocoTestCoverageVerification)
}
