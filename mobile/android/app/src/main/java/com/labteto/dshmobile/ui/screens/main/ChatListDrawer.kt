package com.labteto.dshmobile.ui.screens.main

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.labteto.dshmobile.R
import com.labteto.dshmobile.data.SessionRow
import com.labteto.dshmobile.data.SessionStore
import com.labteto.dshmobile.data.WorkspaceRow
import com.labteto.dshmobile.ui.components.DisclosureRow
import com.labteto.dshmobile.ui.components.DsButton
import com.labteto.dshmobile.ui.components.DsButtonVariant
import com.labteto.dshmobile.ui.components.DsDialog
import com.labteto.dshmobile.ui.components.DsIconButton
import com.labteto.dshmobile.ui.components.DsPill
import com.labteto.dshmobile.ui.components.DsMenu
import com.labteto.dshmobile.ui.components.EmptyHero
import com.labteto.dshmobile.ui.components.MenuItem
import com.labteto.dshmobile.ui.components.SectionHeader
import com.labteto.dshmobile.ui.components.StateDot
import com.labteto.dshmobile.ui.components.StateDotState
import com.labteto.dshmobile.ui.components.relativeTime
import com.labteto.dshmobile.ui.rememberHostsStore
import com.labteto.dshmobile.ui.rememberSessionStore
import com.labteto.dshmobile.ui.theme.DsAnimations
import com.labteto.dshmobile.ui.theme.DsShapes
import com.labteto.dshmobile.ui.theme.DsSpacing
import com.labteto.dshmobile.ui.theme.DsTheme
import com.labteto.dshmobile.ui.theme.DsType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** [com.labteto.dshmobile.connection.HostsStore.sessionSort]: the workspace's own row order. */
private const val SORT_MANUAL = "manual"

/** [com.labteto.dshmobile.connection.HostsStore.sessionSort]: most recently updated first. */
private const val SORT_UPDATED = "updated"

/**
 * The chat history: workspaces, their sessions, and search.
 *
 * Two rules keep it readable. Blank sessions are hidden — the harness treats a session with no turn
 * as scratch space and reuses it, so listing them just accumulates empty rows. And times are
 * relative, because a clock time cannot distinguish "an hour ago" from "last Tuesday".
 */
@Composable
fun ChatListDrawer(
    onClose: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val colors = DsTheme.colors
    val store = rememberSessionStore()
    val scope = rememberCoroutineScope()
    val hostsStore = rememberHostsStore()

    val sessions by store.sessions.collectAsStateWithLifecycle()
    val workspaces by store.workspaces.collectAsStateWithLifecycle()
    val archivedIds by store.archivedSessionIds.collectAsStateWithLifecycle()
    val searchResults by store.searchResults.collectAsStateWithLifecycle()
    val contentSearchAvailable by store.contentSearchAvailable.collectAsStateWithLifecycle()
    val currentSessionId by store.currentSessionId.collectAsStateWithLifecycle()
    val hostInfo by store.hostInfo.collectAsStateWithLifecycle()
    // Null against a harness without pinning (before 0.1.7), which hides the section and the menu row.
    val pinnedIds by store.pinnedSessionIds.collectAsStateWithLifecycle()

    var query by remember { mutableStateOf("") }
    var searchOpen by remember { mutableStateOf(false) }
    // Persisted, not remembered: the order you read your sessions in is a preference, and it used
    // to reset every time the drawer was closed.
    val sessionSort by hostsStore.sessionSort.collectAsStateWithLifecycle(initialValue = SORT_MANUAL)
    val sortByRecency = sessionSort == SORT_UPDATED
    var newWorkspaceOpen by remember { mutableStateOf(false) }
    var newSessionOpen by remember { mutableStateOf(false) }
    val collapsed = remember { mutableStateMapOf<String, Boolean>() }

    LaunchedEffect(query) {
        delay(250)
        store.search(query.trim())
    }

    // Local matching is not debounced: it is a string comparison over a list already in memory, and
    // making someone wait a quarter second for it is what made search feel like it did nothing.
    val searchHits = remember(sessions, workspaces, archivedIds, query, searchResults) {
        deriveSearchResults(
            sessions = sessions,
            workspaces = workspaces,
            archivedIds = archivedIds,
            query = query,
            contentHits = searchResults,
        )
    }

    // Blank sessions are scratch space the harness reuses; subagent transcripts belong under their
    // parent, not as top-level rows.
    val listable = sessions.filter { it.sessionId !in archivedIds && !it.blank }
    val sessionsById = sessions.associateBy { it.sessionId }
    val archivedSessions = sessions.filter { it.sessionId in archivedIds }
    val workspaceSessionIds = workspaces.flatMap { it.sessionIds }.toSet()

    // Subagents nest under the session that spawned them. `origin` is the discriminator, not
    // `parentSessionId` — an ordinary fork sets a parent too, and a fork is a session in its own
    // right that belongs at the top level. Grouping is by *immediate* parent so a subagent that
    // spawned its own subagents nests to whatever depth the run actually reached; a child whose
    // parent is archived or blank attaches to the nearest ancestor still on screen instead of
    // disappearing with it.
    val childrenByParent = remember(listable) { indexSubagents(listable, sessionsById) }
    val nestedIds = remember(childrenByParent) {
        childrenByParent.values.flatten().mapTo(HashSet()) { it.sessionId }
    }
    // Every session between the open one and the root, so a subtree holding it opens by default.
    val openPath = remember(currentSessionId, sessionsById) {
        buildSet {
            var cursor = currentSessionId?.let { sessionsById[it] }
            while (cursor != null && add(cursor.sessionId)) {
                cursor = cursor.parentSessionId?.let { sessionsById[it] }
            }
        }
    }

    // `collapsed` holds explicit choices only; the default is closed unless the subtree holds the
    // session you are looking at, so opening the drawer mid-run shows you where you are.
    fun isExpanded(sessionId: String): Boolean = collapsed[sessionId]?.not() ?: (sessionId in openPath)
    fun toggleChildren(sessionId: String) {
        collapsed[sessionId] = isExpanded(sessionId)
    }

    /** Depth-first expansion of one top-level session, honouring each row's collapse state. */
    fun subtree(root: SessionRow): List<Pair<SessionRow, Int>> {
        val out = mutableListOf<Pair<SessionRow, Int>>()
        fun walk(row: SessionRow, depth: Int) {
            out += row to depth
            val children = childrenByParent[row.sessionId].orEmpty()
            if (children.isEmpty() || !isExpanded(row.sessionId)) return
            val ordered = if (sortByRecency) children.sortedByDescending(SessionRow::updatedAt) else children
            ordered.forEach { walk(it, depth + 1) }
        }
        walk(root, 0)
        return out
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.sidebar)
            .safeDrawingPadding()
            .padding(horizontal = DsSpacing.medium),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = DsSpacing.small),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.chatlist_title),
                style = DsType.large20,
                color = colors.labelPrimary,
                modifier = Modifier.weight(1f),
            )
            DsIconButton(
                icon = Icons.Filled.Search,
                contentDescription = stringResource(R.string.common_search),
                // Closing the field clears the query too: a hidden field holding text left the list
                // filtered by something no longer on screen.
                onClick = {
                    searchOpen = !searchOpen
                    if (!searchOpen) query = ""
                },
                tint = if (searchOpen) colors.accent else colors.labelTertiary,
            )
            SortChip(sortByRecency) { next ->
                scope.launch { hostsStore.setSessionSort(if (next) SORT_UPDATED else SORT_MANUAL) }
            }
            DsIconButton(
                icon = Icons.Filled.Settings,
                contentDescription = stringResource(R.string.settings_title),
                onClick = onOpenSettings,
                tint = colors.labelTertiary,
            )
        }

        DsButton(
            text = stringResource(R.string.chatlist_new_session),
            icon = Icons.Filled.Add,
            onClick = { newSessionOpen = true },
            variant = DsButtonVariant.Info,
            modifier = Modifier.fillMaxWidth(),
        )

        // The search field folds away rather than permanently occupying a row of a phone-height
        // drawer, which is otherwise pure overhead for the common case.
        AnimatedVisibility(visible = searchOpen) {
            Column(modifier = Modifier.padding(top = DsSpacing.small)) {
                TextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text(stringResource(R.string.chatlist_search_hint), style = DsType.std14) },
                    singleLine = true,
                    colors = dialogTextFieldColors(),
                )
                // Stated once, quietly, and only while searching. Most harnesses ship with the
                // content index off, so this is a normal capability note — not a failure.
                if (!contentSearchAvailable && query.isNotBlank()) {
                    Text(
                        stringResource(R.string.chatlist_search_content_off),
                        style = DsType.caption11,
                        color = colors.labelCaption,
                        modifier = Modifier.padding(top = DsSpacing.tiny),
                    )
                }
            }
        }

        Spacer(Modifier.height(DsSpacing.small))

        LazyColumn(modifier = Modifier.weight(1f)) {
            if (query.isNotBlank()) {
                item(key = "search-header") { SectionHeader(stringResource(R.string.common_search)) }
                if (searchHits.items.isEmpty()) {
                    item(key = "search-empty") {
                        Text(
                            stringResource(R.string.chatlist_search_empty),
                            style = DsType.std14,
                            color = colors.labelTertiary,
                            modifier = Modifier.padding(vertical = DsSpacing.small),
                        )
                    }
                }
                items(searchHits.items, key = { it.session.sessionId }) { hit ->
                    SearchResultRow(hit, store, scope, onClose)
                }
                if (searchHits.hasMore) {
                    item(key = "search-more") {
                        Text(
                            stringResource(R.string.chatlist_search_refine),
                            style = DsType.caption11,
                            color = colors.labelCaption,
                            modifier = Modifier.padding(vertical = DsSpacing.xsmall),
                        )
                    }
                }
                return@LazyColumn
            }

            var anyShown = false
            // Pinned sessions lead, in pin order, as a shortcut: each stays in its own group too.
            val pinnedRows = pinnedIds.orEmpty().mapNotNull { id -> listable.firstOrNull { it.sessionId == id } }
            if (pinnedRows.isNotEmpty()) {
                anyShown = true
                item(key = "pinned-header") { SectionHeader(stringResource(R.string.chatlist_pinned)) }
                items(pinnedRows, key = { "pinned-${it.sessionId}" }) { session ->
                    Box(Modifier.animateItem()) {
                        SessionRowItem(
                            session = session,
                            isCurrent = session.sessionId == currentSessionId,
                            store = store,
                            scope = scope,
                            onClose = onClose,
                            pinned = true,
                        )
                    }
                }
            }
            for (workspace in workspaces) {
                val roots = workspace.sessionIds
                    .mapNotNull { id -> listable.firstOrNull { it.sessionId == id } }
                    .filterNot { it.sessionId in nestedIds }
                    .let { if (sortByRecency) it.sortedByDescending(SessionRow::updatedAt) else it }
                if (roots.isEmpty()) continue
                anyShown = true
                // Only the workspace you are working in is open by default. With twenty sessions
                // and their subagents in one group, expanding everything buries the list you came
                // for; the explicit map entry then remembers whatever you choose.
                val holdsCurrent = roots.any { it.sessionId in openPath }
                val isCollapsed = collapsed[workspace.workspaceId] ?: !holdsCurrent
                item(key = "ws-${workspace.workspaceId}") {
                    WorkspaceHeader(
                        workspace = workspace,
                        collapsed = isCollapsed,
                        // Sessions, not sessions-plus-their-subagents: a subagent count belongs on
                        // the row that spawned them, where it says something.
                        sessionCount = roots.size,
                        onToggle = { collapsed[workspace.workspaceId] = !isCollapsed },
                        store = store,
                        scope = scope,
                        onNewSession = {
                            scope.launch {
                                store.createSession(workspaceId = workspace.workspaceId)
                                onClose()
                            }
                        },
                    )
                }
                if (!isCollapsed) {
                    val flat = roots.flatMap { subtree(it) }
                    items(flat, key = { it.first.sessionId }) { (session, depth) ->
                        Box(Modifier.animateItem()) {
                            SessionRowItem(
                                session = session,
                                isCurrent = session.sessionId == currentSessionId,
                                store = store,
                                scope = scope,
                                onClose = onClose,
                                depth = depth,
                                childCount = childrenByParent[session.sessionId].orEmpty().size,
                                childrenExpanded = isExpanded(session.sessionId),
                                onToggleChildren = { toggleChildren(session.sessionId) },
                                pinned = pinnedIds?.let { session.sessionId in it },
                            )
                        }
                    }
                }
            }

            // Sessions the harness never registered in a workspace, plus any subagent whose whole
            // ancestry is archived or blank — those have no row left to nest under.
            val ungrouped = listable.filter {
                it.sessionId !in workspaceSessionIds && it.sessionId !in nestedIds
            }
            if (ungrouped.isNotEmpty()) {
                anyShown = true
                item(key = "sessions-header") { SectionHeader(stringResource(R.string.chatlist_sessions)) }
                val flat = ungrouped
                    .let { if (sortByRecency) it.sortedByDescending(SessionRow::updatedAt) else it }
                    .flatMap { subtree(it) }
                items(flat, key = { it.first.sessionId }) { (session, depth) ->
                    Box(Modifier.animateItem()) {
                        SessionRowItem(
                            session = session,
                            isCurrent = session.sessionId == currentSessionId,
                            store = store,
                            scope = scope,
                            onClose = onClose,
                            depth = depth,
                            childCount = childrenByParent[session.sessionId].orEmpty().size,
                            childrenExpanded = isExpanded(session.sessionId),
                            onToggleChildren = { toggleChildren(session.sessionId) },
                            pinned = pinnedIds?.let { session.sessionId in it },
                        )
                    }
                }
            }

            if (archivedSessions.isNotEmpty()) {
                anyShown = true
                item(key = "archived") {
                    var archivedExpanded by remember { mutableStateOf(false) }
                    DisclosureRow(
                        title = stringResource(R.string.chatlist_archived),
                        summary = archivedSessions.size.toString(),
                        expanded = archivedExpanded,
                        onToggle = { archivedExpanded = !archivedExpanded },
                    ) {
                        archivedSessions.forEach { session ->
                            SessionRowItem(session, false, store, scope, onClose)
                        }
                    }
                }
            }

            if (!anyShown) {
                item(key = "empty") {
                    EmptyHero(
                        headline = stringResource(R.string.chatlist_empty),
                        subtitle = stringResource(R.string.chatlist_empty_hint),
                    )
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(DsShapes.row)
                .clickable { newWorkspaceOpen = true }
                .padding(vertical = DsSpacing.small),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.Add,
                contentDescription = null,
                tint = colors.labelTertiary,
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(DsSpacing.small))
            Text(
                stringResource(R.string.chatlist_new_workspace),
                style = DsType.std14,
                color = colors.labelSecondary,
            )
        }
    }

    if (newSessionOpen) {
        NewSessionDialog(
            workspaces = workspaces,
            homeCwd = hostInfo?.home,
            onPick = { workspaceId ->
                newSessionOpen = false
                scope.launch {
                    store.createSession(workspaceId = workspaceId)
                    onClose()
                }
            },
            onDismiss = { newSessionOpen = false },
        )
    }

    if (newWorkspaceOpen) {
        NewWorkspaceDialog(
            onDismiss = { newWorkspaceOpen = false },
            onCreate = { path ->
                scope.launch {
                    store.createWorkspace(path)
                    newWorkspaceOpen = false
                }
            },
        )
    }
}

/**
 * The session-order control.
 *
 * It used to be a bare ⇅ icon whose only label was a content description, which told a sighted user
 * nothing: two arrows over a chat list could as easily mean sync, move, or reorder. Naming the
 * current order and offering the other one is the whole fix — and the strings for both modes were
 * already translated in all eleven locales, waiting for a control to use them.
 */
@Composable
private fun SortChip(byRecency: Boolean, onPick: (byRecency: Boolean) -> Unit) {
    val colors = DsTheme.colors
    val updated = stringResource(R.string.chatlist_sort_updated)
    val manual = stringResource(R.string.chatlist_sort_manual)
    DsMenu(
        anchor = {
            Row(
                modifier = Modifier
                    .clip(DsShapes.cube)
                    .padding(horizontal = DsSpacing.xsmall, vertical = DsSpacing.tiny),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(DsSpacing.tiny),
            ) {
                Icon(
                    Icons.Filled.SwapVert,
                    contentDescription = stringResource(R.string.chatlist_sort_title),
                    tint = colors.labelTertiary,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    if (byRecency) updated else manual,
                    style = DsType.small13,
                    color = colors.labelSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        items = listOf(
            MenuItem(text = manual) { onPick(false) },
            MenuItem(text = updated) { onPick(true) },
        ),
    )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * A workspace header that collapses its group and carries the workspace verbs.
 *
 * Rename and remove exist on the wire and had no UI at all; a long-press menu is where a
 * phone user expects to find them.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WorkspaceHeader(
    workspace: WorkspaceRow,
    collapsed: Boolean,
    sessionCount: Int,
    onToggle: () -> Unit,
    store: SessionStore,
    scope: CoroutineScope,
    onNewSession: () -> Unit,
) {
    val colors = DsTheme.colors
    var menuOpen by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    val rotation by animateFloatAsState(
        targetValue = if (collapsed) 0f else 90f,
        animationSpec = DsAnimations.chevron,
        label = "workspaceChevron",
    )
    val label = workspace.title.ifBlank { basename(workspace.path) }

    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(DsShapes.row)
                .combinedClickable(onClick = onToggle, onLongClick = { menuOpen = true })
                .padding(vertical = DsSpacing.xsmall),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = colors.labelTertiary,
                modifier = Modifier
                    .size(16.dp)
                    .graphicsLayer { rotationZ = rotation },
            )
            Spacer(Modifier.width(DsSpacing.tiny))
            Text(
                label,
                style = DsType.std14Strong,
                color = colors.labelSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(sessionCount.toString(), style = DsType.caption11, color = colors.labelCaption)
        }
        if (menuOpen) {
            WorkspaceMenu(
                onDismiss = { menuOpen = false },
                onNewSession = {
                    menuOpen = false
                    onNewSession()
                },
                onRename = {
                    menuOpen = false
                    renaming = true
                },
                onDelete = {
                    menuOpen = false
                    deleting = true
                },
            )
        }
    }

    if (renaming) {
        RenameDialog(
            initial = workspace.title,
            title = stringResource(R.string.chatlist_workspace_rename),
            onDismiss = { renaming = false },
            onConfirm = {
                scope.launch { store.renameWorkspace(workspace.workspaceId, it) }
                renaming = false
            },
        )
    }
    if (deleting) {
        ConfirmDialog(
            title = stringResource(R.string.chatlist_workspace_delete),
            body = stringResource(R.string.chatlist_workspace_delete_confirm),
            confirmLabel = stringResource(R.string.common_remove),
            onDismiss = { deleting = false },
            onConfirm = {
                scope.launch { store.deleteWorkspace(workspace.workspaceId) }
                deleting = false
            },
        )
    }
}

@Composable
private fun WorkspaceMenu(
    onDismiss: () -> Unit,
    onNewSession: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    DsDialog(title = null, onDismiss = onDismiss) {
        SheetRow(title = stringResource(R.string.chatlist_workspace_new_session), onClick = onNewSession)
        SheetRow(title = stringResource(R.string.chatlist_workspace_rename), onClick = onRename)
        SheetRow(title = stringResource(R.string.chatlist_workspace_delete), onClick = onDelete)
    }
}

/**
 * One session row: status, title, relative time, and the session verbs on long-press.
 *
 * [depth] indents the row under whatever spawned it, and a row with [childCount] subagents grows a
 * disclosure chevron that opens them in place. Subagents used to be dumped into one flat
 * "Subagents" heading per workspace, which said nothing about which run produced which — with a
 * dozen of them from three sessions it was a wall of near-identical rows.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SessionRowItem(
    session: SessionRow,
    isCurrent: Boolean,
    store: SessionStore,
    scope: CoroutineScope,
    onClose: () -> Unit,
    depth: Int = 0,
    childCount: Int = 0,
    childrenExpanded: Boolean = false,
    onToggleChildren: () -> Unit = {},
    /** Whether the session is pinned; null when the harness has no pinning to offer. */
    pinned: Boolean? = null,
) {
    val colors = DsTheme.colors
    var menuOpen by remember { mutableStateOf(false) }
    var renameOpen by remember { mutableStateOf(false) }
    var archiveConfirmOpen by remember { mutableStateOf(false) }
    var archiveBusy by remember { mutableStateOf<com.labteto.dshmobile.data.ArchiveOutcome.Busy?>(null) }
    val chevronRotation by animateFloatAsState(
        targetValue = if (childrenExpanded) 90f else 0f,
        animationSpec = DsAnimations.chevron,
        label = "sessionChevron",
    )

    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = (depth * 16).dp)
                .clip(DsShapes.row)
                .background(if (isCurrent) colors.sidebarNavActive else androidx.compose.ui.graphics.Color.Transparent)
                .combinedClickable(
                    onClick = {
                        scope.launch {
                            store.openSession(session.sessionId)
                            onClose()
                        }
                    },
                    onLongClick = { menuOpen = true },
                )
                .padding(horizontal = DsSpacing.small, vertical = DsSpacing.xsmall),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // A current-session accent rail reads faster than a background tint alone on a
            // low-contrast sidebar.
            Box(
                Modifier
                    .width(2.dp)
                    .height(24.dp)
                    .clip(RoundedCornerShape(1.dp))
                    .background(if (isCurrent) colors.accent else androidx.compose.ui.graphics.Color.Transparent),
            )
            Spacer(Modifier.width(DsSpacing.small))
            // The chevron is its own tap target: opening a session and looking at what it spawned
            // are different intentions, and conflating them means you cannot do one without the
            // other. The spacer keeps titles aligned down a column of mixed rows.
            if (childCount > 0) {
                Icon(
                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                    contentDescription = stringResource(R.string.chatlist_subagents),
                    tint = colors.labelTertiary,
                    modifier = Modifier
                        .size(16.dp)
                        .graphicsLayer { rotationZ = chevronRotation }
                        .clickable(onClick = onToggleChildren),
                )
            } else {
                Spacer(Modifier.width(16.dp))
            }
            Spacer(Modifier.width(DsSpacing.tiny))
            StateDot(
                state = when {
                    session.running -> StateDotState.Running
                    session.pendingInteraction != null -> StateDotState.Warning
                    else -> StateDotState.Idle
                },
            )
            Spacer(Modifier.width(DsSpacing.small))
            Column(Modifier.weight(1f)) {
                Text(
                    text = sessionTitle(session),
                    style = DsType.std14,
                    color = colors.labelPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    session.cwd?.takeIf { it.isNotBlank() }?.let {
                        Text(
                            basename(it),
                            style = DsType.caption11,
                            color = colors.labelCaption,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Text(" · ", style = DsType.caption11, color = colors.labelCaption)
                    }
                    Text(
                        relativeTime(session.updatedAt),
                        style = DsType.caption11,
                        color = colors.labelCaption,
                    )
                }
            }
            if (session.pendingInteraction != null) {
                Spacer(Modifier.width(DsSpacing.xsmall))
                DsPill(text = stringResource(R.string.chatlist_needs_action), warn = true)
            }
            // The count replaces the old "Subagents" pill on parents: with the children indented
            // underneath, what is worth saying is how many are down there when the row is closed.
            if (childCount > 0) {
                Spacer(Modifier.width(DsSpacing.xsmall))
                DsPill(text = childCount.toString())
            } else if (session.origin == "subagent" && depth == 0) {
                // Only reached by an orphan — its whole ancestry is archived or blank — where the
                // indent cannot say what the row is.
                Spacer(Modifier.width(DsSpacing.xsmall))
                DsPill(text = stringResource(R.string.chatlist_subagents))
            }
        }

        if (menuOpen) {
            DsDialog(title = null, onDismiss = { menuOpen = false }) {
                SheetRow(title = stringResource(R.string.chatlist_session_rename)) {
                    menuOpen = false
                    renameOpen = true
                }
                SheetRow(title = stringResource(R.string.chatlist_session_fork)) {
                    menuOpen = false
                    scope.launch { store.forkSession(session.sessionId) }
                }
                if (pinned != null) {
                    SheetRow(
                        title = stringResource(if (pinned) R.string.chatlist_session_unpin else R.string.chatlist_session_pin),
                    ) {
                        menuOpen = false
                        scope.launch { store.setPinned(session.sessionId, !pinned) }
                    }
                }
                SheetRow(title = stringResource(R.string.chatlist_session_archive)) {
                    menuOpen = false
                    archiveConfirmOpen = true
                }
            }
        }
    }

    if (renameOpen) {
        RenameDialog(
            initial = session.title.orEmpty(),
            title = stringResource(R.string.chatlist_session_rename),
            onDismiss = { renameOpen = false },
            onConfirm = {
                scope.launch { store.renameSession(session.sessionId, it) }
                renameOpen = false
            },
        )
    }

    if (archiveConfirmOpen) {
        ConfirmDialog(
            title = stringResource(R.string.chatlist_session_archive),
            body = sessionTitle(session),
            confirmLabel = stringResource(R.string.common_archive),
            onDismiss = { archiveConfirmOpen = false },
            onConfirm = {
                archiveConfirmOpen = false
                scope.launch {
                    (store.archiveSession(session.sessionId) as? com.labteto.dshmobile.data.ArchiveOutcome.Busy)
                        ?.let { archiveBusy = it }
                }
            },
        )
    }

    archiveBusy?.let { busy ->
        ArchiveBusyDialog(
            busy = busy,
            onDismiss = { archiveBusy = null },
            onConfirm = {
                archiveBusy = null
                scope.launch { store.archiveSession(busy.sessionId, stopActivity = true) }
            },
        )
    }
}

/**
 * One search result: the session's own name first, then where it lives, then the matching excerpt
 * if the host had one.
 *
 * The row used to lead with the excerpt and label itself with a raw session id, which is neither
 * something anyone searched for nor something they can recognise. A result should name the thing
 * you are about to open.
 */
@Composable
private fun SearchResultRow(
    hit: SearchHit,
    store: SessionStore,
    scope: CoroutineScope,
    onClose: () -> Unit,
) {
    val colors = DsTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(DsShapes.row)
            .clickable {
                scope.launch {
                    store.openSession(hit.session.sessionId)
                    onClose()
                }
            }
            .padding(horizontal = DsSpacing.tiny, vertical = DsSpacing.xsmall),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = sessionTitle(hit.session),
                style = DsType.rowText,
                color = colors.labelPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (hit.session.origin == "subagent") {
                Spacer(Modifier.width(DsSpacing.xsmall))
                DsPill(text = stringResource(R.string.chatlist_subagents))
            }
        }
        hit.workspaceLabel.takeIf { it.isNotBlank() }?.let {
            Text(
                text = it,
                style = DsType.caption11,
                color = colors.labelCaption,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        hit.snippet?.let {
            Text(
                text = it,
                style = DsType.caption11,
                color = colors.labelSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

@Composable
private fun NewSessionDialog(
    workspaces: List<WorkspaceRow>,
    homeCwd: String?,
    onPick: (String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DsTheme.colors
    DsDialog(title = stringResource(R.string.chatlist_new_session_in), onDismiss = onDismiss) {
        if (workspaces.isEmpty()) {
            Text(
                stringResource(R.string.chatlist_no_workspaces),
                style = DsType.std14,
                color = colors.labelSecondary,
            )
        }
        workspaces.forEach { workspace ->
            SheetRow(
                title = workspace.title.ifBlank { basename(workspace.path) },
                subtitle = workspace.path,
                onClick = { onPick(workspace.workspaceId) },
            )
        }
        SheetRow(
            title = stringResource(R.string.chatlist_home_directory),
            subtitle = homeCwd,
            onClick = { onPick(null) },
        )
    }
}

@Composable
private fun NewWorkspaceDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var pathText by remember { mutableStateOf("") }
    DsDialog(title = stringResource(R.string.chatlist_new_workspace), onDismiss = onDismiss) {
        TextField(
            value = pathText,
            onValueChange = { pathText = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text(stringResource(R.string.chatlist_workspace_path), style = DsType.std14) },
            singleLine = true,
            colors = dialogTextFieldColors(),
        )
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            DsButton(
                text = stringResource(R.string.common_cancel),
                onClick = onDismiss,
                variant = DsButtonVariant.Ghost,
            )
            Spacer(Modifier.width(DsSpacing.small))
            DsButton(
                text = stringResource(R.string.common_save),
                onClick = { onCreate(pathText.trim()) },
                variant = DsButtonVariant.Info,
                enabled = pathText.isNotBlank(),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk a (possibly nested) subagent session's parent chain up to the session directly registered in
 * a workspace, returning that workspace id — or null for an orphan.
 */
/**
 * Group subagent sessions under the visible session that spawned them.
 *
 * Keyed by immediate parent, so a subagent that spawned its own subagents nests as deeply as the
 * run actually went. Free function so the rules that are easy to get wrong — forks staying at the
 * top level, orphans re-attaching, cycles not hanging — can be tested without a device.
 */
internal fun indexSubagents(
    listable: List<SessionRow>,
    sessionsById: Map<String, SessionRow>,
): Map<String, List<SessionRow>> {
    val listableIds = listable.mapTo(HashSet()) { it.sessionId }

    /**
     * The nearest ancestor that is actually on screen.
     *
     * Usually the immediate parent. The walk exists for the case that used to lose rows entirely:
     * archiving a session, or the harness reusing a blank one, removes it from the list while its
     * subagents remain — those attach to the next ancestor up rather than vanishing with it. The
     * visited set guards against a lineage cycle, which would otherwise hang the drawer.
     */
    fun attachPoint(child: SessionRow): String? {
        // Seeded with the child so a lineage cycle cannot walk back around and make the row its own
        // parent — which would nest it inside itself and render nothing at all.
        val visited = hashSetOf(child.sessionId)
        var cursor = child.parentSessionId
        while (cursor != null && visited.add(cursor)) {
            if (cursor in listableIds) return cursor
            cursor = sessionsById[cursor]?.parentSessionId
        }
        return null
    }

    return listable
        .filter { it.origin == "subagent" }
        .mapNotNull { child -> attachPoint(child)?.let { it to child } }
        .groupBy({ it.first }, { it.second })
}

/** Display title: an explicit title, else the working directory's folder, else the id. */
internal fun sessionTitle(session: SessionRow): String {
    val title = session.title?.takeIf { it.isNotBlank() }
    val folder = session.cwd?.takeIf { it.isNotBlank() }?.let { basename(it) }?.takeIf { it.isNotBlank() }
    return title ?: folder ?: session.sessionId
}
