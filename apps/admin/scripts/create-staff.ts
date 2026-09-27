/**
 * Bootstrap the first SUPER_ADMIN (there is no sign-up for staff).
 * Usage: pnpm --filter @arkiv/admin create-staff founder@arkiv.app "Founder Name" 'a-long-password' SUPER_ADMIN
 * Prints the TOTP secret once; add it to an authenticator app.
 */
import { createStaff } from '@arkiv/auth';
import { closeAll } from '@arkiv/db';

const [email, name, password, roles = 'SUPER_ADMIN'] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error('usage: create-staff <email> <name> <password> [ROLE,ROLE]');
  process.exit(1);
}
const r = await createStaff({ email, name, password, roles: roles.split(',') as never });
console.log(`staff ${r.staffId}\nTOTP secret: ${r.totpSecret}\n${r.otpauth}`);
await closeAll();
