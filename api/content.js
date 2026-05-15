// =============================================================================
// Content Management API - Multiplexed Vercel Serverless Function
// Single POST endpoint with action-based routing
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_STATUS_FILE = path.join(__dirname, '..', 'workspace-data', 'client-statuses.json');
const CLIENT_STATUS_ALLOWED = new Set(['ativo', 'onboarding', 'standby', 'arquivado', 'desativado']);

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

const HEADERS_RETURN = {
  ...HEADERS,
  Prefer: 'return=representation',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// =============================================================================
// Helpers
// =============================================================================

function ok(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function fail(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function supaSelect(table, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: HEADERS });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SELECT ${table} failed: ${err}`);
  }
  return res.json();
}

async function supaSelectAll(table, query = '', pageSize = 1000) {
  const rows = [];
  let offset = 0;
  while (true) {
    const sep = query ? '&' : '';
    const page = await supaSelect(table, `${query}${sep}limit=${pageSize}&offset=${offset}`);
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

async function supaInsert(table, record) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: HEADERS_RETURN,
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`INSERT ${table} failed: ${err}`);
  }
  return res.json();
}

async function supaUpdate(table, id, updates) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: HEADERS_RETURN,
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`UPDATE ${table} failed: ${err}`);
  }
  return res.json();
}

async function supaDelete(table, id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE',
    headers: HEADERS,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DELETE ${table} failed: ${err}`);
  }
}

function splitAssignees(value) {
  return String(value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function uniqueAssignees(value) {
  return [...new Set(splitAssignees(value))];
}

function sameAssignee(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function taskIsDone(status) {
  return ['publicado', 'publicado-st', 'aprovado', 'cancelado', 'nao-utilizado', 'complete', 'completed', 'cancelled'].includes(status);
}

function normalizeContentStatus(status) {
  return String(status == null ? '' : status)
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-');
}

function getSaoPauloTodayISO(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function safeJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value || {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function taskPostDate(task) {
  if (!task) return '';
  const publishConfig = safeJson(task.publish_config) || {};
  const raw = (publishConfig && (publishConfig.post_date || publishConfig.publish_date || publishConfig.scheduled_date))
    || '';
  const datePart = String(raw || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : '';
}

function readClientStatusStore() {
  try {
    if (!fs.existsSync(CLIENT_STATUS_FILE)) return { statuses: {}, updated_at: null, updated_by: null };
    const parsed = JSON.parse(fs.readFileSync(CLIENT_STATUS_FILE, 'utf8'));
    return {
      statuses: parsed && typeof parsed.statuses === 'object' && parsed.statuses ? parsed.statuses : {},
      updated_at: parsed?.updated_at || null,
      updated_by: parsed?.updated_by || null,
    };
  } catch (err) {
    console.error('[content] failed to read client statuses:', err.message || err);
    return { statuses: {}, updated_at: null, updated_by: null };
  }
}

function writeClientStatusStore(store) {
  fs.mkdirSync(path.dirname(CLIENT_STATUS_FILE), { recursive: true });
  const tmp = CLIENT_STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, CLIENT_STATUS_FILE);
}

async function logActivity(task_id, actor, action, details = null) {
  await supaInsert('content_activity', {
    task_id,
    actor,
    action,
    details: details ? JSON.stringify(details) : null,
    created_at: new Date().toISOString(),
  });
}

async function createTaskNotification({
  task,
  recipient,
  actor,
  event,
  title,
  message,
  channels = ['office'],
  metadata = {},
}) {
  if (!task || !recipient) return null;

  const now = new Date().toISOString();
  const record = {
    recipient,
    actor: actor || 'Sistema',
    event,
    source: 'content_tasks',
    task_id: task.id,
    task_name: task.name || title || 'Task',
    client_id: task.client_id || null,
    group_id: task.group_id || null,
    title: title || task.name || 'Nova task',
    message: message || '',
    channels: JSON.stringify(channels),
    metadata: JSON.stringify(metadata || {}),
    read_at: null,
    delivered_at: null,
    created_at: now,
    updated_at: now,
  };

  try {
    const inserted = await supaInsert('content_notifications', record);
    await supaInsert('content_notification_outbox', {
      notification_id: (Array.isArray(inserted) ? inserted[0] : inserted)?.id || null,
      recipient,
      channel: 'telegram',
      status: 'pending',
      payload: JSON.stringify({
        recipient,
        title: record.title,
        message: record.message,
        task_id: record.task_id,
        client_id: record.client_id,
      }),
      created_at: now,
      updated_at: now,
    }).catch(() => null);
    return inserted;
  } catch (err) {
    console.error('[content] notification failed:', err.message || err);
    return null;
  }
}

async function notifyAssignees(task, assignees, input) {
  const people = uniqueAssignees(assignees);
  if (!people.length) return;
  await Promise.all(people.map((recipient) => createTaskNotification({
    task,
    recipient,
    actor: input.actor || input.user,
    event: input.event,
    title: input.title,
    message: input.message,
    channels: input.channels || ['office', 'telegram'],
    metadata: input.metadata || {},
  })));
}

// =============================================================================
// Group Actions
// =============================================================================

async function listGroups({ client_id, archived, include_archived }) {
  if (!client_id) return fail('client_id is required');
  const showArchived = archived === true || archived === 'true' || archived === '1';
  const includeArchived = include_archived === true || include_archived === 'true' || include_archived === '1';
  const archivedFilter = includeArchived ? '' : `&archived=eq.${showArchived ? 'true' : 'false'}`;

  const groups = await supaSelect(
    'content_groups',
    `select=*&client_id=eq.${client_id}${archivedFilter}&order=position.asc`
  );

  const tasks = await supaSelect(
    'content_tasks',
    `select=id,group_id&client_id=eq.${client_id}`
  );

  const countMap = {};
  for (const t of tasks) {
    countMap[t.group_id] = (countMap[t.group_id] || 0) + 1;
  }

  const result = groups.map((g) => ({
    ...g,
    task_count: countMap[g.id] || 0,
  }));

  return ok(result);
}

async function upsertGroup({ id, client_id, name, position, user }) {
  if (!client_id || !name) return fail('client_id and name are required');
  if (!user) return fail('user is required');

  const now = new Date().toISOString();

  if (id) {
    const data = await supaUpdate('content_groups', id, {
      name,
      ...(position !== undefined && { position }),
      updated_at: now,
    });
    return ok(data);
  }

  const data = await supaInsert('content_groups', {
    client_id,
    name,
    position: position ?? 0,
    created_by: user,
    created_at: now,
    updated_at: now,
    archived: false,
  });
  return ok(data);
}

async function deleteGroup({ id, user }) {
  if (!id) return fail('id is required');
  if (!user) return fail('user is required');

  const data = await supaUpdate('content_groups', id, {
    archived: true,
    updated_at: new Date().toISOString(),
  });
  return ok(data);
}

async function restoreGroup({ id, user }) {
  if (!id) return fail('id is required');
  if (!user) return fail('user is required');

  const data = await supaUpdate('content_groups', id, {
    archived: false,
    updated_at: new Date().toISOString(),
  });
  return ok(data);
}

async function duplicateGroup({ source_group_id, target_client_id, new_name, user }) {
  if (!source_group_id) return fail('source_group_id is required');
  if (!target_client_id) return fail('target_client_id is required');
  if (!user) return fail('user is required');

  const now = new Date().toISOString();

  // Fetch source group
  const srcGroups = await supaSelect('content_groups', `select=*&id=eq.${source_group_id}`);
  if (!srcGroups.length) return fail('Source group not found', 404);
  const srcGroup = srcGroups[0];

  // Create new group
  const groupData = await supaInsert('content_groups', {
    client_id: target_client_id,
    name: new_name || srcGroup.name,
    position: 0,
    created_by: user,
    created_at: now,
    updated_at: now,
    archived: false,
  });
  const newGroupId = groupData[0]?.id || groupData.id;
  if (!newGroupId) return fail('Failed to create group');

  // Fetch all tasks from source group
  const allTasks = await supaSelect(
    'content_tasks',
    `select=*&group_id=eq.${source_group_id}&order=position.asc`
  );

  // Recursive copy: map old IDs to new IDs for parent_id references
  const idMap = {};
  let copiedCount = 0;

  // Sort: parents first (null parent_id), then children
  const sorted = allTasks.sort((a, b) => {
    if (!a.parent_id && b.parent_id) return -1;
    if (a.parent_id && !b.parent_id) return 1;
    return (a.position || 0) - (b.position || 0);
  });

  for (const task of sorted) {
    const newParentId = task.parent_id ? idMap[task.parent_id] : null;
    // Skip orphaned subtasks whose parent wasn't copied
    if (task.parent_id && !newParentId) continue;

    const record = {
      group_id: newGroupId,
      parent_id: newParentId || null,
      client_id: target_client_id,
      name: task.name,
      description: task.description || null,
      briefing: task.briefing || null,
      copy_text: task.copy_text || null,
      status: 'backlog',
      assignee: task.assignee || null,
      priority: task.priority || 'medium',
      due_date: null,
      position: task.position || 0,
      publish_config: null,
      created_by: user,
      created_at: now,
      updated_at: now,
    };

    const created = await supaInsert('content_tasks', record);
    const newId = created[0]?.id || created.id;
    if (newId) {
      idMap[task.id] = newId;
      copiedCount++;
    }
  }

  return ok({ group: groupData[0] || groupData, tasks_copied: copiedCount });
}

// =============================================================================
// Task Actions
// =============================================================================

async function listTasks({ group_id, client_id }) {
  if (!group_id && !client_id) return fail('group_id or client_id is required');

  const filter = group_id
    ? `group_id=eq.${group_id}`
    : `client_id=eq.${client_id}`;

  const tasks = await supaSelect(
    'content_tasks',
    `select=*&${filter}&order=position.asc`
  );

  const parentTasks = [];
  const childMap = {};

  for (const t of tasks) {
    if (t.parent_id) {
      if (!childMap[t.parent_id]) childMap[t.parent_id] = [];
      childMap[t.parent_id].push(t);
    } else {
      parentTasks.push(t);
    }
  }

  // Recursive nesting up to 5 levels
  function nestSubtasks(task, depth) {
    const children = childMap[task.id] || [];
    return {
      ...task,
      subtasks: depth < 5 ? children.map(c => nestSubtasks(c, depth + 1)) : children,
    };
  }

  const result = parentTasks.map(t => nestSubtasks(t, 0));

  return ok(result);
}

async function listMyTasks({ user, name, assignee }) {
  const targetName = user || name || assignee;
  if (!targetName) return fail('user is required');

  // Fetch open root tasks and filter in JS. This avoids fragile ilike.%...%
  // handling in the local Supabase-compatible server and keeps exact matching
  // for comma-separated assignee lists.
  const tasks = await supaSelect(
    'content_tasks',
    `select=*,content_groups!inner(id,name,client_id)&assignee=not.is.null&parent_id=is.null&order=due_date.asc.nullslast,created_at.desc`
  );

  const filtered = tasks.filter(task => {
    const assignees = splitAssignees(task.assignee);
    return assignees.some((item) => sameAssignee(item, targetName));
  });

  // Flatten with group/client info
  const result = filtered.map(t => ({
    ...t,
    group_name: t.content_groups?.name || '',
    client_id: t.content_groups?.client_id || '',
    group_id: t.content_groups?.id || t.group_id,
    content_groups: undefined,
  }));

  return ok(result);
}

async function listNotifications({ user, recipient, unread_only, limit }) {
  const target = user || recipient;
  if (!target) return fail('user is required');

  const cap = Math.min(parseInt(limit, 10) || 30, 100);
  const rows = await supaSelect(
    'content_notifications',
    `select=*&recipient=eq.${encodeURIComponent(target)}&order=created_at.desc&limit=${cap}`
  );

  const filtered = unread_only ? rows.filter((row) => !row.read_at) : rows;
  const result = filtered.map((row) => ({
    ...row,
    channels: typeof row.channels === 'string' ? safeJson(row.channels, []) : row.channels,
    metadata: typeof row.metadata === 'string' ? safeJson(row.metadata, {}) : row.metadata,
  }));
  return ok(result);
}

async function markNotificationRead({ id, user }) {
  if (!id) return fail('id is required');
  const rows = await supaUpdate('content_notifications', id, {
    read_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return ok({ success: true, notification: Array.isArray(rows) ? rows[0] : rows, user: user || null });
}

async function sendTimelineTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '';
  const chatId = process.env.TELEGRAM_OPERATIONAL_GROUP_ID || process.env.TELEGRAM_AGENTS_GROUP_ID || process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) return false;
  const chunks = String(text || '').match(/[\s\S]{1,3500}/g) || [];
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
  }
  return true;
}

async function notifyTimelineAnalysis({ recipients, title, message, user, metadata }) {
  const people = Array.isArray(recipients) ? recipients : String(recipients || '').split(',');
  const unique = [...new Set(people.map((name) => String(name || '').trim()).filter(Boolean))];
  if (!unique.length) return fail('recipients is required');
  const now = new Date().toISOString();
  const cleanTitle = title || 'Lurdinha · análise geral da timeline';
  const text = `${cleanTitle}
Para: ${unique.join(', ')}

${message || ''}`;
  let telegramSent = false;
  let telegramError = null;
  try {
    telegramSent = await sendTimelineTelegramMessage(text);
  } catch (err) {
    telegramError = err.message || String(err);
    console.error('[content] timeline telegram failed:', telegramError);
  }

  const rows = [];
  const dbErrors = [];
  for (const recipient of unique) {
    const record = {
      recipient,
      actor: user || 'Lurdinha',
      event: 'timeline_analysis',
      source: 'client_timeline',
      task_id: null,
      task_name: cleanTitle,
      client_id: null,
      group_id: null,
      title: cleanTitle,
      message: message || '',
      channels: JSON.stringify(['office', 'telegram']),
      metadata: JSON.stringify({ ...(metadata || {}), telegram_sent: telegramSent, telegram_error: telegramError }),
      read_at: null,
      delivered_at: telegramSent ? now : null,
      created_at: now,
      updated_at: now,
    };
    try {
      const inserted = await supaInsert('content_notifications', record);
      const notification = Array.isArray(inserted) ? inserted[0] : inserted;
      rows.push(notification || record);
      await supaInsert('content_notification_outbox', {
        notification_id: notification?.id || null,
        recipient,
        channel: 'telegram',
        status: telegramSent ? 'sent' : 'pending',
        payload: JSON.stringify({ recipient, title: record.title, message: record.message, metadata: metadata || {} }),
        created_at: now,
        updated_at: now,
      }).catch((err) => dbErrors.push(err.message || String(err)));
    } catch (err) {
      dbErrors.push(err.message || String(err));
    }
  }

  if (!rows.length && !telegramSent) {
    console.warn('[content] timeline notification stored only in response; notification tables or telegram env unavailable', dbErrors[0] || 'no provider');
  }
  return ok({
    success: true,
    recipients: unique,
    telegram_sent: telegramSent,
    telegram_error: telegramError,
    notifications_created: rows.length,
    notification_errors: dbErrors.slice(0, 3),
  });
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function taskOverview({ user, assignee }) {
  const target = user || assignee || null;
  const [contentRows, agentRows] = await Promise.all([
    supaSelect('content_tasks', 'select=id,name,status,assignee,created_at,updated_at,due_date,client_id,parent_id'),
    supaSelect('tasks', 'select=id,title,status,npc_id,assigner_id,assigner_npc_id,created_at,updated_at,due_at,completed_at').catch(() => []),
  ]);

  const content = contentRows
    .filter((task) => !task.parent_id)
    .filter((task) => !target || splitAssignees(task.assignee).some((item) => sameAssignee(item, target)));
  const agent = agentRows || [];

  function avgCompletion(rows, completedField, createdField) {
    const durations = rows
      .map((row) => {
        const start = new Date(row[createdField] || 0).getTime();
        const end = new Date(row[completedField] || 0).getTime();
        return start && end && end > start ? end - start : null;
      })
      .filter(Boolean);
    if (!durations.length) return null;
    return Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length / 60000);
  }

  const contentDone = content.filter((task) => taskIsDone(task.status));
  const agentDone = agent.filter((task) => taskIsDone(task.status));

  return ok({
    content: {
      total: content.length,
      open: content.filter((task) => !taskIsDone(task.status)).length,
      done: contentDone.length,
      by_status: countBy(content, 'status'),
    },
    agents: {
      total: agent.length,
      open: agent.filter((task) => !taskIsDone(task.status)).length,
      done: agentDone.length,
      by_status: countBy(agent, 'status'),
      avg_completion_minutes: avgCompletion(agentDone, 'completed_at', 'created_at'),
    },
  });
}

function countBy(rows, field) {
  return rows.reduce((acc, row) => {
    const key = row[field] || 'sem-status';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function getTask({ id }) {
  if (!id) return fail('id is required');

  const [tasks, comments, attachments, activity] = await Promise.all([
    supaSelect('content_tasks', `select=*&id=eq.${id}`),
    supaSelect('content_comments', `select=*&task_id=eq.${id}&order=created_at.desc`),
    supaSelect('content_attachments', `select=*&task_id=eq.${id}&order=created_at.desc`),
    supaSelect('content_activity', `select=*&task_id=eq.${id}&order=created_at.desc&limit=50`),
  ]);

  if (!tasks.length) return fail('Task not found', 404);

  return ok({
    ...tasks[0],
    comments,
    attachments,
    activity,
  });
}

async function upsertTask(params) {
  const {
    id, group_id, parent_id, client_id, name, description,
    briefing, copy_text, status, assignee, priority,
    due_date, position, publish_config, user,
  } = params;

  if (!user) return fail('user is required');
  const now = new Date().toISOString();

  if (id) {
    // Fetch current task for activity logging
    const existing = await supaSelect('content_tasks', `select=id,name,status,assignee,client_id,group_id&id=eq.${id}`);
    const oldTask = existing.length ? existing[0] : null;
    const oldStatus = oldTask ? oldTask.status : null;
    const oldAssignees = uniqueAssignees(oldTask?.assignee);

    const updates = {
      ...(group_id !== undefined && { group_id }),
      ...(parent_id !== undefined && { parent_id }),
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(briefing !== undefined && { briefing }),
      ...(copy_text !== undefined && { copy_text }),
      ...(status !== undefined && { status }),
      ...(assignee !== undefined && { assignee }),
      ...(priority !== undefined && { priority }),
      ...(due_date !== undefined && { due_date }),
      ...(position !== undefined && { position }),
      ...(publish_config !== undefined && { publish_config }),
      updated_at: now,
    };

    const data = await supaUpdate('content_tasks', id, updates);
    const updatedTask = Array.isArray(data) ? data[0] : data;

    if (status !== undefined && status !== oldStatus) {
      await logActivity(id, user, 'status_changed', {
        old_status: oldStatus,
        new_status: status,
      });
      await notifyAssignees(updatedTask, updatedTask.assignee, {
        user,
        event: 'task_status_changed',
        title: 'Status atualizado',
        message: `${user} alterou "${updatedTask.name}" de ${oldStatus || 'sem status'} para ${status}.`,
        metadata: { old_status: oldStatus, new_status: status },
      });
    }

    if (assignee !== undefined) {
      const newAssignees = uniqueAssignees(assignee);
      const added = newAssignees.filter((name) => !oldAssignees.some((old) => sameAssignee(old, name)));
      if (added.length) {
        await notifyAssignees(updatedTask, added, {
          user,
          event: 'task_assigned',
          title: 'Nova task atribuida',
          message: `${user} atribuiu "${updatedTask.name}" para voce.`,
          metadata: { old_assignee: oldTask?.assignee || null, new_assignee: assignee || null },
        });
      }
    }

    // Cascade priority to child tasks
    if (priority !== undefined) {
      const children = await supaSelect('content_tasks', `select=id&parent_id=eq.${id}`);
      if (children.length) {
        await Promise.all(children.map(c =>
          supaUpdate('content_tasks', c.id, { priority, updated_at: now })
        ));
      }
    }

    return ok(data);
  }

  if (!group_id || !client_id || !name) {
    return fail('group_id, client_id, and name are required for new tasks');
  }

  // Calculate next position (add to bottom)
  let nextPos = 0;
  if (position === undefined || position === null) {
    const existing = await supaSelect('content_tasks',
      `select=position&group_id=eq.${group_id}&parent_id=${parent_id ? 'eq.' + parent_id : 'is.null'}&order=position.desc&limit=1`
    );
    nextPos = existing.length ? (existing[0].position || 0) + 1 : 0;
  }

  const record = {
    group_id,
    parent_id: parent_id || null,
    client_id,
    name,
    description: description || null,
    briefing: briefing || null,
    copy_text: copy_text || null,
    status: status || 'backlog',
    assignee: assignee || null,
    priority: priority || 'medium',
    due_date: due_date || null,
    position: position ?? nextPos,
    publish_config: publish_config || null,
    created_by: user,
    created_at: now,
    updated_at: now,
  };

  const data = await supaInsert('content_tasks', record);

  if (data.length) {
    await logActivity(data[0].id, user, 'task_created', { name });
    await notifyAssignees(data[0], data[0].assignee, {
      user,
      event: 'task_created',
      title: 'Nova task criada',
      message: `${user} criou "${data[0].name}" para voce executar.`,
      metadata: { origin: 'manual' },
    });
  }

  return ok(data);
}

async function deleteTask({ id, user }) {
  if (!id) return fail('id is required');
  if (!user) return fail('user is required');

  // Delete subtasks recursively first (up to 5 levels), cleaning related data for each
  async function deleteChildren(parentId) {
    const children = await supaSelect('content_tasks', `select=id&parent_id=eq.${parentId}`);
    for (const child of children) {
      await deleteChildren(child.id);
      await deleteRelatedData(child.id);
      await supaDelete('content_tasks', child.id);
    }
  }

  async function deleteRelatedData(taskId) {
    const results = await Promise.allSettled([
      fetch(`${SUPABASE_URL}/rest/v1/content_comments?task_id=eq.${taskId}`, { method: 'DELETE', headers: HEADERS }),
      fetch(`${SUPABASE_URL}/rest/v1/content_attachments?task_id=eq.${taskId}`, { method: 'DELETE', headers: HEADERS }),
      fetch(`${SUPABASE_URL}/rest/v1/content_activity?task_id=eq.${taskId}`, { method: 'DELETE', headers: HEADERS }),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[deleteTask] Failed to delete related data[${i}] for task ${taskId}:`, r.reason);
      }
    });
  }

  await deleteChildren(id);
  await deleteRelatedData(id);
  await supaDelete('content_tasks', id);
  return ok({ deleted: true });
}

async function changeStatus({ id, status, user }) {
  if (!id || !status) return fail('id and status are required');
  if (!user) return fail('user is required');

  const existing = await supaSelect('content_tasks', `select=status&id=eq.${id}`);
  if (!existing.length) return fail('Task not found', 404);

  const oldStatus = existing[0].status;

  const now = new Date().toISOString();
  const patch = { status, updated_at: now };

  const data = await supaUpdate('content_tasks', id, patch);

  await logActivity(id, user, 'status_changed', {
    old_status: oldStatus,
    new_status: status,
  });

  return ok(data);
}

async function autoPublishOverdueScheduled({ dry_run = true, user = 'Sistema (auto)', today } = {}) {
  const todayISO = /^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))
    ? String(today)
    : getSaoPauloTodayISO();
  const shouldWrite = dry_run === false || dry_run === 'false' || dry_run === 0 || dry_run === '0';

  const candidates = await supaSelectAll(
    'content_tasks',
    'select=id,name,status,due_date,client_id,group_id,publish_config,updated_at&status=eq.agendado&order=due_date.asc.nullslast'
  );

  const overdue = candidates
    .map((task) => ({ ...task, post_date: taskPostDate(task) }))
    .filter((task) => normalizeContentStatus(task.status) === 'agendado' && task.post_date && task.post_date < todayISO);

  const summary = {
    dry_run: !shouldWrite,
    today: todayISO,
    scanned: candidates.length,
    matched: overdue.length,
    updated: 0,
    errors: [],
    examples: overdue.slice(0, 20).map((task) => ({
      id: task.id,
      name: task.name,
      client_id: task.client_id,
      due_date: task.due_date,
      post_date: task.post_date,
      status: task.status,
    })),
  };

  if (!shouldWrite || !overdue.length) return ok(summary);

  const now = new Date().toISOString();
  for (const task of overdue) {
    try {
      await supaUpdate('content_tasks', task.id, { status: 'publicado', updated_at: now });
      await logActivity(task.id, user, 'status_changed', {
        old_status: task.status,
        new_status: 'publicado',
        reason: 'auto_publish_overdue_scheduled',
        post_date: task.post_date,
        cutoff_date: todayISO,
      });
      summary.updated += 1;
    } catch (err) {
      summary.errors.push({
        id: task.id,
        name: task.name,
        error: err.message || String(err),
      });
    }
  }

  return ok(summary);
}

async function reorder({ items, user }) {
  if (!items || !Array.isArray(items)) return fail('items array is required');
  if (!user) return fail('user is required');

  const results = await Promise.all(
    items.map(({ id, position }) =>
      supaUpdate('content_tasks', id, { position, updated_at: new Date().toISOString() })
    )
  );

  return ok({ updated: results.length });
}

// =============================================================================
// Comment Actions
// =============================================================================

async function addComment({ task_id, body, user }) {
  if (!task_id || !body) return fail('task_id and body are required');
  if (!user) return fail('user is required');

  const data = await supaInsert('content_comments', {
    task_id,
    author: user,
    body,
    created_at: new Date().toISOString(),
  });

  await logActivity(task_id, user, 'comment_added', {
    preview: body.substring(0, 100),
  });

  return ok(data);
}

async function listComments({ task_id }) {
  if (!task_id) return fail('task_id is required');

  const data = await supaSelect(
    'content_comments',
    `select=*&task_id=eq.${task_id}&order=created_at.desc`
  );
  return ok(data);
}

// =============================================================================
// Attachment Actions
// =============================================================================

async function addAttachment({ task_id, file_name, file_url, file_type, file_size, category, format_type, user }) {
  if (!task_id || !file_name || !file_url) {
    return fail('task_id, file_name, and file_url are required');
  }
  if (!user) return fail('user is required');

  const data = await supaInsert('content_attachments', {
    task_id,
    file_name,
    file_url,
    file_type: file_type || null,
    file_size: file_size || null,
    category: category || null,
    format_type: format_type || 'feed',
    uploaded_by: user,
    created_at: new Date().toISOString(),
  });

  await logActivity(task_id, user, 'attachment_added', {
    file_name,
    category: category || null,
  });

  return ok(data);
}

async function deleteAttachment({ id, user }) {
  if (!id) return fail('id is required');
  if (!user) return fail('user is required');

  await supaDelete('content_attachments', id);
  return ok({ deleted: true });
}

async function listAttachments({ task_id }) {
  if (!task_id) return fail('task_id is required');

  const data = await supaSelect(
    'content_attachments',
    `select=*&task_id=eq.${task_id}&order=created_at.desc`
  );
  return ok(data);
}

async function listRecurringAttachments({ task_ids }) {
  if (!task_ids || !task_ids.length) return ok([]);
  const ids = (Array.isArray(task_ids) ? task_ids : task_ids.split(',')).map(id => id.trim()).filter(Boolean);
  if (!ids.length) return ok([]);
  const data = await supaSelect(
    'content_attachments',
    `select=task_id,file_url,file_type,category,created_at&task_id=in.(${ids.join(',')})&category=eq.recurring_story&order=created_at.asc`
  );
  return ok(data);
}

// =============================================================================
// Client Info Actions
// =============================================================================

async function getClientInfo({ client_slug }) {
  if (!client_slug) return fail('client_slug is required');

  const data = await supaSelect(
    'client_info',
    `select=*&client_slug=eq.${client_slug}&limit=1`
  );

  return ok(data.length ? data[0] : {});
}

async function saveClientInfo({
  client_slug, client_name, tone_of_voice, persona,
  keywords, forbidden_words, copy_examples, observations, user,
}) {
  if (!client_slug) return fail('client_slug is required');
  if (!user) return fail('user is required');

  const now = new Date().toISOString();

  const record = {
    client_slug,
    ...(client_name !== undefined && { client_name }),
    ...(tone_of_voice !== undefined && { tone_of_voice }),
    ...(persona !== undefined && { persona }),
    ...(keywords !== undefined && { keywords }),
    ...(forbidden_words !== undefined && { forbidden_words }),
    ...(copy_examples !== undefined && { copy_examples }),
    ...(observations !== undefined && { observations }),
    updated_at: now,
    updated_by: user,
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/client_info`, {
    method: 'POST',
    headers: {
      ...HEADERS_RETURN,
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(record),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`UPSERT client_info failed: ${err}`);
  }

  const data = await res.json();
  return ok({ success: true, data: data.length ? data[0] : data });
}

// =============================================================================
// Activity Actions
// =============================================================================

async function listActivity({ task_id, limit }) {
  if (!task_id) return fail('task_id is required');

  const cap = Math.min(limit || 50, 200);
  const data = await supaSelect(
    'content_activity',
    `select=*&task_id=eq.${task_id}&order=created_at.desc&limit=${cap}`
  );

  const parsed = data.map((row) => ({
    ...row,
    details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
  }));

  return ok(parsed);
}

// =============================================================================
// Admin - Create User
// =============================================================================

async function adminCreateUser({ user_name, password, user_role, avatar_color }) {
  if (!user_name || !password) return fail('user_name and password required');

  // Insert into admin_secrets (login credentials) - check if already exists first
  const secretLabel = `Login ${user_name}`;
  const existing = await supaSelect('admin_secrets', `label=eq.${encodeURIComponent(secretLabel)}&select=id`);
  if (!existing || existing.length === 0) {
    await supaInsert('admin_secrets', { label: secretLabel, value: password });
  }

  // Try inserting into users table with all possible column name combos
  const combos = [
    { name: user_name, role: user_role || 'designer', avatar_color: avatar_color || '#ec4899' },
    { user_name, user_role: user_role || 'designer', avatar_color: avatar_color || '#ec4899' },
    { name: user_name, role: user_role || 'designer', color: avatar_color || '#ec4899' },
  ];

  let userResult = null;
  let lastErr = null;
  for (const userData of combos) {
    try {
      userResult = await supaInsert('users', userData);
      break;
    } catch (e) {
      lastErr = e.message;
      continue;
    }
  }

  return ok({ success: true, user: userResult, usersError: lastErr, note: 'admin_secrets OK' });
}

async function adminSetLoginPassword({ user_name, password }) {
  if (!user_name || !password) return fail('user_name and password required');
  const secretLabel = `Login ${user_name}`;
  const existing = await supaSelect('admin_secrets', `select=id,label&label=eq.${encodeURIComponent(secretLabel)}&limit=1`);
  if (existing && existing.length) {
    let updated;
    try {
      updated = await supaUpdate('admin_secrets', existing[0].id, { value: password, updated_at: new Date().toISOString() });
    } catch (_) {
      updated = await supaUpdate('admin_secrets', existing[0].id, { value: password });
    }
    return ok({ success: true, action: 'updated', label: secretLabel, result: updated });
  }
  const inserted = await supaInsert('admin_secrets', { label: secretLabel, value: password });
  return ok({ success: true, action: 'created', label: secretLabel, result: inserted });
}

async function adminDisableLogin({ user_name }) {
  if (!user_name) return fail('user_name required');
  const disabledPassword = `DISABLED_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return adminSetLoginPassword({ user_name, password: disabledPassword });
}

async function adminUpdateUser({ user_name, user_role }) {
  if (!user_name || !user_role) return fail('user_name and user_role required');

  const combos = [
    { filter: `name=eq.${encodeURIComponent(user_name)}`, body: { role: user_role } },
    { filter: `user_name=eq.${encodeURIComponent(user_name)}`, body: { user_role } },
  ];

  let result = null;
  for (const c of combos) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/users?${c.filter}`, {
        method: 'PATCH',
        headers: HEADERS_RETURN,
        body: JSON.stringify(c.body),
      });
      const data = await res.json();
      if (!data.code) { result = data; break; }
    } catch(e) { continue; }
  }

  return ok({ success: true, updated: result });
}

function replaceAssigneeName(value, from, to) {
  const names = splitAssignees(value);
  if (!names.length) return null;
  const next = [];
  names.forEach((name) => {
    const replacement = sameAssignee(name, from) ? to : name;
    if (!next.some((item) => sameAssignee(item, replacement))) next.push(replacement);
  });
  return next.join(',') || null;
}

async function adminMigrateAssignee({ from, to, dry_run = true, active_only = true, user = 'Sistema' }) {
  if (!from || !to) return fail('from and to required');
  const shouldWrite = dry_run === false || dry_run === 'false' || dry_run === 0 || dry_run === '0';
  const onlyActive = !(active_only === false || active_only === 'false' || active_only === 0 || active_only === '0');
  const rows = await supaSelectAll(
    'content_tasks',
    'select=id,name,status,assignee,client_id,due_date,updated_at&assignee=not.is.null&order=updated_at.desc'
  );
  const matches = rows
    .filter((task) => splitAssignees(task.assignee).some((name) => sameAssignee(name, from)))
    .filter((task) => !onlyActive || !taskIsDone(normalizeContentStatus(task.status)))
    .map((task) => ({
      ...task,
      new_assignee: replaceAssigneeName(task.assignee, from, to),
    }));

  const summary = {
    dry_run: !shouldWrite,
    from,
    to,
    active_only: onlyActive,
    scanned: rows.length,
    matched: matches.length,
    updated: 0,
    errors: [],
    examples: matches.slice(0, 20).map((task) => ({
      id: task.id,
      name: task.name,
      client_id: task.client_id,
      status: task.status,
      assignee: task.assignee,
      new_assignee: task.new_assignee,
      due_date: task.due_date,
    })),
  };

  if (!shouldWrite || !matches.length) return ok(summary);

  for (const task of matches) {
    try {
      await supaUpdate('content_tasks', task.id, {
        assignee: task.new_assignee,
        updated_at: new Date().toISOString(),
      });
      await logActivity(task.id, user, 'assignee_changed', {
        old_assignee: task.assignee,
        new_assignee: task.new_assignee,
        reason: 'admin_migrate_assignee',
      });
      summary.updated += 1;
    } catch (err) {
      summary.errors.push({ id: task.id, name: task.name, error: err.message || String(err) });
    }
  }

  return ok(summary);
}

// =============================================================================
// Batch: Create Recurring Week (group + 7 day tasks + N story subtasks in one call)
// =============================================================================

async function createRecurringWeek({ client_id, group_name, position, stories_per_day, user }) {
  if (!client_id || !group_name) return fail('client_id and group_name are required');
  if (!user) return fail('user is required');
  const now = new Date().toISOString();
  const count = Math.max(1, Math.min(20, parseInt(stories_per_day) || 1));

  const DAYS = ['Segunda-Feira','Terça-Feira','Quarta-Feira','Quinta-Feira','Sexta-Feira','Sábado','Domingo'];

  // 1. Create group
  const grpData = await supaInsert('content_groups', {
    client_id, name: group_name,
    position: position ?? 9000,
    created_by: user, created_at: now, updated_at: now, archived: false,
  });
  const grpId = (Array.isArray(grpData) ? grpData[0] : grpData).id;
  if (!grpId) throw new Error('Failed to create group');

  // 2. Create all 7 day tasks in parallel
  const dayPromises = DAYS.map((dayName, di) =>
    supaInsert('content_tasks', {
      group_id: grpId, parent_id: null, client_id,
      name: dayName, status: 'backlog', priority: 'normal',
      position: di, created_by: user, created_at: now, updated_at: now,
    })
  );
  const dayResults = await Promise.all(dayPromises);
  const dayIds = dayResults.map(r => (Array.isArray(r) ? r[0] : r).id);

  // 3. Create all story subtasks in parallel (all days at once)
  const storyPromises = [];
  dayIds.forEach((dayId, di) => {
    for (let s = 0; s < count; s++) {
      storyPromises.push(supaInsert('content_tasks', {
        group_id: grpId, parent_id: dayId, client_id,
        name: 'STORIES ' + (s + 1), status: 'backlog', priority: 'normal',
        position: s, created_by: user, created_at: now, updated_at: now,
      }));
    }
  });
  await Promise.all(storyPromises);

  return ok({ success: true, group_id: grpId, group_name });
}

// =============================================================================
// Client Statuses (central store for sidebar workflow/archive state)
// =============================================================================

async function getClientStatuses() {
  const store = readClientStatusStore();
  return ok({
    success: true,
    statuses: store.statuses || {},
    updated_at: store.updated_at || null,
    updated_by: store.updated_by || null,
  });
}

async function setClientStatus({ client_key, status, user }) {
  const clientKey = String(client_key || '').trim();
  const nextStatus = String(status || '').trim();
  if (!clientKey) return fail('client_key is required');
  if (!CLIENT_STATUS_ALLOWED.has(nextStatus)) return fail('status inválido');

  const store = readClientStatusStore();
  const statuses = store.statuses && typeof store.statuses === 'object' ? store.statuses : {};
  if (nextStatus === 'ativo') {
    delete statuses[clientKey];
  } else {
    statuses[clientKey] = nextStatus;
  }

  const now = new Date().toISOString();
  const nextStore = {
    statuses,
    updated_at: now,
    updated_by: user || 'Sistema',
  };
  writeClientStatusStore(nextStore);

  return ok({
    success: true,
    client_key: clientKey,
    status: nextStatus,
    statuses,
    updated_at: now,
    updated_by: nextStore.updated_by,
  });
}

// =============================================================================
// Dashboard Proxy Actions (service-role reads for dashboard sections)
// =============================================================================

const QUERY_ALLOWED_TABLES = new Set([
  'content_tasks', 'content_groups', 'content_attachments',
  'content_notifications', 'content_notification_outbox',
  'cronograma_status', 'publish_history', 'publish_queue',
  'tasks',
]);

async function queryProxy({ table, select = '*', filters, order, limit }) {
  if (!table || !QUERY_ALLOWED_TABLES.has(table)) return fail('Table not allowed: ' + table);
  let qs = 'select=' + encodeURIComponent(select);
  const filterArr = Array.isArray(filters) ? filters : [];
  filterArr.forEach((f) => { qs += '&' + f; });
  if (order) qs += '&order=' + order;
  if (limit) qs += '&limit=' + limit;
  const data = await supaSelect(table, qs);
  return ok(data);
}

async function deleteCronogramaPeriod({ period_key }) {
  if (!period_key) return fail('period_key required');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cronograma_status?period_key=eq.${encodeURIComponent(period_key)}`, {
    method: 'DELETE',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DELETE cronograma_status failed: ${err}`);
  }
  return ok({ success: true });
}

async function upsertCronograma({ payload }) {
  if (!payload || !payload.id) return fail('payload.id required');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cronograma_status?on_conflict=id`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`UPSERT cronograma_status failed: ${err}`);
  }
  return ok({ success: true });
}

// =============================================================================
// Action Router
// =============================================================================

const ACTIONS = {
  // Groups
  list_groups: listGroups,
  upsert_group: upsertGroup,
  delete_group: deleteGroup,
  restore_group: restoreGroup,
  duplicate_group: duplicateGroup,
  // Tasks
  list_tasks: listTasks,
  list_my_tasks: listMyTasks,
  list_notifications: listNotifications,
  mark_notification_read: markNotificationRead,
  notify_timeline_analysis: notifyTimelineAnalysis,
  task_overview: taskOverview,
  get_task: getTask,
  upsert_task: upsertTask,
  delete_task: deleteTask,
  change_status: changeStatus,
  auto_publish_overdue_scheduled: autoPublishOverdueScheduled,
  reorder,
  // Comments
  add_comment: addComment,
  list_comments: listComments,
  // Attachments
  add_attachment: addAttachment,
  delete_attachment: deleteAttachment,
  list_attachments: listAttachments,
  list_recurring_attachments: listRecurringAttachments,
  // Activity
  list_activity: listActivity,
  // Client Info
  get_client_info: getClientInfo,
  save_client_info: saveClientInfo,
  get_client_statuses: getClientStatuses,
  set_client_status: setClientStatus,
  // Admin
  admin_create_user: adminCreateUser,
  admin_update_user: adminUpdateUser,
  admin_set_login_password: adminSetLoginPassword,
  admin_disable_login: adminDisableLogin,
  admin_migrate_assignee: adminMigrateAssignee,
  // Batch
  create_recurring_week: createRecurringWeek,
  // Dashboard proxy (service-role reads + upserts)
  query: queryProxy,
  upsert_cronograma: upsertCronograma,
  delete_cronograma_period: deleteCronogramaPeriod,
};

// =============================================================================
// Main Handler
// =============================================================================

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Validate required environment variables at boot
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[content] FATAL: SUPABASE_URL or SUPABASE_SERVICE_KEY env var is missing');
    return res.status(500).json({ error: 'Configuração do servidor incompleta. Variáveis de ambiente SUPABASE_URL e/ou SUPABASE_SERVICE_KEY não definidas.' });
  }

  let action, params;

  if (req.method === 'GET') {
    const q = req.query || {};
    action = q.action;
    params = { ...q };
    delete params.action;
  } else if (req.method === 'POST') {
    const body = req.body || {};
    action = body.action;
    params = { ...body };
    delete params.action;
  } else {
    return res.status(405).json({ error: 'Use GET ou POST' });
  }

  if (!action) return res.status(400).json({ error: 'Campo "action" obrigatório' });

  const handler_fn = ACTIONS[action];
  if (!handler_fn) return res.status(400).json({ error: `Action desconhecida: ${action}` });

  try {
    const response = await handler_fn(params);
    // Response is a Web Response object — extract body and status
    const body = await response.json();
    return res.status(response.status).json(body);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro interno' });
  }
};
