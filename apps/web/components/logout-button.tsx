'use client';

import { api } from '@arkiv/ui/client';

export function LogoutButton({ label = 'Log out', next, className = 'ak-textbtn' }: { label?: string; next?: string; className?: string }) {
  return (
    <button
      className={className}
      onClick={async () => {
        const r = await api<{ next: string }>('/api/auth/logout', {}).catch(() => ({ next: '/' }));
        window.location.assign(next ?? r.next);
      }}
    >
      {label}
    </button>
  );
}
