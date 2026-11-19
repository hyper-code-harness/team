/**
 * Hand a task to a child agent with the team rules already inside its instructions
 *
 * Wrapper over agent.delegate for the team manager. When the manager supervises an active team with personas (and no explicit tasks are given), the task is first created in the team backlog (team.taskCreate: title, human --- details) and then handed to the persona by team.dispatch (its free live session, or a new session bound to the persona); the result then carries taskId, teamId and mode. Otherwise (no team) the old behaviour: Builds the instructions as human text + a line `---` + details for the agent + team.brief (the team rules and the current feed), so every child gets the rules in its first message instead of relying on the manager's memory. Without tasks it makes one plan task with id `task`; with tasks the combined text goes in front of the first task's own instructions. With persona: the name of an existing persona copies icon and meta.persona from the latest session of that persona; a new name gets meta.persona {name, role?} and a letter icon. Returns the child id and status.
 * @param opts.agent Manager (parent) agent delegating the work.
 * @param opts.title Short title shown for the child and its plan.
 * @param opts.human Task for a person: 1–3 plain sentences, no paths or function names.
 * @param opts.details Details for the agent: files, functions, steps, constraints.
 * @param opts.tasks Ordered plan tasks in the session.plan format; default one task with id "task".
 * @param opts.persona Persona name (e.g. "Ян") or {name, role}; an existing name reuses its icon and meta.
 * @param opts.model Child model route; omitted inherits the parent model.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Manager (parent) agent delegating the work. */
        agent: types.agent.Agent;
        /** Short title shown for the child and its plan. */
        title: string;
        /** Task for a person: 1–3 plain sentences, no paths or function names. */
        human: string;
        /** Details for the agent: files, functions, steps, constraints. */
        details?: string;
        /** Ordered plan tasks in the session.plan format; default one task with id "task". */
        tasks?: Array<{ id: string; title: string; instructions?: string }>;
        /** Persona name (e.g. "Ян") or {name, role}; an existing name reuses its icon and meta. */
        persona?: string | { name: string; role?: string };
        /** Child model route; omitted inherits the parent model. */
        model?: string;
    },
): Promise<{ id: string; status: string; persona: string | null; taskId?: string; teamId?: string; mode?: 'reuse' | 'new' }> {
    type Row = Record<string, any>;
    const title = String(opts.title ?? '').trim();
    const human = String(opts.human ?? '').trim();
    if (!title) throw new Error('team.delegate: title is empty');
    if (!human) throw new Error('team.delegate: human is empty');
    if (human.includes('\n---')) throw new Error('team.delegate: human must not contain a --- line');
    const details = String(opts.details ?? '').trim();
    // Manager with an active persona team: the task goes to the team backlog first, then to the persona (team.dispatch).
    const teamRows = await ctx.fns.procs.db.select({ sql: "SELECT t.id FROM team.team t WHERE t.supervisor_agent_id = ? AND t.status = 'active' AND EXISTS (SELECT 1 FROM team.team_persona tp WHERE tp.team_id = t.id AND tp.active) ORDER BY t.created_at DESC LIMIT 1", params: [opts.agent.id] }) as Row[];
    if (teamRows[0] && !opts.tasks?.length) {
        const teamId = String(teamRows[0].id);
        const pname = typeof opts.persona === 'string' ? opts.persona.trim() : String(opts.persona?.name ?? '').trim();
        if (!pname) throw new Error('team.delegate: team ' + teamId + ' is active — name the persona (persona: "Ян")');
        const g = await ctx.fns.team.get({ teamId });
        const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
        const taskId = slug + '-' + Date.now().toString(36);
        await ctx.fns.team.taskCreate({ teamId, requestKey: 'delegate:' + taskId, expectedVersion: Number(g.team.version), taskId, title, instructions: human + '\n---\n' + (details || '(no extra details)'), acceptanceCriteria: 'Сделано то, что написано в задании; отчёт team.reportTask с checks/notDone/next.' });
        const d = await ctx.fns.team.dispatch({ teamId, taskId, persona: pname, agent: opts.agent, ...(opts.model ? { model: opts.model } : {}) });
        return { taskId, id: d.id, status: d.status, persona: d.persona, teamId, mode: d.mode };
    }
    const tasks = (opts.tasks?.length ? opts.tasks : [{ id: 'task', title }]).map(t => ({ ...t }));
    const pn = typeof opts.persona === 'string' ? opts.persona.trim() : String(opts.persona?.name ?? '').trim();
    const brief = await ctx.fns.team.brief({ managerAgentId: opts.agent.id, taskId: tasks.map(t => t.id).join(', '), query: title + '\n' + human, ...(pn ? { persona: pn } : {}) });
    const head = human + '\n---\n' + (details || '(no extra details)') + '\n\n' + brief;
    const first = tasks[0]!;
    first.instructions = first.instructions?.trim() ? head + '\n\n' + first.instructions.trim() : head;

    // persona lookup before the child exists
    const p = typeof opts.persona === 'string' ? { name: opts.persona.trim() } : opts.persona ? { name: String(opts.persona.name ?? '').trim(), role: opts.persona.role } : null;
    let icon: string | null = null; let meta: Row | null = null;
    if (p?.name) {
        const prev = await ctx.fns.procs.db.select({ sql: "SELECT icon, meta FROM agents WHERE meta->'persona'->>'name' = ? ORDER BY created_at DESC LIMIT 1", params: [p.name] }) as Row[];
        if (prev[0]) { icon = prev[0].icon ?? null; meta = typeof prev[0].meta === 'string' ? JSON.parse(prev[0].meta) : prev[0].meta; }
        meta = { ...(meta ?? {}), persona: { ...((meta?.persona as Row) ?? {}), name: p.name, ...(p.role ? { role: p.role } : {}) } };
    }

    const r = await ctx.fns.agent.delegate({ agent: opts.agent, title, tasks, ...(opts.model ? { model: opts.model } : {}) });
    if (p?.name && meta) {
        // agent.start takes meta, agent.delegate does not; the child row was just created by this call.
        await ctx.fns.procs.db.run({ sql: 'UPDATE agents SET meta = ?::jsonb WHERE id = ? AND parent_id = ?', params: [JSON.stringify(meta), r.id, opts.agent.id] });
        try {
            if (icon) await ctx.fns.chat.setIcon({ id: r.id, svg: icon });
            else await ctx.fns.chat.setIcon({ id: r.id, emoji: [...p.name][0]!.toUpperCase(), background: '#475569' });
        } catch {}
        try { await ctx.fns.events.refreshAgentMeta({ agentId: r.id, section: 'all', reason: 'team.delegate persona' }); } catch {}
        // Bind the session to the persona (team.persona_session): without it personaSave/memoSave reject the session as «not the persona» and the brief finds no persona.
        await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.persona_session(agent_id,persona_name,team_id,started_at) SELECT ?, name, NULL, ? FROM team.persona WHERE name=? ON CONFLICT(agent_id) DO NOTHING', params: [r.id, Date.now(), p.name] });
    }
    return { id: r.id, status: r.status, persona: p?.name || null };
}
