package com.labteto.dshmobile.ui.screens.pair

import android.content.ContentUris
import android.os.Build
import android.provider.MediaStore
import android.provider.Settings
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.labteto.dshmobile.core.wire.RelayCaCertificate
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RelayCaInstallationTest {
    @Test fun verifiedCaIsExportedForSystemSettingsWithoutStoragePermission() = runBlocking {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val pem = instrumentation.context.assets.open("relay-ca-test.pem").bufferedReader().use { it.readText() }
        val certificate = CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream())
        val fingerprint = MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
        val installation = prepareCaInstallation(context, RelayCaCertificate(pem, fingerprint))
        assertNotNull(installation.fileName)
        val resolver = context.contentResolver
        val uri = resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Downloads._ID),
            "${MediaStore.Downloads.DISPLAY_NAME} = ?", arrayOf(installation.fileName!!), "${MediaStore.Downloads._ID} DESC")!!.use {
            assertTrue(it.moveToFirst())
            ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, it.getLong(0))
        }
        try {
            assertEquals(pem, resolver.openInputStream(uri)!!.bufferedReader().use { it.readText() })
            assertEquals("application/x-x509-ca-cert", resolver.getType(uri))
            assertEquals(Settings.ACTION_SECURITY_SETTINGS, installation.intent().action)
            assertNotNull(installation.intent().resolveActivity(context.packageManager))
        } finally { resolver.delete(uri, null, null) }
    }
}
