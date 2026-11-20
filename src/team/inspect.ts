/**
 * One-call introspection for an agent: its project, visible personas, teams with roster, active tasks and what it may do
 *
 * Read-only, compact JSON (prompt and memory only as lengths/counts). Caller from injected context: an agent sees its project (agents.project_id), the personas of that level (system + its project's), the teams it is on or that its person owns; a person sees own teams, optionally filtered by projectId. `can` tells per action (create, personaCreate, hire, activate, rate) whether the caller may do it now and why; `next` lists the functions to call next. Use before building a team programmatically (team.personaCreate → team.create → team.activate) and after, to check the roster.
 * @param opts.teamId Only this team (roster, tasks and per-team rights).
 * @param opts.projectId Project to look at; default the calling agent's project. 'system' or a project id; a person without it sees every level.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Only this team (roster, tasks and per-team rights). */
        teamId?: string;
        /** Project to look at; default the calling agent's project. 'system' or a project id; a person without it sees every level. */
        projectId?: string;
    },
): Promise<{
    caller: { kind: 'user' | 'agent'; id: string; ownerUserId: string | null; projectId: string | null; projectTitle: string | null; persona: string | null };
    personas: Array<{ name: string; displayName: string; scope: 'system' | 'project'; projectId: string | null; role: string; version: number; promptChars: number; memos: number; currentAgentId: string | null; teams: string[]; rating: { avg: number; count: number } | null }>;
    teams: Array<{ id: string; title: string; status: 'draft' | 'active' | 'archived'; version: number; supervisorAgentId: string; projectId: string | null; mine: boolean; roster: Array<{ agentId: string | null; persona: string | null; role: string; active: boolean }>; tasks: Record<string, number>; active: Array<{ id: string; title: string; status: string; assignee: string | null }> }>;
    can: Record<'create' | 'personaCreate' | 'hire' | 'activate' | 'rate', { ok: boolean; why: string }>;
    next: string[];
}> {
    type Row = Record<string, any>;
    const q = async (sql: string, params: unknown[] = []) => await ctx.fns.procs.db.select({ sql, params }) as Row[];
    const actor = await ctx.fns.team.resolveActor({});
    let ownerUserId: string | null = actor.kind === 'user' ? actor.id : null;
    let callerProject: string | null = null, myPersona: string | null = null;
    if (actor.kind === 'agent') {
        const a = (await q("SELECT created_by, project_id, meta->'persona'->>'name' AS persona FROM agents WHERE id=?", [actor.id]))[0];
        ownerUserId = a?.created_by != null ? String(a.created_by) : null;
        callerProject = a?.project_id != null ? String(a.project_id) : null;
        myPersona = a?.persona ?? null;
    }
    const projectId = opts.projectId?.trim() || callerProject;
    const projectTitle = projectId && projectId !== 'system' ? ((await q('SELECT title FROM projects WHERE id=?', [projectId]))[0]?.title ?? null) : null;

    // Persona levels (scope/project_id) exist once the persona-level migration ran; before it every persona is 'system'.
    const hasScope = (await q("SELECT 1 FROM information_schema.columns WHERE table_schema='team' AND table_name='persona' AND column_name='scope'")).length > 0;
    const hasDisplay = (await q("SELECT 1 FROM information_schema.columns WHERE table_schema='team' AND table_name='persona' AND column_name='display_name'")).length > 0;
    const scopeCols = (hasScope ? 'p.scope, p.project_id' : "'system' AS scope, NULL::text AS project_id") + (hasDisplay ? ', p.display_name' : ', NULL::text AS display_name');
    const pWhere: string[] = [], pParams: unknown[] = [];
    if (hasScope && projectId) { pWhere.push("(p.scope='system' OR p.project_id=?)"); pParams.push(projectId); }
    if (!hasScope && ownerUserId) { pWhere.push('p.owner_user_id=?'); pParams.push(ownerUserId); }
    const pRows = await q(`SELECT p.name, ${scopeCols}, p.role, p.version, length(p.prompt) AS prompt_chars, p.current_agent_id,
        (SELECT count(*) FROM team.persona_memo m WHERE m.persona_name=p.name AND m.deleted_at IS NULL) AS memos,
        COALESCE((SELECT array_agg(tp.team_id ORDER BY tp.team_id) FROM team.team_persona tp WHERE tp.persona_name=p.name AND tp.active), '{}') AS teams
        FROM team.persona p ${pWhere.length ? 'WHERE ' + pWhere.join(' AND ') : ''} ORDER BY p.name`, pParams);
    const rating = new Map<string, { avg: number; count: number }>();
    try {
        const r = await ctx.fns.team.ratings({ groupBy: 'persona', scope: 'all', recent: 0 });
        for (const x of r.personas) if (x.persona) rating.set(x.persona, { avg: Math.round(x.avg * 10) / 10, count: x.count });
    } catch { /* ratings are optional context */ }
    const personas = pRows.map(p => ({ name: String(p.name), displayName: String(p.display_name || p.name), scope: (p.scope === 'project' ? 'project' : 'system') as 'system' | 'project', projectId: p.project_id ?? null, role: String(p.role ?? ''), version: Number(p.version), promptChars: Number(p.prompt_chars ?? 0), memos: Number(p.memos ?? 0), currentAgentId: p.current_agent_id ?? null, teams: (p.teams ?? []).map(String), rating: rating.get(String(p.name)) ?? null }));

    // Teams: owned by the caller's person, or with the caller on the roster. Project of a team = its supervisor session's project.
    const tWhere = ['(t.owner_user_id=? OR EXISTS (SELECT 1 FROM team.member m WHERE m.team_id=t.id AND m.agent_id=?))'];
    const tParams: unknown[] = [ownerUserId ?? '', actor.kind === 'agent' ? actor.id : ''];
    if (opts.teamId) { tWhere.push('t.id=?'); tParams.push(opts.teamId); }
    else if (projectId && projectId !== 'system') { tWhere.push('(sa.project_id=? OR sa.project_id IS NULL)'); tParams.push(projectId); }
    const tRows = await q(`SELECT t.id, t.title, t.status, t.version, t.supervisor_agent_id, t.owner_user_id, sa.project_id FROM team.team t LEFT JOIN agents sa ON sa.id=t.supervisor_agent_id WHERE ${tWhere.join(' AND ')} ORDER BY (t.status='archived'), t.created_at DESC LIMIT 20`, tParams);
    if (opts.teamId && !tRows.length) throw new Error(`inspect: team ${opts.teamId} not found or not yours — call team.inspect({}) to list teams you can see`);
    const ids = tRows.map(t => String(t.id));
    const [mem, tp, cnt, act] = ids.length ? await Promise.all([
        q('SELECT team_id, agent_id, persona, role, active FROM team.member WHERE team_id = ANY(?::text[]) ORDER BY role, agent_id', [ids]),
        q('SELECT team_id, persona_name, active FROM team.team_persona WHERE team_id = ANY(?::text[]) ORDER BY persona_name', [ids]),
        q('SELECT team_id, status, count(*)::int AS n FROM team.task WHERE team_id = ANY(?::text[]) GROUP BY 1,2', [ids]),
        q("SELECT team_id, id, title, status, assignee_agent_id FROM team.task WHERE team_id = ANY(?::text[]) AND status NOT IN ('done','cancelled','todo') ORDER BY status, rank NULLS LAST, id", [ids]),
    ]) : [[], [], [], []];
    const teams = tRows.map(t => {
        const id = String(t.id);
        const roster: Array<{ agentId: string | null; persona: string | null; role: string; active: boolean }> = mem.filter(m => m.team_id === id).map(m => ({ agentId: String(m.agent_id), persona: m.persona ?? null, role: String(m.role ?? ''), active: !!m.active }));
        for (const p of tp.filter(p => p.team_id === id)) if (!roster.some(r => r.persona === p.persona_name)) roster.push({ agentId: null, persona: String(p.persona_name), role: personas.find(x => x.name === p.persona_name)?.role ?? '', active: !!p.active });
        return { id, title: String(t.title), status: t.status, version: Number(t.version), supervisorAgentId: String(t.supervisor_agent_id), projectId: t.project_id ?? null, mine: ownerUserId != null && String(t.owner_user_id) === ownerUserId,
            roster, tasks: Object.fromEntries(cnt.filter(c => c.team_id === id).map(c => [String(c.status), Number(c.n)])),
            active: act.filter(a => a.team_id === id).slice(0, 15).map(a => ({ id: String(a.id), title: String(a.title).slice(0, 80), status: String(a.status), assignee: a.assignee_agent_id ?? null })) };
    });

    // Rights. Owner-only commands open to an agent acting for its person once team.resolveOwnerActor exists.
    const isUser = actor.kind === 'user';
    let onBehalf: { ok: boolean; why: string };
    if (isUser) onBehalf = { ok: true, why: 'signed-in owner' };
    else if (typeof (ctx.fns.team as any).resolveOwnerActor === 'function') {
        try { const o = await (ctx.fns.team as any).resolveOwnerActor({}); onBehalf = { ok: true, why: `agent acting for ${o?.onBehalfOf ?? ownerUserId}` }; }
        catch (e: any) { onBehalf = { ok: false, why: String(e?.message ?? e).slice(0, 160) }; }
    } else onBehalf = { ok: false, why: 'owner-only: the person does it on /team/ (agent-on-behalf not available here)' };
    const focus = opts.teamId ? teams[0] : teams.find(t => t.status !== 'archived');
    let ownsFocus = !!focus?.mine;
    // A roster member agent does not inherit owner authority unless it created the team (resolveOwnerActor.teamOwner).
    if (focus && !isUser && onBehalf.ok) { try { ownsFocus = !!(await (ctx.fns.team as any).resolveOwnerActor({ teamId: focus.id }))?.teamOwner; } catch { ownsFocus = false; } }
    // An agent activates only when the owner's maintenance cron grant already exists (team.resolveOwnerActor rule); otherwise the person activates on /team/.
    let grantOk = isUser;
    if (!isUser && ownerUserId) { try { grantOk = (await q('SELECT 1 FROM cron_grants WHERE task_name=? LIMIT 1', ['team-maintenance:' + ownerUserId])).length > 0; } catch { grantOk = false; } }
    const supervises = !isUser && !!focus && focus.supervisorAgentId === actor.id;
    const can = {
        create: onBehalf,
        personaCreate: onBehalf,
        hire: !focus ? { ok: false, why: 'no team yet' } : (ownsFocus && onBehalf.ok) || supervises ? { ok: true, why: supervises ? `supervisor of ${focus.id}` : `owner of ${focus.id}` } : { ok: false, why: `owner or supervisor of ${focus.id} only` },
        activate: !focus ? { ok: false, why: 'no team yet' } : focus.status !== 'draft' ? { ok: false, why: `${focus.id} is ${focus.status}, not draft` } : ownsFocus && onBehalf.ok && grantOk ? { ok: true, why: `owner of ${focus.id}` } : ownsFocus && onBehalf.ok ? { ok: false, why: 'no team-maintenance cron grant yet: the person activates on /team/' } : { ok: false, why: isUser ? 'not your team' : onBehalf.why },
        rate: isUser ? { ok: true, why: 'signed-in person' } : { ok: false, why: 'only the person rates (team.rate); agent: team.accept as manager' },
    };
    const next: string[] = [];
    if (!personas.length || !teams.length) next.push(can.personaCreate.ok ? `team.personaCreate({ name, role${hasScope ? ", scope: 'project'" : ''} })` : 'ask the person to create personas on /team/personas');
    if (!teams.length) next.push(can.create.ok ? 'team.create({ teamId, requestKey, title, goal, supervisorAgentId: <your id>, members: [{ agentId: <your id>, role, responsibilities }], personas: [{ name, role }] })' : 'ask the person to create a team on /team/');
    if (focus?.status === 'draft') next.push(can.activate.ok ? `team.activate({ teamId: '${focus.id}', requestKey, expectedVersion: ${focus.version} })` : `ask the person to activate ${focus.id} on /team/`);
    if (focus?.status === 'active') next.push(`team.delegate({ agent, persona, title, human, details }) — give work to ${focus.id}`, `team.inspect({ teamId: '${focus.id}' }) — roster and tasks`);
    return {
        caller: { kind: actor.kind, id: actor.id, ownerUserId, projectId: callerProject ?? (isUser ? projectId : null), projectTitle, persona: myPersona },
        personas, teams, can, next,
    };
}
