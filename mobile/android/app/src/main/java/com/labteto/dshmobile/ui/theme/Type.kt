package com.labteto.dshmobile.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * DeepSeek Harness type scale (gradient-shadow-text.css):
 * sizes 11..24, system UI stack + mono code stack.
 */
object DsType {
    val uiFont = FontFamily.SansSerif
    val codeFont = FontFamily.Monospace

    // Markdown roles
    val mdH1 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Bold, fontSize = 24.sp, lineHeight = 34.sp)
    val mdH2 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 32.sp)
    val mdH3 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Bold, fontSize = 20.sp, lineHeight = 30.sp)
    val mdH4 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 28.sp)
    val mdBody = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 28.sp)
    val mdSmall = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 24.sp)
    val mdCode = TextStyle(fontFamily = codeFont, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 22.sp)

    // UI roles
    val display24 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp)
    val hero26 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Medium, fontSize = 26.sp, lineHeight = 32.sp)
    val large20 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Medium, fontSize = 20.sp, lineHeight = 28.sp)
    val base16 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp)
    val base16Strong = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 24.sp)
    val std14 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 22.sp)
    val std14Strong = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 22.sp)
    val small13 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 20.sp)
    val small13Strong = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 20.sp)
    val xsmall12 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 18.sp)
    val caption11 = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 11.sp, lineHeight = 14.sp)
    val caption11Strong = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 14.sp)

    // Composer / rows / bubbles
    val bubbleText = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp)
    val rowText = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp)
    val tabText = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 16.sp)
    val dockTitle = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Medium, fontSize = 13.sp, lineHeight = 24.sp)
    val statsText = TextStyle(fontFamily = uiFont, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 20.sp)
}

/** Material 3 mapping: sizes follow DsType, colors come from DsColors. */
val DsTypography = Typography(
    displayLarge = DsType.display24,
    headlineMedium = DsType.large20,
    titleMedium = DsType.std14Strong,
    bodyLarge = DsType.base16,
    bodyMedium = DsType.std14,
    bodySmall = DsType.small13,
    labelLarge = DsType.std14Strong,
    labelMedium = DsType.small13Strong,
    labelSmall = DsType.caption11,
)
