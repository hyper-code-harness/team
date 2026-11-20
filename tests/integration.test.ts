import { beforeAll, afterAll, test, expect } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';

// No existing database URL or application context is accepted. This suite owns its
// loopback-only, memory-backed Docker database and removes only that exact container.
const name = `hyper-team-test-${crypto.randomUUID().slice(0, 12)}`;
let sql: any;
let owned = false;
const tx = new AsyncLocalStorage<any>();
const identity = new AsyncLocalStorage<any>();
const faults = new AsyncLocalStorage<string>();
const runtime: Record<string, any> = {};
const notifications: any[] = [];
const messages: any[] = [];
const refreshes: string[] = [];
let grant: any = null;
const root = join(import.meta.dir, '../src/team');
async function docker(...args: string[]) {
  const p = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw new Error(`docker ${args[0]}: ${err}`);
  return out.trim();
}
function guardedURL(port: number) {
  const url = new URL(`postgres://team_test:ephemeral_test_only@127.0.0.1:${port}/team_test`);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/team_test' || !Number.isInteger(port) || port < 1024 || port > 65535 || [5432, 54393].includes(port)) throw new Error('Unsafe database target');
  return url.toString();
}
async function query({ sql: text, params = [] }: any) {
  if (faults.getStore() && text.includes(faults.getStore()!)) throw new Error('Injected write failure');
  let n = 0;
  return (tx.getStore() ?? sql).unsafe(text.replace(/\?/g, () => `$${++n}`), params);
}
const ctx: any = { fns: {
  procs: { events: { refresh: async (o: any) => { refreshes.push(o.topic); if (o.topic === 'boom') throw new Error('x'); } }, db: { select: query, run: query, exec: query, transaction: async ({ fn }: any) => sql.begin((connection: any) => tx.run(connection, fn)) } },
  agent: { current: async () => ({ id: identity.getStore().currentId }), message: async (opts: any) => { messages.push({ from: opts.agent.id, to: opts.to, text: opts.text }); return { delivered: true }; } },
  session: { load: async ({ id }: any) => ({ id, createdBy: id === 'foreign' ? 'someone-else' : 'owner' }), enqueueNotification: async (opts: any) => { notifications.push(opts); return { accepted: true }; } },
  cron: { authority: async () => grant },
  team: new Proxy({}, { get: (_, key: string) => (opts: any) => runtime[key](ctx, identity.getStore()?.session ?? null, opts) }),
} };
const human = (fn: () => any, id = 'owner') => identity.run({ session: { user: { id }, req: {} } }, fn);
const member = (id: string, fn: () => any) => identity.run({ currentId: id, session: { agentId: id, user: { id: 'owner' }, req: {} } }, fn);
let serial = 0;
async function fixture() {
  const id = `integration-${++serial}`;
  const roster = [`${id}-supervisor`, `${id}-worker`, `${id}-other`];
  const create = { teamId: id, requestKey: 'create', title: 'Test', goal: 'Integration', supervisorAgentId: roster[0], members: roster.map(agentId => ({ agentId, role: 'member', responsibilities: 'Test' })) };
  await human(() => ctx.fns.team.create(create));
  await human(() => ctx.fns.team.executeCommand({ teamId: id, requestKey: 'activate', expectedVersion: 1, command: { action: 'activate' } }));
  const command = (command: any, expectedVersion: number, requestKey = crypto.randomUUID()) => ctx.fns.team.executeCommand({ teamId: id, command, expectedVersion, requestKey });
  const add = async (taskId: string) => {
    const rows = await query({ sql: 'SELECT version FROM team.team WHERE id=?', params: [id] });
    return human(() => command({ action: 'taskCreate', taskId, title: 'Task', instructions: 'Do', acceptanceCriteria: 'Pass', assigneeAgentId: roster[1] }, rows[0].version));
  };
  return { id, roster, create, command, add };
}
beforeAll(async () => {
  try {
    let image = '';
    for (const candidate of ['postgres:17', 'postgres:16']) {
      try { await docker('image', 'inspect', candidate); image = candidate; break; } catch { /* Try next cached image; never pull. */ }
    }
    if (!image) throw new Error('No cached Postgres image');
    await docker('run', '-d', '--pull=never', '--name', name, '--memory', '256m', '--cpus', '1', '--network', 'bridge', '--tmpfs', '/var/lib/postgresql/data:rw', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=team_test', '-e', 'POSTGRES_PASSWORD=ephemeral_test_only', '-e', 'POSTGRES_DB=team_test', image);
    owned = true;
    const binding = await docker('port', name, '5432/tcp');
    if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('Unexpected bind');
    const port = Number(binding.split(':')[1]);
    const url = guardedURL(port);
    console.log(JSON.stringify({ disposableContainer: name, image, host: '127.0.0.1', port, database: 'team_test' }));
    sql = new Bun.SQL(url, { max: 10, connectionTimeout: 3, prepare: false });
    let ready = false;
    for (let i = 0; i < 60; i++) { try { await sql.unsafe('SELECT 1'); ready = true; break; } catch { await Bun.sleep(250); } }
    if (!ready) throw new Error('Disposable Postgres did not become ready');
    const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });
    for (const file of new Bun.Glob('*.ts').scanSync(root)) {
      if (/^[A-Z]/.test(file) || file.startsWith('$route')) continue;
      const js = transpiler.transformSync(await Bun.file(join(root, file)).text());
      runtime[file.slice(0, -3)] = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).default;
    }
    await runtime['$migration_20291012000100_team'].up(ctx);
    await runtime['$migration_20291012000100_team'].up(ctx);
    await runtime['$migration_20291020000100_team_queue'].up(ctx);
    await runtime['$migration_20291020000100_team_queue'].up(ctx);
  } catch (error) { if (sql) await sql.close(); if (owned) { await docker('rm', '-f', name); owned = false; } throw error; }
}, 60000);
afterAll(async () => { if (sql) await sql.close(); if (owned) { await docker('rm', '-f', name); console.log(`Removed disposable container ${name}`); } }, 30000);

test('fail-closed URL refuses production/default ports', () => {
  expect(() => guardedURL(54393)).toThrow(); expect(() => guardedURL(5432)).toThrow(); expect(() => guardedURL(NaN)).toThrow();
});
test('creation and command exact replay; conflicting replay changes nothing', async () => {
  const f = await fixture();
  const created = await human(() => ctx.fns.team.create(f.create));
  expect(created.teamVersion).toBe(1);
  await expect(human(() => ctx.fns.team.create({ ...f.create, goal: 'Changed' }))).rejects.toThrow();
  const c = { action: 'say', to: 'all', text: 'Hello' };
  const first = await human(() => f.command(c, 2, 'same'));
  expect(await human(() => f.command(c, 2, 'same'))).toEqual(first);
  await expect(human(() => f.command({ ...c, text: 'Changed' }, 2, 'same'))).rejects.toThrow('conflict');
  expect((await query({ sql: "SELECT * FROM team.event WHERE team_id=? AND kind='say'", params: [f.id] })).length).toBe(1);
});
test('real concurrent team CAS permits exactly one board mutation', async () => {
  const f = await fixture();
  const results = await Promise.allSettled(['a', 'b'].map(s => human(() => f.command({ action: 'taskCreate', taskId: `${f.id}-${s}`, title: s, instructions: 'Do', acceptanceCriteria: 'Pass' }, 2))));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(String((results.find(r => r.status === 'rejected') as any).reason)).toContain('Version conflict');
});
test('real concurrent starts enforce one working slot', async () => {
  const f = await fixture(); const ids = [`${f.id}-a`, `${f.id}-b`];
  for (const id of ids) await f.add(id);
  const results = await Promise.allSettled(ids.map(taskId => member(f.roster[1], () => f.command({ action: 'taskTransition', taskId, transition: { action: 'start' } }, 1))));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(String((results.find(r => r.status === 'rejected') as any).reason)).toContain('working or blocked');
  expect((await query({ sql: "SELECT * FROM team.task WHERE team_id=? AND status='working'", params: [f.id] })).length).toBe(1);
});
test('started assignment immutable, stale submission rejected after changes and resubmit', async () => {
  const f = await fixture(); const taskId = `${f.id}-task`; await f.add(taskId);
  const transition = (transition: any, version: number, actor = f.roster[1]) => member(actor, () => f.command({ action: 'taskTransition', taskId, transition }, version));
  await transition({ action: 'start' }, 1);
  await expect(human(() => f.command({ action: 'taskAssign', taskId, assigneeAgentId: f.roster[2] }, 2))).rejects.toThrow('immutable');
  const first = await transition({ action: 'submit', summary: 'Done', artifacts: [], verification: 'Checked' }, 2);
  await transition({ action: 'changes', submissionId: first.eventId, reason: 'Fix' }, 3, f.roster[0]);
  await expect(human(() => f.command({ action: 'taskAssign', taskId, assigneeAgentId: f.roster[2] }, 4))).rejects.toThrow('immutable');
  await transition({ action: 'start' }, 4);
  const second = await transition({ action: 'submit', summary: 'Fixed', artifacts: [], verification: 'Checked' }, 5);
  await expect(transition({ action: 'approve', submissionId: first.eventId, reason: 'Old' }, 6, f.roster[0])).rejects.toThrow('Stale');
  const approved = await transition({ action: 'approve', submissionId: second.eventId, reason: 'Verified' }, 6, f.roster[0]);
  expect(approved.task.status).toBe('done');
});
test('late command write failure rolls back task/event/outbox/sequence and command', async () => {
  const f = await fixture();
  const snapshot = async () => { const result: any = {}; for (const table of ['team','task','event','delivery','command']) result[table] = await query({ sql: `SELECT * FROM team.${table} WHERE ${table === 'team' ? 'id' : 'team_id'}=? ORDER BY 1`, params: [f.id] }); return JSON.stringify(result); };
  const before = await snapshot();
  await expect(faults.run('INSERT INTO team.command', () => f.add(`${f.id}-rollback`))).rejects.toThrow('Injected');
  expect(await snapshot()).toBe(before);
  await f.add(`${f.id}-rollback`);
});
test('active membership unique across teams, failed activation atomic', async () => {
  const f = await fixture(); const second = { ...f.create, teamId: `${f.id}-second` };
  await human(() => ctx.fns.team.create(second));
  await expect(human(() => ctx.fns.team.executeCommand({ teamId: second.teamId, requestKey: 'activate', expectedVersion: 1, command: { action: 'activate' } }))).rejects.toThrow();
  const rows = await query({ sql: 'SELECT status,version,next_seq FROM team.team WHERE id=?', params: [second.teamId] });
  expect(rows[0].status).toBe('draft'); expect(rows[0].version).toBe(1); expect(Number(rows[0].next_seq)).toBe(1);
});
test('outsider denied, agent cannot inherit owner authority, foreign-owned roster rejected', async () => {
  const f = await fixture();
  await expect(human(() => ctx.fns.team.get({ teamId: f.id }), 'outsider')).rejects.toThrow();
  await expect(member('outsider', () => f.command({ action: 'say', text: 'Spoof', to: 'all' }, 2))).rejects.toThrow();
  await expect(member(f.roster[0], () => f.command({ action: 'archive', reason: 'Spoof owner' }, 2))).rejects.toThrow();
  await expect(identity.run({ session: { kind: 'service', user: { id: 'owner' }, req: {} } }, () => ctx.fns.team.resolveActor({}))).rejects.toThrow();
  await expect(human(() => ctx.fns.team.create({ ...f.create, teamId: `${f.id}-foreign`, supervisorAgentId: 'foreign', members: [{ agentId: 'foreign', role: 'Test', responsibilities: 'Test' }] }))).rejects.toThrow('owned');
});
test('authorized get/list/tasks/sync and exact sequence pagination', async () => {
  const f = await fixture(); await f.add(`${f.id}-task`);
  const all: any[] = []; let afterSeq = 0;
  for (;;) { const page = await member(f.roster[1], () => ctx.fns.team.timeline({ teamId: f.id, afterSeq, limit: 2 })); if (!page.length) break; all.push(...page); afterSeq = Number(page.at(-1).seq); }
  expect(all.map(e => Number(e.seq))).toEqual([1,2,3]);
  const state = await human(() => ctx.fns.team.get({ teamId: f.id })); expect(state.members).toHaveLength(3); expect(state.tasks).toHaveLength(1);
  expect(await member(f.roster[1], () => ctx.fns.team.sync({ teamId: f.id }))).toEqual(state);
  expect(await human(() => ctx.fns.team.tasks({ teamId: f.id }))).toHaveLength(1);
  expect((await human(() => ctx.fns.team.list({}))).some((r: any) => r.id === f.id)).toBe(true);
});
test('archive exact replay works after archived status', async () => {
  const f = await fixture(); const command = { action: 'archive', reason: 'Complete' };
  grant = { ownerId: 'owner', targetFn: 'team.maintenance', transportActor: 'service:test' };
  for (let i = 0; i < 20; i++) { const drained = await ctx.fns.team.flushDeliveries({ limit: 100 }); if (!drained.delivered) break; }
  grant = null;
  const archived = await human(() => f.command(command, 2, 'archive-once'));
  expect(archived.status).toBe('archived');
  expect(await human(() => f.command(command, 2, 'archive-once'))).toEqual(archived);
  await expect(human(() => f.command({ ...command, reason: 'Different' }, 2, 'archive-once'))).rejects.toThrow('conflict');
});
test('deadline batches handle over twenty tasks without starvation or duplicate generations', async () => {
  const f = await fixture();
  for (let n = 0; n < 25; n++) {
    const id = `${f.id}-${n}`; await f.add(id);
    await query({ sql: 'UPDATE team.task SET progress_due_at=1,deadline_generation=7 WHERE id=?', params: [id] });
  }
  grant = { ownerId: 'owner', targetFn: 'team.maintenance', transportActor: 'service:test' };
  expect((await ctx.fns.team.checkDeadlines({ limit: 20 })).escalated).toBe(20);
  expect((await ctx.fns.team.checkDeadlines({ limit: 20 })).escalated).toBe(5);
  expect((await ctx.fns.team.checkDeadlines({ limit: 20 })).escalated).toBe(0);
  const events = await query({ sql: "SELECT causation_id FROM team.event WHERE team_id=? AND kind='deadline'", params: [f.id] });
  expect(events).toHaveLength(25); expect(new Set(events.map((e: any) => e.causation_id)).size).toBe(25);
  grant = null;
});
test('maintenance scoped authority, deadline dedup, mocked delivery only', async () => {
  const f = await fixture(); const taskId = `${f.id}-task`; await f.add(taskId);
  await member(f.roster[1], () => f.command({ action: 'taskTransition', taskId, transition: { action: 'start' } }, 1));
  await query({ sql: 'UPDATE team.task SET progress_due_at=1 WHERE id=?', params: [taskId] });
  grant = null; expect((await ctx.fns.team.maintenance({})).authorized).toBe(false);
  grant = { ownerId: 'owner', targetFn: 'unrelated', transportActor: 'service:test' }; expect((await ctx.fns.team.maintenance({})).authorized).toBe(false);
  grant = { ownerId: 'owner', targetFn: 'team.maintenance', transportActor: 'service:test' };
  const result = await ctx.fns.team.maintenance({}); expect(result.authorized).toBe(true); expect(result.escalated).toBe(1);
  expect((await ctx.fns.team.maintenance({})).escalated).toBe(0);
  expect(notifications.length).toBeGreaterThan(0); expect(notifications[0].key).toStartWith('team.delivery:');
  expect((await query({ sql: "SELECT * FROM team.event WHERE team_id=? AND kind='deadline'", params: [f.id] }))).toHaveLength(1);
  grant = null;
});

const liveAgent = (id: string, fn: () => any) => identity.run({ currentId: id, session: { agent: { id }, agentId: id, user: { id: 'owner' }, req: {} } }, fn);
const teamVersion = async (id: string) => Number((await query({ sql: 'SELECT version FROM team.team WHERE id=?', params: [id] }))[0].version);
test('queue migration is idempotent and paused requires an assignee', async () => {
  const f = await fixture(); await f.add(`${f.id}-t`);
  await expect(query({ sql: "UPDATE team.task SET status='paused', assignee_agent_id=NULL WHERE id=?", params: [`${f.id}-t`] })).rejects.toThrow();
});
test('claim race: two agents claim one backlog task, exactly one wins; dependencies gate claim', async () => {
  const f = await fixture(); const dep = `${f.id}-dep`, taskId = `${f.id}-claim`;
  await human(async () => f.command({ action: 'taskCreate', taskId: dep, title: 'Dep', instructions: 'i', acceptanceCriteria: 'a', groupKey: 'g1' }, await teamVersion(f.id)));
  await human(async () => f.command({ action: 'taskCreate', taskId, title: 'Claim me', instructions: 'i', acceptanceCriteria: 'a', groupKey: 'g1', dependsOn: [dep] }, await teamVersion(f.id)));
  await expect(human(async () => f.command({ action: 'taskCreate', taskId: `${f.id}-bad`, title: 'x', instructions: 'i', acceptanceCriteria: 'a', dependsOn: ['nope'] }, await teamVersion(f.id)))).rejects.toThrow('Unknown dependencies: nope');
  await expect(member(f.roster[1], () => f.command({ action: 'taskTransition', taskId, transition: { action: 'claim' } }, 1))).rejects.toThrow('Dependencies not done');
  await query({ sql: "UPDATE team.task SET status='done', assignee_agent_id=? WHERE id=?", params: [f.roster[2], dep] });
  const results = await Promise.allSettled([f.roster[1], f.roster[2]].map(agent => member(agent, () => f.command({ action: 'taskTransition', taskId, transition: { action: 'claim' } }, 1))));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(String((results.find(r => r.status === 'rejected') as any).reason)).toContain('Version conflict');
  const row = (await query({ sql: 'SELECT * FROM team.task WHERE id=?', params: [taskId] }))[0];
  expect(row.status).toBe('assigned'); expect([f.roster[1], f.roster[2]]).toContain(row.assignee_agent_id);
  expect(row.group_key).toBe('g1'); expect(row.depends_on).toEqual([dep]);
  expect(refreshes).toContain('team');
});
test('preempt pauses current work, heads the queue, emits preempt delivery and an urgent message', async () => {
  const f = await fixture(); const cur = `${f.id}-cur`, next = `${f.id}-next`, urgent = `${f.id}-urgent`;
  await f.add(cur); await f.add(next);
  await member(f.roster[1], () => f.command({ action: 'taskTransition', taskId: cur, transition: { action: 'start' } }, 1));
  await human(async () => f.command({ action: 'taskCreate', taskId: urgent, title: 'Hotfix', instructions: 'i', acceptanceCriteria: 'a' }, await teamVersion(f.id)));
  await expect(member(f.roster[1], async () => f.command({ action: 'preempt', urgentTaskId: urgent, note: 'Prod down', assigneeAgentId: f.roster[1] }, await teamVersion(f.id)))).rejects.toThrow('Supervisor or owner required');
  const before = messages.length; const key = crypto.randomUUID(); const v = await teamVersion(f.id);
  const res: any = await liveAgent(f.roster[0], () => f.command({ action: 'preempt', urgentTaskId: urgent, note: 'Prod down', assigneeAgentId: f.roster[1] }, v, key));
  expect(res.paused.id).toBe(cur); expect(res.interrupt).toEqual({ messaged: true, stopped: false });
  expect(messages.slice(before)).toHaveLength(1); expect(messages.at(-1).to).toBe(f.roster[1]); expect(messages.at(-1).text).toContain('URGENT');
  const rows = Object.fromEntries((await query({ sql: 'SELECT * FROM team.task WHERE team_id=?', params: [f.id] })).map((r: any) => [r.id, r]));
  expect(rows[cur].status).toBe('paused'); expect(rows[cur].paused_note).toBe('Prod down'); expect(rows[cur].progress_due_at).toBeNull();
  expect(rows[urgent].status).toBe('assigned'); expect(rows[urgent].assignee_agent_id).toBe(f.roster[1]);
  expect(Number(rows[urgent].rank)).toBeLessThan(Number(rows[next].rank));
  const ev = await query({ sql: "SELECT e.kind,e.task_id,d.recipient_agent_id FROM team.event e LEFT JOIN team.delivery d ON d.event_id=e.id WHERE e.team_id=? AND e.kind IN ('preempt','pause') ORDER BY e.seq", params: [f.id] });
  expect(ev.map((e: any) => [e.kind, e.task_id])).toEqual([['pause', cur], ['preempt', urgent]]);
  expect(ev[1].recipient_agent_id).toBe(f.roster[1]);
  // Exact replay returns the committed result without a second interrupt.
  const replay: any = await liveAgent(f.roster[0], () => f.command({ action: 'preempt', urgentTaskId: urgent, note: 'Prod down', assigneeAgentId: f.roster[1] }, v, key));
  expect(replay.interrupt).toBeUndefined(); expect(messages.length).toBe(before + 1);
  // Paused does not hold the slot: urgent can start, then the old task resumes only after urgent leaves the slot.
  await member(f.roster[1], () => f.command({ action: 'taskTransition', taskId: urgent, transition: { action: 'start' } }, Number(rows[urgent].version)));
  await expect(member(f.roster[1], () => f.command({ action: 'taskTransition', taskId: cur, transition: { action: 'resume' } }, Number(rows[cur].version)))).rejects.toThrow('working or blocked');
  await member(f.roster[1], () => f.command({ action: 'taskTransition', taskId: urgent, transition: { action: 'submit', summary: 's', artifacts: [], verification: 'v' } }, Number(rows[urgent].version) + 1));
  await member(f.roster[1], () => f.command({ action: 'taskTransition', taskId: cur, transition: { action: 'resume' } }, Number(rows[cur].version)));
  // Owner preempt without an agent session still commits; interrupt reports outbox-only.
  const other = `${f.id}-o`; await f.add(other);
  const o: any = await human(async () => f.command({ action: 'preempt', urgentTaskId: other, note: 'Again' }, await teamVersion(f.id)));
  expect(o.paused.id).toBe(cur); expect(o.interrupt.messaged).toBe(false);
  const pausedRow = (await query({ sql: 'SELECT version FROM team.task WHERE id=?', params: [cur] }))[0];
  await expect(member(f.roster[1], () => f.command({ action: 'taskTransition', taskId: cur, transition: { action: 'cancel', reason: 'x' } }, Number(pausedRow.version)))).rejects.toThrow('Supervisor or owner required');
  await human(() => f.command({ action: 'taskTransition', taskId: cur, transition: { action: 'cancel', reason: 'User changed mind' } }, Number(pausedRow.version)));
  expect((await query({ sql: 'SELECT status FROM team.task WHERE id=?', params: [cur] }))[0].status).toBe('cancelled');
});
test('taskReorder queues work for an assignee and tasks orders by assignee, rank', async () => {
  const f = await fixture(); const a = `${f.id}-a`, b = `${f.id}-b`, c = `${f.id}-c`;
  await f.add(a); await f.add(b);
  await human(async () => f.command({ action: 'taskCreate', taskId: c, title: 'Backlog', instructions: 'i', acceptanceCriteria: 'a' }, await teamVersion(f.id)));
  await expect(member(f.roster[1], () => f.command({ action: 'taskReorder', taskId: c, rank: 1.5 }, 1))).rejects.toThrow('Supervisor or owner required');
  await human(() => f.command({ action: 'taskReorder', taskId: c, rank: 1.5, assigneeAgentId: f.roster[1] }, 1));
  const order = (await member(f.roster[1], () => ctx.fns.team.tasks({ teamId: f.id }))).filter((t: any) => t.assignee_agent_id === f.roster[1]).map((t: any) => t.id);
  expect(order).toEqual([a, c, b]);
  await member(f.roster[1], () => f.command({ action: 'taskTransition', taskId: a, transition: { action: 'start' } }, 1));
  await expect(human(() => f.command({ action: 'taskReorder', taskId: a, rank: 9 }, 2))).rejects.toThrow('never-started');
});
test('submit stores normalized report in event payload; owner feedback reopens review and says otherwise', async () => {
  const f = await fixture(); const taskId = `${f.id}-rep`; await f.add(taskId);
  const transition = (transition: any, version: number, actor = f.roster[1]) => member(actor, () => f.command({ action: 'taskTransition', taskId, transition }, version));
  await transition({ action: 'start' }, 1);
  const sub = await transition({ action: 'submit', summary: 'Done', artifacts: ['a.ts'], verification: 'bun test', report: { summary: 'Did it', decisions: [{ what: 'X', why: 'Y' }, 'Z'], questions: ['Q?'] } }, 2);
  const ev = (await query({ sql: 'SELECT payload FROM team.event WHERE id=?', params: [sub.eventId] }))[0];
  expect(ev.payload.report).toEqual({ summary: 'Did it', done: [], decisions: [{ what: 'X', why: 'Y' }, { what: 'Z', why: '' }], checks: ['bun test'], files: ['a.ts'], questions: ['Q?'], next: [], notDone: [], visuals: [] });
  const back = await human(() => ctx.fns.team.feedback({ taskId, text: 'Не согласен: переделай' }));
  expect(back).toMatchObject({ kind: 'team', delivered: 'changes', reopened: true, to: f.roster[1] });
  const t = (await query({ sql: 'SELECT status FROM team.task WHERE id=?', params: [taskId] }))[0];
  expect(t.status).toBe('assigned');
  const said = await human(() => ctx.fns.team.feedback({ taskId, text: 'ещё одно' }));
  expect(said).toMatchObject({ delivered: 'say', reopened: false });
  const kinds = (await query({ sql: 'SELECT kind, text FROM team.event WHERE task_id=? ORDER BY seq', params: [taskId] })).map((r: any) => r.kind);
  expect(kinds.slice(-2)).toEqual(['changes', 'say']);
  const del = await query({ sql: 'SELECT recipient_agent_id FROM team.delivery d JOIN team.event e ON e.id=d.event_id WHERE e.task_id=? AND e.kind=?', params: [taskId, 'say'] });
  expect(del.map((r: any) => r.recipient_agent_id)).toEqual([f.roster[1]]);
  await expect(member(f.roster[1], () => ctx.fns.team.feedback({ taskId, text: 'x' }))).rejects.toThrow('signed-in person');
});
test('team.reopen: review → changes to the same assignee with the comment; done → continuation task; reopen recorded', async () => {
  const f = await fixture(); const taskId = `${f.id}-ro`; await f.add(taskId);
  const transition = (transition: any, version: number, actor = f.roster[1]) => member(actor, () => f.command({ action: 'taskTransition', taskId, transition }, version));
  await transition({ action: 'start' }, 1);
  await transition({ action: 'submit', summary: 'Done', artifacts: [], verification: 'bun test', report: { summary: 'Did it', notDone: [], next: [] } }, 2);
  await expect(human(() => ctx.fns.team.reopen({ taskId, comment: '  ' }))).rejects.toThrow('комментарий');
  const back = await human(() => ctx.fns.team.reopen({ taskId, comment: 'Нет теста — допиши' }));
  expect(back).toMatchObject({ kind: 'team', action: 'changes', to: f.roster[1], newTaskId: null });
  const t = (await query({ sql: 'SELECT status, assignee_agent_id, version FROM team.task WHERE id=?', params: [taskId] }))[0];
  expect(t.status).toBe('assigned'); expect(t.assignee_agent_id).toBe(f.roster[1]);
  const ch = (await query({ sql: "SELECT text FROM team.event WHERE task_id=? AND kind='changes'", params: [taskId] }))[0];
  expect(ch.text).toContain('Нет теста — допиши');
  const ro = await query({ sql: 'SELECT agent_id, action, comment, to_agent_id FROM team.reopen WHERE task_id=?', params: [taskId] });
  expect(ro).toEqual([{ agent_id: '', action: 'changes', comment: 'Нет теста — допиши', to_agent_id: f.roster[1] }]);
  // finish, approve (done is terminal) → reopen creates a continuation for the same assignee
  await transition({ action: 'start' }, Number(t.version));
  const v2 = (await query({ sql: 'SELECT version FROM team.task WHERE id=?', params: [taskId] }))[0].version;
  const sub = await transition({ action: 'submit', summary: 'Done again', artifacts: [], verification: 'bun test', report: { summary: 'ok' } }, Number(v2));
  const v3 = (await query({ sql: 'SELECT version, current_submission_id FROM team.task WHERE id=?', params: [taskId] }))[0];
  await human(() => f.command({ action: 'taskTransition', taskId, transition: { action: 'approve', submissionId: v3.current_submission_id, reason: 'ok' } }, Number(v3.version)));
  const cont = await human(() => ctx.fns.team.reopen({ taskId, comment: 'Ещё одно' }));
  expect(cont.action).toBe('continueTask'); expect(cont.newTaskId).toBeTruthy();
  const nt = (await query({ sql: 'SELECT status, assignee_agent_id, title, instructions FROM team.task WHERE id=?', params: [cont.newTaskId] }))[0];
  expect(nt.assignee_agent_id).toBe(f.roster[1]); expect(nt.title).toContain('Доделать'); expect(nt.instructions).toContain('Ещё одно');
  expect((await query({ sql: 'SELECT new_task_id FROM team.reopen WHERE task_id=? AND action=?', params: [taskId, 'continueTask'] }))[0].new_task_id).toBe(cont.newTaskId);
  void sub;
});
test('team.rate → persona reflects: live session gets a message, repeat dedups, no session → queued into the brief', async () => {
  // minimal host tables the persona path reads (agents, cron_tasks) + every team migration after the queue one
  await query({ sql: "CREATE TABLE IF NOT EXISTS agents (id text PRIMARY KEY, parent_id text, archived_at bigint, run_state text, scratchpad jsonb, meta jsonb, created_at bigint)" });
  await query({ sql: "CREATE TABLE IF NOT EXISTS cron_tasks (name text PRIMARY KEY, fn text, args jsonb, enabled boolean DEFAULT true)" });
  const raw = { fns: { procs: { db: { exec: ({ sql: text }: any) => sql.unsafe(text) } } } }; // jsonb `?` operator in migrations: no placeholder rewrite
  for (const k of Object.keys(runtime).filter(k => k.startsWith('$migration_') && k > '$migration_20291020000100_team_queue').sort()) await runtime[k].up(raw);
  ctx.fns.cron.add = async (o: any) => { await query({ sql: 'INSERT INTO cron_tasks(name, fn, args) VALUES (?, ?, ?::jsonb) ON CONFLICT (name) DO UPDATE SET args = EXCLUDED.args, enabled = true', params: [o.name, o.fn, JSON.stringify(o.args)] }); return o; };
  const f = await fixture(); const worker = f.roster[1];
  const done = async (taskId: string) => {
    await f.add(taskId);
    const tr = (transition: any, version: number) => member(worker, () => f.command({ action: 'taskTransition', taskId, transition }, version));
    await tr({ action: 'start' }, 1);
    await tr({ action: 'submit', summary: 'Done', artifacts: [], verification: 'bun test', report: { summary: 'ok' } }, 2);
  };
  const now = Date.now(); const pname = `Рома-${f.id}`;
  await query({ sql: "INSERT INTO agents(id, created_at) VALUES (?, ?)", params: [worker, now] });
  await query({ sql: "INSERT INTO team.persona(name, owner_user_id, current_agent_id, created_at, updated_at) VALUES (?, 'owner', ?, ?, ?)", params: [pname, worker, now, now] });
  await query({ sql: 'INSERT INTO team.persona_session(agent_id, persona_name, started_at) VALUES (?, ?, ?)', params: [worker, pname, now] });
  await f.add(`${f.id}-r0`); // another open task: the rating of r1 accepts it but is not the session's farewell
  const t1 = `${f.id}-r1`; await done(t1);
  const before = notifications.length;
  const r = await human(() => ctx.fns.team.rate({ taskId: t1, stars: 3, comment: 'мало тестов' }));
  expect(r.reflect).toMatchObject({ status: 'sent', persona: pname, to: worker });
  expect(r.closed).toBe(false); // the owner only rates; the executor decides
  expect(notifications.at(-1).text).toContain('team.close'); expect(notifications.at(-1).text).toContain('team.rework');
  expect(notifications.length).toBe(before + 1);
  const note = notifications.at(-1);
  expect(note.to).toBe(worker); expect(note.text).toContain('★3'); expect(note.text).toContain('мало тестов'); expect(note.text).toContain('team.memoSave');
  expect((await query({ sql: "SELECT text FROM team.post WHERE author_id=? AND text LIKE '%рефлексирует%'", params: [worker] })).length).toBe(1);
  // same stars + comment → no second message; changed → message again
  expect((await human(() => ctx.fns.team.rate({ taskId: t1, stars: 3, comment: 'мало тестов' }))).reflect).toMatchObject({ status: 'duplicate' });
  expect(notifications.length).toBe(before + 1);
  expect((await human(() => ctx.fns.team.rate({ taskId: t1, stars: 4, comment: 'мало тестов' }))).reflect).toMatchObject({ status: 'sent' });
  expect(notifications.length).toBe(before + 2);
  // the session writes a memo → reflectFinish posts the diff and marks the feedback reflected
  const inboxId = (r.reflect as any).inboxId;
  expect((await runtime.reflectFinish(ctx, null, { inboxId })).status).toBe('waiting');
  await query({ sql: "INSERT INTO team.persona_rev(id, persona_name, field, author_kind, author_id, path, summary, at) VALUES (?, ?, 'memo', 'agent', ?, 'user/feedback.md', 'мемо user/feedback.md: + больше тестов', ?)", params: [crypto.randomUUID(), pname, worker, Date.now() + 1] });
  const fin = await runtime.reflectFinish(ctx, null, { inboxId });
  expect(fin.status).toBe('reflected'); expect(fin.summary).toContain('user/feedback.md');
  expect((await query({ sql: 'SELECT status FROM team.feedback_inbox WHERE id=?', params: [inboxId] }))[0].status).toBe('reflected');
  // session archived → the next rating waits in the queue and the next brief lists it first
  await query({ sql: 'UPDATE agents SET archived_at=? WHERE id=?', params: [Date.now(), worker] });
  const t2 = `${f.id}-r2`; await done(t2);
  const q = await human(() => ctx.fns.team.rate({ taskId: t2, stars: 2, comment: 'не тот экран' }));
  expect(q.reflect).toMatchObject({ status: 'queued', to: null });
  expect(notifications.length).toBe(before + 2);
  // brief reads SKILL.md next to its file: load it with import.meta.dir pointing at the plugin source
  const src = (await Bun.file(join(root, 'brief.ts')).text()).replaceAll('import.meta.dir', JSON.stringify(root));
  runtime.brief = (await import(`data:text/javascript;base64,${Buffer.from(new Bun.Transpiler({ loader: 'ts', target: 'bun' }).transformSync(src)).toString('base64')}`)).default;
  runtime.feed = async () => ({ working: [], entries: [], cursor: '' });
  ctx.fns.plugins = { readSkill: async () => ({ text: '' }) };
  const brief = await human(() => ctx.fns.team.brief({ persona: pname }));
  expect(brief).toContain('Непрочитанные отзывы владельца (1)'); expect(brief).toContain('★2'); expect(brief).toContain('не тот экран');
  expect((await query({ sql: 'SELECT status FROM team.feedback_inbox WHERE task_id=?', params: [t2] }))[0].status).toBe('briefed');
});

const hostSetup = async () => {
  await query({ sql: "CREATE TABLE IF NOT EXISTS agents (id text PRIMARY KEY, parent_id text, archived_at bigint, run_state text, scratchpad jsonb, meta jsonb, created_at bigint)" });
  await query({ sql: "CREATE TABLE IF NOT EXISTS cron_tasks (name text PRIMARY KEY, fn text, args jsonb, enabled boolean DEFAULT true)" });
  const raw = { fns: { procs: { db: { exec: ({ sql: text }: any) => sql.unsafe(text) } } } };
  for (const k of Object.keys(runtime).filter(k => k.startsWith('$migration_') && k > '$migration_20291020000100_team_queue').sort()) await runtime[k].up(raw);
  ctx.fns.cron.add = async (o: any) => { await query({ sql: 'INSERT INTO cron_tasks(name, fn, args) VALUES (?, ?, ?::jsonb) ON CONFLICT (name) DO UPDATE SET args = EXCLUDED.args, enabled = true', params: [o.name, o.fn, JSON.stringify(o.args)] }); return o; };
  const wakes: any[] = [];
  ctx.fns.jobs = { canSee: async () => true };
  ctx.fns.agent.wake = async (o: any) => { wakes.push(o); return { ok: true }; };
  ctx.fns.session.archive = async ({ id }: any) => { await query({ sql: 'UPDATE agents SET archived_at=? WHERE id=?', params: [Date.now(), id] }); return { ok: true }; };
  return wakes;
};
const personaFixture = async (prefix: string) => {
  const f = await fixture(); const worker = f.roster[1];
  const now = Date.now(); const pname = `${prefix}-${f.id}`;
  await query({ sql: "INSERT INTO agents(id, run_state, created_at) VALUES (?, 'idle', ?)", params: [worker, now] });
  await query({ sql: "INSERT INTO team.persona(name, owner_user_id, current_agent_id, created_at, updated_at) VALUES (?, 'owner', ?, ?, ?)", params: [pname, worker, now, now] });
  await query({ sql: 'INSERT INTO team.persona_session(agent_id, persona_name, team_id, started_at) VALUES (?, ?, ?, ?)', params: [worker, pname, f.id, now] });
  const submit = async (taskId: string) => {
    const tr = (transition: any, version: number) => member(worker, () => f.command({ action: 'taskTransition', taskId, transition }, version));
    const v = Number((await query({ sql: 'SELECT version FROM team.task WHERE id=?', params: [taskId] }))[0].version);
    const st = (await query({ sql: 'SELECT status FROM team.task WHERE id=?', params: [taskId] }))[0].status;
    let n = v; if (st === 'assigned') { await tr({ action: 'start' }, n); n++; }
    await tr({ action: 'submit', summary: 'Done', artifacts: [], verification: 'bun test', report: { summary: 'ok' } }, n);
  };
  return { f, worker, pname, submit };
};
const status = async (taskId: string) => (await query({ sql: 'SELECT status FROM team.task WHERE id=?', params: [taskId] }))[0].status;

test('rate without a rework request → one message; persona reflects → team.close → done + archive; chronicle: оценка → рефлексирует → закрыла → в архиве', async () => {
  const wakes = await hostSetup();
  const { f, worker, pname, submit } = await personaFixture('Даша');
  const t1 = `${f.id}-a1`; await f.add(t1); await submit(t1);
  // close before any rating → error
  await expect(member(worker, () => ctx.fns.team.close({ taskId: t1 }))).rejects.toThrow(/Нет оценки/);
  const notesBefore = notifications.length;
  const r = await human(() => ctx.fns.team.rate({ taskId: t1, stars: 4, comment: 'хорошо, но описания короче' }));
  // the owner only rated: the task is still in review, one message to the executor
  expect(r.closed).toBe(false); expect(await status(t1)).toBe('review');
  expect(r.reflect).toMatchObject({ status: 'sent', to: worker });
  expect(notifications.length).toBe(notesBefore + 1);
  const msg = notifications.at(-1);
  expect(msg.to).toBe(worker); expect(msg.text).toContain('★4'); expect(msg.text).toContain('описания короче'); expect(msg.text).toContain('team.close'); expect(msg.text).toContain('team.rework');
  // the owner cannot close; another agent cannot close
  await expect(human(() => ctx.fns.team.close({ taskId: t1 }))).rejects.toThrow(/исполнитель/);
  await expect(member(f.roster[2], () => ctx.fns.team.close({ taskId: t1 }))).rejects.toThrow(/исполнитель/);
  // the persona reflects (memo) then closes
  await query({ sql: "INSERT INTO team.persona_rev(id, persona_name, field, author_kind, author_id, path, summary, at) VALUES (?, ?, 'memo', 'agent', ?, 'user/feedback.md', 'мемо user/feedback.md: + короче описания', ?)", params: [crypto.randomUUID(), pname, worker, Date.now() + 1] });
  const inboxId = (r.reflect as any).inboxId;
  expect((await runtime.reflectFinish(ctx, null, { inboxId })).status).toBe('reflected');
  const c = await member(worker, () => ctx.fns.team.close({ taskId: t1 }));
  expect(c).toMatchObject({ status: 'closed', stars: 4, last: true });
  expect(await status(t1)).toBe('done');
  expect((await query({ sql: "SELECT accepted_by FROM team.accept WHERE agent_id='' AND task_id=?", params: [t1] }))[0].accepted_by).toBe('owner');
  // quiet retire: no extra turn, archived as soon as idle
  expect(wakes.filter(w => w.id === worker).length).toBe(0);
  expect((await query({ sql: "SELECT args FROM cron_tasks WHERE name=?", params: ['team-retire:' + worker] }))[0].args.quiet).toBe(true);
  const fin = await runtime.retireFinish(ctx, null, { agentId: worker });
  expect(fin.status).toBe('archived');
  expect((await query({ sql: 'SELECT archived_at FROM agents WHERE id=?', params: [worker] }))[0].archived_at).not.toBeNull();
  const posts = (await query({ sql: 'SELECT text FROM team.post WHERE author_id=? ORDER BY created_at, id', params: [worker] })).map((x: any) => x.text);
  expect(posts.some((x: string) => x.includes('рефлексирует по оценке ★4'))).toBe(true);
  expect(posts.some((x: string) => x.includes('вывод по оценке ★4') && x.includes('user/feedback.md'))).toBe(true);
  expect(posts.some((x: string) => x.includes(pname + ' закрыла задачу') && x.includes('★4'))).toBe(true);
  expect(posts.some((x: string) => x.includes('в архиве'))).toBe(true);
  // re-rating the closed task: stars updated, session archived → queued for the brief, nothing to close
  const again = await human(() => ctx.fns.team.rate({ taskId: t1, stars: 5 }));
  expect(again.closed).toBe(false); expect(again.reflect).toMatchObject({ status: 'queued' });
  expect((await query({ sql: "SELECT stars FROM team.rating WHERE agent_id='' AND task_id=?", params: [t1] }))[0].stars).toBe(5);
});

test('rate asking for rework → team.rework → task back in work, same live session; resubmit needs a fresh rating to close', async () => {
  const wakes = await hostSetup();
  const { f, worker, pname, submit } = await personaFixture('Рework');
  const t1 = `${f.id}-w1`; await f.add(t1); await submit(t1);
  await human(() => ctx.fns.team.rate({ taskId: t1, stars: 2, comment: 'доделай тесты на пустой ввод' }));
  const w = await member(worker, () => ctx.fns.team.rework({ taskId: t1 }));
  expect(w).toMatchObject({ status: 'rework', comment: 'доделай тесты на пустой ввод' });
  expect(await status(t1)).toBe('assigned');
  expect((await query({ sql: 'SELECT archived_at FROM agents WHERE id=?', params: [worker] }))[0].archived_at).toBeNull();
  expect((await query({ sql: "SELECT 1 FROM cron_tasks WHERE name=?", params: ['team-retire:' + worker] })).length).toBe(0);
  expect((await query({ sql: "SELECT 1 FROM team.post WHERE author_id=? AND text LIKE ?", params: [worker, pname + ' доделывает по комментарию%'] })).length).toBe(1);
  // resubmitted: the old rating predates the new hand-in → close refused until the owner rates again
  await submit(t1);
  await expect(member(worker, () => ctx.fns.team.close({ taskId: t1 }))).rejects.toThrow(/Нет оценки/);
  await Bun.sleep(5);
  await human(() => ctx.fns.team.rate({ taskId: t1, stars: 5, comment: 'отлично' }));
  expect((await member(worker, () => ctx.fns.team.close({ taskId: t1 }))).status).toBe('closed');
  expect(await status(t1)).toBe('done');
  expect(wakes.length).toBe(0);
});

test('rate of an archived session’s open task → closed at once, feedback queued for the brief; manager accept unchanged; person accept needs stars', async () => {
  await hostSetup();
  const { f, worker, submit } = await personaFixture('Архив');
  const sup = f.roster[0];
  const t1 = `${f.id}-z1`, t2 = `${f.id}-z2`; await f.add(t1); await submit(t1);
  // manager first pass: mark manager:<sup>, task stays in review
  const m = await member(sup, () => ctx.fns.team.accept({ taskId: t1 }));
  expect(m).toMatchObject({ final: false, by: 'manager:' + sup });
  expect(await status(t1)).toBe('review');
  // a person's accept without stars is refused: the owner rates
  await expect(human(() => ctx.fns.team.accept({ taskId: t1 }))).rejects.toThrow(/stars/);
  // session archived → nobody would close it: rate closes on the owner's behalf and queues the feedback
  await query({ sql: 'UPDATE agents SET archived_at=? WHERE id=?', params: [Date.now(), worker] });
  const r = await human(() => ctx.fns.team.accept({ taskId: t1, stars: 3, comment: 'нормально' }));
  expect(r).toMatchObject({ final: true, rating: { stars: 3 } });
  expect(r.reflect).toMatchObject({ status: 'queued' });
  expect(await status(t1)).toBe('done');
  expect((await query({ sql: "SELECT accepted_by FROM team.accept WHERE agent_id='' AND task_id=?", params: [t1] }))[0].accepted_by).toBe('owner');
  // not a persona session (no persona row for this assignee): also closed at once
  const g = await fixture(); const plain = g.roster[1];
  await g.add(t2.replace(f.id, g.id));
  const t3 = t2.replace(f.id, g.id);
  const tr = (transition: any, version: number) => member(plain, () => g.command({ action: 'taskTransition', taskId: t3, transition }, version));
  await tr({ action: 'start' }, 1); await tr({ action: 'submit', summary: 'Done', artifacts: [], verification: 'x', report: { summary: 'ok' } }, 2);
  const q = await human(() => ctx.fns.team.rate({ taskId: t3, stars: 4 }));
  expect(q.closed).toBe(true); expect(await status(t3)).toBe('done');
});
