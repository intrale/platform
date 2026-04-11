package ar.com.intrale.e2e

import com.microsoft.playwright.APIRequest
import com.microsoft.playwright.APIRequestContext
import com.microsoft.playwright.Browser
import com.microsoft.playwright.BrowserType
import com.microsoft.playwright.Playwright
import com.microsoft.playwright.Tracing
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.slf4j.Logger
import org.slf4j.LoggerFactory
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Clase base para tests E2E.
 * Provee contexto Playwright (API request + browser con tracing) y directorio de recordings.
 *
 * Genera un trace (.zip) por cada clase de test en qa/recordings/.
 * Para ver un trace: npx playwright show-trace qa/recordings/NombreTest-trace.zip
 */
abstract class QATestBase {

    companion object {
        val logger: Logger = LoggerFactory.getLogger("ar.com.intrale.e2e")

        lateinit var playwright: Playwright
        lateinit var apiContext: APIRequestContext
        lateinit var browser: Browser
        lateinit var recordingsDir: Path

        val baseUrl: String
            get() = System.getenv("QA_BASE_URL") ?: "https://mgnr0htbvd.execute-api.us-east-2.amazonaws.com/dev"

        @JvmStatic
        @BeforeAll
        fun setupPlaywright() {
            recordingsDir = Paths.get(
                System.getenv("RECORDINGS_DIR")
                    ?: Paths.get("qa", "recordings").toAbsolutePath().toString()
            )
            Files.createDirectories(recordingsDir)

            logger.info("Iniciando Playwright — baseUrl=$baseUrl, recordings=$recordingsDir")

            playwright = Playwright.create()
            apiContext = playwright.request().newContext(
                APIRequest.NewContextOptions()
                    .setBaseURL(baseUrl)
            )

            // Browser headless para tracing (captura network de cada request/response)
            try {
                browser = playwright.chromium().launch(
                    BrowserType.LaunchOptions().setHeadless(true)
                )
                val context = browser.newContext()
                context.tracing().start(
                    Tracing.StartOptions()
                        .setScreenshots(false)
                        .setSnapshots(true)
                )
                logger.info("Tracing iniciado")
            } catch (e: Exception) {
                logger.warn("No se pudo iniciar browser para tracing (Chromium no instalado?): ${e.message}")
            }
        }

        @JvmStatic
        @AfterAll
        fun teardownPlaywright() {
            // Guardar trace si el browser esta disponible
            if (::browser.isInitialized) {
                try {
                    val callerClass = Thread.currentThread().stackTrace
                        .firstOrNull { it.className.contains("e2e.api") }
                        ?.className?.substringAfterLast('.') ?: "QATest"
                    val tracePath = recordingsDir.resolve("$callerClass-trace.zip")
                    browser.contexts().firstOrNull()?.tracing()?.stop(
                        Tracing.StopOptions().setPath(tracePath)
                    )
                    logger.info("Trace guardado: $tracePath")
                } catch (e: Exception) {
                    logger.warn("No se pudo guardar trace: ${e.message}")
                }
                browser.close()
            }

            logger.info("Cerrando Playwright")
            if (::apiContext.isInitialized) apiContext.dispose()
            if (::playwright.isInitialized) playwright.close()
        }
    }
}
