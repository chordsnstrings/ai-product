'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { themeCookie, type ThemeChoice } from '@/lib/theme';

const OPTIONS: [ThemeChoice, string][] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

/** Light / dark / follow the system (design §2.1). The workspace layout re-renders with the choice. */
export function ThemeToggle({ current, compact }: { current: ThemeChoice; compact?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState<ThemeChoice>(current);
  function choose(c: ThemeChoice) {
    setValue(c);
    document.cookie = themeCookie(c);
    router.refresh();
  }
  return (
    <fieldset className="ak-field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className={compact ? 'ak-sr' : 'ak-label'}>Appearance</legend>
      <div className="ak-row" role="presentation" style={{ gap: compact ? 8 : 16, flexWrap: 'wrap' }}>
        {OPTIONS.map(([k, label]) => (
          <label key={k} className="ak-check" style={{ alignItems: 'center' }}>
            <input type="radio" name="arkiv-theme" value={k} checked={value === k} onChange={() => choose(k)} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
