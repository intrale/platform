package ui.sc.business

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Title
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
import ar.com.intrale.strings.Txt
import ar.com.intrale.strings.model.MessageKey
import org.kodein.log.LoggerFactory
import org.kodein.log.newLogger
import ui.sc.shared.Screen
import ui.session.SessionStore
import ui.session.UserRole
import ui.th.spacing

const val PERSONALIZATION_PATH = "/personalization"

private val ALLOWED_ROLES = setOf(UserRole.BusinessAdmin, UserRole.PlatformAdmin)

class PersonalizationScreen : Screen(PERSONALIZATION_PATH) {

    override val messageTitle: MessageKey = MessageKey.personalization_title

    private val logger = LoggerFactory.default.newLogger<PersonalizationScreen>()

    @Composable
    override fun screen() {
        logger.info { "Renderizando PersonalizationScreen" }
        PersonalizationContent()
    }

    @Composable
    private fun PersonalizationContent() {
        val sessionStateState = SessionStore.sessionState.collectAsState()
        val sessionState = sessionStateState.value
        val role = sessionState.role
        val hasAccess = role in ALLOWED_ROLES && sessionState.selectedBusinessId?.isNotBlank() == true

        val accessDeniedMessage = Txt(MessageKey.personalization_access_denied)

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

        val description = Txt(MessageKey.personalization_description)
        val businessContext = Txt(
            key = MessageKey.personalization_business_context,
            params = mapOf("businessId" to sessionState.selectedBusinessId.orEmpty()),
        )
        val pendingLabel = Txt(MessageKey.personalization_section_pending)

        val sections = listOf(
            PersonalizationSection(
                icon = Icons.Default.Palette,
                title = Txt(MessageKey.personalization_section_colors),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Title,
                title = Txt(MessageKey.personalization_section_typography),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Image,
                title = Txt(MessageKey.personalization_section_images),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Brush,
                title = Txt(MessageKey.personalization_section_app_icon),
                description = pendingLabel,
            ),
            PersonalizationSection(
                icon = Icons.Default.Visibility,
                title = Txt(MessageKey.personalization_section_preview),
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
                text = businessContext,
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
