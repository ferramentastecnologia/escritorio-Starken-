/**
 * /api/meta/publish — Publicar/agendar post + Histórico centralizado
 *
 * GET  — Retorna histórico de publicações (Supabase: publish_history)
 *   ?limit=50  — número de registros (default 50)
 *   ?client=   — filtrar por client_key
 *   ?status=   — filtrar por PUBLISHED | SCHEDULED
 *
 * POST — Publica ou agenda post no IG/FB e salva no histórico
 *   { destination, client, caption, type, image_url, scheduled_publish_time, user }
 */

const { graphPost, graphPostForm, graphDelete, verifyMediaUrl } = require('./_lib/graph');
const { validateTenant } = require('./_lib/tenants');

// ─── Supabase helpers ───
const SUPABASE_URL = () => process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.SUPABASE_SERVICE_KEY || '';

function supabaseHeaders() {
  const key = SUPABASE_KEY();
  return { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };
}

// Encodes image URLs for publish_history: single URL stays as string,
// multiple URLs (carousel) stored as JSON array string for full recovery on retry.
function encodeImageUrl(urls) {
  if (!urls || urls.length === 0) return null;
  if (urls.length === 1) return urls[0];
  return JSON.stringify(urls);
}

const FB_SCHEDULE_MIN_LEAD_SECONDS = 15 * 60;

function facebookScheduleValidation(scheduledPublishTime) {
  if (!scheduledPublishTime) return null;
  const ts = Number(scheduledPublishTime);
  if (!Number.isFinite(ts)) {
    return {
      error: true,
      code: 'INVALID_SCHEDULE_TIME',
      message: 'Data e hora de agendamento inválidas para Facebook.',
    };
  }
  const earliest = Math.ceil(Date.now() / 1000) + FB_SCHEDULE_MIN_LEAD_SECONDS;
  if (ts < earliest) {
    return {
      error: true,
      code: 'FACEBOOK_SCHEDULE_TOO_SOON',
      message: 'Facebook precisa de pelo menos 15 minutos de antecedência para agendar com segurança.',
    };
  }
  return null;
}

// ─── Queue helpers ───
async function saveToQueue(record) {
  const url = SUPABASE_URL();
  if (!url) throw new Error('Supabase não configurado');
  const res = await fetch(`${url}/rest/v1/publish_queue`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify(record),
  });
  if (!res.ok) throw new Error('Erro ao salvar na fila: ' + await res.text());
  const data = await res.json();
  return data[0] || data;
}

async function processPublishQueue() {
  const url = SUPABASE_URL();
  if (!url) return { processed: 0 };

  const now = new Date().toISOString();

  // Auto-mark FB SCHEDULED posts as PUBLISHED when their scheduled time has passed
  // (FB handles scheduling natively via API, so we just update our history)
  await fetch(`${url}/rest/v1/publish_history?status=eq.SCHEDULED&platform=eq.fb&scheduled_for=lte.${now}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify({ status: 'PUBLISHED', published_at: now }),
  });

  // Reset items stuck in PROCESSING for more than 5 minutes (function timeout recovery)
  const stuckCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await fetch(`${url}/rest/v1/publish_queue?status=eq.PROCESSING&updated_at=lte.${stuckCutoff}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify({ status: 'QUEUED' }),
  });

  // Busca posts QUEUED que já passaram da hora
  const queueRes = await fetch(
    `${url}/rest/v1/publish_queue?status=eq.QUEUED&scheduled_for=lte.${now}&order=scheduled_for.asc&limit=10`,
    { headers: { 'apikey': SUPABASE_KEY(), 'Authorization': `Bearer ${SUPABASE_KEY()}` } }
  );
  if (!queueRes.ok) return { processed: 0, error: 'Queue fetch failed' };
  const items = await queueRes.json();
  if (items.length === 0) return { processed: 0 };

  const { getClient } = require('./_lib/tenants');
  const results = [];

  for (const item of items) {
    // ─── ATOMIC CLAIM: only update if status is still QUEUED ───
    // This prevents race condition when pg_cron + frontend both call processPublishQueue simultaneously
    const claimRes = await fetch(`${url}/rest/v1/publish_queue?id=eq.${item.id}&status=eq.QUEUED`, {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
      body: JSON.stringify({ status: 'PROCESSING', updated_at: new Date().toISOString() }),
    });
    const claimed = await claimRes.json();
    // If nothing was updated, another process already claimed this item — skip it
    if (!claimed || claimed.length === 0) {
      console.log('[publish_queue] Item', item.id, 'already claimed by another process, skipping.');
      continue;
    }

    try {
      const client = await getClient(item.client_key);
      if (!client) throw new Error('Cliente não encontrado: ' + item.client_key);

      const igToken = client.pageAccessToken || process.env.META_ACCESS_TOKEN;
      const imageUrls = item.image_urls || [];
      let publishedId;

      if (item.platform === 'ig') {
        if (!client.igUserId) {
          throw new Error('igUserId não configurado para o cliente "' + item.client_key + '". Configure o Instagram User ID nas definições Meta.');
        }

        // Helper: wait for container (extended timeout for videos: 60 polls × 3s = 180s)
        const isCrossPost = item.media_type === 'STORIES_CROSSPOST'; // IG story + cross-post to FB page
        const isStoryItem = item.post_type === 'story' || item.media_type === 'STORIES' || isCrossPost;
        const isVideoItem = item.media_type === 'REELS' || item.media_type === 'VIDEO' || /\.(mp4|mov|avi|webm|mkv|m4v)(\?|$)/i.test(imageUrls[0] || '');
        const maxPolls = isVideoItem ? 60 : 15;
        const pollDelay = isVideoItem ? 3000 : 2000;

        async function waitIG(cid) {
          for (let i = 0; i < maxPolls; i++) {
            await new Promise(r => setTimeout(r, pollDelay));
            const ck = await fetch(`https://graph.facebook.com/v25.0/${cid}?fields=status_code,status&access_token=${igToken}`);
            const st = await ck.json();
            if (st.status_code === 'FINISHED') return;
            if (st.status_code === 'ERROR') {
              throw new Error('IG processing error: ' + (st.status || 'container failed'));
            }
          }
          throw new Error('IG container timeout após ' + Math.round(maxPolls * pollDelay / 1000) + 's');
        }

        // Verify media URLs are accessible before sending to Meta
        for (const mediaUrl of imageUrls) {
          await verifyMediaUrl(mediaUrl);
        }

        if (imageUrls.length > 1) {
          // Carousel
          const childIds = [];
          for (const imgUrl of imageUrls) {
            const ir = await graphPost(`/${client.igUserId}/media`, { image_url: imgUrl, is_carousel_item: true, access_token: igToken });
            childIds.push(ir.id);
          }
          for (const cid of childIds) await waitIG(cid);
          const cr = await graphPost(`/${client.igUserId}/media`, { media_type: 'CAROUSEL', children: childIds.join(','), caption: item.caption || '', access_token: igToken });
          await waitIG(cr.id);
          const pr = await graphPost(`/${client.igUserId}/media_publish`, { creation_id: cr.id, access_token: igToken });
          publishedId = pr.id;
        } else if (imageUrls.length === 1) {
          // Check if it's a video/reels (by URL extension or media_type flag)
          const isVideo = isVideoItem;
          if (isVideo) {
            const videoBody = {
              video_url: imageUrls[0],
              caption: item.caption || '',
              media_type: (item.media_type === 'REELS') ? 'REELS' : 'VIDEO',
              access_token: igToken,
            };
            const mr = await graphPost(`/${client.igUserId}/media`, videoBody, { videoMode: true });
            await waitIG(mr.id);
            const pr = await graphPost(`/${client.igUserId}/media_publish`, { creation_id: mr.id, access_token: igToken }, { videoMode: true });
            publishedId = pr.id;
          } else {
            const igContainerBody = { image_url: imageUrls[0], caption: item.caption || '', access_token: igToken };
            if (isStoryItem) igContainerBody.media_type = 'STORIES';
            // Cross-post IG story to FB page via fb_page_id (avoids photo_stories API restriction on non-Professional pages)
            if (isCrossPost && client.pageId) {
              igContainerBody.fb_page_id = client.pageId;
            }
            const mr = await graphPost(`/${client.igUserId}/media`, igContainerBody);
            await waitIG(mr.id);
            const pr = await graphPost(`/${client.igUserId}/media_publish`, { creation_id: mr.id, access_token: igToken });
            publishedId = pr.id;
          }
        }
      } else if (item.platform === 'fb') {
        const isFbStory = item.post_type === 'story' || item.media_type === 'STORIES';
        // FB Story: try photo_stories, fall back to regular photo
        if (isFbStory && imageUrls.length >= 1) {
          const storyUrl = `https://graph.facebook.com/v25.0/${client.pageId}/photo_stories?access_token=${encodeURIComponent(igToken)}`;
          const sp = new URLSearchParams();
          sp.append('url', imageUrls[0]);
          const storyRes = await fetch(storyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: sp.toString(),
          });
          const storyData = await storyRes.json();
          if (!storyRes.ok || storyData.error) {
            console.warn('[queue/fb] photo_stories fallback to /photos:', storyData.error && storyData.error.message);
            const fallback = await graphPost(`/${client.pageId}/photos`, { url: imageUrls[0], caption: item.caption || '', access_token: igToken });
            publishedId = fallback.id || fallback.post_id;
          } else {
            publishedId = storyData.id;
          }
        } else if (imageUrls.length > 1) {
          const photoIds = [];
          for (const imgUrl of imageUrls) {
            const pr = await graphPost(`/${client.pageId}/photos`, { url: imgUrl, published: false, access_token: igToken });
            photoIds.push(pr.id);
          }
          const body = { message: item.caption || '', access_token: igToken };
          photoIds.forEach((pid, i) => { body[`attached_media[${i}]`] = JSON.stringify({ media_fbid: pid }); });
          const postRes = await graphPostForm(`/${client.pageId}/feed`, body);
          publishedId = postRes.id;
        } else if (imageUrls.length === 1) {
          const pr = await graphPost(`/${client.pageId}/photos`, { url: imageUrls[0], caption: item.caption || '', access_token: igToken });
          publishedId = pr.id;
        } else {
          const pr = await graphPost(`/${client.pageId}/feed`, { message: item.caption || '', access_token: igToken });
          publishedId = pr.id;
        }
      }

      // Mark as PUBLISHED
      await fetch(`${url}/rest/v1/publish_queue?id=eq.${item.id}`, {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({ status: 'PUBLISHED', post_id: publishedId, processed_at: new Date().toISOString() }),
      });

      // Save to history with published_at timestamp
      const publishedAt = new Date().toISOString();
      await saveToHistory({
        user_name: item.user_name || 'Cron',
        client_key: item.client_key,
        client_name: item.client_name,
        platform: item.platform,
        status: 'PUBLISHED',
        post_id: publishedId,
        caption: item.caption || '',
        has_image: imageUrls.length > 0,
        image_url: encodeImageUrl(imageUrls),
        scheduled_for: item.scheduled_for,
        published_at: publishedAt,
      });

      // Auto-update task status to 'publicado' if task_id is present
      let taskStatusUpdateFailed = false;
      if (item.task_id) {
        try {
          const patchRes = await fetch(`${url}/rest/v1/content_tasks?id=eq.${item.task_id}`, {
            method: 'PATCH',
            headers: supabaseHeaders(),
            body: JSON.stringify({
              status: 'publicado',
              updated_at: publishedAt,
            }),
          });
          if (!patchRes.ok) throw new Error('HTTP ' + patchRes.status);

          // Update publish_config entries in the task
          const taskRes = await fetch(`${url}/rest/v1/content_tasks?id=eq.${item.task_id}&select=publish_config`, {
            headers: { 'apikey': SUPABASE_KEY(), 'Authorization': `Bearer ${SUPABASE_KEY()}` },
          });
          if (taskRes.ok) {
            const taskRows = await taskRes.json();
            if (taskRows.length > 0 && taskRows[0].publish_config) {
              const pc = taskRows[0].publish_config;
              let updated = false;
              // Update matching entries in format configs and legacy entries
              const updateEntries = (entries) => {
                if (!entries) return;
                entries.forEach(e => {
                  if (e.post_id === item.id && e.status === 'scheduled') {
                    e.status = 'published';
                    e.published_at = publishedAt;
                    e.post_id = publishedId;
                    updated = true;
                  }
                });
              };
              updateEntries(pc.entries);
              // Check format-specific entries (feed, story, carrossel, reels)
              ['feed', 'story', 'carrossel', 'reels'].forEach(f => {
                if (pc[f] && pc[f].entries) updateEntries(pc[f].entries);
              });
              if (updated) {
                await fetch(`${url}/rest/v1/content_tasks?id=eq.${item.task_id}`, {
                  method: 'PATCH',
                  headers: supabaseHeaders(),
                  body: JSON.stringify({ publish_config: pc }),
                });
              }
            }
          }
        } catch (e) {
          console.error('[publish_queue] Failed to update task status for task', item.task_id, ':', e.message);
          taskStatusUpdateFailed = true;
        }
      }

      results.push({
        id: item.id,
        status: 'PUBLISHED',
        post_id: publishedId,
        task_id: item.task_id || null,
        task_status_update_failed: taskStatusUpdateFailed,
        client_name: item.client_name || null,
      });
    } catch (err) {
      // Build detailed error message
      let errorDetail = err.message || 'Erro desconhecido';

      if (err.meta_code === 190 || err.code === 'TOKEN_EXPIRED') {
        errorDetail = 'Token de acesso expirado. Reconecte a conta Meta nas configurações.';
      } else if (err.meta_code === 389 || (err.message && err.message.includes('389'))) {
        errorDetail = 'Meta não conseguiu baixar a mídia (erro 389). URL: ' + (imageUrls[0] || 'N/A');
      } else if (err.code === 'MEDIA_URL_INACCESSIBLE') {
        errorDetail = 'URL da mídia inacessível (bucket privado?): ' + (imageUrls[0] || 'N/A');
      } else if (err.message && err.message.includes('igUserId')) {
        errorDetail = 'Instagram User ID não configurado para o cliente "' + item.client_key + '". Configure nas definições Meta.';
      } else if (err.message && err.message.includes('CLIENT_NOT_CONFIGURED')) {
        errorDetail = 'Cliente "' + item.client_key + '" não encontrado na configuração Meta.';
      } else if (err.message && err.message.includes('timeout')) {
        errorDetail = 'Tempo limite atingido ao processar mídia no Instagram. Tente publicar novamente.';
      } else if (err.meta_code) {
        errorDetail = 'Erro Meta API ' + err.meta_code + ': ' + (err.message || 'Erro desconhecido');
      }

      console.error('[publish_queue] FAILED item', item.id, 'client:', item.client_key, 'platform:', item.platform, '| error:', errorDetail);

      // Mark as FAILED in queue
      await fetch(`${url}/rest/v1/publish_queue?id=eq.${item.id}`, {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({ status: 'FAILED', error_message: errorDetail, processed_at: new Date().toISOString() }),
      });

      // Save FAILED entry to history so user sees it
      await saveToHistory({
        user_name: item.user_name || 'Cron',
        client_key: item.client_key,
        client_name: item.client_name,
        platform: item.platform,
        status: 'FAILED',
        caption: item.caption || '',
        has_image: (item.image_urls || []).length > 0,
        image_url: encodeImageUrl(item.image_urls || []),
        scheduled_for: item.scheduled_for,
        error_message: errorDetail,
        ...(item.task_id && { task_id: item.task_id }),
      });

      results.push({ id: item.id, status: 'FAILED', error: errorDetail });
    }
  }

  return { processed: results.length, results };
}

async function saveToHistory(record) {
  const url = SUPABASE_URL();
  if (!url) return; // Silently skip if no Supabase
  try {
    await fetch(`${url}/rest/v1/publish_history`, {
      method: 'POST',
      headers: supabaseHeaders(),
      body: JSON.stringify(record),
    });
  } catch (e) {
    console.warn('History save failed:', e.message);
  }
}

async function loadHistory(query) {
  const url = SUPABASE_URL();
  if (!url) return [];
  try {
    const limit = query.limit || 50;
    let endpoint = `${url}/rest/v1/publish_history?select=*&order=created_at.desc&limit=${limit}`;
    if (query.client) endpoint += `&client_key=eq.${query.client}`;
    if (query.status) endpoint += `&status=eq.${query.status}`;

    const res = await fetch(endpoint, {
      headers: { 'apikey': SUPABASE_KEY(), 'Authorization': `Bearer ${SUPABASE_KEY()}` },
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Validate required environment variables
  if (!SUPABASE_URL() || !SUPABASE_KEY()) {
    console.error('[publish] FATAL: SUPABASE_URL or SUPABASE_SERVICE_KEY env var is missing');
    return res.status(500).json({ error: 'Configuração do servidor incompleta. Variáveis de ambiente SUPABASE_URL e/ou SUPABASE_SERVICE_KEY não definidas.' });
  }

  // ─── GET: Histórico ou Cron de publicação ───
  if (req.method === 'GET') {
    // CRON: processar fila de agendamentos
    if (req.query.cron === 'process') {
      try {
        const result = await processPublishQueue();
        return res.status(200).json(result);
      } catch (err) {
        return res.status(500).json({ error: true, message: err.message });
      }
    }
    // Histórico normal
    const history = await loadHistory(req.query || {});
    return res.status(200).json({ history, count: history.length });
  }

  // ─── DELETE: Cancelar/excluir post do Meta ───
  if (req.method === 'DELETE') {
    const { post_id, history_id, client, user } = req.body || {};

    if (!post_id) {
      return res.status(400).json({ error: true, code: 'MISSING_PARAM', message: 'post_id é obrigatório' });
    }

    try {
      // Tenta pegar page access token do cliente (se informado)
      let pageToken = null;
      if (client) {
        try {
          const { getClient } = require('./_lib/tenants');
          const clientData = await getClient(client);
          if (clientData) pageToken = clientData.pageAccessToken;
        } catch (e) { /* usa token global */ }
      }

      // 1. Tenta cancelar na publish_queue (agendamentos IG/FB pendentes)
      let queueCancelled = false;
      const url = SUPABASE_URL();
      if (url) {
        // post_id pode ser o queue_id para agendamentos IG
        const queueCheck = await fetch(
          `${url}/rest/v1/publish_queue?id=eq.${post_id}&status=in.(QUEUED,PROCESSING)&select=id,status`,
          { headers: { 'apikey': SUPABASE_KEY(), 'Authorization': `Bearer ${SUPABASE_KEY()}` } }
        );
        if (queueCheck.ok) {
          const queueItems = await queueCheck.json();
          if (queueItems.length > 0) {
            await fetch(`${url}/rest/v1/publish_queue?id=eq.${post_id}`, {
              method: 'PATCH',
              headers: supabaseHeaders(),
              body: JSON.stringify({ status: 'CANCELLED', processed_at: new Date().toISOString() }),
            });
            queueCancelled = true;
          }
        }
      }

      // 2. Tenta deletar do Meta Graph API (FB scheduled/published posts)
      let metaDeleted = false;
      let metaError = null;
      if (!queueCancelled) {
        try {
          const deleteParams = {};
          if (pageToken) deleteParams.access_token = pageToken;
          await graphDelete(`/${post_id}`, deleteParams);
          metaDeleted = true;
        } catch (delErr) {
          // IG posts geralmente não podem ser deletados via API
          metaError = delErr.message || 'Não foi possível excluir do Meta';
        }
      }

      // 3. Atualiza status no histórico (Supabase)
      if (history_id && url) {
        await fetch(`${url}/rest/v1/publish_history?id=eq.${history_id}`, {
          method: 'PATCH',
          headers: { ...supabaseHeaders(), 'Prefer': 'return=minimal' },
          body: JSON.stringify({ status: 'DELETED' }),
        });
      }

      return res.status(200).json({
        ok: true,
        deleted: post_id,
        meta_deleted: metaDeleted,
        queue_cancelled: queueCancelled,
        message: queueCancelled
          ? 'Agendamento cancelado com sucesso! O post não será publicado.'
          : metaDeleted
            ? 'Post excluído/cancelado com sucesso no Meta'
            : 'Removido do histórico. ' + (metaError || 'Exclua manualmente no Meta Business Suite para posts do Instagram.'),
      });
    } catch (err) {
      if (err.error) return res.status(err.status || 502).json(err);
      return res.status(500).json({ error: true, code: 'DELETE_ERROR', message: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: true, code: 'METHOD_NOT_ALLOWED', message: 'Use GET, POST ou DELETE' });
  }

  // ─── MARK AS PUBLISHED: marcar entrada FAILED como publicado manualmente ───
  if (req.body && req.body.action === 'mark_published') {
    try {
      const { history_id, user_name } = req.body;
      if (!history_id) return res.status(400).json({ error: true, message: 'history_id é obrigatório' });
      const url = SUPABASE_URL();
      await fetch(`${url}/rest/v1/publish_history?id=eq.${history_id}`, {
        method: 'PATCH',
        headers: supabaseHeaders(),
        body: JSON.stringify({ status: 'PUBLISHED', published_at: new Date().toISOString(), user_name: user_name || 'Manual' }),
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: true, message: err.message });
    }
  }

  // ─── QUEUE: Agendar para publicação futura ───
  if (req.body && req.body.action === 'queue') {
    try {
      const { client_key, client_name, platform, caption, image_urls, post_type, media_type, scheduled_for, user_name, task_id } = req.body;
      if (!client_key || !platform || !scheduled_for) {
        return res.status(400).json({ error: true, message: 'client_key, platform e scheduled_for são obrigatórios' });
      }
      const queued = await saveToQueue({
        client_key, client_name: client_name || client_key, platform,
        caption: caption || '', image_urls: image_urls || [],
        post_type: post_type || 'feed',
        media_type: media_type || (post_type === 'story' ? 'STORIES' : post_type === 'reels' ? 'REELS' : null),
        scheduled_for,
        user_name: user_name || 'Sistema', status: 'QUEUED',
      });

      // Also save to history as SCHEDULED
      await saveToHistory({
        user_name: user_name || 'Sistema', client_key, client_name: client_name || client_key,
        platform, status: 'SCHEDULED', post_id: queued.id,
        caption: caption || '', has_image: (image_urls || []).length > 0,
        image_url: encodeImageUrl(image_urls || []),
        scheduled_for, ...(task_id && { task_id }),
      });

      return res.status(201).json({ ok: true, queue_id: queued.id, status: 'SCHEDULED', scheduled_for });
    } catch (err) {
      return res.status(500).json({ error: true, message: err.message });
    }
  }

  const tenant = await validateTenant(req, res);
  if (!tenant) return;

  const { destination, caption, type, container_id, photo_ids, scheduled_publish_time, image_url, video_url, media_type, user, task_id } = req.body || {};

  if (!destination || !['ig', 'fb'].includes(destination)) {
    return res.status(400).json({ error: true, code: 'MISSING_PARAM', message: 'destination deve ser "ig" ou "fb"' });
  }

  if (destination === 'fb') {
    const scheduleError = facebookScheduleValidation(scheduled_publish_time);
    if (scheduleError) return res.status(400).json(scheduleError);
  }

  try {
    // ─── INSTAGRAM ───
    if (destination === 'ig') {
      if (!tenant.igUserId) {
        return res.status(400).json({
          error: true, code: 'MISSING_PARAM',
          message: `IG User ID não configurado para "${tenant.name || tenant.key}".`,
        });
      }

      const igToken = tenant.pageAccessToken || undefined;
      const image_urls = req.body.image_urls || [];
      let publishedId;

      // Helper: wait for IG container to be ready (polls status)
      // Videos get extended timeout (180s vs 30s for images)
      async function waitForContainer(containerId, maxWait) {
        if (!maxWait) maxWait = 30000; // default 30s for images
        const pollInterval = maxWait > 60000 ? 3000 : 2000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          await new Promise(r => setTimeout(r, pollInterval));
          try {
            const check = await fetch(
              `https://graph.facebook.com/v25.0/${containerId}?fields=status_code,status&access_token=${igToken || process.env.META_ACCESS_TOKEN}`,
              { method: 'GET' }
            );
            const status = await check.json();
            if (status.status_code === 'FINISHED') return true;
            if (status.status_code === 'ERROR') {
              throw new Error('IG container failed: ' + (status.status || 'processing error'));
            }
          } catch (e) {
            if (e.message.includes('failed') || e.message.includes('container')) throw e;
          }
        }
        throw new Error('IG container timeout após ' + Math.round(maxWait / 1000) + 's');
      }

      // ─── IG CARROSSEL (múltiplas imagens) ───
      if (image_urls.length > 1) {
        // Step 1: Create individual media containers (is_carousel_item)
        const childIds = [];
        for (const url of image_urls) {
          const itemRes = await graphPost(`/${tenant.igUserId}/media`, {
            image_url: url,
            is_carousel_item: true,
            ...(igToken && { access_token: igToken }),
          });
          childIds.push(itemRes.id);
        }

        // Step 1.5: Wait for all children to be ready
        for (const cid of childIds) {
          await waitForContainer(cid);
        }

        // Step 2: Create carousel container
        const carouselRes = await graphPost(`/${tenant.igUserId}/media`, {
          media_type: 'CAROUSEL',
          children: childIds.join(','),
          caption: caption || '',
          ...(igToken && { access_token: igToken }),
        });

        // Step 2.5: Wait for carousel to be ready
        await waitForContainer(carouselRes.id);

        // Step 3: Publish carousel
        const pubRes = await graphPost(`/${tenant.igUserId}/media_publish`, {
          creation_id: carouselRes.id,
          ...(igToken && { access_token: igToken }),
        });
        publishedId = pubRes.id;
      }
      // ─── IG IMAGEM ÚNICA (via container_id ou image_url) ───
      else if (container_id) {
        await waitForContainer(container_id);
        const pubBody = { creation_id: container_id };
        if (igToken) pubBody.access_token = igToken;
        const pubRes = await graphPost(`/${tenant.igUserId}/media_publish`, pubBody);
        publishedId = pubRes.id;
      }
      // ─── IG VIDEO / REELS ───
      else if (video_url) {
        // Verify video URL is accessible before sending to Meta
        await verifyMediaUrl(video_url);

        const videoBody = {
          video_url: video_url,
          caption: caption || '',
          media_type: (media_type === 'REELS') ? 'REELS' : 'VIDEO',
          ...(igToken && { access_token: igToken }),
        };
        const mediaRes = await graphPost(`/${tenant.igUserId}/media`, videoBody, { videoMode: true });
        await waitForContainer(mediaRes.id, 180000); // 180s for videos
        const pubRes = await graphPost(`/${tenant.igUserId}/media_publish`, {
          creation_id: mediaRes.id,
          ...(igToken && { access_token: igToken }),
        }, { videoMode: true });
        publishedId = pubRes.id;
      }
      // ─── IG IMAGEM ÚNICA via URL direta ───
      else if (image_url) {
        const mediaRes = await graphPost(`/${tenant.igUserId}/media`, {
          image_url: image_url,
          caption: caption || '',
          ...(igToken && { access_token: igToken }),
        });
        await waitForContainer(mediaRes.id);
        const pubRes = await graphPost(`/${tenant.igUserId}/media_publish`, {
          creation_id: mediaRes.id,
          ...(igToken && { access_token: igToken }),
        });
        publishedId = pubRes.id;
      }
      else {
        return res.status(400).json({
          error: true, code: 'MISSING_PARAM',
          message: 'Instagram requer mídia. Envie image_url, video_url, image_urls[] ou container_id.',
        });
      }

      const result = {
        post_id: publishedId,
        status: 'PUBLISHED',
        client: tenant.name || tenant.key,
        photo_count: image_urls.length > 1 ? image_urls.length : 1,
      };

      // Salva no histórico
      await saveToHistory({
        user_name: user || 'Sistema',
        client_key: req.body.client || tenant.key,
        client_name: tenant.name || tenant.key,
        platform: 'ig',
        status: 'PUBLISHED',
        post_id: publishedId,
        caption: caption || '',
        has_image: true,
        image_url: encodeImageUrl(image_urls && image_urls.length ? image_urls : (image_url || video_url ? [image_url || video_url] : [])),
        ...(task_id && { task_id }),
      });

      return res.status(201).json(result);
    }

    // ─── FACEBOOK ───
    if (destination === 'fb') {
      if (!tenant.pageId) {
        return res.status(400).json({
          error: true, code: 'MISSING_PARAM',
          message: `Page ID não configurado para "${tenant.name || tenant.key}".`,
        });
      }

      if (!tenant.pageAccessToken) {
        return res.status(400).json({
          error: true, code: 'MISSING_PAGE_TOKEN',
          message: `Page Access Token não encontrado para "${tenant.name || tenant.key}". Re-descubra ativos na Configuração Meta.`,
        });
      }

      let result;
      const image_urls = req.body.image_urls || [];

      // ─── CARROSSEL (múltiplas imagens) ───
      if (image_urls.length > 1) {
        // Upload all as unpublished photos
        const photoIds = [];
        for (const url of image_urls) {
          const photoRes = await graphPost(`/${tenant.pageId}/photos`, {
            url: url,
            published: false,
            access_token: tenant.pageAccessToken,
          });
          photoIds.push(photoRes.id);
        }

        // Create post with attached_media
        const postBody = {
          message: caption || '',
          access_token: tenant.pageAccessToken,
        };
        photoIds.forEach((pid, i) => {
          postBody[`attached_media[${i}]`] = JSON.stringify({ media_fbid: pid });
        });

        if (scheduled_publish_time) {
          postBody.scheduled_publish_time = scheduled_publish_time;
          postBody.published = false;
        }

        const postRes = await graphPostForm(`/${tenant.pageId}/feed`, postBody);

        result = {
          post_id: postRes.id,
          status: scheduled_publish_time ? 'SCHEDULED' : 'PUBLISHED',
          has_image: true,
          photo_count: photoIds.length,
          client: tenant.name || tenant.key,
          page: tenant.pageName || tenant.pageId,
          ...(scheduled_publish_time && { scheduled_for: new Date(scheduled_publish_time * 1000).toISOString() }),
        };
      }
      // ─── STORY (FB) ───
      else if (type === 'story' || media_type === 'STORIES') {
        if (!tenant.pageAccessToken) {
          return res.status(400).json({ error: true, code: 'MISSING_PAGE_TOKEN', message: 'Page Access Token não encontrado para publicar Story no Facebook.' });
        }
        let storyId, storyNote;
        if (video_url) {
          await verifyMediaUrl(video_url);
          const vr = await graphPost(`/${tenant.pageId}/video_stories`, {
            file_url: video_url,
            access_token: tenant.pageAccessToken,
          }, { videoMode: true });
          storyId = vr.id;
        } else if (image_url) {
          // Try photo_stories; if the page doesn't support it, fall back to regular photo
          const storyUrl = `https://graph.facebook.com/v25.0/${tenant.pageId}/photo_stories?access_token=${encodeURIComponent(tenant.pageAccessToken)}`;
          const formParams = new URLSearchParams();
          formParams.append('url', image_url);
          const storyRes = await fetch(storyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formParams.toString(),
          });
          const storyData = await storyRes.json();
          console.log('[publish/fb] photo_stories response:', JSON.stringify(storyData));
          if (!storyRes.ok || storyData.error) {
            console.warn('[publish/fb] photo_stories unavailable, falling back to /photos:', storyData.error && storyData.error.message);
            const fallback = await graphPost(`/${tenant.pageId}/photos`, {
              url: image_url,
              caption: caption || '',
              access_token: tenant.pageAccessToken,
            });
            storyId = fallback.id || fallback.post_id;
            storyNote = 'Publicado como foto (Stories API indisponível para esta página)';
          } else {
            storyId = storyData.id;
          }
        } else {
          return res.status(400).json({ error: true, code: 'MISSING_PARAM', message: 'Story requer uma imagem ou vídeo.' });
        }
        console.log('[publish/fb] story id:', storyId, 'page:', tenant.pageId);
        result = {
          post_id: storyId,
          status: 'PUBLISHED',
          has_image: true,
          client: tenant.name || tenant.key,
          page: tenant.pageName || tenant.pageId,
          ...(storyNote && { note: storyNote }),
        };
      }
      // ─── VIDEO / REELS (FB) ───
      else if (video_url) {
        // Verify video URL is accessible before sending to Meta
        await verifyMediaUrl(video_url);

        const videoBody = {
          file_url: video_url,
          description: caption || '',
          access_token: tenant.pageAccessToken,
        };
        if (scheduled_publish_time) {
          videoBody.scheduled_publish_time = scheduled_publish_time;
          videoBody.published = false;
        }
        const videoRes = await graphPost(`/${tenant.pageId}/videos`, videoBody, { videoMode: true });
        result = {
          post_id: videoRes.id,
          status: scheduled_publish_time ? 'SCHEDULED' : 'PUBLISHED',
          has_image: true,
          media_type: 'VIDEO',
          client: tenant.name || tenant.key,
          page: tenant.pageName || tenant.pageId,
          ...(scheduled_publish_time && { scheduled_for: new Date(scheduled_publish_time * 1000).toISOString() }),
        };
      }
      // ─── COM IMAGEM ÚNICA ───
      else if (image_url) {

        // PUBLICAR AGORA com imagem
        if (!scheduled_publish_time) {
          const photoRes = await graphPost(`/${tenant.pageId}/photos`, {
            url: image_url,
            caption: caption || '',
            access_token: tenant.pageAccessToken,
          });

          result = {
            post_id: photoRes.id || photoRes.post_id,
            status: 'PUBLISHED',
            has_image: true,
            client: tenant.name || tenant.key,
            page: tenant.pageName || tenant.pageId,
          };
        } else {
          // AGENDAR com imagem: upload não-publicado + feed com attached_media
          const uploadRes = await graphPost(`/${tenant.pageId}/photos`, {
            url: image_url,
            published: false,
            access_token: tenant.pageAccessToken,
          });

          const schedRes = await graphPostForm(`/${tenant.pageId}/feed`, {
            message: caption || '',
            'attached_media[0]': JSON.stringify({ media_fbid: uploadRes.id }),
            scheduled_publish_time: scheduled_publish_time,
            published: 'false',
            access_token: tenant.pageAccessToken,
          });

          result = {
            post_id: schedRes.id,
            status: 'SCHEDULED',
            has_image: true,
            photo_id: uploadRes.id,
            client: tenant.name || tenant.key,
            page: tenant.pageName || tenant.pageId,
            scheduled_for: new Date(scheduled_publish_time * 1000).toISOString(),
          };
        }
      }
      // ─── SEM IMAGEM ───
      else {
        const postBody = {
          message: caption || '',
          access_token: tenant.pageAccessToken,
        };

        if (scheduled_publish_time) {
          postBody.scheduled_publish_time = scheduled_publish_time;
          postBody.published = false;
        }

        const postRes = await graphPost(`/${tenant.pageId}/feed`, postBody);

        result = {
          post_id: postRes.id,
          status: scheduled_publish_time ? 'SCHEDULED' : 'PUBLISHED',
          has_image: false,
          client: tenant.name || tenant.key,
          page: tenant.pageName || tenant.pageId,
          scheduled_for: scheduled_publish_time
            ? new Date(scheduled_publish_time * 1000).toISOString()
            : null,
        };
      }

      // Salva no histórico (Supabase)
      const fbImgUrls = req.body.image_urls || [];
      await saveToHistory({
        user_name: user || 'Sistema',
        client_key: req.body.client || tenant.key,
        client_name: tenant.name || tenant.key,
        platform: 'fb',
        status: result.status,
        post_id: result.post_id,
        caption: caption || '',
        has_image: result.has_image || !!video_url,
        image_url: encodeImageUrl(fbImgUrls.length ? fbImgUrls : (image_url || video_url ? [image_url || video_url] : [])),
        scheduled_for: result.scheduled_for || null,
        ...(task_id && { task_id }),
      });

      return res.status(201).json(result);
    }
  } catch (err) {
    // Salva erro no histórico
    const failedImageUrls = (req.body && req.body.image_urls) || [];
    const failedMediaUrls = failedImageUrls.length ? failedImageUrls : (image_url || video_url ? [image_url || video_url] : []);
    let failedScheduledFor = null;
    if (scheduled_publish_time) {
      const scheduledMs = Number(scheduled_publish_time) * 1000;
      if (Number.isFinite(scheduledMs)) failedScheduledFor = new Date(scheduledMs).toISOString();
    }
    await saveToHistory({
      user_name: (req.body || {}).user || (req.body || {}).user_name || 'Sistema',
      client_key: (req.body || {}).client || tenant.key,
      client_name: tenant.name || tenant.key,
      platform: destination,
      status: 'FAILED',
      caption: caption || '',
      has_image: failedMediaUrls.length > 0,
      image_url: encodeImageUrl(failedMediaUrls),
      scheduled_for: failedScheduledFor,
      error_message: err.message || 'Erro interno ao publicar',
      ...(task_id && { task_id }),
    });

    if (err.error) {
      return res.status(err.status || 502).json(err);
    }
    return res.status(500).json({
      error: true,
      code: 'INTERNAL_ERROR',
      message: err.message || 'Erro interno',
    });
  }
};
