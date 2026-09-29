package com.labteto.dshmobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** Theme preference, mirroring the harness Appearance row (light|dark|system). */
enum class ThemePreference { LIGHT, DARK, SYSTEM }

/** Full DeepSeek Harness semantic palette for one scheme. */
data class DsColors(
    val bgBase: Color,
    val bgLayer1: Color,
    val bgLayer2: Color,
    val bgLayer3: Color,
    val bgModulePlatform: Color,
    val borderL1: Color,
    val borderL2: Color,
    val borderL3: Color,
    val brandPrimary: Color,
    val onBrandPrimary: Color,
    val labelPrimary: Color,
    val labelSecondary: Color,
    val labelTertiary: Color,
    val labelCaption: Color,
    val labelDimmed: Color,
    val accent: Color,
    val onAccent: Color,
    val accentTertiary: Color,
    val accentHover: Color,
    val hover: Color,
    val hoverSolid: Color,
    val hoverAccent: Color,
    val active: Color,
    val dangerHover: Color,
    val buttonPrimaryHover: Color,
    val buttonPrimaryDimmed: Color,
    val buttonInfoFill: Color,
    val buttonInfoHover: Color,
    val error: Color,
    val errorSecondary: Color,
    val errorTertiary: Color,
    val success: Color,
    val successSecondary: Color,
    val successTertiary: Color,
    val warnLabel: Color,
    val warn: Color,
    val warnSecondary: Color,
    val warnTertiary: Color,
    val toastBg: Color,
    val tooltipBg: Color,
    val userBubble: Color,
    val userBubbleHighlight: Color,
    val composerCard: Color,
    val sidebar: Color,
    val sidebarNavActive: Color,
    val sidebarNavAccent: Color,
    val sidebarNavHover: Color,
    val tipSurface: Color,
    val codeBlockBg: Color,
    val codeBlockBanner: Color,
    val inlineCode: Color,
    val citation: Color,
    val markdownTag: Color,
    val overlayMask: Color,
)

object DsThemeTokens {
    val light = DsColors(
        bgBase = DsLight.bgBase, bgLayer1 = DsLight.bgLayer1, bgLayer2 = DsLight.bgLayer2,
        bgLayer3 = DsLight.bgLayer3, bgModulePlatform = DsLight.bgModulePlatform,
        borderL1 = DsLight.borderL1, borderL2 = DsLight.borderL2, borderL3 = DsLight.borderL3,
        brandPrimary = DsLight.brandPrimary, onBrandPrimary = DsLight.onBrandPrimary,
        labelPrimary = DsLight.labelPrimary, labelSecondary = DsLight.labelSecondary,
        labelTertiary = DsLight.labelTertiary, labelCaption = DsLight.labelCaption,
        labelDimmed = DsLight.labelDimmed,
        accent = DsLight.accent, onAccent = DsLight.onAccent,
        accentTertiary = DsLight.accentTertiary, accentHover = DsLight.accentHover,
        hover = DsLight.hover, hoverSolid = DsLight.hoverSolid, hoverAccent = DsLight.hoverAccent,
        active = DsLight.active, dangerHover = DsLight.dangerHover,
        buttonPrimaryHover = DsLight.buttonPrimaryHover, buttonPrimaryDimmed = DsLight.buttonPrimaryDimmed,
        buttonInfoFill = DsLight.buttonInfoFill, buttonInfoHover = DsLight.buttonInfoHover,
        error = DsLight.error, errorSecondary = DsLight.errorSecondary, errorTertiary = DsLight.errorTertiary,
        success = DsLight.success, successSecondary = DsLight.successSecondary,
        successTertiary = DsLight.successTertiary,
        warnLabel = DsLight.warnLabel, warn = DsLight.warn, warnSecondary = DsLight.warnSecondary,
        warnTertiary = DsLight.warnTertiary,
        toastBg = DsLight.toastBg, tooltipBg = DsLight.tooltipBg,
        userBubble = DsLight.userBubble, userBubbleHighlight = DsLight.userBubbleHighlight,
        composerCard = DsLight.composerCard,
        sidebar = DsLight.sidebar, sidebarNavActive = DsLight.sidebarNavActive,
        sidebarNavAccent = DsLight.sidebarNavAccent, sidebarNavHover = DsLight.sidebarNavHover,
        tipSurface = DsLight.tipSurface,
        codeBlockBg = DsLight.codeBlockBg, codeBlockBanner = DsLight.codeBlockBanner,
        inlineCode = DsLight.inlineCode, citation = DsLight.citation,
        markdownTag = DsLight.markdownTag, overlayMask = DsLight.overlayMask,
    )

    val dark = DsColors(
        bgBase = DsDark.bgBase, bgLayer1 = DsDark.bgLayer1, bgLayer2 = DsDark.bgLayer2,
        bgLayer3 = DsDark.bgLayer3, bgModulePlatform = DsDark.bgModulePlatform,
        borderL1 = DsDark.borderL1, borderL2 = DsDark.borderL2, borderL3 = DsDark.borderL3,
        brandPrimary = DsDark.brandPrimary, onBrandPrimary = DsDark.onBrandPrimary,
        labelPrimary = DsDark.labelPrimary, labelSecondary = DsDark.labelSecondary,
        labelTertiary = DsDark.labelTertiary, labelCaption = DsDark.labelCaption,
        labelDimmed = DsDark.labelDimmed,
        accent = DsDark.accent, onAccent = DsDark.onAccent,
        accentTertiary = DsDark.accentTertiary, accentHover = DsDark.accentHover,
        hover = DsDark.hover, hoverSolid = DsDark.hoverSolid, hoverAccent = DsDark.hoverAccent,
        active = DsDark.active, dangerHover = DsDark.dangerHover,
        buttonPrimaryHover = DsDark.buttonPrimaryHover, buttonPrimaryDimmed = DsDark.buttonPrimaryDimmed,
        buttonInfoFill = DsDark.buttonInfoFill, buttonInfoHover = DsDark.buttonInfoHover,
        error = DsDark.error, errorSecondary = DsDark.errorSecondary, errorTertiary = DsDark.errorTertiary,
        success = DsDark.success, successSecondary = DsDark.successSecondary,
        successTertiary = DsDark.successTertiary,
        warnLabel = DsDark.warnLabel, warn = DsDark.warn, warnSecondary = DsDark.warnSecondary,
        warnTertiary = DsDark.warnTertiary,
        toastBg = DsDark.toastBg, tooltipBg = DsDark.tooltipBg,
        userBubble = DsDark.userBubble, userBubbleHighlight = DsDark.userBubbleHighlight,
        composerCard = DsDark.composerCard,
        sidebar = DsDark.sidebar, sidebarNavActive = DsDark.sidebarNavActive,
        sidebarNavAccent = DsDark.sidebarNavAccent, sidebarNavHover = DsDark.sidebarNavHover,
        tipSurface = DsDark.tipSurface,
        codeBlockBg = DsDark.codeBlockBg, codeBlockBanner = DsDark.codeBlockBanner,
        inlineCode = DsDark.inlineCode, citation = DsDark.citation,
        markdownTag = DsDark.markdownTag, overlayMask = DsDark.overlayMask,
    )
}

/** The full DeepSeek palette as a CompositionLocal. */
val LocalDsColors = staticCompositionLocalOf { DsThemeTokens.light }

object DsTheme {
    val colors: DsColors
        @Composable get() = LocalDsColors.current
}

private fun materialLightScheme(c: DsColors) = lightColorScheme(
    primary = c.accent,
    onPrimary = c.onAccent,
    secondary = c.labelSecondary,
    onSecondary = c.bgBase,
    tertiary = c.warn,
    background = c.bgBase,
    onBackground = c.labelPrimary,
    surface = c.bgLayer1,
    onSurface = c.labelPrimary,
    surfaceVariant = c.bgModulePlatform,
    onSurfaceVariant = c.labelSecondary,
    outline = c.borderL2,
    outlineVariant = c.borderL1,
    error = c.error,
    onError = Color.White,
)

private fun materialDarkScheme(c: DsColors) = darkColorScheme(
    primary = c.accent,
    onPrimary = c.onAccent,
    secondary = c.labelSecondary,
    onSecondary = c.bgBase,
    tertiary = c.warn,
    background = c.bgBase,
    onBackground = c.labelPrimary,
    surface = c.bgLayer1,
    onSurface = c.labelPrimary,
    surfaceVariant = c.bgModulePlatform,
    onSurfaceVariant = c.labelSecondary,
    outline = c.borderL2,
    outlineVariant = c.borderL1,
    error = c.error,
    onError = Color.White,
)

/**
 * The DeepSeek Harness theme. Honors the app's theme preference
 * (light | dark | system) and always uses the DSH token palette.
 */
@Composable
fun DshTheme(
    preference: ThemePreference = ThemePreference.SYSTEM,
    content: @Composable () -> Unit,
) {
    val dark = when (preference) {
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
        ThemePreference.SYSTEM -> isSystemInDarkTheme()
    }
    val ds = if (dark) DsThemeTokens.dark else DsThemeTokens.light
    val scheme = if (dark) materialDarkScheme(ds) else materialLightScheme(ds)
    CompositionLocalProvider(LocalDsColors provides ds) {
        MaterialTheme(
            colorScheme = scheme,
            typography = DsTypography,
            shapes = DsMaterialShapes,
            content = content,
        )
    }
}
