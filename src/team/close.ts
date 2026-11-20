/**
 * The executor closes its task after the owner's rating: final accept on the owner's behalf, then the session leaves if that was its last task
 *
 * Called by the assignee session itself (agent actor = the task's assignee; for a delegated child plan task = that child) after it read the owner's rating (team.rate → team.reflect message) and reflected it into memory. Allowed only when the owner rated the task AFTER its last hand-in (team.rating.rated_at ≥ the current submission / plan task completedAt); otherwise it throws «Нет оценки владельца после последней сдачи». Team task in review: team.executeCommand approve (review → done) with byOwnerRating — reviewer authority and the team.accept mark are the rater's, in the same transaction. Delegated plan task: team.accept mark of the rater (takes over a manager's first-pass mark). Posts «<persona> закрыла задачу «…» (★N)» to the chronicle. When it was the session's last open task (team: no other open task of the assignee; plan: every task done and accepted by a person) the session leaves without an extra turn: team.retire with quiet — team.retireFinish archives it as soon as it goes idle (result `retire`). Idempotent for an already closed task (status 'already').
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task (the caller itself).
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task (the caller itself). */
        agentId?: string;
    },
): Promise<{ status: 'closed' | 'already'; taskId: string; stars: number; last: boolean; retire: unknown }> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    const taskId = String(opts.taskId ?? '').trim(); const agentId = String(opts.agentId ?? '').trim();
    if (!taskId) throw new Error('taskId required');
    if (actor.kind !== 'agent') throw new Error('team.close: закрывает исполнитель по оценке владельца; владелец только оценивает (team.rate)');
    const me = actor.id; const now = Date.now();
    const rating = (await ctx.fns.procs.db.select({ sql: 'SELECT stars, comment, rated_by, rated_at FROM team.rating WHERE agent_id = ? AND task_id = ?', params: [agentId, taskId] }).catch(() => []) as Row[])[0];
    let title = taskId; let last = false; let teamId: string | null = null;
    if (agentId) {
        if (agentId !== me) throw new Error('team.close: закрыть может только исполнитель задачи');
        const a = (await ctx.fns.procs.db.select({ sql: 'SELECT scratchpad FROM agents WHERE id = ?', params: [agentId] }) as Row[])[0];
        if (!a) throw new Error('Agent not found');
        const sp = typeof a.scratchpad === 'string' ? JSON.parse(a.scratchpad || '{}') : (a.scratchpad ?? {});
        const tasks = (sp.plan?.tasks ?? []) as Row[];
        const t = tasks.find(x => x?.id === taskId);
        if (!t) throw new Error('No plan task ' + taskId);
        title = String(t.title ?? taskId);
        const acc0 = (await ctx.fns.procs.db.select({ sql: 'SELECT accepted_by FROM team.accept WHERE agent_id = ? AND task_id = ?', params: [agentId, taskId] }).catch(() => []) as Row[])[0];
        if (acc0 && !/^manager:/.test(String(acc0.accepted_by))) return { status: 'already', taskId, stars: Number(rating?.stars ?? 0), last: false, retire: null };
        if (t.status !== 'done') throw new Error('Задача не сдана: сначала сдай её (team.reportTask, session.done)');
        if (!rating || Number(rating.rated_at) < (Number(t.completedAt) || 0)) throw new Error('Нет оценки владельца после последней сдачи');
        await ctx.fns.procs.db.run({ sql: 'CREATE TABLE IF NOT EXISTS team.accept (agent_id text NOT NULL, task_id text NOT NULL, accepted_by text NOT NULL, accepted_at bigint NOT NULL, PRIMARY KEY (agent_id, task_id))' });
        await ctx.fns.procs.db.run({ sql: "INSERT INTO team.accept (agent_id, task_id, accepted_by, accepted_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, task_id) DO UPDATE SET accepted_by = EXCLUDED.accepted_by, accepted_at = EXCLUDED.accepted_at WHERE team.accept.accepted_by LIKE 'manager:%'", params: [agentId, taskId, String(rating.rated_by), now] });
        const acc = new Set((await ctx.fns.procs.db.select({ sql: "SELECT task_id FROM team.accept WHERE agent_id = ? AND accepted_by NOT LIKE 'manager:%'", params: [agentId] }) as Row[]).map(x => String(x.task_id)));
        last = tasks.every(x => x?.status === 'done' && acc.has(String(x.id)));
    } else {
        const found = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ?', params: [taskId] }) as Row[];
        let team: Row | undefined; let task: Row | undefined;
        for (const r of found) { try { const g = await ctx.fns.team.get({ teamId: String(r.team_id) }); task = g.tasks.find((y: Row) => y.id === taskId); if (task) { team = g; break; } } catch {} }
        if (!task || !team) throw new Error('Task not found or access denied');
        if (String(task.assignee_agent_id ?? '') !== me) throw new Error('team.close: закрыть может только исполнитель задачи');
        title = String(task.title ?? taskId); teamId = String(team.team.id);
        if (task.status === 'done') return { status: 'already', taskId, stars: Number(rating?.stars ?? 0), last: false, retire: null };
        if (task.status !== 'review' || !task.current_submission_id) throw new Error('Задача не на ревью: сначала сдай её');
        // executeCommand re-checks the rating against the current submission inside the transaction
        await ctx.fns.team.executeCommand({ teamId, requestKey: 'team-close:' + Bun.randomUUIDv7(), expectedVersion: Number(task.version), command: { action: 'taskTransition', taskId, transition: { action: 'approve', submissionId: String(task.current_submission_id), reason: 'Закрыто исполнителем по оценке владельца ★' + Number(rating?.stars ?? 0), byOwnerRating: true } } });
        const open = await ctx.fns.procs.db.select({ sql: "SELECT 1 FROM team.task WHERE assignee_agent_id = ? AND id <> ? AND status NOT IN ('done','cancelled') LIMIT 1", params: [me, taskId] }) as Row[];
        last = !open.length;
    }
    const stars = Number(rating?.stars ?? 0);
    const p = (await ctx.fns.procs.db.select({ sql: 'SELECT p.name, s.team_id FROM team.persona_session s JOIN team.persona p ON p.name = s.persona_name WHERE s.agent_id = ? UNION ALL SELECT name, NULL FROM team.persona WHERE current_agent_id = ? LIMIT 1', params: [me, me] }).catch(() => []) as Row[])[0];
    const who = p ? String(p.name) : me;
    try { await ctx.fns.procs.db.run({ sql: "INSERT INTO team.post (id, author_kind, author_id, team_id, task_id, kind, text, created_at) VALUES (?, 'agent', ?, ?, ?, 'note', ?, ?)", params: [Bun.randomUUIDv7(), me, teamId ?? p?.team_id ?? null, agentId ? null : taskId, `${who} закрыла задачу «${title.slice(0, 120)}» (оценка ★${stars})`.slice(0, 280), now] }); } catch {}
    let retire: unknown = null;
    if (last && p) { try { retire = await ctx.fns.team.retire({ agentId: me, reason: 'последняя задача закрыта по оценке ★' + stars, quiet: true, timeoutSec: 300 }); } catch (e) { retire = { error: String((e as Error)?.message ?? e).slice(0, 200) }; } }
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { status: 'closed', taskId, stars, last, retire };
}
