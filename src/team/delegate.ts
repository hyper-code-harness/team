/**
 * Hand a task to a child agent with the team rules already inside its instructions
 *
 * Wrapper over agent.delegate for the team manager. When the manager supervises an active team with personas (and no explicit tasks are given), the task is first created in the team backlog (team.taskCreate: title, human --- details) and then handed to the persona by team.dispatch (its free live session, or a new session bound to the persona); the result then carries taskId, teamId and mode. Otherwise (no team) the old behaviour: Builds the instructions as human text + a line `---` + details for the agent + team.brief (the team rules and the current feed), so every child gets the rules in its first message instead of relying on the manager's memory. Without tasks it makes one plan task with a unique id (title slug + short suffix, returned as taskId; old sessions may still have `task`); with tasks the combined text goes in front of the first task's own instructions. The plan limit (12000 characters per task) is never exceeded and never throws: the task text goes whole when it fits, team.brief gets the rest (maxChars, its persona block shrinks first with a «[бриф обрезан…]» mark), and only an over-long details/own-instructions part is cut, with a mark. With persona: the name of an existing persona copies icon and meta.persona from the latest session of that persona; a new name gets meta.persona {name, role?} and a letter icon. Returns the child id and status.
 * @param opts.agent Manager (parent) agent delegating the work.
 * @param opts.title Short title shown for the child and its plan.
 * @param opts.human Task for a person: 1–3 plain sentences, no paths or function names.
 * @param opts.details Details for the agent: files, functions, steps, constraints.
 * @param opts.tasks Ordered plan tasks in the session.plan format; default one task with a unique id (title slug + short suffix), returned as taskId.
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
        /** Ordered plan tasks in the session.plan format; default one task with a unique id (title slug + short suffix), returned as taskId. */
        tasks?: Array<{ id: string; title: string; instructions?: string }>;
        /** Persona name (e.g. "Ян") or {name, role}; an existing name reuses its icon and meta. */
        persona?: string | { name: string; role?: string };
        /** Child model route; omitted inherits the parent model. */
        model?: string;
    },
): Promise<{ id: string; status: string; persona: string | null; taskId?: string; teamId?: string; mode?: 'reuse' | 'new'; projectId?: string }> {
    type Row = Record<string, any>;
    const title = String(opts.title ?? '').trim();
    const human = String(opts.human ?? '').trim();
    if (!title) throw new Error('team.delegate: title is empty');
    if (!human) throw new Error('team.delegate: human is empty');
    if (human.includes('\n---')) throw new Error('team.delegate: human must not contain a --- line');
    const details = String(opts.details ?? '').trim();
    // Persona visibility: system personas + project personas of the manager's project; another project's persona throws «persona X belongs to project Y». The resolved storage key replaces the shown name.
    const rawPersona = typeof opts.persona === 'string' ? opts.persona.trim() : String(opts.persona?.name ?? '').trim();
    let personaKey = rawPersona;
    if (rawPersona) {
        let mgrProject: string | null = null;
        try { mgrProject = ((await ctx.fns.procs.db.select({ sql: 'SELECT project_id FROM agents WHERE id = ?', params: [opts.agent.id] }) as Row[])[0]?.project_id ?? null); } catch { /* host agents table without project_id */ }
        const rp = await ctx.fns.team.personaResolve({ name: rawPersona, ...(mgrProject ? { projectId: String(mgrProject) } : {}) });
        if (rp) personaKey = rp.name;
    }
    // Manager with an active persona team: the task goes to the team backlog first, then to the persona (team.dispatch).
    const teamRows = await ctx.fns.procs.db.select({ sql: "SELECT t.id FROM team.team t WHERE t.supervisor_agent_id = ? AND t.status = 'active' AND EXISTS (SELECT 1 FROM team.team_persona tp WHERE tp.team_id = t.id AND tp.active) ORDER BY t.created_at DESC LIMIT 1", params: [opts.agent.id] }) as Row[];
    if (teamRows[0] && !opts.tasks?.length) {
        const teamId = String(teamRows[0].id);
        const pname = personaKey;
        if (!pname) throw new Error('team.delegate: team ' + teamId + ' is active — name the persona (persona: "Ян")');
        const g = await ctx.fns.team.get({ teamId });
        const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
        const taskId = slug + '-' + Date.now().toString(36);
        await ctx.fns.team.taskCreate({ teamId, requestKey: 'delegate:' + taskId, expectedVersion: Number(g.team.version), taskId, title, instructions: human + '\n---\n' + (details || '(no extra details)'), acceptanceCriteria: 'Сделано то, что написано в задании; отчёт team.reportTask с checks/notDone/next.' });
        const d = await ctx.fns.team.dispatch({ teamId, taskId, persona: pname, agent: opts.agent, ...(opts.model ? { model: opts.model } : {}) });
        return { taskId, id: d.id, status: d.status, persona: d.persona, teamId, mode: d.mode };
    }
    // Unique default id (slug + short suffix): a literal 'task' for every child mixed up ratings and history keyed by (agentId, taskId).
    const defaultId = () => (title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task') + '-' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
    const tasks = (opts.tasks?.length ? opts.tasks : [{ id: defaultId(), title }]).map(t => ({ ...t }));
    const pn = personaKey;
    // session.plan caps instructions at 12000: the task text goes first and whole when it can, the brief gets what is left (its persona block shrinks, marked), and only then the details are cut — marked, never a throw.
    const LIMIT = 11800;
    const first = tasks[0]!;
    const own = String(first.instructions ?? '').trim();
    const textOf = (d: string) => human + '\n---\n' + (d || '(no extra details)');
    const briefBudget = Math.max(3500, Math.min(8000, LIMIT - textOf(details).length - (own ? own.length + 2 : 0) - 2));
    const brief = await ctx.fns.team.brief({ managerAgentId: opts.agent.id, taskId: tasks.map(t => t.id).join(', '), query: title + '\n' + human, maxChars: briefBudget, ...(pn ? { persona: pn } : {}) });
    const fit = (s: string, n: number, what: string) => s.length <= n ? s : s.slice(0, Math.max(0, n - 80)) + `\n[${what} обрезаны на ${s.length - Math.max(0, n - 80)} символов — лимит плана]`;
    let ownPart = own; let det = details;
    const over = () => textOf(det).length + 2 + brief.length + (ownPart ? ownPart.length + 2 : 0) - LIMIT;
    if (over() > 0 && det) det = fit(det, Math.max(500, det.length - over()), 'Детали');
    if (over() > 0 && ownPart) ownPart = fit(ownPart, Math.max(300, ownPart.length - over()), 'Инструкции задачи');
    let head = textOf(det) + '\n\n' + brief;
    if (head.length + (ownPart ? ownPart.length + 2 : 0) > LIMIT) head = fit(head, LIMIT - (ownPart ? ownPart.length + 2 : 0), 'Задание и бриф');
    first.instructions = ownPart ? head + '\n\n' + ownPart : head;

    // persona lookup before the child exists
    const p = typeof opts.persona === 'string' ? { name: personaKey } : opts.persona ? { name: personaKey, role: opts.persona.role } : null;
    let icon: string | null = null; let meta: Row | null = null;
    if (p?.name) {
        const prev = await ctx.fns.procs.db.select({ sql: "SELECT icon, meta FROM agents WHERE meta->'persona'->>'name' = ? ORDER BY created_at DESC LIMIT 1", params: [p.name] }) as Row[];
        if (prev[0]) { icon = prev[0].icon ?? null; meta = typeof prev[0].meta === 'string' ? JSON.parse(prev[0].meta) : prev[0].meta; }
        meta = { ...(meta ?? {}), persona: { ...((meta?.persona as Row) ?? {}), name: p.name, ...(p.role ? { role: p.role } : {}) } };
    }

    const r = await ctx.fns.agent.delegate({ agent: opts.agent, title, tasks, ...(opts.model ? { model: opts.model } : {}) });
    // Project binding: a project persona → its project, otherwise the manager's project (agent.delegate does not carry project_id).
    let projectId: string | null = null;
    if (p?.name) { try { const pr = (await ctx.fns.procs.db.select({ sql: 'SELECT scope, project_id FROM team.persona WHERE name = ?', params: [p.name] }) as Row[])[0]; if (pr?.scope === 'project' && pr.project_id) projectId = String(pr.project_id); } catch { /* scope columns not migrated yet */ } }
    if (!projectId) projectId = ((await ctx.fns.procs.db.select({ sql: 'SELECT project_id FROM agents WHERE id = ?', params: [opts.agent.id] }) as Row[])[0]?.project_id ?? null);
    if (projectId) await ctx.fns.project.assign({ project: String(projectId), agentId: r.id, keepWorkspace: true });
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
    return { id: r.id, status: r.status, persona: p?.name || null, taskId: tasks[0]!.id, ...(projectId ? { projectId: String(projectId) } : {}) };
}
