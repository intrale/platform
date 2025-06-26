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

val artifactId = "users"
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
    mainClass.set("ar.com.intrale.UsersApplicationKt")

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

dependencies {

    // Testing
    testImplementation(libs.kotlin.test.junit)
    testImplementation(libs.mockk)

    //testImplementation("io.ktor:ktor-server-test-host-jvm")
    testImplementation(libs.ktor.server.tests)
    testImplementation(libs.ktor.client.mock)
    testImplementation(libs.ktor.client.core)
    testImplementation(libs.ktor.client.cio)
    testImplementation(libs.ktor.client.content.negotiation)

    // Backend
    implementation(libs.backend)

    implementation("io.ktor:ktor-server-call-logging-jvm")
    implementation("io.ktor:ktor-server-core-jvm")
    implementation("io.ktor:ktor-server-content-negotiation-jvm")
    implementation("io.ktor:ktor-serialization-gson-jvm")
    implementation("io.ktor:ktor-server-netty-jvm")

    implementation(libs.logback.classic)
    implementation(libs.ktor.server.rate.limiting)
    implementation("io.ktor:ktor-server-openapi-jvm")
    implementation("io.ktor:ktor-server-swagger-jvm")

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

    // DynamoDB
    implementation("software.amazon.awssdk:dynamodb:2.25.28")
    implementation("software.amazon.awssdk:dynamodb-enhanced:2.25.28")
    implementation("software.amazon.awssdk:auth:2.25.28")
    implementation("software.amazon.awssdk:regions:2.25.28")

    // Two Factor
    implementation("com.eatthepath:java-otp:0.4.0")
    implementation("commons-codec:commons-codec:1.15")

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
        xml.required.set(true)
        html.required.set(false)
    }
}

tasks.jacocoTestCoverageVerification {
    violationRules {
        rule {
            limit {
                minimum = "0.35".toBigDecimal()
            }
        }
    }
}

tasks.check {
    dependsOn(tasks.jacocoTestCoverageVerification)
}
