import { describe, expect, test } from 'bun:test';
import indexGet from '../src/team/$route__GET';
import detailGet from '../src/team/$route_$id_GET';
import createPost from '../src/team/$route__POST';
import commandPost from '../src/team/$route_$id_command_POST';

// HTTP handler unit/contract tests, NOT E2E: every runtime procedure is a
// recorded mock. No server, real session, database, worker, or live mutation.
// ACL tests verify response translation; domain authorization is tested elsewhere.
type Call = { name: string; opts: any };
const origin = 'https://team.test';
const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)> & \'"';
const escaped = Bun.escapeHTML(hostile);
function fixture() {
  return {
    team: { id: 't1', owner_user_id: 'owner', title: 'Title', goal: 'Goal', status: 'draft', version: 7, supervisor_agent_id: 'super', next_seq: 1 },
    members: [{ agent_id: 'super', role: 'supervisor', responsibilities: 'Review', active: true }],
    tasks: [] as any[], deliveries: [] as any[],
  };
}
function harness() {
  const calls: Call[] = [];
  const data = fixture();
  const state = {
    data, events: [] as any[], getError: null as Error | null, configureError: null as Error | null,
    readiness: { ready: false, running: false, tracked: false, legacyRequiresDrain: true, reason: 'Verified cron handoff pending' },
  };
  const record = (name: string, fn: (opts: any) => any) => async (opts: any) => {
    calls.push({ name, opts });
    return fn(opts);
  };
  const ctx: any = { fns: {
    team: {
      list: record('list', () => [data.team]),
      get: record('get', () => { if (state.getError) throw state.getError; return state.data; }),
      timeline: record('timeline', () => state.events),
      configureMaintenance: record('configureMaintenance', () => { if (state.configureError) throw state.configureError; return { configured: true }; }),
      executeCommand: record('executeCommand', () => ({ ok: true })),
      create: record('create', () => ({ teamId: 't1' })),
    },
    cron: { workerReadiness: record('workerReadiness', () => state.readiness) },
    // POST create is CSRF-gated (Origin differs behind the mesh proxy); a forged request has no valid token.
    auth: { verifyCsrf: async () => false },
  } };
  return { ctx, calls, state };
}
const routes = [
  { name: 'GET index', fn: indexGet, method: 'GET', path: '/team' },
  { name: 'GET detail', fn: detailGet, method: 'GET', path: '/team/t1' },
  { name: 'POST create', fn: createPost, method: 'POST', path: '/team' },
  { name: 'POST command', fn: commandPost, method: 'POST', path: '/team/t1/command' },
] as const;
const form = (action = 'activate') => new URLSearchParams({ action, expectedVersion: '7', requestKey: 'intent-1' }).toString();
function request(route: typeof routes[number], headers: Record<string, string> = {}, body = form()) {
  return new Request(origin + route.path, {
    method: route.method,
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    ...(route.method === 'POST' ? { body } : {}),
  });
}
function session(req: Request, user = 'owner'): any { return { user: { id: user }, req }; }
async function command(h: ReturnType<typeof harness>, body = form()) {
  const req = request(routes[3], {}, body);
  return commandPost(h.ctx, session(req), { req, params: { id: 't1' } });
}
async function page(h: ReturnType<typeof harness>, user = 'owner', query = '') {
  const req = new Request(origin + '/team/t1' + query);
  const result = await detailGet(h.ctx, session(req, user), { req, params: { id: 't1' } });
  expect(result).not.toBeInstanceOf(Response);
  if (result instanceof Response) throw new Error(`Expected HTML, got ${result.status}`);
  return result.main;
}

describe('HTTP authentication and same-origin form boundary (mock runtime)', () => {
  for (const route of routes) {
    for (const identity of ['no session', 'no user', 'no trusted request']) {
      test(`${route.name}: ${identity} returns 401 before runtime calls`, async () => {
        const h = harness(), req = request(route);
        const actor: any = identity === 'no session' ? null : identity === 'no user' ? { req } : { user: { id: 'owner' } };
        const res = await route.fn(h.ctx, actor, { req, params: { id: 't1' } });
        expect(res).toBeInstanceOf(Response);
        expect((res as Response).status).toBe(401);
        expect(h.calls).toEqual([]);
      });
    }
  }
  for (const route of routes.filter(r => r.method === 'POST')) {
    for (const mode of ['missing Origin', 'foreign Origin', 'cross-site']) {
      test(`${route.name}: ${mode} returns 403 without runtime calls`, async () => {
        const h = harness(), req = request(route);
        if (mode === 'missing Origin') req.headers.delete('origin');
        if (mode === 'foreign Origin') req.headers.set('origin', 'https://evil.test');
        if (mode === 'cross-site') req.headers.set('sec-fetch-site', 'cross-site');
        const res = await route.fn(h.ctx, session(req), { req, params: { id: 't1' } });
        expect((res as Response).status).toBe(403);
        expect(h.calls).toEqual([]);
      });
    }
    for (const contentType of [null, 'application/json', 'multipart/form-data']) {
      test(`${route.name}: content-type ${contentType} returns 415`, async () => {
        const h = harness(), req = request(route);
        if (contentType === null) req.headers.delete('content-type'); else req.headers.set('content-type', contentType);
        const res = await route.fn(h.ctx, session(req), { req, params: { id: 't1' } });
        expect((res as Response).status).toBe(415);
        expect(h.calls).toEqual([]);
      });
    }
  }
});

describe('team access response contracts', () => {
  for (const route of [routes[1], routes[3]]) {
    for (const id of ['unknown-team', 'foreign-team']) {
      test(`${route.name}: denied ${id} maps to non-disclosing 404`, async () => {
        const h = harness(), req = request(route);
        h.state.getError = new Error('Team not found or access denied');
        const res = await route.fn(h.ctx, session(req), { req, params: { id } });
        expect((res as Response).status).toBe(404);
        expect(h.calls).toEqual([{ name: 'get', opts: { teamId: id } }]);
      });
    }
  }
  test('command additionally rejects a readable non-owner team with 403', async () => {
    const h = harness(); h.state.data.team.owner_user_id = 'someone-else';
    expect((await command(h)).status).toBe(403);
    expect(h.calls.map(c => c.name)).toEqual(['get']);
  });
});

describe('activation and maintenance wiring, no live mutations', () => {
  test('owner activation configures maintenance before command with unchanged intent', async () => {
    const h = harness(), res = await command(h);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/team/t1');
    expect(h.calls).toEqual([
      { name: 'get', opts: { teamId: 't1' } },
      { name: 'configureMaintenance', opts: {} },
      { name: 'executeCommand', opts: { teamId: 't1', requestKey: 'intent-1', expectedVersion: 7, command: { action: 'activate' } } },
    ]);
  });
  test('configuration failure returns 409 and never activates', async () => {
    const h = harness(); h.state.configureError = new Error('Injected grant failure');
    const res = await command(h);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Injected grant failure');
    expect(h.calls.map(c => c.name)).toEqual(['get', 'configureMaintenance']);
  });
  test('repair submits configuration only, without requiring command version/key', async () => {
    const h = harness();
    expect((await command(h, 'action=configureMaintenance')).status).toBe(303);
    expect(h.calls.map(c => c.name)).toEqual(['get', 'configureMaintenance']);
  });
  test('repair failure returns 409 without domain command', async () => {
    const h = harness(); h.state.configureError = new Error('Injected grant failure');
    expect((await command(h, 'action=configureMaintenance')).status).toBe(409);
    expect(h.calls.map(c => c.name)).toEqual(['get', 'configureMaintenance']);
  });
  test('archive does not configure maintenance', async () => {
    const h = harness(); expect((await command(h, form('archive'))).status).toBe(303);
    expect(h.calls.map(c => c.name)).toEqual(['get', 'executeCommand']);
  });
});

describe('HTML contracts', () => {
  test('index escapes hostile title/goal/supervisor and encodes team URL', async () => {
    const h = harness(); Object.assign(h.state.data.team, { id: 'x/"<>', title: hostile, goal: hostile, supervisor_agent_id: hostile });
    const req = request(routes[0]);
    const res = await indexGet(h.ctx, session(req), { req, params: {} });
    if (res instanceof Response) throw new Error('Expected HTML');
    expect(res.main).toContain(escaped);
    expect(res.main).not.toContain(hostile);
    expect(res.main).toContain('/team/' + encodeURIComponent('x/"<>'));
  });
  test('detail escapes task, member, event payload, errors and filter attributes', async () => {
    const h = harness();
    Object.assign(h.state.data.team, { title: hostile, goal: hostile, supervisor_agent_id: hostile });
    Object.assign(h.state.data.members[0]!, { agent_id: hostile, role: hostile, responsibilities: hostile });
    h.state.data.tasks.push({ id: hostile, title: hostile, instructions: hostile, acceptance_criteria: hostile, blocked_reason: hostile, assignee_agent_id: hostile, status: 'blocked', version: 1 });
    h.state.data.deliveries.push({ id: hostile, recipient_agent_id: hostile, event_id: hostile, attempts: 1, status: 'failed', last_error: hostile });
    h.state.events.push({ seq: 1, kind: hostile, actor_kind: hostile, actor_id: hostile, timestamp: 0, text: hostile, payload: { note: hostile } });
    const html = await page(h, 'owner', '?' + new URLSearchParams({ taskId: hostile, kind: hostile }));
    expect(html).toContain(escaped);
    expect(html).not.toContain(hostile);
    expect(html).toContain(Bun.escapeHTML(JSON.stringify({ note: hostile }, null, 2)));
    expect(html).toContain(`name="taskId" value="${escaped}"`);
    expect(html).toContain(`name="kind" value="${escaped}"`);
  });
  for (const status of ['draft', 'active', 'archived']) {
    for (const user of ['owner', 'reader']) {
      test(`${status} ${user}: repair grant form visibility`, async () => {
        const h = harness(); h.state.data.team.status = status;
        const html = await page(h, user);
        expect(html.includes('name="action" value="configureMaintenance"')).toBe(user === 'owner' && status !== 'archived');
      });
    }
  }
  test('pending delivery displays honest cron readiness warning', async () => {
    const h = harness(); h.state.data.team.status = 'active';
    h.state.data.deliveries.push({ status: 'pending' });
    const html = await page(h);
    expect(html).toContain('1 pending or claimed');
    expect(html).toContain('Registration is not proof of delivery');
    expect(html).toContain('NOT READY');
    expect(html).toContain('running false');
    expect(html).toContain('tracked false');
    expect(html).toContain('legacy drain true');
    expect(h.calls.some(c => c.name === 'workerReadiness')).toBe(true);
    expect(html).toContain(h.state.readiness.reason);
  });
  test('ready tracked worker is displayed distinctly and reason is escaped', async () => {
    const h = harness();
    Object.assign(h.state.readiness, { ready: true, running: true, tracked: true, legacyRequiresDrain: false, reason: hostile });
    const html = await page(h);
    expect(html).not.toContain('NOT READY');
    expect(html).toContain('running true');
    expect(html).toContain('tracked true');
    expect(html).toContain('legacy drain false');
    expect(html).toContain(escaped);
    expect(html).not.toContain(hostile);
  });
});
