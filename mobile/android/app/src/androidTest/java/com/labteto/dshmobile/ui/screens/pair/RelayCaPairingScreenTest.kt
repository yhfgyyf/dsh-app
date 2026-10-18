package com.labteto.dshmobile.ui.screens.pair

import androidx.activity.compose.setContent
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.labteto.dshmobile.MainActivity
import com.labteto.dshmobile.ui.theme.DshTheme
import java.security.MessageDigest
import java.security.KeyStore
import java.security.cert.CertificateFactory
import android.os.Bundle
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject

/** Run with relayOrigin pointing at the isolated HTTPS fixture through adb reverse. */
@RunWith(AndroidJUnit4::class)
class RelayCaPairingScreenTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun scanningAnUntrustedRelayExportsCaAndShowsTheSystemTrustStep() {
        val origin = InstrumentationRegistry.getArguments().getString("relayOrigin")
        assumeNotNull(origin)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.executeShellCommand("pm grant ${instrumentation.targetContext.packageName} android.permission.POST_NOTIFICATIONS").close()
        val pem = instrumentation.context.assets.open("relay-ca-test.pem").bufferedReader().use { it.readText() }
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream())
        val fingerprint = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
        val qr = JSONObject().put("kind", "dsh-desktop-pair").put("version", 2).put("computerId", "computer_ui_fixture")
            .put("name", "CA test computer").put("key", "A".repeat(43)).put("expiresAt", System.currentTimeMillis() + 120000)
            .put("relay", JSONObject().put("origin", origin).put("deviceId", "desktop_ui_fixture").put("inviteId", "invite_ui_fixture")
                .put("claimSecret", "claim_ui_fixture").put("caFingerprint", fingerprint)).toString()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var model: PairViewModel
            var closed = false
            scenario.onActivity { activity ->
                model = ViewModelProvider(activity)[PairViewModel::class.java]
                model.onScanned(qr)
                activity.setContent { DshTheme { PairScreen(onClose = { closed = true }, viewModel = model) } }
            }
            compose.waitUntil(15000) { model.state.value.caInstallation != null || model.state.value.error != null }
            assertNull(model.state.value.error)
            assertNull(model.state.value.paired)
            assertEquals(fingerprint, model.state.value.caInstallation!!.certificate.fingerprint)
            compose.onNodeWithText("需要信任中继证书").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("打开证书设置").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("已安装，继续绑定").performScrollTo().performClick()
            compose.waitUntil(15000) { model.state.value.error != null }
            assertEquals("尚未检测到证书信任，请在系统设置中完成安装后继续。", model.state.value.error)
            assertNull(model.state.value.paired)
            if (InstrumentationRegistry.getArguments().getString("manualTrust") == "true") {
                instrumentation.sendStatus(2, Bundle().apply { putString("caStage", "awaiting-system-installation") })
                compose.waitUntil(90000) {
                    val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
                    store.aliases().toList().any { alias ->
                        val encoded = store.getCertificate(alias)?.encoded
                        encoded != null && encoded.contentEquals(cert.encoded)
                    }
                }
                // Keep the ViewModel and its original singleton OkHttp client alive across the Settings step.
                compose.runOnUiThread { model.continueAfterCaInstallation() }
                compose.waitUntil(15000) { closed || model.state.value.paired != null || model.state.value.error != null }
                assertNull(model.state.value.error)
                assertTrue("Trusted pairing must complete, including while Settings remains foreground", closed || model.state.value.paired != null)
                instrumentation.sendStatus(2, Bundle().apply { putString("caStage", "paired-after-system-installation") })
            }
        }
    }
}
