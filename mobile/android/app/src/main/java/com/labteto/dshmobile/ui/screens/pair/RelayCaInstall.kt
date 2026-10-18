package com.labteto.dshmobile.ui.screens.pair

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.security.KeyChain
import com.labteto.dshmobile.core.wire.RelayCaCertificate
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class RelayCaInstallation(val certificate: RelayCaCertificate, val fileName: String? = null) {
    fun intent(): Intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Intent(Settings.ACTION_SECURITY_SETTINGS)
    else KeyChain.createInstallIntent().putExtra(KeyChain.EXTRA_CERTIFICATE, certificate.pem.toByteArray(Charsets.UTF_8))
        .putExtra(KeyChain.EXTRA_NAME, "DSH Relay CA")
}

/** Android 11+ accepts CA installation only from Settings, using a file in shared Downloads. */
internal suspend fun prepareCaInstallation(context: Context, certificate: RelayCaCertificate): RelayCaInstallation = withContext(Dispatchers.IO) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return@withContext RelayCaInstallation(certificate)
    val resolver = context.contentResolver
    val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, certificate.fileName)
        put(MediaStore.Downloads.MIME_TYPE, "application/x-x509-ca-cert")
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DSH Remote")
        put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IOException("Cannot create CA download")
    try {
        (resolver.openOutputStream(uri, "w") ?: throw IOException("Cannot write CA download")).use {
            it.write(certificate.pem.toByteArray(Charsets.UTF_8))
        }
        resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        val name = resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: certificate.fileName
        RelayCaInstallation(certificate, name)
    } catch (error: Exception) {
        resolver.delete(uri, null, null)
        throw error
    }
}
