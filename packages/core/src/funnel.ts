import { globalTx, type Tx } from '@arkiv/db';
import { DomainError, type EventType } from '@arkiv/shared';
import { setting } from './settings';

/** Server-side funnel events (plan 04 §1) — the source of truth; client analytics are secondary. */
export async function recordFunnel(
  type: EventType,
  data: {
    visitorId?: string | null;
    workspaceId?: string | null;
    page?: string | null;
    variant?: string | null;
    utm?: Record<string, string> | null;
    props?: Record<string, unknown>;
  },
  tx?: Tx,
): Promise<void> {
  const run = (t: Tx) => t`
    insert into funnel_events (type, visitor_id, workspace_id, page, variant, utm, props)
    values (${type}, ${data.visitorId ?? null}, ${data.workspaceId ?? null}, ${data.page ?? null},
            ${data.variant ?? null}, ${data.utm ? t.json(data.utm) : null}, ${t.json((data.props ?? {}) as never)})`;
  if (tx) await run(tx);
  else await globalTx(run);
}

/**
 * The anonymous visitor whose free preview created this project's SKU (skus.origin_visitor_id). Later funnel
 * stages carry it, so a preview merged into an existing account (moveProvisionalSkus) keeps its first-touch
 * attribution instead of inheriting the target workspace's.
 */
export async function projectVisitor(tx: Tx, workspaceId: string, projectId: string): Promise<string | null> {
  const [r] = await tx`select s.origin_visitor_id from projects p join skus s on s.id = p.sku_id and s.workspace_id = p.workspace_id
                       where p.id = ${projectId} and p.workspace_id = ${workspaceId}`;
  return (r?.origin_visitor_id as string | null) ?? null;
}

/** Workspace-level stages (a subscription) go to the most recent previewed SKU's visitor, when there is one. */
export async function workspaceVisitor(tx: Tx, workspaceId: string): Promise<string | null> {
  const [r] = await tx`select origin_visitor_id from skus where workspace_id = ${workspaceId} and origin_visitor_id is not null order by created_at desc limit 1`;
  return (r?.origin_visitor_id as string | null) ?? null;
}

/**
 * Funnel slices (plan 05 §4 "sliced by: landing page, campaign/UTM, ad creative ID, device, country/state, new vs
 * returning, offer variant"). All but `offer` come from the visitor's first landing view; `offer` is the Taste offer
 * (definition · experiment variant) the visitor's storyboard was priced with, so earlier stages show "(no offer yet)".
 */
export const FUNNEL_SLICES = ['page', 'variant', 'utm_source', 'utm_campaign', 'utm_content', 'ad_id', 'device', 'country', 'region', 'returning', 'offer', 'in_app'] as const;
export type FunnelSlice = (typeof FUNNEL_SLICES)[number];

/** Device class from a user agent, for the `device` slice. Crawlers and link previewers are `bot`. */
export function deviceClass(ua: string | null | undefined): 'bot' | 'tablet' | 'mobile' | 'desktop' {
  const s = ua ?? '';
  if (!s || /bot|crawl|spider|slurp|preview|facebookexternalhit|headless/i.test(s)) return 'bot';
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(s)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|BlackBerry|Opera Mini|IEMobile/i.test(s)) return 'mobile';
  return 'desktop';
}

/** Why an upload attempt didn't start a preview (plan 05 §4 drop-off drilldown), from the error the visitor saw. */
export type UploadFailureCategory = 'file_too_big' | 'file_too_small' | 'unsupported_file' | 'unsupported_page' | 'unreachable_page' | 'invalid_link' | 'bot_challenge' | 'rate_limited' | 'needs_account' | 'other';
export function uploadFailureCategory(e: unknown): UploadFailureCategory {
  if (!(e instanceof DomainError)) return 'other';
  const m = e.message;
  if (e.code === 'RATE_LIMITED') return 'rate_limited';
  if (e.code === 'FORBIDDEN' && e.details?.challenge) return 'bot_challenge';
  if (e.code === 'PAYMENT_REQUIRED' && e.details?.needsAccount) return 'needs_account';
  if (/too large|too big|maxBytes/i.test(m) || e.details?.maxBytes) return 'file_too_big';
  if (/too small/i.test(m)) return 'file_too_small';
  if (/file type|couldn’t read that file|damaged|HEIC|JPG|PNG/i.test(m)) return 'unsupported_file';
  if (/marketplace|blocked our reader|couldn’t open that page|not supported/i.test(m)) return 'unsupported_page';
  if (/couldn’t reach|not reachable|took too long|redirects/i.test(m)) return 'unreachable_page';
  if (/web address|http\(s\)|credentials|port|product link/i.test(m)) return 'invalid_link';
  return 'other';
}

const sliceOf = (tx: Tx, by: FunnelSlice) => {
  switch (by) {
    case 'page':
      return tx`coalesce(page, '(none)')`;
    case 'variant':
      return tx`coalesce(variant, '(none)')`;
    case 'in_app':
      return tx`coalesce(props->>'inApp', 'false')`;
    case 'ad_id':
      return tx`coalesce(nullif(props->>'adId', ''), nullif(utm->>'utm_id', ''), '(none)')`;
    case 'device':
      return tx`coalesce(props->>'device', '(unknown)')`;
    case 'country':
      return tx`coalesce(props->>'country', '(unknown)')`;
    case 'region':
      return tx`coalesce((props->>'country') || '-' || (props->>'region'), props->>'country', '(unknown)')`;
    case 'returning':
      return tx`case props->>'returning' when 'true' then 'returning' when 'false' then 'new' else '(unknown)' end`;
    default:
      return tx`coalesce(utm->>${by}, '(none)')`;
  }
};

/**
 * Unique visitors per stage, attributed to the slice of each visitor's first landing view (plan 05 §4). An event
 * without a visitor falls back to the earliest visitor seen on its workspace. Test workspaces are excluded
 * unless asked for (§2.3).
 */
export async function funnelBySlice(tx: Tx, opts: { by: FunnelSlice; days: number; includeTest?: boolean }) {
  const { by, days } = opts;
  const firstTouch =
    by === 'offer'
      ? tx`select distinct on (vid) vid as visitor_id, concat_ws(' · ', props->>'offer', props->>'offerVariant') as slice
           from (select coalesce(f.visitor_id, wv.visitor_id) as vid, f.props, f.at from funnel_events f left join ws_visitor wv on wv.workspace_id = f.workspace_id
                 where f.type = 'STORYBOARD_READY' and f.at > now() - make_interval(days => ${days}) and f.props ? 'offer') x
           where vid is not null order by vid, at`
      : tx`select distinct on (visitor_id) visitor_id, ${sliceOf(tx, by)} as slice
           from funnel_events where type = 'LP_VIEWED' and at > now() - make_interval(days => ${days}) and visitor_id is not null order by visitor_id, at`;
  const rows = await tx`
    with ws_visitor as (select distinct on (workspace_id) workspace_id, visitor_id from funnel_events where visitor_id is not null and workspace_id is not null order by workspace_id, at),
    first_touch as (${firstTouch}),
    ev as (
      select f.type, coalesce(f.visitor_id, wv.visitor_id) as vid from funnel_events f left join ws_visitor wv on wv.workspace_id = f.workspace_id
      where f.at > now() - make_interval(days => ${days})
        and (${!!opts.includeTest} or f.workspace_id is null or f.workspace_id not in (select id from workspaces where is_test)))
    select coalesce(nullif(ft.slice, ''), ${by === 'offer' ? '(no offer yet)' : '(unattributed)'}) as slice, ev.type, count(distinct ev.vid)::int as n
    from ev left join first_touch ft on ft.visitor_id = ev.vid group by 1, 2`;
  return rows.map((r) => ({ slice: r.slice as string, type: r.type as EventType, n: Number(r.n) }));
}

const testFilter = (tx: Tx, includeTest: boolean | undefined, col: string) =>
  includeTest ? tx`` : tx`and (${tx(col)} is null or ${tx(col)} not in (select id from workspaces where is_test))`;

/**
 * Stage drop-off drilldown for uploads (plan 05 §4): visitors who started an upload, by why they didn't get to
 * concepts — refused at upload (file too big, unsupported page…), link unreadable, product out of scope, analysis
 * that never produced concepts, or no recorded reason (left before submitting).
 */
export async function uploadDropoff(tx: Tx, opts: { days: number; includeTest?: boolean }) {
  const { days } = opts;
  const rows = await tx`
    select 'Upload refused: ' || coalesce(props->>'category', 'other') as reason, count(distinct coalesce(visitor_id, id::text))::int as n
      from funnel_events where type = 'UPLOAD_FAILED' and at > now() - make_interval(days => ${days}) ${testFilter(tx, opts.includeTest, 'workspace_id')} group by 1
    union all
    select 'Link unreadable: ' || coalesce(props->>'category', left(props->>'reason', 60), 'unknown'), count(*)::int
      from funnel_events where type = 'URL_PARSE_FAILED' and at > now() - make_interval(days => ${days}) ${testFilter(tx, opts.includeTest, 'workspace_id')} group by 1
    union all
    select 'Out of scope: ' || left(coalesce(props->>'reason', 'rejected'), 60), count(*)::int
      from funnel_events where type = 'SKU_REJECTED' and at > now() - make_interval(days => ${days}) ${testFilter(tx, opts.includeTest, 'workspace_id')} group by 1
    union all
    -- Analysis never produced concepts (and wasn't rejected) within 30 minutes of the upload.
    select 'Gave up during analysis (no concepts after 30 min)', count(distinct c.workspace_id)::int
      from funnel_events c where c.type = 'UPLOAD_COMPLETED' and c.at > now() - make_interval(days => ${days}) and c.at < now() - interval '30 minutes' ${testFilter(tx, opts.includeTest, 'c.workspace_id')}
        and not exists (select 1 from funnel_events r where r.workspace_id = c.workspace_id and r.type in ('CONCEPTS_READY', 'SKU_REJECTED') and r.at >= c.at)
    union all
    select 'Started, never submitted or completed', count(distinct s.visitor_id)::int
      from funnel_events s where s.type = 'UPLOAD_STARTED' and s.at > now() - make_interval(days => ${days}) ${testFilter(tx, opts.includeTest, 's.workspace_id')}
        and not exists (select 1 from funnel_events c where c.visitor_id = s.visitor_id and c.type in ('UPLOAD_COMPLETED', 'UPLOAD_FAILED') and c.at >= s.at)`;
  return rows.map((r) => ({ reason: r.reason as string, n: Number(r.n) })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n);
}

export type CohortBy = 'week' | 'page' | 'concept';

/**
 * Taste → subscription conversion (plan 05 §4 "Cohorts: … by week, by landing page, by concept type chosen"): Taste
 * buyers in the window, and how many of their workspaces subscribed after buying. Landing page is the buyer's
 * first-touch page (the visitor whose preview created the SKU); concept type is the angle of the concept they chose.
 */
export async function tasteCohorts(tx: Tx, opts: { by: CohortBy; days: number; tz: string; includeTest?: boolean }) {
  const dim =
    opts.by === 'week'
      ? tx`to_char(date_trunc('week', p.paid_at, ${opts.tz}) at time zone ${opts.tz}, 'YYYY-MM-DD')`
      : opts.by === 'page'
        ? tx`coalesce(ft.page, '(unattributed)')`
        : tx`coalesce(c.proposal->>'angle', '(unknown)')`;
  const rows = await tx`
    with first_touch as (select distinct on (visitor_id) visitor_id, coalesce(page, '(none)') as page from funnel_events
                         where type = 'LP_VIEWED' and visitor_id is not null order by visitor_id, at)
    select ${dim} as cohort, count(distinct p.workspace_id)::int as taste,
           count(distinct p.workspace_id) filter (where exists (select 1 from subscriptions s where s.workspace_id = p.workspace_id and s.created_at > p.paid_at))::int as subscribed
    from purchases p
    join projects pr on pr.id = p.project_id and pr.workspace_id = p.workspace_id
    join skus sk on sk.id = pr.sku_id and sk.workspace_id = pr.workspace_id
    left join concepts c on c.id = pr.selected_concept_id and c.workspace_id = pr.workspace_id
    left join first_touch ft on ft.visitor_id = sk.origin_visitor_id
    where p.kind = 'taste' and p.status in ('paid', 'refunded') and p.paid_at > now() - make_interval(days => ${opts.days}) ${testFilter(tx, opts.includeTest, 'p.workspace_id')}
    group by 1 order by 1 desc`;
  return rows.map((r) => ({ cohort: r.cohort as string, taste: Number(r.taste), subscribed: Number(r.subscribed) }));
}

/** Payment fee allocation for Taste contribution (Appendix C): basis points + fixed per charge, platform settings. */
async function paymentFee(tx: Tx) {
  return { bps: await setting(tx, 'finance.payment_fee_bps'), fixedMicros: await setting(tx, 'finance.payment_fee_fixed_micros') };
}

export interface CacRow {
  campaign: string;
  spendMicros: number;
  tasteBuyers: number;
  subscribers: number;
  previewCogsMicros: number;
  tasteContributionMicros: number;
  /** Media CAC per Taste buyer: paid media ÷ Taste buyers. */
  mediaCacPerTaste: number | null;
  /** Appendix C: (paid media + free-preview COGS − Taste contribution) ÷ new subscribers, floored at zero. */
  effectiveSubscriberCac: number | null;
}

/**
 * CAC by campaign (plan 05 §4, Appendix C) from imported ad spend and server-side funnel attribution. A workspace
 * belongs to the utm_campaign of its first visitor's first landing view. Free-preview COGS is provider cost on a
 * workspace's preview work before any payment; Taste contribution is Taste revenue net of refunds, minus the
 * provider cost of producing it and the payment fee.
 */
export async function cacByCampaign(tx: Tx, opts: { days: number; includeTest?: boolean }): Promise<{ rows: CacRow[]; total: CacRow }> {
  const { days } = opts;
  const fee = await paymentFee(tx);
  const attributed = tx`
    first_touch as (select distinct on (visitor_id) visitor_id, lower(trim(coalesce(utm->>'utm_campaign', ''))) as campaign from funnel_events
                    where type = 'LP_VIEWED' and visitor_id is not null order by visitor_id, at),
    ws_campaign as (select distinct on (f.workspace_id) f.workspace_id, ft.campaign from funnel_events f join first_touch ft on ft.visitor_id = f.visitor_id
                    where f.workspace_id is not null ${testFilter(tx, opts.includeTest, 'f.workspace_id')} order by f.workspace_id, f.at)`;
  const spend = await tx`select lower(trim(campaign)) as campaign, sum(spend_micros)::bigint as micros from ad_spend where date > current_date - ${days}::int group by 1`;
  const buyers = await tx`
    with ${attributed}
    select wc.campaign,
           count(distinct f.workspace_id) filter (where f.type = 'TASTE_PAID' and f.props->>'kind' = 'taste')::int as taste,
           count(distinct f.workspace_id) filter (where f.type = 'SUBSCRIPTION_STARTED')::int as subs
    from funnel_events f join ws_campaign wc on wc.workspace_id = f.workspace_id
    where f.type in ('TASTE_PAID', 'SUBSCRIPTION_STARTED') and f.at > now() - make_interval(days => ${days}) group by 1`;
  const money = await tx`
    with ${attributed},
    taste as (select p.workspace_id, p.project_id, p.paid_at, p.amount_micros - coalesce(p.refunded_micros, 0) as net, p.amount_micros
              from purchases p where p.kind = 'taste' and p.status in ('paid', 'refunded') and p.paid_at > now() - make_interval(days => ${days}))
    select wc.campaign,
      coalesce((select sum(t.net - (t.amount_micros * ${fee.bps} / 10000) - ${fee.fixedMicros}
                         - coalesce((select sum(l.amount) from ledger_entries l where l.workspace_id = t.workspace_id and l.project_id = t.project_id
                                      and l.type = 'PROVIDER_COST_RECORDED' and l.created_at >= t.paid_at), 0))
                from taste t where t.workspace_id = wc.workspace_id), 0)::bigint as contribution,
      coalesce((select sum(l.amount) from ledger_entries l join projects pr on pr.id = l.project_id and pr.workspace_id = l.workspace_id
                where l.workspace_id = wc.workspace_id and l.type = 'PROVIDER_COST_RECORDED' and pr.kind = 'preview'
                  and l.created_at > now() - make_interval(days => ${days})
                  and not exists (select 1 from purchases p where p.workspace_id = l.workspace_id and p.project_id = l.project_id and p.paid_at <= l.created_at)), 0)::bigint as preview_cogs
    from ws_campaign wc`;
  const by = new Map<string, CacRow>();
  const row = (campaign: string) => {
    let r = by.get(campaign);
    if (!r) by.set(campaign, (r = { campaign, spendMicros: 0, tasteBuyers: 0, subscribers: 0, previewCogsMicros: 0, tasteContributionMicros: 0, mediaCacPerTaste: null, effectiveSubscriberCac: null }));
    return r;
  };
  for (const s of spend) row(s.campaign as string).spendMicros += Number(s.micros);
  for (const b of buyers) {
    const r = row(b.campaign as string);
    r.tasteBuyers += Number(b.taste);
    r.subscribers += Number(b.subs);
  }
  for (const m of money) {
    const r = row(m.campaign as string);
    r.tasteContributionMicros += Number(m.contribution);
    r.previewCogsMicros += Number(m.preview_cogs);
  }
  const finish = (r: CacRow): CacRow => ({
    ...r,
    mediaCacPerTaste: r.tasteBuyers ? Math.round(r.spendMicros / r.tasteBuyers) : null,
    effectiveSubscriberCac: r.subscribers ? Math.max(0, Math.round((r.spendMicros + r.previewCogsMicros - r.tasteContributionMicros) / r.subscribers)) : null,
  });
  const rows = [...by.values()].filter((r) => r.spendMicros || r.tasteBuyers || r.subscribers).map(finish).sort((a, b) => b.spendMicros - a.spendMicros);
  const total = finish(
    rows.reduce((t, r) => ({ ...t, spendMicros: t.spendMicros + r.spendMicros, tasteBuyers: t.tasteBuyers + r.tasteBuyers, subscribers: t.subscribers + r.subscribers, previewCogsMicros: t.previewCogsMicros + r.previewCogsMicros, tasteContributionMicros: t.tasteContributionMicros + r.tasteContributionMicros }), {
      campaign: 'all campaigns', spendMicros: 0, tasteBuyers: 0, subscribers: 0, previewCogsMicros: 0, tasteContributionMicros: 0, mediaCacPerTaste: null, effectiveSubscriberCac: null,
    } as CacRow),
  );
  return { rows, total };
}

export interface AdSpendRow {
  date: string;
  source: string;
  campaign: string;
  adId: string;
  spendMicros: number;
}

/** Split one CSV line, honouring double-quoted fields ("a, b" and "" escapes). */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Ad spend CSV (plan 05 §4 "manually imported CSV in V1"): a header row naming date, spend and campaign (source
 * and ad id optional; `source` may be given for the whole file). Spend is in US dollars. Throws on the first bad
 * row with its line number, so a half-imported file never happens.
 */
export function parseAdSpendCsv(text: string, defaultSource?: string | null): AdSpendRow[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new DomainError('INVALID', 'Paste a header row and at least one row of spend.');
  const head = csvLine(lines[0]!).map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iDate = col('date', 'day', 'reporting_starts');
  const iSpend = col('spend', 'amount_spent_usd', 'amount_spent', 'cost', 'spend_usd');
  const iCampaign = col('campaign', 'utm_campaign', 'campaign_name');
  const iSource = col('source', 'platform', 'utm_source');
  const iAd = col('ad_id', 'ad', 'utm_id', 'creative_id');
  if (iDate < 0 || iSpend < 0 || iCampaign < 0) throw new DomainError('INVALID', 'The header needs date, spend and campaign columns.');
  if (iSource < 0 && !defaultSource?.trim()) throw new DomainError('INVALID', 'Add a source column or choose the source for the whole file.');
  if (lines.length > 20_001) throw new DomainError('INVALID', 'Import at most 20,000 rows at a time.');
  return lines.slice(1).map((l, n) => {
    const c = csvLine(l);
    const date = c[iDate] ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new DomainError('INVALID', `Line ${n + 2}: dates look like 2026-09-24.`);
    const spend = Number((c[iSpend] ?? '').replace(/[$,\s]/g, ''));
    if (!Number.isFinite(spend) || spend < 0) throw new DomainError('INVALID', `Line ${n + 2}: spend must be a positive amount in USD.`);
    const source = (iSource >= 0 ? c[iSource] : defaultSource)?.trim().toLowerCase() ?? '';
    if (!source) throw new DomainError('INVALID', `Line ${n + 2}: source is missing.`);
    return { date, source: source.slice(0, 40), campaign: (c[iCampaign] ?? '').slice(0, 200), adId: (iAd >= 0 ? c[iAd] ?? '' : '').slice(0, 100), spendMicros: Math.round(spend * 1e6) };
  });
}

/** Store parsed ad spend (staff role). A re-import of the same day × source × campaign × ad replaces its amount. */
export async function importAdSpend(tx: Tx, input: AdSpendRow[], by: { staffId: string; batchId: string }) {
  // Rows for the same key in one file (e.g. split by placement) add up.
  const merged = new Map<string, AdSpendRow>();
  for (const r of input) {
    const key = JSON.stringify([r.date, r.source, r.campaign, r.adId]);
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, spendMicros: prev.spendMicros + r.spendMicros } : { ...r });
  }
  const rows = [...merged.values()];
  let n = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const r = await tx`
      insert into ad_spend (date, source, campaign, ad_id, spend_micros, import_batch, imported_by)
      select d::date, s, c, a, m, ${by.batchId}::uuid, ${by.staffId}::uuid
      from unnest(${chunk.map((x) => x.date)}::text[], ${chunk.map((x) => x.source)}::text[], ${chunk.map((x) => x.campaign)}::text[],
                  ${chunk.map((x) => x.adId)}::text[], ${chunk.map((x) => x.spendMicros)}::bigint[]) as t(d, s, c, a, m)
      on conflict (date, source, campaign, ad_id) do update set spend_micros = excluded.spend_micros, import_batch = excluded.import_batch, imported_by = excluded.imported_by`;
    n += r.count;
  }
  return n;
}
