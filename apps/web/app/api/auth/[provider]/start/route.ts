import { NextResponse } from 'next/server';
import { startOAuth } from '@arkiv/auth';
import { resolveProvisional } from '@arkiv/core';
import { errorResponse } from '@/lib/http';
import { provisionalToken } from '@/lib/session';

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== 'google' && provider !== 'apple') return new NextResponse('Not found', { status: 404 });
  try {
    const next = new URL(req.url).searchParams.get('next');
    const url = await startOAuth(provider, { redirectTo: next && next.startsWith('/') && !next.startsWith('//') ? next : null, provisionalWorkspaceId: await resolveProvisional(await provisionalToken()) });
    return NextResponse.redirect(url);
  } catch (e) {
    return errorResponse(e);
  }
}
