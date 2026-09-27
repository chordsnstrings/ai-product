import { redirect } from 'next/navigation';
import { currentStaff } from '@/lib/staff';
import { LoginForm } from './form';

export default async function Login() {
  if (await currentStaff()) redirect('/');
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 380 }}>
      <p className="ak-label">Arkiv · Staff console</p>
      <h1 className="ak-h2">Sign in</h1>
      <p className="ak-small ak-muted">Staff accounts only. Password plus an authenticator code or a passkey. Every action is audited.</p>
      <LoginForm />
    </div>
  );
}
