/**
 * Create a draft team around an owner-approved roster: sessions and/or persistent personas.
 *
 * Use from authenticated owner HTTP context to register dedicated existing agent sessions. Creation is transactional and replayable; activation sends the frozen passport through the durable notification outbox.
 * @param opts.teamId New team identifier.
 * @param opts.requestKey Stable creation intent key for exact retries.
 * @param opts.title Team display title.
 * @param opts.goal Shared team objective frozen at activation.
 * @param opts.supervisorAgentId Supervisor session included in the fixed roster.
 * @param opts.members Existing dedicated owner sessions and their fixed responsibilities.
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
        /** Supervisor session included in the fixed roster. */
        supervisorAgentId: string;
        /** Existing dedicated owner sessions and their fixed responsibilities. */
        members: Array<{agentId:string;role:string;responsibilities:string}>;
        /** Reporting deadline window in milliseconds. @default 3600000 @minimum 1000 @maximum 86400000 */
        progressWindowMs?: number;
        /** Team personas (persistent members that outlive sessions): created in team.persona when missing (icon from the latest session of that name), then joined to the team. With personas, members may hold only the supervisor session. */
        personas?: Array<{name:string;role:string;responsibilities?:string;icon?:string;prompt?:string;plugins?:string[];model?:string}>;
    },
): Promise<Record<string,unknown>> {
    const actor=await ctx.fns.team.resolveActor({}); if(actor.kind!=='user')throw new Error('Only authenticated owner may create a team');
    if(!opts.teamId.trim()||!opts.requestKey.trim()||!opts.title.trim()||!opts.goal.trim()||opts.members.length<1||opts.members.length>30)throw new Error('Team identity, title, goal and 1–30 members required');
    const ids=opts.members.map(m=>m.agentId); if(new Set(ids).size!==ids.length||!ids.includes(opts.supervisorAgentId))throw new Error('Unique roster including supervisor required');
    for(const m of opts.members) {
     if(!m.role.trim()||!m.responsibilities.trim())throw new Error('Role and responsibilities required');
     const a=await ctx.fns.session.load({id:m.agentId});
     if(!a||a.createdBy!==actor.id||a.visibility==='hidden')throw new Error('Members must be existing nonhidden nonarchived sessions owned by the caller');
    }
    const progress=opts.progressWindowMs??3600000;if(!Number.isInteger(progress)||progress<1000||progress>86400000)throw new Error('Invalid progress policy');
    const personas=(opts.personas??[]).map(p=>({...p,name:String(p.name??'').trim(),role:String(p.role??'').trim(),responsibilities:String(p.responsibilities??'').trim()}));
    if(personas.length>30||personas.some(p=>!p.name||!p.role)||new Set(personas.map(p=>p.name)).size!==personas.length)throw new Error('Personas need unique names and roles, at most 30');
    const payload=JSON.stringify({teamId:opts.teamId,title:opts.title,goal:opts.goal,supervisorAgentId:opts.supervisorAgentId,members:[...opts.members].sort((a,b)=>a.agentId.localeCompare(b.agentId)),progressWindowMs:progress,...(personas.length?{personas:personas.map(p=>({name:p.name,role:p.role,responsibilities:p.responsibilities}))}:{})});
    const hash=new Bun.CryptoHasher('sha256').update(payload).digest('hex');
    // Personas are owner-global and outlive teams: create missing ones before the team transaction (personaCreate is idempotent per owner).
    const replayed=(await ctx.fns.procs.db.select({sql:'SELECT 1 FROM team.team WHERE id=?',params:[opts.teamId]})).length>0;
    if(!replayed) for(const p of personas) await ctx.fns.team.personaCreate({name:p.name,role:p.role,responsibilities:p.responsibilities,...(p.icon?{icon:p.icon}:{}),...(p.prompt?{prompt:p.prompt}:{}),...(p.plugins?{plugins:p.plugins}:{}),...(p.model?{model:p.model}:{})});
    return await ctx.fns.procs.db.transaction({fn:async()=>{
     // Stable advisory key serializes creation before the team row exists.
     await ctx.fns.procs.db.select({sql:'SELECT pg_advisory_xact_lock(hashtextextended(?,0))',params:['team.create:'+opts.teamId]});
     const existing=await ctx.fns.procs.db.select({sql:'SELECT owner_user_id FROM team.team WHERE id=?',params:[opts.teamId]});
     if(existing.length){
      if(existing[0].owner_user_id!==actor.id)throw new Error('Team identifier unavailable');
      const prior=await ctx.fns.procs.db.select({sql:"SELECT payload_hash,result FROM team.command WHERE team_id=? AND actor_kind='user' AND actor_id=? AND request_key=?",params:[opts.teamId,actor.id,opts.requestKey]});
      if(prior[0]?.payload_hash===hash)return prior[0].result as Record<string,unknown>;
      throw new Error('Existing team or conflicting creation replay');
     }
     const now=Date.now();
     await ctx.fns.procs.db.run({sql:'INSERT INTO team.team(id,owner_user_id,title,goal,supervisor_agent_id,progress_window_ms,created_at,next_seq) VALUES(?,?,?,?,?,?,?,1)',params:[opts.teamId,actor.id,opts.title,opts.goal,opts.supervisorAgentId,progress,now]});
     for(const m of opts.members)await ctx.fns.procs.db.run({sql:'INSERT INTO team.member(team_id,agent_id,role,responsibilities) VALUES(?,?,?,?)',params:[opts.teamId,m.agentId,m.role,m.responsibilities]});
     for(const p of personas)await ctx.fns.procs.db.run({sql:'INSERT INTO team.team_persona(team_id,persona_name,active,joined_at) VALUES(?,?,true,?)',params:[opts.teamId,p.name,now]});
     const eventId=Bun.randomUUIDv7();
     await ctx.fns.procs.db.run({sql:"INSERT INTO team.event(id,team_id,seq,actor_kind,actor_id,kind,text,payload,command_key,timestamp) VALUES(?,?,1,'user',?,'created',?,?::jsonb,?,?)",params:[eventId,opts.teamId,actor.id,opts.title,payload,opts.requestKey,now]});
     const result={teamId:opts.teamId,teamVersion:1,status:'draft',eventId,seq:1};
     await ctx.fns.procs.db.run({sql:"INSERT INTO team.command(team_id,actor_kind,actor_id,request_key,payload_hash,result) VALUES(?,'user',?,?,?,?::jsonb)",params:[opts.teamId,actor.id,opts.requestKey,hash,JSON.stringify(result)]});
     return result;
    }}) as Record<string,unknown>;
}
