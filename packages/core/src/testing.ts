import sharp from 'sharp';
import type { Role, WorkspaceState } from '@arkiv/shared';
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

export const ctxFor = (workspaceId: string, userId: string, role: Role = 'OWNER', state: WorkspaceState = 'ACTIVE_FREE'): TenantContext => ({
  workspaceId,
  workspaceState: state,
  role,
  actor: { kind: 'user', id: userId },
  requestId: 'test',
});
