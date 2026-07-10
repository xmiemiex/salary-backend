import { actorFromRequest } from './current-actor.decorator';

describe('CurrentActor', () => {
  it('reads actor from request.actor first', () => {
    const actor = { userId: 'actor-user', roleCode: 'finance', permissions: ['employee.manage'] };

    expect(actorFromRequest({ actor, user: { userId: 'user', roleCode: 'employee', permissions: [] } })).toBe(actor);
  });

  it('falls back to request.user', () => {
    const user = { userId: 'user', roleCode: 'employee', permissions: ['salary.view_self'] };

    expect(actorFromRequest({ user })).toBe(user);
  });
});
