import { describe, expect, it } from 'vitest';
import { currentPlanFor } from './pricing';

const ws = (id: string, plan: string | null, state = 'ACTIVE_PAID', role = 'OWNER') => ({ workspace_id: id, slug: `s-${id}`, plan_code: plan, role, state });

describe('pricing page: the visitor’s current plan (plan 03 P11 edge)', () => {
  it('is null without a running plan', () => {
    expect(currentPlanFor([], null)).toBeNull();
    expect(currentPlanFor([ws('a', null, 'ACTIVE_FREE'), ws('b', 'GROWTH', 'CANCELLED')], null)).toBeNull();
  });
  it('prefers the workspace used last, then the first on a plan', () => {
    const list = [ws('a', 'LAUNCH'), ws('b', 'SCALE', 'PAST_DUE', 'MEMBER')];
    expect(currentPlanFor(list, 'b')).toEqual({ slug: 's-b', planCode: 'SCALE', canManage: false });
    expect(currentPlanFor(list, 'zzz')).toEqual({ slug: 's-a', planCode: 'LAUNCH', canManage: true });
  });
});
