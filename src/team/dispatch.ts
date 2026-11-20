/**
 * Hand a team task to its persona: reuse the persona's free live session or start a new one
 *
 * Supervisor (agent) or owner. The task is a team.task row in backlog (todo, give persona) or assigned (persona = persona of the assignee session; e.g. after review changes). Instructions stay within the plan limit (brief shrinks first, an over-long task text is cut with a mark). A current session archived automatically (agent.archiveCompleted) but not retired counts as alive: it is unarchived and reused. Session choice: the persona's current session when it is alive, still on the roster and free (no other open team task, its delegated plan finished) or already the assignee → it gets a fresh plan with this task (plan task id = team task id) and a message with the task text. Otherwise a new session is started with agent.delegate under the supervisor (brief with the persona block from team.brief), bound to the persona with personaBind (current_agent_id; the open tasks of a dead previous session move to it; a live busy previous session keeps its own work), and the task is assigned to it. Writes team.task_link(session, taskId) so team.reportTask of that plan task submits the team task for review. Returns the team task id, the session id, how it was chosen and the persona.
 * @param opts.teamId Team identifier.
 * @param opts.taskId Team task to hand out.
 * @param opts.persona Persona name; required for a backlog task, defaults to the persona of the assignee.
 * @param opts.note Extra text for the session, e.g. the owner's comment when work is returned.
 * @param opts.agent Live supervisor agent (manager); defaults to the stored supervisor session.
 * @param opts.model Model for a new session; defaults to the persona model, then the supervisor's.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team identifier. */
        teamId: string;
        /** Team task to hand out. */
        taskId: string;
        /** Persona name; required for a backlog task, defaults to the persona of the assignee. */
        persona?: string;
        /** Extra text for the session, e.g. the owner's comment when work is returned. */
        note?: string;
        /** Live supervisor agent (manager); defaults to the stored supervisor session. */
        agent?: types.agent.Agent;
        /** Model for a new session; defaults to the persona model, then the supervisor's. */
        model?: string;
    },
): Promise<{ taskId: string; id: string; status: string; persona: string; mode: 'reuse' | 'new' }> {
    type Row = Record<string, any>;
    const teamId = String(opts.teamId ?? '').trim(), taskId = String(opts.taskId ?? '').trim();
    if (!teamId || !taskId) throw new Error('team.dispatch: teamId and taskId required');
    const load = async () => {
        const g = await ctx.fns.team.get({ teamId });
        const t = g.tasks.find(x => x.id === taskId) as Row | undefined;
        if (!t) throw new Error('team.dispatch: no task ' + taskId + ' in ' + teamId);
        return { g, t };
    };
    let { g, t } = await load();
    if (g.team.status !== 'active') throw new Error('team.dispatch: team is not active');
    if (!['todo', 'assigned'].includes(String(t.status))) throw new Error('team.dispatch: task is ' + t.status + ', only backlog or assigned tasks are handed out');
    let name = String(opts.persona ?? '').trim();
    if (!name && t.assignee_agent_id) name = (await ctx.fns.team.personaGet({ agentId: String(t.assignee_agent_id), revisions: 0 }))?.name ?? '';
    if (!name) throw new Error('team.dispatch: persona required (task has no persona assignee)');
    { // visibility: the team supervisor's project sees system personas and its own project personas
        let pj: string | null = null;
        try { pj = ((await ctx.fns.procs.db.select({ sql: 'SELECT a.project_id FROM team.team t JOIN agents a ON a.id = t.supervisor_agent_id WHERE t.id = ?', params: [teamId] }) as Row[])[0]?.project_id ?? null); } catch { /* host agents table without project_id */ }
        const rp = await ctx.fns.team.personaResolve({ name, ...(pj ? { projectId: String(pj) } : {}) });
        if (rp) name = rp.name;
    }
    const p = await ctx.fns.team.personaGet({ name, revisions: 0 });
    if (!p) throw new Error('team.dispatch: no persona ' + name);
    if (!(await ctx.fns.procs.db.select({ sql: 'SELECT 1 FROM team.team_persona WHERE team_id=? AND persona_name=? AND active', params: [teamId, name] })).length) throw new Error('team.dispatch: ' + name + ' is not in team ' + teamId);
    const supId = String(g.team.supervisor_agent_id);
    const sup = opts.agent?.id === supId ? opts.agent : ((ctx.state as any).agent?.[supId] ?? await ctx.fns.session.load({ id: supId }));
    if (!sup) throw new Error('team.dispatch: supervisor session ' + supId + ' not found');
    const key = (s: string) => 'dispatch:' + taskId + ':' + s + ':' + Bun.randomUUIDv7();

    // Is the current session alive, on the roster and free?
    const cur = p.currentAgentId;
    let alive = false, free = false;
    let revive = false;
    if (cur) {
        const a = (await ctx.fns.procs.db.select({ sql: 'SELECT archived_at, scratchpad FROM agents WHERE id=?', params: [cur] }) as Row[])[0];
        const member = g.members.some((m: Row) => m.agent_id === cur && m.active && m.left_at == null);
        // auto-archived by agent.archiveCompleted (idle finished child) but not retired → still the persona's session: unarchive and reuse
        if (a && a.archived_at != null && member) { try { revive = !(await ctx.fns.procs.db.select({ sql: 'SELECT 1 FROM team.persona_session WHERE agent_id=? AND ended_at IS NOT NULL', params: [cur] }) as Row[]).length; } catch { revive = false; } }
        alive = !!a && (a.archived_at == null || revive) && member;
        if (alive) {
            const sp = typeof a!.scratchpad === 'string' ? JSON.parse(a!.scratchpad || '{}') : (a!.scratchpad ?? {});
            const others = g.tasks.filter(x => x.assignee_agent_id === cur && x.id !== taskId && !['done', 'cancelled'].includes(String(x.status)));
            const finished = !sp.delegation || sp.delegation.status === 'ready';
            free = t.assignee_agent_id === cur || (!others.length && finished);
        }
    }
    // session.plan caps instructions at 12000: the brief gets what the task text leaves (persona block shrinks first, marked); an over-long task text is cut with a mark, never a throw.
    const LIMIT = 11800;
    const text = (brief: string) => {
        const fixed = `Это задача команды ${teamId}, id ${taskId}. Плановая задача с тем же id. Перед session.done вызови team.reportTask({ taskId: '${taskId}', report }) — это сдаёт задачу команды на ревью; потом agent.finishTask с тем же отчётом.`;
        let body = String(t.instructions) + (opts.note?.trim() ? '\n\nКомментарий: ' + opts.note.trim() : '');
        const room = LIMIT - String(t.title).length - fixed.length - brief.length - 10;
        if (body.length > room) body = body.slice(0, Math.max(0, room - 120)) + `\n[задание обрезано на ${body.length - Math.max(0, room - 120)} символов — полностью: team.tasks({ teamId: '${teamId}' })]`;
        return [String(t.title), '', body, '', fixed, '', brief].join('\n').slice(0, 11990);
    };
    const briefBudget = Math.max(3500, Math.min(8000, LIMIT - String(t.title).length - String(t.instructions ?? '').length - (opts.note?.length ?? 0) - 400));
    let id: string, mode: 'reuse' | 'new';
    if (alive && free) {
        id = cur!; mode = 'reuse';
        if (t.assignee_agent_id !== id) {
            ({ g, t } = await load());
            await ctx.fns.team.taskAssign({ teamId, requestKey: key('assign'), expectedVersion: Number(t.version), taskId, assigneeAgentId: id });
        }
        if (revive) { await ctx.fns.session.unarchive({ id }); try { await ctx.fns.events.refreshAgentMeta({ agentId: supId, section: 'team', reason: 'team-dispatch-unarchive' }); } catch {} }
        const brief = await ctx.fns.team.brief({ agentId: id, taskId, managerAgentId: supId, query: String(t.title) + '\n' + String(t.instructions ?? ''), maxChars: briefBudget });
        const instructions = text(brief);
        const live: Row | undefined = (ctx.state as any).agent?.[id];
        const out: any = await ctx.fns.session.mutateScratchpad({ id, mutate: (sp: Row, now: number) => {
            sp.plan = { version: 1, title: String(t.title).slice(0, 300), tasks: [{ id: taskId, title: String(t.title).slice(0, 300), instructions, status: 'active', startedAt: now, activeSince: now, elapsedMs: 0, completedAt: null }], createdAt: now, updatedAt: now, pausedAt: null };
            if (sp.delegation) { sp.delegation.status = 'working'; delete sp.delegation.summary; delete sp.delegation.result; }
            return true;
        } });
        if (live) { live.scratchpad = out.scratchpad; try { await ctx.fns.session.syncAgentState({ agent: live as any }); } catch {} }
        await ctx.fns.agent.message({ agent: sup, to: id, text: 'Новая задача от менеджера (план обновлён):\n\n' + instructions });
    } else {
        mode = 'new';
        const brief = await ctx.fns.team.brief({ persona: name, taskId, managerAgentId: supId, query: String(t.title) + '\n' + String(t.instructions ?? ''), maxChars: briefBudget });
        const model = opts.model ?? p.model ?? undefined;
        const r = await ctx.fns.agent.delegate({ agent: sup, title: `${name}: ${String(t.title)}`.slice(0, 200), tasks: [{ id: taskId, title: String(t.title).slice(0, 300), instructions: text(brief) }], ...(model ? { model } : {}) });
        id = r.id;
        // Project binding: a project persona → its project, otherwise the supervisor's project (agent.delegate does not carry project_id).
        let projectId: string | null = null;
        try { const pr = (await ctx.fns.procs.db.select({ sql: 'SELECT scope, project_id FROM team.persona WHERE name = ?', params: [name] }) as Row[])[0]; if (pr?.scope === 'project' && pr.project_id) projectId = String(pr.project_id); } catch { /* scope columns not migrated yet */ }
        if (!projectId) projectId = ((await ctx.fns.procs.db.select({ sql: 'SELECT project_id FROM agents WHERE id = ?', params: [supId] }) as Row[])[0]?.project_id ?? null);
        if (projectId) await ctx.fns.project.assign({ project: String(projectId), agentId: id, keepWorkspace: true });
        // Persona face and meta on the new session (agent.delegate has no meta option); team.persona stays the source of truth.
        const meta = { persona: { name, role: p.role, teamId } };
        await ctx.fns.procs.db.run({ sql: "UPDATE agents SET meta = COALESCE(meta::jsonb,'{}'::jsonb) || ?::jsonb WHERE id = ?", params: [JSON.stringify(meta), id] });
        try { if (p.icon) await ctx.fns.chat.setIcon({ id, svg: p.icon }); else await ctx.fns.chat.setIcon({ id, emoji: [...name][0]!.toUpperCase(), background: '#475569' }); } catch {}
        try { await ctx.fns.events.refreshAgentMeta({ agentId: id, section: 'all', reason: 'team.dispatch persona' }); } catch {}
        ({ g, t } = await load());
        await ctx.fns.team.executeCommand({ teamId, requestKey: key('bind'), expectedVersion: Number(g.team.version), command: { action: 'personaBind', name, agentId: id, moveOpen: !alive } });
        ({ g, t } = await load());
        if (t.assignee_agent_id !== id) await ctx.fns.team.taskAssign({ teamId, requestKey: key('assign'), expectedVersion: Number(t.version), taskId, assigneeAgentId: id });
    }
    await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.task_link(agent_id,plan_task_id,team_id,task_id,persona_name,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id,plan_task_id) DO UPDATE SET team_id=EXCLUDED.team_id, task_id=EXCLUDED.task_id, persona_name=EXCLUDED.persona_name, created_at=EXCLUDED.created_at', params: [id, taskId, teamId, taskId, name, Date.now()] });
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { taskId, id, status: 'assigned', persona: name, mode };
}
