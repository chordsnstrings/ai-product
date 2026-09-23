import { passkeyLoginOptions } from '@arkiv/auth';
import { json, route } from '@/lib/http';

export const POST = route(async () => json(await passkeyLoginOptions()));
