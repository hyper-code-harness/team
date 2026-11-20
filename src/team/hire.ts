/**
 * Hire a new agent into an active team on the fly.
 *
 * Supervisor or owner only. Creates a dedicated persistent session (child of the supervisor, empty transcript, team visibility) with the passport in its system prompt and agents.meta.persona, adds it to team.member with the persona, emits a public memberHire event and kicks the newcomer off with the passport. The newcomer gets the passport, not the history. Exact retries with the same requestKey return the original result without a second session.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Stable intent key; reuse only for exact retries.
 * @param opts.expectedVersion Current team version. @minimum 1
 * @param opts.persona Passport: display name, role, what it can do (skills) and what it may do (allowed).
 * @param opts.brief First instructions for the newcomer.
 * @param opts.model Model for the new session; defaults to the supervisor's model.
 * @param opts.workspaceDir Workspace for the new session; defaults to the supervisor's workspace.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team identifier. */
        teamId: string;
        /** Stable intent key; reuse only for exact retries. */
        requestKey: string;
        /** Current team version. @minimum 1 */
        expectedVersion: number;
        /** Passport: display name, role, what it can do (skills) and what it may do (allowed). */
        persona: {name:string; role:string; skills?:string[]; allowed?:string[]};
        /** First instructions for the newcomer. */
        brief?: string;
        /** Model for the new session; defaults to the supervisor's model. */
        model?: string;
        /** Workspace for the new session; defaults to the supervisor's workspace. */
        workspaceDir?: string;
    },
): Promise<Record<string,unknown>> {
    const actor=await ctx.fns.team.resolveActor({});
    const replay=await ctx.fns.procs.db.select({sql:'SELECT result FROM team.command WHERE team_id=? AND actor_kind=? AND actor_id=? AND request_key=?',params:[opts.teamId,actor.kind,actor.id,opts.requestKey]});
    if(replay[0]) {
     const r=replay[0].result as Record<string,unknown>;
     const ev=await ctx.fns.procs.db.select({sql:'SELECT payload FROM team.event WHERE team_id=? AND id=?',params:[opts.teamId,String(r.eventId??'')]});
     const cmd=(ev[0]?.payload as {command?:{agentId?:string;persona?:unknown}}|undefined)?.command;
     return {...r,agentId:cmd?.agentId,persona:cmd?.persona,replayed:true};
    }
    const teams=await ctx.fns.procs.db.select({sql:'SELECT * FROM team.team WHERE id=?',params:[opts.teamId]});
    const team=teams[0]; if(!team) throw new Error('Team not found');
    const ownerAgent=actor.kind==='agent'&&actor.id!==team.supervisor_agent_id?await ctx.fns.team.resolveOwnerActor({teamId:opts.teamId}).then(o=>!!o.teamOwner,()=>false):false;
    if(!((actor.kind==='user'&&actor.id===team.owner_user_id)||(actor.kind==='agent'&&actor.id===team.supervisor_agent_id)||ownerAgent)) throw new Error('Supervisor or owner required (or an agent of the owner\'s own session that is not on the roster)');
    if(team.status!=='active') throw new Error('Team not active');
    const p=opts.persona; if(!p?.name?.trim()||!p?.role?.trim()) throw new Error('persona.name and persona.role required');
    const supervisor=await ctx.fns.session.load({id:String(team.supervisor_agent_id)});
    if(!supervisor) throw new Error('Supervisor session not found');
    const persona={name:p.name.trim(),role:p.role.trim(),skills:(p.skills??[]).map(String),allowed:(p.allowed??[]).map(String)};
    const passport=[
     `You are ${persona.name}, ${persona.role} in team "${team.title}" (teamId ${team.id}).`,
     `Team goal: ${team.goal}`,
     `Supervisor (your manager): agent ${team.supervisor_agent_id}.`,
     persona.skills.length?`What you are good at: ${persona.skills.join(', ')}.`:'',
     persona.allowed.length?`What you are allowed to do: ${persona.allowed.join(', ')}. Anything else needs the supervisor's explicit approval.`:'',
     opts.brief?.trim()?`Brief: ${opts.brief.trim()}`:'',
     'Rules: call team.sync({teamId}) before work; take your queue top-down (team.tasks), one working/blocked task at a time; report progress with team.report; submit with evidence for review. The timeline is public. Questions for the user go to the supervisor via agent.message; never contact the user directly. No outward actions (send, push, pay, publish) without explicit approval.',
    ].filter(Boolean).join('\n');
    const created=await ctx.fns.agent.start({model:opts.model??supervisor.model,title:`${persona.name} · ${persona.role}`,workspaceDir:opts.workspaceDir??supervisor.workspaceDir,workspaceHost:opts.workspaceDir?undefined:supervisor.workspaceHost,systemPrompt:passport,parentId:supervisor.id,forkOffset:0,visibility:'team',meta:{persona:{...persona,teamId:team.id,hiredBy:actor.id,hiredAt:Date.now()}}});
    let out:Record<string,unknown>;
    try {
     if(created.createdBy && created.createdBy!==team.owner_user_id) throw new Error('New session is not owned by the team owner');
     out=await ctx.fns.team.executeCommand({teamId:opts.teamId,requestKey:opts.requestKey,expectedVersion:opts.expectedVersion,command:{action:'memberHire',agentId:created.id,persona,...(opts.brief?{brief:opts.brief}:{})}});
    } catch(e) { await ctx.fns.session.archive({id:created.id}).catch(()=>null); throw e; }
    const kickoff=`Team passport for ${team.id}:\n${passport}\n\nStart: call team.sync({teamId:"${team.id}"}) and take your first task.`;
    let started:Record<string,unknown>;
    try {
     if(session?.agent) { await ctx.fns.agent.message({agent:session.agent,to:created.id,text:kickoff}); started={via:'agent.message'}; }
     else { const w=await ctx.fns.agent.wake({id:created.id,inMs:1000,prompt:kickoff}); started={via:'agent.wake',jobId:w.id}; }
    } catch(e) { started={via:'none',error:String(e instanceof Error?e.message:e)}; }
    return {...out,agentId:created.id,persona,started};
}
