/**
 * Create a draft team around an owner-approved roster: sessions and/or persistent personas.
 *
 * Use from authenticated owner HTTP context, or from an agent whose session belongs to that owner (recorded as actor_kind agent, on_behalf_of owner), to register dedicated existing agent sessions. Creation is transactional and replayable; activation sends the frozen passport through the durable notification outbox.
 * @param opts.teamId New team identifier.
 * @param opts.requestKey Stable creation intent key for exact retries.
 * @param opts.title Team display title.
 * @param opts.goal Shared team objective frozen at activation.
 * @param opts.supervisorAgentId Supervisor session included in the fixed roster; default: the calling agent session (required when a person calls without members).
 * @param opts.members Existing dedicated owner sessions and their fixed responsibilities. Optional with personas: empty or missing → the roster is just the supervisor session (role supervisor).
 * @param opts.progressWindowMs Reporting deadline window in milliseconds. @default 3600000 @minimum 1000 @maximum 86400000
 * @param opts.personas Team personas (persistent members that outlive sessions): created in team.persona when missing (icon from the latest session of that name), then joined to the team. With personas, members may hold only the supervisor session.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** New team identifier. */
        teamId: string;
        /** Stable creation intent key for exact retries. */
        requestKey: string;
        /** Team display title. */
        title: string;
        /** Shared team objective frozen at activation. */
        goal: string;
        /** Supervisor session included in the fixed roster; default: the calling agent session (required when a person calls without members). */
        supervisorAgentId?: string;
        /** Existing dedicated owner sessions and their fixed responsibilities. Optional with personas: empty or missing → the roster is just the supervisor session (role supervisor). */
        members?: Array<{agentId:string;role:string;responsibilities:string}>;
        /** Reporting deadline window in milliseconds. @default 3600000 @minimum 1000 @maximum 86400000 */
        progressWindowMs?: number;
        /** Team personas (persistent members that outlive sessions): created in team.persona when missing (icon from the latest session of that name), then joined to the team. With personas, members may hold only the supervisor session. */
        personas?: Array<{name:string;role:string;responsibilities?:string;icon?:string;prompt?:string;plugins?:string[];model?:string}>;
    },
): Promise<Record<string,unknown>> {
    // The person, or an agent of the person's own session acting on their behalf (on_behalf_of).
    const actor=await ctx.fns.team.resolveOwnerActor({}); const ownerId=actor.ownerId;
    // Supervisor: explicit, else the calling agent session. With personas and no members the roster is the supervisor alone.
    const supervisorAgentId=String(opts.supervisorAgentId??'').trim()||(actor.kind==='agent'?actor.id:'');
    let members=opts.members??[];
    if(!members.length&&opts.personas?.length){
     if(!supervisorAgentId)throw new Error('team.create: with personas and no members pass supervisorAgentId (the supervisor session) or call from that agent session — the roster is filled with the supervisor');
     members=[{agentId:supervisorAgentId,role:'supervisor',responsibilities:'Supervises the team: gives tasks to personas, reviews and accepts results'}];
    }
    if(!supervisorAgentId)throw new Error('team.create: supervisorAgentId required (default is the calling agent session)');
    if(!opts.teamId.trim()||!opts.requestKey.trim()||!opts.title.trim()||!opts.goal.trim()||members.length<1||members.length>30)throw new Error('Team identity, title, goal and 1–30 members required');
    const ids=members.map(m=>m.agentId); if(new Set(ids).size!==ids.length||!ids.includes(supervisorAgentId))throw new Error('Unique roster including supervisor required');
    for(const m of members) {
     if(!m.role.trim()||!m.responsibilities.trim())throw new Error('Role and responsibilities required');
     const a=await ctx.fns.session.load({id:m.agentId});
     if(!a||String(a.createdBy??'')!==ownerId||a.visibility==='hidden')throw new Error('Members must be existing nonhidden nonarchived sessions owned by the caller (or by the person whose agent calls)');
    }
    const progress=opts.progressWindowMs??3600000;if(!Number.isInteger(progress)||progress<1000||progress>86400000)throw new Error('Invalid progress policy');
    const personas=(opts.personas??[]).map(p=>({...p,name:String(p.name??'').trim(),role:String(p.role??'').trim(),responsibilities:String(p.responsibilities??'').trim()}));
    if(personas.length>30||personas.some(p=>!p.name||!p.role)||new Set(personas.map(p=>p.name)).size!==personas.length)throw new Error('Personas need unique names and roles, at most 30');
    const payload=JSON.stringify({teamId:opts.teamId,title:opts.title,goal:opts.goal,supervisorAgentId:supervisorAgentId,members:[...members].sort((a,b)=>a.agentId.localeCompare(b.agentId)),progressWindowMs:progress,...(personas.length?{personas:personas.map(p=>({name:p.name,role:p.role,responsibilities:p.responsibilities}))}:{})});
    const hash=new Bun.CryptoHasher('sha256').update(payload).digest('hex');
    // Personas are owner-global and outlive teams: create missing ones before the team transaction (personaCreate is idempotent per owner).
    const replayed=(await ctx.fns.procs.db.select({sql:'SELECT 1 FROM team.team WHERE id=?',params:[opts.teamId]})).length>0;
    if(!replayed) for(const p of personas) p.name=(await ctx.fns.team.personaCreate({name:p.name,role:p.role,responsibilities:p.responsibilities,...(p.icon?{icon:p.icon}:{}),...(p.prompt?{prompt:p.prompt}:{}),...(p.plugins?{plugins:p.plugins}:{}),...(p.model?{model:p.model}:{})})).name; // storage key (may be «Имя@project»)
    return await ctx.fns.procs.db.transaction({fn:async()=>{
     // Stable advisory key serializes creation before the team row exists.
     await ctx.fns.procs.db.select({sql:'SELECT pg_advisory_xact_lock(hashtextextended(?,0))',params:['team.create:'+opts.teamId]});
     const existing=await ctx.fns.procs.db.select({sql:'SELECT owner_user_id FROM team.team WHERE id=?',params:[opts.teamId]});
     if(existing.length){
      if(existing[0].owner_user_id!==ownerId)throw new Error('Team identifier unavailable');
      const prior=await ctx.fns.procs.db.select({sql:"SELECT payload_hash,result FROM team.command WHERE team_id=? AND actor_kind=? AND actor_id=? AND request_key=?",params:[opts.teamId,actor.kind,actor.id,opts.requestKey]});
      if(prior[0]?.payload_hash===hash)return prior[0].result as Record<string,unknown>;
      throw new Error('Existing team or conflicting creation replay');
     }
     const now=Date.now();
     await ctx.fns.procs.db.run({sql:'INSERT INTO team.team(id,owner_user_id,title,goal,supervisor_agent_id,progress_window_ms,created_at,next_seq) VALUES(?,?,?,?,?,?,?,1)',params:[opts.teamId,ownerId,opts.title,opts.goal,supervisorAgentId,progress,now]});
     for(const m of members)await ctx.fns.procs.db.run({sql:'INSERT INTO team.member(team_id,agent_id,role,responsibilities) VALUES(?,?,?,?)',params:[opts.teamId,m.agentId,m.role,m.responsibilities]});
     for(const p of personas)await ctx.fns.procs.db.run({sql:'INSERT INTO team.team_persona(team_id,persona_name,active,joined_at) VALUES(?,?,true,?)',params:[opts.teamId,p.name,now]});
     const eventId=Bun.randomUUIDv7();
     if(actor.onBehalfOf) await ctx.fns.procs.db.run({sql:"INSERT INTO team.event(id,team_id,seq,actor_kind,actor_id,kind,text,payload,command_key,timestamp,on_behalf_of) VALUES(?,?,1,'agent',?,'created',?,?::jsonb,?,?,?)",params:[eventId,opts.teamId,actor.id,opts.title,payload,opts.requestKey,now,actor.onBehalfOf]});
     else await ctx.fns.procs.db.run({sql:"INSERT INTO team.event(id,team_id,seq,actor_kind,actor_id,kind,text,payload,command_key,timestamp) VALUES(?,?,1,'user',?,'created',?,?::jsonb,?,?)",params:[eventId,opts.teamId,actor.id,opts.title,payload,opts.requestKey,now]});
     const result={teamId:opts.teamId,teamVersion:1,status:'draft',eventId,seq:1};
     if(actor.onBehalfOf) await ctx.fns.procs.db.run({sql:"INSERT INTO team.command(team_id,actor_kind,actor_id,request_key,payload_hash,result,on_behalf_of) VALUES(?,'agent',?,?,?,?::jsonb,?)",params:[opts.teamId,actor.id,opts.requestKey,hash,JSON.stringify(result),actor.onBehalfOf]});
     else await ctx.fns.procs.db.run({sql:"INSERT INTO team.command(team_id,actor_kind,actor_id,request_key,payload_hash,result) VALUES(?,'user',?,?,?,?::jsonb)",params:[opts.teamId,actor.id,opts.requestKey,hash,JSON.stringify(result)]});
     return result;
    }}) as Record<string,unknown>;
}
