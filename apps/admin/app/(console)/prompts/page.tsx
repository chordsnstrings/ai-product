import * as prompts from '@arkiv/core/prompts';
import { withAdmin } from '@arkiv/db';
import { GOLDEN, staffCan } from '@arkiv/core';
import { ActButton, ActForm } from '@/components/act';
import { dt, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Prompts & evals' };

/** Plan 05 §11: git is the source of prompts (read-only here); evals run golden sets; results gate route changes. */
export default async function Prompts({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const s = await requireStaff('routes.manage');
  const runId = (await searchParams).run;
  const d0 = await withAdmin(async (tx) => ({
    routes: await tx`select task, model, prompt_version, rollout_pct, canary from model_routes order by task`,
    runs: await tx`select r.*, s.name from eval_runs r join staff_users s on s.id = r.created_by order by r.created_at desc limit 30`,
    run: runId && /^[0-9a-f-]{36}$/i.test(runId) ? (await tx`select * from eval_runs where id = ${runId}`)[0] : null,
  }));
  const templates = Object.entries(prompts).filter(([, v]) => typeof v === 'string') as [string, string][];
  return (
    <Page title="Prompt registry & evaluations">
      <Section title="Golden datasets" right={staffCan(s.roles, 'evals.run') ? <span className="ak-row">{Object.keys(GOLDEN).map((dsName) => <ActButton key={dsName} small action="eval.run" payload={{ dataset: dsName }}>Run {dsName}</ActButton>)}</span> : null}>
        <Table head={['Dataset', 'Cases', 'Sample']} rows={Object.entries(GOLDEN).map(([k, v]) => [<Mono key="k">{k}</Mono>, v.length, <span key="s" className="ak-small">{v.slice(0, 3).map((c) => `“${c.input}” → ${c.expect}`).join(' · ')}</span>])} />
      </Section>
      {staffCan(s.roles, 'evals.run') ? (
        <Section title="Eval a route change (required before route.update, valid 7 days)">
          <div className="ak-panel" style={{ maxWidth: 560 }}>
            <ActForm action="eval.run" submit="Run eval" fields={[
              { name: 'task', label: 'Task', type: 'select', options: d0.routes.map((r) => r.task as string) },
              { name: 'model', label: 'Candidate model (empty = current)' },
              { name: 'promptVersion', label: 'Candidate prompt version (empty = current)' },
              { name: 'reason', label: 'Reason', defaultValue: 'route change' },
            ]} />
          </div>
        </Section>
      ) : null}
      <Section title="Eval runs">
        <Table head={['When', 'Task · model · prompt', 'Dataset', 'Status', 'Score', 'Cases', 'By', '']} rows={d0.runs.map((r) => [dt(r.created_at), <Mono key="t">{`${r.task} · ${r.model} · ${r.prompt_version}`}</Mono>, r.dataset as string, <span key="s" className={`ak-chip ${r.status === 'passed' ? 'ak-chip--ok' : r.status === 'failed' ? 'ak-chip--risk' : ''}`}>{r.status as string}</span>, r.score === null ? '—' : pct(Number(r.score)), r.cases as number, r.name as string, <a key="v" href={`/prompts?run=${r.id}`}>view</a>])} empty="No runs yet." />
        {d0.run ? <Table head={['Case', 'Input', 'Expected', 'Got', '']} rows={(d0.run.results as { id: string; input: string; expected: string; got: string; ok: boolean }[]).map((c) => [c.id, c.input, c.expected, c.got, c.ok ? '✓' : '✗'])} /> : null}
      </Section>
      <Section title="Live routes">
        <Table head={['Task', 'Model', 'Prompt version', 'Rollout', 'Canary']} rows={d0.routes.map((r) => {
          const c = r.canary as { model?: string; promptVersion?: string; pct?: number } | null;
          return [<Mono key="t">{r.task as string}</Mono>, <Mono key="m">{r.model as string}</Mono>, <Mono key="p">{r.prompt_version as string}</Mono>, `${r.rollout_pct}%`, c ? <Mono key="c">{`${c.pct}% → ${c.model} · ${c.promptVersion}`}</Mono> : '—'];
        })} />
      </Section>
      <Section title="Templates (from git, read-only)">
        {templates.map(([name, text]) => (
          <details key={name} style={{ marginBottom: 8 }}>
            <summary><Mono>{name}</Mono> <span className="ak-small ak-muted">{text.length} chars</span></summary>
            <pre className="ak-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--paper-sunk)', padding: 12 }}>{text}</pre>
          </details>
        ))}
      </Section>
    </Page>
  );
}
