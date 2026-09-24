import sharp from 'sharp';
import { ownerPool } from '@arkiv/db';
import { assertEventEnvelope, type EventType, type Role, type WorkspaceState } from '@arkiv/shared';
import type { TenantContext } from './context';

/** Provider injection for suites outside this package (chaos): e.g. a hanging or failing video provider. */
export { MockImage, MockLlm, MockTts, MockVideo, setProviders, type VideoProvider } from '@arkiv/providers';

/** Synthetic product photo: a dropper bottle on a plain background, so cut-out/fingerprint run for real. */
export async function productPhoto(label = 'GLOW SERUM', color = '#C9A27E'): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1250">
    <rect width="1000" height="1250" fill="#FAFAF8"/>
    <rect x="420" y="250" width="160" height="120" rx="12" fill="#222"/>
    <rect x="455" y="170" width="90" height="90" rx="40" fill="#111"/>
    <rect x="330" y="360" width="340" height="620" rx="36" fill="${color}"/>
    <rect x="360" y="560" width="280" height="200" fill="#FFFFFF"/>
    <text x="500" y="650" text-anchor="middle" font-family="Arial" font-size="34" fill="#111">${label}</text>
    <text x="500" y="700" text-anchor="middle" font-family="Arial" font-size="22" fill="#444">30 ml</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

const STRIPES = ['#D94F30', '#2E7D32', '#1565C0', '#F9A825', '#6A1B9A', '#00838F'];

/**
 * The same bottle on a busy, many-coloured background (a lifestyle shot) that border keying can't separate. With
 * `backdrop` it is drawn on one flat colour instead — what a background-removal edit returns — and `dx` moves it.
 */
export async function lifestylePhoto(opts: { backdrop?: string; dx?: number } = {}): Promise<Buffer> {
  const back = opts.backdrop
    ? `<rect width="1000" height="1250" fill="${opts.backdrop}"/>`
    : Array.from({ length: 25 }, (_, i) => `<rect x="${i * 40}" y="0" width="40" height="1250" fill="${STRIPES[i % 6]}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1250">${back}
    <g transform="translate(${opts.dx ?? 0} 0)">
      <rect x="420" y="250" width="160" height="120" rx="12" fill="#222"/>
      <rect x="455" y="170" width="90" height="90" rx="40" fill="#111"/>
      <rect x="330" y="360" width="340" height="620" rx="36" fill="#C9A27E"/>
      <rect x="360" y="560" width="280" height="200" fill="#FFFFFF"/>
      <text x="500" y="650" text-anchor="middle" font-family="Arial" font-size="34" fill="#111">GLOW SERUM</text>
    </g></svg>`;
  const img = sharp(Buffer.from(svg)).removeAlpha();
  return opts.backdrop ? img.png().toBuffer() : img.jpeg({ quality: 92 }).toBuffer();
}

export const ctxFor = (workspaceId: string, userId: string, role: Role = 'OWNER', state: WorkspaceState = 'ACTIVE_FREE'): TenantContext => ({
  workspaceId,
  workspaceState: state,
  role,
  actor: { kind: 'user', id: userId },
  requestId: 'test',
});

/** Events of a workspace that break their registered subject type or required refs (standard §36). */
export async function eventContractProblems(workspaceId: string): Promise<string[]> {
  const rows = await ownerPool()`select type, subject_type, subject_id, refs from events where workspace_id = ${workspaceId} order by seq`;
  const problems: string[] = [];
  for (const r of rows) {
    try {
      assertEventEnvelope(r.type as EventType, r.subject_type ? { type: r.subject_type as string, id: r.subject_id as string } : null, r.refs as Record<string, string>);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  return problems;
}
