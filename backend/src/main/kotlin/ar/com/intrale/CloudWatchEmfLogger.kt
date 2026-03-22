package ar.com.intrale

import org.slf4j.Logger
import org.slf4j.LoggerFactory

/**
 * Emite métricas en formato CloudWatch Embedded Metrics Format (EMF).
 *
 * El formato EMF es JSON estructurado escrito a stdout. En AWS Lambda,
 * stdout va a CloudWatch Logs y el agente de CloudWatch extrae
 * automáticamente las métricas sin SDK adicional.
 *
 * Referencia: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */
object CloudWatchEmfLogger {

    private val logger: Logger = LoggerFactory.getLogger("ar.com.intrale")

    const val NAMESPACE = "Intrale/Backend"

    /**
     * Emite una métrica de invocación con latencia y estado de error.
     *
     * @param functionName nombre de la función invocada (ej: "signin")
     * @param business     nombre del negocio (ej: "intrale")
     * @param httpMethod   método HTTP (ej: "POST")
     * @param statusCode   código HTTP de la respuesta
     * @param latencyMs    latencia en milisegundos
     */
    fun emitInvocation(
        functionName: String,
        business: String,
        httpMethod: String,
        statusCode: Int,
        latencyMs: Long
    ) {
        val isError = if (statusCode >= 400) 1 else 0
        val timestamp = System.currentTimeMillis()

        val emf = buildString {
            append("""{"_aws":{"Timestamp":$timestamp,"CloudWatchMetrics":[{"Namespace":"$NAMESPACE",""")
            append(""""Dimensions":[["FunctionName","Business","HttpMethod"]],""")
            append(""""Metrics":[""")
            append("""{"Name":"Latency","Unit":"Milliseconds"},""")
            append("""{"Name":"Errors","Unit":"Count"},""")
            append("""{"Name":"Invocations","Unit":"Count"}""")
            append("""]}]},""")
            append(""""FunctionName":"$functionName",""")
            append(""""Business":"$business",""")
            append(""""HttpMethod":"$httpMethod",""")
            append(""""StatusCode":$statusCode,""")
            append(""""Latency":$latencyMs,""")
            append(""""Errors":$isError,""")
            append(""""Invocations":1}""")
        }

        logger.info(emf)
    }
}
