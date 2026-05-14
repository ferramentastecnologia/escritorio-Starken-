/**
 * /api/meta/insights — Extração de métricas de campanhas (BI)
 *
 * GET ?tenant=starken|alpha
 *     ou ?client=arena-gourmet (consulta somente a conta do cliente)
 *     &preset=last_7d|this_month|last_month|last_90d|custom
 *     &date_start=YYYY-MM-DD (se preset=custom)
 *     &date_end=YYYY-MM-DD   (se preset=custom)
 *     &level=account|campaign|adset|ad (default: campaign)
 *
 * Consulta as ad accounts do tenant ou, quando client=... for informado,
 * somente a conta do cliente selecionado.
 */

const { graphGet } = require('./_lib/graph');
const { validateTenant } = require('./_lib/tenants');

function resolveDateRange(preset, dateStart, dateEnd) {
  const today = new Date();
  const fmt = d => d.toISOString().slice(0, 10);

  switch (preset) {
    case 'last_7d': {
      const since = new Date(today);
      since.setDate(since.getDate() - 7);
      return { since: fmt(since), until: fmt(today) };
    }
    case 'this_month': {
      const since = new Date(today.getFullYear(), today.getMonth(), 1);
      return { since: fmt(since), until: fmt(today) };
    }
    case 'last_month': {
      const since = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const until = new Date(today.getFullYear(), today.getMonth(), 0);
      return { since: fmt(since), until: fmt(until) };
    }
    case 'last_90d':
    case 'last_3m': {
      const since = new Date(today);
      since.setDate(since.getDate() - 90);
      return { since: fmt(since), until: fmt(today) };
    }
    case 'custom': {
      if (!dateStart || !dateEnd) {
        throw { error: true, code: 'MISSING_PARAM', message: 'date_start e date_end são obrigatórios para preset=custom' };
      }
      return { since: dateStart, until: dateEnd };
    }
    default:
      throw { error: true, code: 'MISSING_PARAM', message: `Preset "${preset}" inválido. Use: last_7d, this_month, last_month, last_90d, custom` };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: true, code: 'METHOD_NOT_ALLOWED', message: 'Use GET' });
  }

  const tenant = await validateTenant(req, res);
  if (!tenant) return;

  if (!tenant.adAccountIds || !tenant.adAccountIds.length) {
    return res.status(400).json({
      error: true,
      code: 'NOT_CONFIGURED',
      message: `Nenhuma conta de anúncios configurada para "${tenant.name}".`,
    });
  }

  const preset = req.query.preset || 'last_7d';
  const level = req.query.level || 'campaign';
  const requestedClient = req.query.client || null;

  let dateRange;
  try {
    dateRange = resolveDateRange(preset, req.query.date_start, req.query.date_end);
  } catch (err) {
    return res.status(400).json(err);
  }

  try {
    let allData = [];

    // Consulta cada ad account do tenant
    for (const adAccountId of tenant.adAccountIds) {
      let params = {
        fields: 'campaign_id,campaign_name,adset_name,ad_name,spend,impressions,reach,clicks,cpc,cpm,ctr,actions,action_values,cost_per_action_type',
        time_range: JSON.stringify(dateRange),
        level: level,
        limit: '500',
      };

      try {
        const firstPage = await graphGet(`/${adAccountId}/insights`, params);
        const rows = (firstPage.data || []).map(r => ({ ...r, ad_account_id: adAccountId }));
        allData = allData.concat(rows);

        // Paginação
        let nextUrl = firstPage.paging?.next;
        while (nextUrl) {
          const pageRes = await fetch(nextUrl);
          const pageData = await pageRes.json();
          if (pageData.error) break;
          allData = allData.concat((pageData.data || []).map(r => ({ ...r, ad_account_id: adAccountId })));
          nextUrl = pageData.paging?.next;
        }
      } catch (err) {
        // Continua com as outras contas se uma falhar
      }
    }

    // Calcular summary
    let totalSpend = 0, totalImpressions = 0, totalClicks = 0;
    allData.forEach(row => {
      totalSpend += parseFloat(row.spend || 0);
      totalImpressions += parseInt(row.impressions || 0);
      totalClicks += parseInt(row.clicks || 0);
    });

    const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
    const avgCpm = totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0;
    const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

    return res.status(200).json({
      tenant: tenant.tenant || tenant.key,
      client: requestedClient ? tenant.key : null,
      scope: requestedClient ? 'client' : 'tenant',
      preset,
      period: dateRange,
      accounts_checked: tenant.adAccountIds.length,
      data: allData,
      summary: {
        total_spend: totalSpend.toFixed(2),
        total_impressions: totalImpressions.toString(),
        total_clicks: totalClicks.toString(),
        avg_cpc: avgCpc.toFixed(2),
        avg_cpm: avgCpm.toFixed(2),
        avg_ctr: avgCtr.toFixed(2),
      },
    });
  } catch (err) {
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
