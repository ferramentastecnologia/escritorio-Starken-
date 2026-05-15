/**
 * /api/meta/campaigns — Gerenciamento de campanhas Meta Ads
 *
 * GET  ?client=super-x-guaratuba
 *      &status=ACTIVE|PAUSED|ARCHIVED (opcional, default: todos)
 *      → Lista campanhas com ad sets e ads
 *
 * GET  ?client=super-x-guaratuba&campaign_id=123&deep=true
 *      → Retorna estrutura completa de uma campanha (targeting, criativos, etc.)
 *
 * POST ?client=super-x-itapoa
 *      body: { source_campaign_id, source_client, name_override }
 *      → Replica uma campanha de outra conta (ou cria nova)
 *
 * POST ?client=super-x-itapoa
 *      body: { campaign: {...}, adsets: [{...}], ads: [{...}] }
 *      → Cria campanha do zero
 */

const { graphGet, graphPost } = require('./_lib/graph');
const { validateTenant, getClient } = require('./_lib/tenants');

// ─── GET: Listar campanhas ────────────────────────────────────────────────────

async function graphGetAll(path, params) {
  const first = await graphGet(path, params);
  let data = first.data || [];
  let nextUrl = first.paging && first.paging.next;
  while (nextUrl) {
    const pageRes = await fetch(nextUrl);
    const pageData = await pageRes.json();
    if (pageData.error) break;
    data = data.concat(pageData.data || []);
    nextUrl = pageData.paging && pageData.paging.next;
  }
  return data;
}

async function handleGet(req, res) {
  const tenant = await validateTenant(req, res);
  if (!tenant) return;

  if (!tenant.adAccountIds || !tenant.adAccountIds.length) {
    return res.status(400).json({
      error: true, code: 'NOT_CONFIGURED',
      message: `Nenhuma conta de anúncios configurada para "${tenant.name}".`,
    });
  }

  const adAccountId = tenant.adAccountIds[0];
  const campaignId = req.query.campaign_id;
  const deep = req.query.deep === 'true';
  const statusFilter = req.query.status; // ACTIVE, PAUSED, ARCHIVED

  try {
    // ── Deep read: estrutura completa de uma campanha ──
    if (campaignId && deep) {
      return await getDeepCampaign(res, adAccountId, campaignId);
    }

    // ── Lista de campanhas ──
    const params = {
      fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,buying_type,special_ad_categories,created_time,updated_time',
      limit: '100',
    };
    if (statusFilter) {
      params.effective_status = JSON.stringify([statusFilter]);
    } else {
      params.effective_status = JSON.stringify(['ACTIVE', 'PAUSED', 'ARCHIVED']);
    }

    const campaigns = await graphGetAll(`/${adAccountId}/campaigns`, params);

    // Para cada campanha, buscar ad sets
    const enriched = [];
    for (const campaign of campaigns) {
      const adsets = await graphGetAll(`/${campaign.id}/adsets`, {
        fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,billing_event,optimization_goal,bid_amount,targeting,promoted_object,start_time,end_time',
        limit: '100',
      });

      enriched.push({
        ...campaign,
        adsets,
      });
    }

    return res.status(200).json({
      client: tenant.key,
      ad_account_id: adAccountId,
      campaigns: enriched,
      total: enriched.length,
    });

  } catch (err) {
    if (err.error) return res.status(err.status || 502).json(err);
    return res.status(500).json({ error: true, code: 'INTERNAL_ERROR', message: err.message });
  }
}

/**
 * Retorna estrutura completa de uma campanha: campaign → adsets → ads (com criativos)
 */
async function getDeepCampaign(res, adAccountId, campaignId) {
  // 1. Campaign details
  const campaign = await graphGet(`/${campaignId}`, {
    fields: 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,buying_type,special_ad_categories,created_time',
  });

  // 2. Ad Sets
  const adsets = await graphGetAll(`/${campaignId}/adsets`, {
    fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,billing_event,optimization_goal,bid_amount,targeting,promoted_object,destination_type,start_time,end_time',
    limit: '100',
  });

  // 3. Ads for each ad set (with creative details)
  for (const adset of adsets) {
    adset.ads = await graphGetAll(`/${adset.id}/ads`, {
      fields: 'id,name,status,effective_status,creative{id,name,title,body,image_url,image_hash,video_id,object_story_spec,asset_feed_spec,url_tags,thumbnail_url,effective_object_story_id}',
      limit: '100',
    });
  }

  return res.status(200).json({
    ad_account_id: adAccountId,
    campaign,
    adsets,
  });
}

// ─── POST: Criar/Replicar campanha ───────────────────────────────────────────

async function handlePost(req, res) {
  const tenant = await validateTenant(req, res);
  if (!tenant) return;

  if (!tenant.adAccountIds || !tenant.adAccountIds.length) {
    return res.status(400).json({
      error: true, code: 'NOT_CONFIGURED',
      message: `Nenhuma conta de anúncios configurada para "${tenant.name}".`,
    });
  }

  const targetAdAccount = tenant.adAccountIds[0];
  const body = req.body || {};

  try {
    // ── Modo replicação: copia campanha de outra conta ──
    if (body.source_campaign_id && body.source_client) {
      return await replicateCampaign(res, body, targetAdAccount, tenant);
    }

    // ── Modo criação direta ──
    if (body.campaign) {
      return await createCampaign(res, body, targetAdAccount);
    }

    return res.status(400).json({
      error: true, code: 'INVALID_BODY',
      message: 'Envie { source_campaign_id, source_client } para replicar ou { campaign, adsets, ads } para criar.',
    });

  } catch (err) {
    if (err.error) return res.status(err.status || 502).json(err);
    return res.status(500).json({ error: true, code: 'INTERNAL_ERROR', message: err.message });
  }
}

/**
 * Replica uma campanha de uma conta para outra
 */
async function replicateCampaign(res, body, targetAdAccount, targetTenant) {
  const { source_campaign_id, source_client, name_override } = body;

  // 1. Buscar client de origem
  const sourceClient = await getClient(source_client);
  if (!sourceClient.adAccountIds.length) {
    return res.status(400).json({
      error: true, code: 'SOURCE_NOT_CONFIGURED',
      message: `Cliente origem "${source_client}" não possui conta de anúncios.`,
    });
  }
  const sourceAdAccount = sourceClient.adAccountIds[0];

  // 2. Ler campanha completa da origem
  const campaign = await graphGet(`/${source_campaign_id}`, {
    fields: 'id,name,objective,status,daily_budget,lifetime_budget,bid_strategy,buying_type,special_ad_categories',
  });

  const adsetResult = await graphGet(`/${source_campaign_id}/adsets`, {
    fields: 'id,name,status,daily_budget,lifetime_budget,billing_event,optimization_goal,bid_amount,targeting,promoted_object,destination_type',
    limit: '50',
  });
  const sourceAdsets = adsetResult.data || [];

  // 3. Criar campanha no destino
  const newCampaignData = {
    name: name_override || campaign.name,
    objective: campaign.objective,
    status: 'PAUSED', // Sempre cria pausada por segurança
    special_ad_categories: campaign.special_ad_categories || [],
  };

  if (campaign.bid_strategy) newCampaignData.bid_strategy = campaign.bid_strategy;
  if (campaign.buying_type) newCampaignData.buying_type = campaign.buying_type;
  if (campaign.daily_budget) newCampaignData.daily_budget = campaign.daily_budget;
  if (campaign.lifetime_budget) newCampaignData.lifetime_budget = campaign.lifetime_budget;

  const newCampaign = await graphPost(`/${targetAdAccount}/campaigns`, newCampaignData);

  // 4. Criar ad sets no destino
  const createdAdsets = [];
  for (const adset of sourceAdsets) {
    const newAdsetData = {
      campaign_id: newCampaign.id,
      name: adset.name,
      status: 'PAUSED',
      billing_event: adset.billing_event,
      optimization_goal: adset.optimization_goal,
      targeting: adset.targeting,
    };

    if (adset.daily_budget) newAdsetData.daily_budget = adset.daily_budget;
    if (adset.lifetime_budget) newAdsetData.lifetime_budget = adset.lifetime_budget;
    if (adset.bid_amount) newAdsetData.bid_amount = adset.bid_amount;
    if (adset.destination_type) newAdsetData.destination_type = adset.destination_type;

    // Ajustar promoted_object para a nova página/conta se necessário
    if (adset.promoted_object) {
      const po = { ...adset.promoted_object };
      // Substituir page_id pela página do destino
      if (po.page_id && targetTenant.pageId) {
        po.page_id = targetTenant.pageId;
      }
      newAdsetData.promoted_object = po;
    }

    const newAdset = await graphPost(`/${targetAdAccount}/adsets`, newAdsetData);
    createdAdsets.push({
      source_id: adset.id,
      new_id: newAdset.id,
      name: adset.name,
    });

    // 5. Copiar ads de cada ad set
    const adsResult = await graphGet(`/${adset.id}/ads`, {
      fields: 'id,name,status,creative{id,name,title,body,image_url,image_hash,video_id,object_story_spec,url_tags,thumbnail_url}',
      limit: '50',
    });

    for (const ad of (adsResult.data || [])) {
      try {
        // Criar creative no destino
        const creativeData = {};
        if (ad.creative?.object_story_spec) {
          const spec = { ...ad.creative.object_story_spec };
          // Ajustar page_id no criativo
          if (spec.page_id && targetTenant.pageId) {
            spec.page_id = targetTenant.pageId;
          }
          // Ajustar link_data.page_id se existir
          if (spec.link_data?.page_id && targetTenant.pageId) {
            spec.link_data.page_id = targetTenant.pageId;
          }
          creativeData.object_story_spec = spec;
        }
        if (ad.creative?.url_tags) creativeData.url_tags = ad.creative.url_tags;
        if (ad.creative?.name) creativeData.name = ad.creative.name;

        if (Object.keys(creativeData).length > 0) {
          const newCreative = await graphPost(`/${targetAdAccount}/adcreatives`, creativeData);

          // Criar ad vinculado ao novo ad set e creative
          await graphPost(`/${targetAdAccount}/ads`, {
            name: ad.name,
            adset_id: newAdset.id,
            creative: { creative_id: newCreative.id },
            status: 'PAUSED',
          });
        }
      } catch (adErr) {
        // Log error but continue with other ads
        createdAdsets[createdAdsets.length - 1].ad_errors =
          createdAdsets[createdAdsets.length - 1].ad_errors || [];
        createdAdsets[createdAdsets.length - 1].ad_errors.push({
          source_ad_id: ad.id,
          error: adErr.message || adErr.code || 'Unknown error',
        });
      }
    }
  }

  return res.status(201).json({
    success: true,
    message: `Campanha replicada com sucesso para ${targetTenant.name}`,
    source: {
      client: source_client,
      campaign_id: source_campaign_id,
      campaign_name: campaign.name,
    },
    created: {
      campaign_id: newCampaign.id,
      campaign_name: name_override || campaign.name,
      ad_account: targetAdAccount,
      status: 'PAUSED',
      adsets: createdAdsets,
    },
  });
}

/**
 * Cria campanha do zero com estrutura fornecida
 */
async function createCampaign(res, body, targetAdAccount) {
  const { campaign, adsets = [], ads = [] } = body;

  // 1. Criar campanha
  const newCampaign = await graphPost(`/${targetAdAccount}/campaigns`, {
    name: campaign.name,
    objective: campaign.objective,
    status: campaign.status || 'PAUSED',
    special_ad_categories: campaign.special_ad_categories || [],
    ...(campaign.daily_budget && { daily_budget: campaign.daily_budget }),
    ...(campaign.lifetime_budget && { lifetime_budget: campaign.lifetime_budget }),
    ...(campaign.bid_strategy && { bid_strategy: campaign.bid_strategy }),
  });

  // 2. Criar ad sets
  const createdAdsets = [];
  for (const adset of adsets) {
    const newAdset = await graphPost(`/${targetAdAccount}/adsets`, {
      campaign_id: newCampaign.id,
      name: adset.name,
      status: adset.status || 'PAUSED',
      billing_event: adset.billing_event,
      optimization_goal: adset.optimization_goal,
      targeting: adset.targeting,
      ...(adset.daily_budget && { daily_budget: adset.daily_budget }),
      ...(adset.lifetime_budget && { lifetime_budget: adset.lifetime_budget }),
      ...(adset.bid_amount && { bid_amount: adset.bid_amount }),
      ...(adset.promoted_object && { promoted_object: adset.promoted_object }),
      ...(adset.destination_type && { destination_type: adset.destination_type }),
    });

    createdAdsets.push({ id: newAdset.id, name: adset.name });
  }

  return res.status(201).json({
    success: true,
    campaign: { id: newCampaign.id, name: campaign.name },
    adsets: createdAdsets,
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);

  return res.status(405).json({ error: true, code: 'METHOD_NOT_ALLOWED', message: 'Use GET ou POST' });
};
