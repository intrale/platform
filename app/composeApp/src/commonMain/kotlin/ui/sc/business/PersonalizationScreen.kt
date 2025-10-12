package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.Title
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import org.jetbrains.compose.resources.ExperimentalResourceApi
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.rs.personalization_access_denied
import ui.rs.personalization_business_context
import ui.rs.personalization_description
import ui.rs.personalization_section_app_icon
import ui.rs.personalization_section_colors
import ui.rs.personalization_section_images
import ui.rs.personalization_section_pending
import ui.rs.personalization_section_preview
import ui.rs.personalization_section_typography
import ui.rs.personalization_title
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing
import ui.util.RES_ERROR_PREFIX
import ui.util.fb
import ui.util.resString

const val PERSONALIZATION_PATH = "/personalization"

private val ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class PersonalizationScreen : Screen(PERSONALIZATION_PATH, personalization_title) {

    private val logger = LoggerFactory.default.newLogger<PersonalizationScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando PersonalizationScreen" }
        PersonalizationContent()
    }

    @OptIn(ExperimentalResourceApi::class)
    @Composable
    private fun PersonalizationContent() {
        val sessionStateState = SessionStore.sessionState.collectAsState()
        val sessionState = sessionStateState.value
        val role = sessionState.role
        val hasAccess = role in ALLOWED_ROLES && sessionState.selectedBusinessId?.isNotBlank() == true

        val accessDeniedMessage = resString(
            composeId = personalization_access_denied,
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("No tienes permiso para acceder a esta seccion"),
        )

        if (!hasAccess) {
            Text(
                text = accessDeniedMessage,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x4)
            )
            return
        }

        val businessLabel = resString(
            composeId = personalization_business_context,
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Negocio actual"),
        )
        val description = resString(
            composeId = personalization_description,
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Configura la apariencia de tu negocio"),
        )
        val pendingLabel = resString(
            composeId = personalization_section_pending,
            fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Disponible proximamente"),
        )

        val sections = listOf(
            PersonalizationSection(
                icon = Icons.Default.Palette,
                title = resString(
                    composeId = personalization_section_colors,
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Colores"),
                ),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Title,
                title = resString(
                    composeId = personalization_section_typography,
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Tipografias"),
                ),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Image,
                title = resString(
                    composeId = personalization_section_images,
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Imagenes"),
                ),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Brush,
                title = resString(
                    composeId = personalization_section_app_icon,
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Icono de app"),
                ),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Visibility,
                title = resString(
                    composeId = personalization_section_preview,
                    fallbackAsciiSafe = RES_ERROR_PREFIX + fb("Previsualizacion"),
                ),
                description = pendingLabel,
            ),
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(
                    horizontal = MaterialTheme.spacing.x3,
                    vertical = MaterialTheme.spacing.x4
                ),
            verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x3),
        ) {
            Text(
                text = description,
                style = MaterialTheme.typography.bodyLarge,
            )

            Text(
                text = "$businessLabel: ${sessionState.selectedBusinessId.orEmpty()}",
                style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold),
            )

            sections.forEach { section ->
                PersonalizationCard(section)
            }
        }
    }

    @Composable
    private fun PersonalizationCard(section: PersonalizationSection) {
        Card(
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.x3),
                verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
            ) {
                RowHeader(section)

                Text(
                    text = section.description,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }

    @Composable
    private fun RowHeader(section: PersonalizationSection) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.x2)
        ) {
            Icon(
                imageVector = section.icon,
                contentDescription = null
            )
            Text(
                text = section.title,
                style = MaterialTheme.typography.titleMedium,
            )
        }
    }
}

private data class PersonalizationSection(
    val icon: androidx.compose.ui.graphics.vector.ImageVector,
    val title: String,
    val description: String,
)
