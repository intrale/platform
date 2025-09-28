package ar.com.intrale.branding

import kotlin.test.Test
import kotlin.test.assertEquals

class BrandingParserTest {

    private val parser = BrandingParser()

    @Test
    fun `parse envelope and preserve core fields`() {
        val sampleJson = """
            {
              "version": 3,
              "schemaVersion": 1,
              "payload": {
                "appName": "Intrale",
                "palette": {
                  "primary": "#FF0000",
                  "onPrimary": "#FFFFFF",
                  "surface": "#F0F0F0"
                },
                "typography": {
                  "headline": "Roboto",
                  "body": "Inter"
                }
              },
              "meta": {
                "cacheTtl": 3600
              }
            }
        """.trimIndent()

        val envelope = parser.parseEnvelope(sampleJson)

        assertEquals(3, envelope.version, "La version del sobre debe parsearse correctamente")
        assertEquals("Intrale", envelope.payload.appName)
        assertEquals("#FF0000", envelope.payload.palette?.primary)

        val serialized = parser.toJson(envelope)
        val roundTrip = parser.parseEnvelope(serialized)

        assertEquals(envelope, roundTrip, "La serializacion debe ser estable para reusos en cache")
    }
}
