/**
 * Acts on one «Дальше» item of a task report: return the task to its assignee, or put the item into the backlog
 *
 * Owner (signed-in person) only. The item is report.next[idx] of the task (team task: latest submit report; delegated child: plan task report or finishTask result). kind 'continue' («Вернуть в работу»): team.reopen with «Доделать: <item text>» as the comment — the same assignee continues the same task (team task: changes / continuation task; live child: plan task back to active + message; archived child: a new session of the same persona via team.delegate, linked by reopenOf). kind 'new' («В бэклог»): team.taskCreate into the team backlog (team task: its team; child: the active team supervised by its manager), or, without a team, a notification to the manager asking to create it. Every item fires once: the action is stored in team.next (agent_id '' for team tasks), shows as kind 'next' in team.feed and the task history, and refreshes the 'team' live topic.
 * @param opts.taskId Team task id, or plan task id when agentId is given.
 * @param opts.agentId Delegated child whose plan holds the task.
 * @param opts.idx Index of the item in report.next. @minimum 0
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team task id, or plan task id when agentId is given. */
        taskId: string;
        /** Delegated child whose plan holds the task. */
        agentId?: string;
        /** Index of the item in report.next. @minimum 0 */
        idx: number;
    },
): Promise<{kind:'continue'|'new'; action:string; to:string; title:string; at:number; duplicate:boolean; [k:string]:unknown}> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    if (actor.kind !== 'user') throw new Error('Next steps are activated on behalf of the signed-in person — Агент: оценку/отзыв ставит только человек на /team/; работу дай через team.delegate({agent, persona, title, human, details}); команду и персону агент сессии человека создаёт сам (team.create, team.personaCreate)');
    const taskId = String(opts.taskId ?? '').trim(); const agentId = String(opts.agentId ?? '').trim();
    const idx = Number(opts.idx);
    if (!taskId) throw new Error('taskId required');
    if (!Number.isInteger(idx) || idx < 0) throw new Error('idx must be a non-negative integer');
    const json = (v: unknown): Row => { if (!v) return {}; if (typeof v === 'object') return v as Row; try { return JSON.parse(String(v)); } catch { return {}; } };
    // Self-heal when the migration has not run yet (same DDL as $migration_20291215000100_team_next_rating).
    await ctx.fns.procs.db.run({ sql: "CREATE TABLE IF NOT EXISTS team.next (agent_id text NOT NULL DEFAULT '', task_id text NOT NULL, idx integer NOT NULL, kind text NOT NULL, title text NOT NULL, action text NOT NULL, result jsonb NOT NULL DEFAULT '{}'::jsonb, by_user text NOT NULL, at bigint NOT NULL, PRIMARY KEY (agent_id, task_id, idx))" });
    const prev = await ctx.fns.procs.db.select({ sql: 'SELECT kind, title, action, result, at FROM team.next WHERE agent_id = ? AND task_id = ? AND idx = ?', params: [agentId, taskId, idx] }) as Row[];
    if (prev[0]) { const r = json(prev[0].result); return { kind: prev[0].kind, action: String(prev[0].action), to: String(r.to ?? ''), title: String(prev[0].title), at: Number(prev[0].at), duplicate: true }; }
    const key = 'team-next:' + (agentId || 'team') + ':' + taskId + ':' + idx;
    const at = Date.now();
    let report: Row | null = null; let taskTitle = taskId; let out: Row;
    const pick = (r: Row | null) => { const items = Array.isArray(r?.next) ? r!.next : []; const it = items[idx]; if (!it) throw new Error('В отчёте нет пункта «Дальше» №' + (idx + 1)); return typeof it === 'string' ? { title: it, why: '', kind: 'new' } : { title: String(it.title ?? ''), why: String(it.why ?? ''), kind: it.kind === 'continue' ? 'continue' : 'new' }; };
    const backlog = async (teamId: string, version: number, item: Row, from: string) => {
        const nid = (taskId + '-next-' + (idx + 1)).slice(0, 120);
        const res = await ctx.fns.team.taskCreate({ teamId, requestKey: key, expectedVersion: version, taskId: nid, title: item.title.slice(0, 200), instructions: item.title + (item.why ? '\n\n' + item.why : '') + '\n---\nПункт «Дальше» из отчёта по задаче «' + taskTitle + '» (' + from + ').', acceptanceCriteria: 'Сделано то, что написано в задании; отчёт с notDone/next.' });
        return { action: 'backlog', to: teamId, newTaskId: nid, eventId: res.eventId };
    };
    if (agentId) {
        if (!(await ctx.fns.jobs.canSee({ agentId }))) throw new Error('Not your agent');
        const rows = await ctx.fns.procs.db.select({ sql: 'SELECT id, parent_id, archived_at, scratchpad FROM agents WHERE id = ?', params: [agentId] }) as Row[];
        const a = rows[0]; if (!a) throw new Error('Agent not found');
        const t = (json(a.scratchpad).plan?.tasks ?? []).find((x: Row) => x?.id === taskId);
        if (!t) throw new Error('No plan task ' + taskId);
        taskTitle = String(t.title ?? taskId);
        const r = t.result && typeof t.result === 'object' ? t.result : null;
        // same source and normalization as team.taskView, so idx points at the same item the person clicked
        if (t.report) report = t.report;
        else if (r && (r.report || r.summary || r.done || r.decisions || r.next)) report = await ctx.fns.team.normalizeReport({ report: r.report ?? r, fallbackSummary: String(t.resultSummary ?? '') || undefined });
        const item = pick(report);
        const manager = String(a.parent_id ?? '');
        const archived = a.archived_at != null;
        if (item.kind === 'continue') {
            const re = await ctx.fns.team.reopen({ taskId, agentId, comment: 'Доделать: ' + item.title + (item.why ? ' — ' + item.why : ''), nextIdx: idx });
            out = { action: re.action, to: re.to, toName: re.toName, reopenId: re.reopenId, ...(re.newAgentId ? { newAgentId: re.newAgentId, newTaskId: re.newTaskId } : {}) };
        } else {
            const teams = manager ? await ctx.fns.procs.db.select({ sql: "SELECT id, version FROM team.team WHERE supervisor_agent_id = ? AND owner_user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", params: [manager, actor.id] }) as Row[] : [];
            if (teams[0]) out = await backlog(String(teams[0].id), Number(teams[0].version), item, 'субагент ' + agentId);
            else {
                const to = manager || agentId;
                const sent = await ctx.fns.session.enqueueNotification({ to, key, text: 'Владелец просит поставить в бэклог новую задачу (пункт «Дальше» из отчёта субагента ' + agentId + ' по задаче «' + taskTitle + '»):\n\n' + item.title + (item.why ? '\n' + item.why : ''), originalAuthor: actor.id });
                out = { action: 'askManager', to, messageIdx: sent.messageIdx };
            }
        }
        await ctx.fns.procs.db.run({ sql: "INSERT INTO team.next (agent_id, task_id, idx, kind, title, action, result, by_user, at) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?) ON CONFLICT DO NOTHING", params: [agentId, taskId, idx, item.kind, item.title, out.action, JSON.stringify(out), actor.id, at] });
        try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
        return { kind: item.kind as any, title: item.title, at, duplicate: false, ...out, action: String(out.action), to: String(out.to) };
    }
    const found = await ctx.fns.procs.db.select({ sql: 'SELECT team_id FROM team.task WHERE id = ?', params: [taskId] }) as Row[];
    let team: any = null; let task: Row | undefined;
    for (const r of found) { try { const g = await ctx.fns.team.get({ teamId: String(r.team_id) }); const x = g.tasks.find((y: Row) => y.id === taskId); if (x) { team = g; task = x; break; } } catch {} }
    if (!team || !task) throw new Error('Task not found or access denied');
    const teamId = String(team.team.id); taskTitle = String(task.title);
    const evs = await ctx.fns.procs.db.select({ sql: "SELECT payload FROM team.event WHERE team_id = ? AND task_id = ? AND kind = 'submit' ORDER BY seq DESC LIMIT 1", params: [teamId, taskId] }) as Row[];
    const p = json(evs[0]?.payload); report = p.report ?? p.command?.transition?.report ?? null;
    const item = pick(report);
    const assignee = String(task.assignee_agent_id ?? team.team.supervisor_agent_id);
    if (item.kind === 'continue') {
        const re = await ctx.fns.team.reopen({ taskId, comment: 'Доделать: ' + item.title + (item.why ? ' — ' + item.why : ''), nextIdx: idx });
        out = { action: re.action, to: re.to, toName: re.toName, reopenId: re.reopenId, ...(re.newTaskId ? { newTaskId: re.newTaskId } : {}) };
    } else out = await backlog(teamId, Number(team.team.version), item, 'задача команды ' + taskId);
    await ctx.fns.procs.db.run({ sql: "INSERT INTO team.next (agent_id, task_id, idx, kind, title, action, result, by_user, at) VALUES ('', ?, ?, ?, ?, ?, ?::jsonb, ?, ?) ON CONFLICT DO NOTHING", params: [taskId, idx, item.kind, item.title, out.action, JSON.stringify(out), actor.id, at] });
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { kind: item.kind as any, title: item.title, at, duplicate: false, ...out, action: String(out.action), to: String(out.to) };
}
