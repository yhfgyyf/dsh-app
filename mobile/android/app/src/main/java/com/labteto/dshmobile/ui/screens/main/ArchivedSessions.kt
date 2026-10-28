package com.labteto.dshmobile.ui.screens.main

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.labteto.dshmobile.R
import com.labteto.dshmobile.data.SessionStore
import kotlinx.coroutines.launch

@Composable
internal fun ArchivedSessions(store: SessionStore) {
    val sessions by store.sessions.collectAsStateWithLifecycle()
    val archived by store.archivedSessionIds.collectAsStateWithLifecycle()
    val workspaces by store.workspaces.collectAsStateWithLifecycle()
    var query by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(store.activeHostKey, archived) { store.refreshSessions() }
    OutlinedTextField(query, { query = it }, label = { Text(stringResource(R.string.common_search)) }, modifier = Modifier.fillMaxWidth())
    val rows = sessions.filter { it.sessionId in archived &&
        (it.title.orEmpty().contains(query, true) || it.cwd.orEmpty().contains(query, true)) }
        .sortedByDescending { it.updatedAt }
    if (rows.isEmpty()) Text(stringResource(R.string.archived_empty))
    if (failed) Text(stringResource(R.string.panel_failed), color = MaterialTheme.colorScheme.error)
    rows.forEach { row ->
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
            Column(Modifier.weight(1f)) {
                Text(row.title ?: row.sessionId)
                Text(workspaces.firstOrNull { row.sessionId in it.sessionIds }?.let { "${it.title} · ${it.path}" } ?: row.cwd.orEmpty(), style = MaterialTheme.typography.bodySmall)
                Text(java.text.DateFormat.getDateTimeInstance().format(java.util.Date(row.updatedAt)), style = MaterialTheme.typography.bodySmall)
            }
            TextButton(enabled = busy == null, onClick = {
                busy = row.sessionId
                scope.launch { try { failed = !store.unarchiveSession(row.sessionId) } finally { busy = null } }
            }) { Text(stringResource(R.string.archived_restore)) }
        }
    }
}
