/** Global e2e setup (run with tsx): seed a SUPER_ADMIN staff account and write its TOTP secret for the admin spec. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createStaff } from '@arkiv/auth';
import { closeAll, ownerPool } from '@arkiv/db';

const email = `e2e-${Date.now().toString(36)}@arkiv.test`;
const password = 'e2e correct horse battery staple';
const s = await createStaff({ email, name: 'E2E Admin', password, roles: ['SUPER_ADMIN'] });
await mkdir(new URL('../../.storage/', import.meta.url), { recursive: true });
await writeFile(new URL('../../.storage/e2e-staff.json', import.meta.url), JSON.stringify({ email, password, secret: s.totpSecret }));
// A previous interrupted run must not leave a kill switch on (e.g. read-only would block the funnel spec).
await ownerPool()`update feature_flags set enabled = false where key like 'kill.%'`;
// Nor may an earlier run's sign-ins leave this machine over the per-IP sign-in budget (10 per 15 minutes): the
// browsers here all sign in from loopback, so a re-run inside the same window would be answered with a challenge.
await ownerPool()`delete from rate_limits where key in ('login:ip:127.0.0.1', 'login:ip:::1', 'login:ip:::ffff:127.0.0.1')`;
await closeAll();
