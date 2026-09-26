import { withAdmin } from '@arkiv/db';
import { DATASETS, EXPECTED_LABELS, GOLDEN, staffCan } from '@arkiv/core';
import { findPrompt, PROMPT_TEMPLATES, promptRef, type PromptTemplate } from '@arkiv/core/prompts';
import { ActButton, ActForm } from '@/components/act';
import { dt, money, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Prompts & evals' };

const UUID = /^[0-9a-f-]{36}$/i;

type CaseRow = { id: string; input: string; expected: string; got: string; ok: boolean; latencyMs?: number; costMicros?: number; error?: string };

/**
 * Plan 05 §11: git is the source of prompts (read-only here, with the version → route/rollout mapping); evals run
 * template × model × golden dataset with per-case diffs, cost and latency, and two runs compare side by side;
 * golden datasets are browsed and extended (synthetic, or production cases with consent under break-glass).
 */
export default async function Prompts({ searchParams }: { searchParams: Promise<{ run?: string; a?: string; b?: string }> }) {
  const s = await requireStaff('routes.manage');
  const sp = await searchParams;
  const ids = [sp.run, sp.a, sp.b].filter((x): x is string => !!x && UUID.test(x));
  const d0 = await withAdmin(async (tx) => ({
    routes: await tx`select task, provider, model, prompt_version, rollout_pct, canary from model_routes order by task`,
    runs: await tx`select r.*, coalesce(s.name, 'System') as name from eval_runs r left join staff_users s on s.id = r.created_by order by r.created_at desc limit 30`,
    picked: ids.length ? await tx`select * from eval_runs where id = any(${ids}::uuid[])` : [],
    added: await tx`select g.id, g.dataset, g.input, g.expected, g.note, g.source, g.consent_ref, g.created_at, s.name from golden_cases g join staff_users s on s.id = g.created_by
                    where g.retired_at is null order by g.created_at desc limit 200`,
  }));
  const byId = (id?: string) => d0.picked.find((r) => r.id === id) ?? null;
  const run = byId(sp.run);
  const [runA, runB] = [byId(sp.a), byId(sp.b)];
  const canRun = staffCan(s.roles, 'evals.run');
  const canAdd = staffCan(s.roles, 'golden.add');

  // Which template version is live on which route (stable arm and canary), with its rollout.
  const liveOn = (t: PromptTemplate) =>
    d0.routes.flatMap((r) => {
      const c = r.canary as { promptVersion?: string; pct?: number } | null;
      const out: string[] = [];
      if (r.prompt_version === promptRef(t)) out.push(`${r.task as string} (stable ${c?.pct ? 100 - Number(c.pct) : r.rollout_pct}%)`);
      if (c?.promptVersion === promptRef(t) && c.pct) out.push(`${r.task as string} (canary ${c.pct}%)`);
      return out;
    });
  const families = [...new Set(PROMPT_TEMPLATES.map((t) => t.name))];

  const cases = (r: Record<string, unknown>) => (r.results as CaseRow[]) ?? [];
  const summary = (r: Record<string, unknown>) => `${r.task as string} · ${r.model as string} · ${r.prompt_version as string}`;
  const lat = (v: unknown) => (v == null ? '—' : `${v}ms`);

  return (
    <Page title="Prompt registry & evaluations">
      <Section title="Golden datasets">
        <Table
          head={['Dataset', 'Category', 'Runs as', 'Cases (seed + added)', 'Sample', '']}
          rows={Object.entries(DATASETS).map(([name, info]) => {
            const added = d0.added.filter((c) => c.dataset === name).length;
            const seed = GOLDEN[name] ?? [];
            return [
              <Mono key="k">{name}</Mono>,
              <span key="c" className="ak-small">{info.category}<br /><span className="ak-muted">{info.description}</span></span>,
              info.kind === 'rules' ? 'rules' : <span key="r">{info.kind} · <Mono>{info.task}</Mono></span>,
              `${seed.length} + ${added}`,
              <span key="s" className="ak-small">{seed.slice(0, 2).map((c) => `“${c.input.slice(0, 50)}” → ${c.expect}`).join(' · ')}</span>,
              canRun ? <ActButton key="b" small action="eval.run" payload={{ dataset: name }}>Run</ActButton> : null,
            ];
          })}
        />
        <Table
          head={['Added', 'Dataset', 'Input', 'Expected', 'Source', 'By', '']}
          rows={d0.added.map((c) => [
            dt(c.created_at), <Mono key="d">{c.dataset as string}</Mono>, <span key="i" className="ak-small">{String(c.input).slice(0, 160)}</span>, c.expected as string,
            c.source === 'production' ? <span key="s" title={`consent ${c.consent_ref as string}`}>production (consent {c.consent_ref as string})</span> : 'synthetic',
            c.name as string,
            canAdd ? <ActButton key="r" small action="golden.retire" payload={{ id: c.id }} reason="Why retire this case?">Retire</ActButton> : null,
          ])}
          empty="No cases added yet; seeds only."
        />
        {canAdd ? (
          <details style={{ marginTop: 8 }}>
            <summary className="ak-small">Add a synthetic case (production cases are added from a QA or claims review, under break-glass with consent)</summary>
            <div className="ak-panel" style={{ maxWidth: 560 }}>
              <ActForm action="golden.add" extra={{ source: 'synthetic' }} submit="Add case" fields={[
                { name: 'dataset', label: 'Dataset', type: 'select', options: Object.keys(DATASETS) },
                { name: 'input', label: 'Input (performance cases: {"a":[impr,clicks,days],"b":[…],"confounders":n})', type: 'textarea', required: true },
                { name: 'expected', label: `Expected label (${Object.entries(EXPECTED_LABELS).map(([k, v]) => `${k}: ${v.join('/')}`).join('; ')})`, required: true },
                { name: 'note', label: 'Note' },
              ]} />
            </div>
          </details>
        ) : null}
      </Section>
      {canRun ? (
        <Section title="Eval a route change (required before route.update, valid 7 days)">
          <div className="ak-panel" style={{ maxWidth: 560 }}>
            <p className="ak-small ak-muted">Model-backed datasets send every case through the gateway on the candidate template × model (internal evals workspace, priced and recorded); rules datasets run the deterministic engines.</p>
            <ActForm action="eval.run" submit="Run eval" fields={[
              { name: 'task', label: 'Task', type: 'select', options: d0.routes.map((r) => r.task as string) },
              { name: 'model', label: 'Candidate model (empty = current)' },
              { name: 'promptVersion', label: 'Candidate prompt version (empty = current)', type: 'select', options: ['', ...PROMPT_TEMPLATES.map(promptRef)] },
              { name: 'reason', label: 'Reason', defaultValue: 'route change' },
            ]} />
          </div>
        </Section>
      ) : null}
      <Section title="Eval runs">
        <form method="get" className="ak-row" style={{ gap: 8, marginBottom: 8, alignItems: 'end' }}>
          <label className="ak-small">Compare A <select name="a" defaultValue={sp.a ?? ''}><option value="">—</option>{d0.runs.map((r) => <option key={r.id as string} value={r.id as string}>{dt(r.created_at)} · {summary(r)}</option>)}</select></label>
          <label className="ak-small">with B <select name="b" defaultValue={sp.b ?? ''}><option value="">—</option>{d0.runs.map((r) => <option key={r.id as string} value={r.id as string}>{dt(r.created_at)} · {summary(r)}</option>)}</select></label>
          <button className="ak-btn ak-btn--secondary ak-btn--sm" type="submit">Compare</button>
        </form>
        <Table
          head={['When', 'Task · model · prompt', 'Dataset', 'Status', 'Score', 'Cases', 'Cost', 'p50 latency', 'By', '']}
          rows={d0.runs.map((r) => [
            dt(r.created_at), <Mono key="t">{summary(r)}</Mono>, r.dataset as string,
            <span key="s" className={`ak-chip ${r.status === 'passed' ? 'ak-chip--ok' : r.status === 'failed' || r.status === 'error' ? 'ak-chip--risk' : ''}`}>{r.status as string}</span>,
            r.score === null ? '—' : pct(Number(r.score)), r.cases as number, money(Number(r.cost_micros), 4), lat(r.latency_p50_ms), r.name as string, <a key="v" href={`/prompts?run=${r.id}`}>view</a>,
          ])}
          empty="No runs yet."
        />
        {run ? (
          <Section title={`Run ${summary(run)} — per-case diff against gold labels`}>
            <Table head={['Case', 'Input', 'Expected', 'Got', 'Latency', 'Cost', '']} rows={cases(run).map((c) => [c.id, <span key="i" className="ak-small">{c.input.slice(0, 120)}</span>, c.expected, c.error ? <span key="g" title={c.error}>{c.got} ⚠</span> : c.got, lat(c.latencyMs), money(c.costMicros ?? 0, 4), c.ok ? '✓' : '✗'])} />
          </Section>
        ) : null}
        {runA && runB ? (
          <Section title="Side by side">
            <Table
              head={['', 'A', 'B']}
              rows={[
                ['Candidate', <Mono key="a">{summary(runA)}</Mono>, <Mono key="b">{summary(runB)}</Mono>],
                ['Dataset', runA.dataset as string, runB.dataset as string],
                ['Status', runA.status as string, runB.status as string],
                ['Score', runA.score === null ? '—' : pct(Number(runA.score)), runB.score === null ? '—' : pct(Number(runB.score))],
                ['Cost', money(Number(runA.cost_micros), 4), money(Number(runB.cost_micros), 4)],
                ['p50 latency', lat(runA.latency_p50_ms), lat(runB.latency_p50_ms)],
              ]}
            />
            <Table
              head={['Case', 'Input', 'Expected', 'A got', 'B got', 'Latency A / B', '']}
              rows={[...new Set([...cases(runA), ...cases(runB)].map((c) => c.id))].map((id) => {
                const ca = cases(runA).find((c) => c.id === id);
                const cb = cases(runB).find((c) => c.id === id);
                const diff = (ca?.ok ?? null) !== (cb?.ok ?? null);
                return [id, <span key="i" className="ak-small">{(ca ?? cb)!.input.slice(0, 100)}</span>, (ca ?? cb)!.expected, ca ? `${ca.got} ${ca.ok ? '✓' : '✗'}` : '—', cb ? `${cb.got} ${cb.ok ? '✓' : '✗'}` : '—', `${lat(ca?.latencyMs)} / ${lat(cb?.latencyMs)}`, diff ? <span key="d" className="ak-chip ak-chip--risk">differs</span> : ''];
              })}
            />
          </Section>
        ) : null}
      </Section>
      <Section title="Live routes">
        <Table head={['Task', 'Model', 'Prompt version', 'Template', 'Rollout', 'Canary']} rows={d0.routes.map((r) => {
          const c = r.canary as { model?: string; promptVersion?: string; pct?: number } | null;
          const t = findPrompt(r.prompt_version as string);
          return [
            <Mono key="t">{r.task as string}</Mono>, <Mono key="m">{r.model as string}</Mono>, <Mono key="p">{r.prompt_version as string}</Mono>,
            t ? <span key="x" className="ak-small">{t.changelog}</span> : <span key="x" className="ak-small ak-muted">built in code (no system template)</span>,
            `${r.rollout_pct}%`, c ? <Mono key="c">{`${c.pct}% → ${c.model} · ${c.promptVersion}`}</Mono> : '—',
          ];
        })} />
      </Section>
      <Section title="Templates (from git, read-only)">
        {families.map((name) => (
          <div key={name} style={{ marginBottom: 12 }}>
            <p className="ak-label"><Mono>{name}</Mono></p>
            <Table
              head={['Version', 'Live on', 'Changelog', 'Variables', 'Output schema', 'Author · date', '']}
              rows={PROMPT_TEMPLATES.filter((t) => t.name === name).map((t) => {
                const live = liveOn(t);
                return [
                  <Mono key="v">{t.version}</Mono>,
                  live.length ? <span key="l" className="ak-small">{live.join(', ')}</span> : <span key="l" className="ak-muted ak-small">not live</span>,
                  <span key="c" className="ak-small">{t.changelog}</span>,
                  <span key="va" className="ak-small">{Object.entries(t.variables).map(([k, v]) => `${k}: ${v}`).join(' · ')}</span>,
                  <Mono key="o">{t.outputSchema}</Mono>,
                  <span key="a" className="ak-small">{t.author} · {t.date}</span>,
                  <details key="t"><summary className="ak-small">{t.text.length} chars</summary><pre className="ak-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--paper-sunk)', padding: 12 }}>{t.text}</pre></details>,
                ];
              })}
            />
          </div>
        ))}
      </Section>
    </Page>
  );
}
