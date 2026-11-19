/**
 * Commit a versioned team command with its public event and notification outbox.
 *
 * Use for owner lifecycle, supervisor board management, assignee transitions and public communication. Serializes on the team row, enforces injected actor permissions, CAS and successful-command replay before atomically writing team-only storage.
 * @param opts.teamId Team identifier.
 * @param opts.requestKey Unique intent key; reuse only for exact retries.
 * @param opts.expectedVersion Task version for assign, reorder or transition; team version for other commands (including preempt). @minimum 1
 * @param opts.command Explicit lifecycle, board or public communication intent.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Team identifier. */
        teamId: string;
        /** Unique intent key; reuse only for exact retries. */
        requestKey: string;
        /** Task version for assign, reorder or transition; team version for other commands (including preempt). @minimum 1 */
        expectedVersion: number;
        /** Explicit lifecycle, board or public communication intent. */
        command: types.team.Command;
    },
): Promise<Record<string, unknown>> {
    const actor = await ctx.fns.team.resolveActor({});
    if (!opts.requestKey?.trim() || opts.requestKey.length > 200 || !Number.isInteger(opts.expectedVersion) || opts.expectedVersion < 1) throw new Error('requestKey and positive expectedVersion required');
    const canonical = (v:unknown):string => { if(Array.isArray(v)) return '['+v.map(canonical).join(',')+']'; if(v && typeof v==='object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}'; return JSON.stringify(v) ?? 'null'; };
    const hash = new Bun.CryptoHasher('sha256').update(canonical({command:opts.command,expectedVersion:opts.expectedVersion})).digest('hex');
    let committed=false;
    const out = await ctx.fns.procs.db.transaction({fn:async()=>{
     const rows = await ctx.fns.procs.db.select({sql:'SELECT * FROM team.team WHERE id=? FOR UPDATE',params:[opts.teamId]});
     const team = rows[0]; if(!team) throw new Error('Team not found');
     // Departed members (left_at set) keep their row for history and FKs but lose all roster rights.
     const members = (await ctx.fns.procs.db.select({sql:'SELECT * FROM team.member WHERE team_id=? ORDER BY agent_id',params:[opts.teamId]})).filter(m=>m.left_at==null);
     const owner = actor.kind==='user' && actor.id===team.owner_user_id;
     const member = actor.kind==='agent' && members.some(m=>m.agent_id===actor.id);
     if(!owner && !member) throw new Error('Team access denied');
     const supervisor = member && actor.id===team.supervisor_agent_id;
     const existing = await ctx.fns.procs.db.select({sql:'SELECT payload_hash,result FROM team.command WHERE team_id=? AND actor_kind=? AND actor_id=? AND request_key=?',params:[opts.teamId,actor.kind,actor.id,opts.requestKey]});
     if(existing[0]) {if(existing[0].payload_hash!==hash) throw new Error('Idempotency key payload conflict'); return existing[0].result as Record<string,unknown>;}
     if(team.status==='archived') throw new Error('Team archived');
     const c = opts.command; const now=Date.now(); const eventId=Bun.randomUUIDv7();
     let task:types.team.Task|null=null; let taskId:string|null=null; let recipients:string[]=[]; let text=''; let kind:string=c.action;
     const requireManager=()=>{if(!owner&&!supervisor) throw new Error('Supervisor or owner required')};
     const requireOwner=()=>{if(!owner) throw new Error('Owner required')};
     const requireMember=(id:string)=>{if(!members.some(m=>m.agent_id===id)) throw new Error('Recipient or assignee outside fixed roster')};
     const mapTask=(r:Record<string,unknown>):types.team.Task=>({id:String(r.id),teamId:String(r.team_id),title:String(r.title),instructions:String(r.instructions),acceptanceCriteria:String(r.acceptance_criteria),assigneeAgentId:r.assignee_agent_id===null?null:String(r.assignee_agent_id),status:r.status as types.team.Task['status'],version:Number(r.version),everStartedAt:r.ever_started_at===null?null:Number(r.ever_started_at),currentSubmissionId:r.current_submission_id===null?null:String(r.current_submission_id),blockedReason:r.blocked_reason===null?null:String(r.blocked_reason),progressDueAt:r.progress_due_at===null?null:Number(r.progress_due_at),lastProgressAt:r.last_progress_at===null?null:Number(r.last_progress_at),deadlineGeneration:Number(r.deadline_generation),rank:r.rank===null||r.rank===undefined?null:Number(r.rank),groupKey:r.group_key==null?null:String(r.group_key),dependsOn:Array.isArray(r.depends_on)?r.depends_on.map(String):[],pausedNote:r.paused_note==null?null:String(r.paused_note)});
     const lockTask=async(id:string)=>{const tr=await ctx.fns.procs.db.select({sql:'SELECT * FROM team.task WHERE team_id=? AND id=? FOR UPDATE',params:[opts.teamId,id]}); if(!tr[0]) throw new Error('Task not found in this team'); return mapTask(tr[0]);};
     const saveTask=async(t:types.team.Task)=>ctx.fns.procs.db.run({sql:'UPDATE team.task SET assignee_agent_id=?,status=?,version=?,ever_started_at=?,current_submission_id=?,blocked_reason=?,progress_due_at=?,last_progress_at=?,deadline_generation=?,rank=?,paused_note=? WHERE team_id=? AND id=?',params:[t.assigneeAgentId,t.status,t.version,t.everStartedAt,t.currentSubmissionId,t.blockedReason,t.progressDueAt,t.lastProgressAt,t.deadlineGeneration,t.rank,t.pausedNote,opts.teamId,t.id]});
     const queueEnd=async(assignee:string|null)=>{const r=await ctx.fns.procs.db.select({sql:'SELECT COALESCE(MAX(rank),0)+1 AS r FROM team.task WHERE team_id=? AND assignee_agent_id IS NOT DISTINCT FROM ?',params:[opts.teamId,assignee]}); return Number(r[0].r);};
     let paused:types.team.Task|null=null; let extra:Record<string,unknown>={};
     let report:types.team.TaskReport|null=null;
     if('taskId' in c && c.taskId) {taskId=c.taskId; if(c.action!=='taskCreate') task=await lockTask(taskId);}
     const depStatuses=async(t:types.team.Task)=>{if(!t.dependsOn.length) return {}; const rows=await ctx.fns.procs.db.select({sql:'SELECT id,status FROM team.task WHERE team_id=? AND id IN (SELECT jsonb_array_elements_text(?::jsonb))',params:[opts.teamId,JSON.stringify(t.dependsOn)]}); return Object.fromEntries(rows.map(r=>[String(r.id),String(r.status)]));};
     if(c.action==='preempt') {taskId=c.urgentTaskId; task=await lockTask(c.urgentTaskId);}
     const expected = task && ['taskAssign','taskReorder','taskTransition'].includes(c.action) ? task.version : Number(team.version);
     if(opts.expectedVersion!==expected) throw new Error('Version conflict');
     if(c.action!=='activate' && c.action!=='archive' && team.status!=='active') throw new Error('Team not active');
     switch(c.action) {
     case 'activate': {
      requireOwner(); if(team.status!=='draft') throw new Error('Activation requires draft'); requireMember(team.supervisor_agent_id);
      await ctx.fns.procs.db.run({sql:'UPDATE team.member SET active=true WHERE team_id=?',params:[opts.teamId]});
      await ctx.fns.procs.db.run({sql:"UPDATE team.team SET status='active',version=version+1 WHERE id=?",params:[opts.teamId]});
      recipients=members.map(m=>String(m.agent_id));
      text='Team passport: '+JSON.stringify({teamId:team.id,goal:team.goal,supervisor:team.supervisor_agent_id,members:members.map(m=>({agentId:m.agent_id,role:m.role,responsibilities:m.responsibilities})),rules:'Call team.sync before work. Public timeline, one working/blocked slot. Never reassign started work. Submit evidence for explicit review. No automatic external action authorization.'}); break;
     }
     case 'archive': {
      requireOwner(); const open=await ctx.fns.procs.db.select({sql:"SELECT id FROM team.task WHERE team_id=? AND status NOT IN ('done','cancelled') LIMIT 1",params:[opts.teamId]});
      const pending=await ctx.fns.procs.db.select({sql:"SELECT id FROM team.delivery WHERE team_id=? AND status NOT IN ('delivered','cancelled') LIMIT 1",params:[opts.teamId]});
      if(open.length||pending.length) throw new Error('Unfinished tasks or unresolved deliveries prevent archive');
      await ctx.fns.procs.db.run({sql:"UPDATE team.team SET status='archived',version=version+1 WHERE id=?",params:[opts.teamId]});
      await ctx.fns.procs.db.run({sql:'UPDATE team.member SET active=false WHERE team_id=?',params:[opts.teamId]}); text='Team archived'; break;
     }
     case 'retryDelivery': {
      requireOwner(); const failed=await ctx.fns.procs.db.select({sql:"SELECT id FROM team.delivery WHERE id=? AND team_id=? AND status='failed' FOR UPDATE",params:[c.deliveryId,opts.teamId]});
      if(!failed.length)throw new Error('Failed delivery not found in team');
      await ctx.fns.procs.db.run({sql:"UPDATE team.delivery SET status='pending',attempts=0,next_at=?,last_error=NULL WHERE id=?",params:[now,c.deliveryId]});text='Owner requested retry for delivery '+c.deliveryId;break;
     }
     case 'taskCreate': {
      requireManager(); if(!c.taskId.trim()||!c.title.trim()||!c.instructions.trim()||!c.acceptanceCriteria.trim()) throw new Error('Task identifier, title, instructions and criteria required');
      if(c.assigneeAgentId) requireMember(c.assigneeAgentId);
      if(c.rank!==undefined && !Number.isFinite(c.rank)) throw new Error('rank must be a finite number');
      if(c.groupKey!==undefined && (typeof c.groupKey!=='string' || !c.groupKey.trim())) throw new Error('groupKey must be nonblank');
      const dependsOn=[...new Set(c.dependsOn??[])];
      if(dependsOn.some(d=>typeof d!=='string'||!d.trim()||d===c.taskId)) throw new Error('dependsOn must list other task identifiers');
      if(dependsOn.length){const found=await ctx.fns.procs.db.select({sql:'SELECT id FROM team.task WHERE team_id=? AND id IN (SELECT jsonb_array_elements_text(?::jsonb))',params:[opts.teamId,JSON.stringify(dependsOn)]}); const known=new Set(found.map(r=>String(r.id))); const missing=dependsOn.filter(d=>!known.has(d)); if(missing.length) throw new Error('Unknown dependencies: '+missing.join(','));}
      const rank=c.rank??await queueEnd(c.assigneeAgentId??null);
      task={id:c.taskId,teamId:opts.teamId,title:c.title,instructions:c.instructions,acceptanceCriteria:c.acceptanceCriteria,assigneeAgentId:c.assigneeAgentId??null,status:c.assigneeAgentId?'assigned':'todo',version:1,everStartedAt:null,currentSubmissionId:null,blockedReason:null,progressDueAt:null,lastProgressAt:null,deadlineGeneration:0,rank,groupKey:c.groupKey??null,dependsOn,pausedNote:null};
      await ctx.fns.procs.db.run({sql:'INSERT INTO team.task(id,team_id,title,instructions,acceptance_criteria,assignee_agent_id,status,rank,group_key,depends_on) VALUES(?,?,?,?,?,?,?,?,?,ARRAY(SELECT jsonb_array_elements_text(?::jsonb)))',params:[task.id,task.teamId,task.title,task.instructions,task.acceptanceCriteria,task.assigneeAgentId,task.status,task.rank,task.groupKey,JSON.stringify(dependsOn)]});
      if(task.assigneeAgentId) recipients=[task.assigneeAgentId]; text=c.title; break;
     }
     case 'taskAssign': {
      requireManager(); if(!task) throw new Error('Task required'); requireMember(c.assigneeAgentId);
      if(task.everStartedAt!==null || !['todo','assigned'].includes(task.status)) throw new Error('Assignment is immutable after first start');
      if(task.assigneeAgentId!==c.assigneeAgentId) task.rank=await queueEnd(c.assigneeAgentId);
      task.assigneeAgentId=c.assigneeAgentId;task.status='assigned';task.version++;recipients=[c.assigneeAgentId];text='Task assigned';break;
     }
     case 'taskReorder': {
      // Queue insert: place never-started work at a chosen position of the backlog or an assignee queue.
      requireManager(); if(!task) throw new Error('Task required'); if(!Number.isFinite(c.rank)) throw new Error('rank must be a finite number');
      if(task.everStartedAt!==null || !['todo','assigned'].includes(task.status)) throw new Error('Reorder requires never-started todo or assigned');
      if(c.assigneeAgentId) {requireMember(c.assigneeAgentId); task.assigneeAgentId=c.assigneeAgentId; task.status='assigned'; recipients=[c.assigneeAgentId];}
      task.rank=c.rank; task.version++; text='Task queued at rank '+c.rank+(task.assigneeAgentId?' for '+task.assigneeAgentId:' in backlog'); break;
     }
     case 'preempt': {
      // Hard interrupt: pause the assignee's current work and put the urgent task at the head of the queue.
      requireManager(); if(!task) throw new Error('Task required'); if(typeof c.note!=='string'||!c.note.trim()) throw new Error('Preempt note required');
      if(task.everStartedAt!==null || !['todo','assigned'].includes(task.status)) throw new Error('Urgent task must be never-started todo or assigned');
      const target=c.assigneeAgentId??task.assigneeAgentId; if(!target) throw new Error('assigneeAgentId required for unassigned urgent task'); requireMember(target);
      const current=await ctx.fns.procs.db.select({sql:"SELECT id FROM team.task WHERE team_id=? AND assignee_agent_id=? AND status IN ('working','blocked') FOR UPDATE",params:[opts.teamId,target]});
      if(current[0]) {
       const cur=await lockTask(String(current[0].id));
       paused=await ctx.fns.team.reduceTask({task:cur,command:{action:'pause',note:c.note},actorKind:actor.kind,actorId:actor.id,supervisorId:String(team.supervisor_agent_id),slotTaskId:cur.id,now,submissionId:eventId,progressWindowMs:Number(team.progress_window_ms)});
       await saveTask(paused);
       // The paused task keeps its own thread entry; the main preempt event follows with the next seq.
       const ps=await ctx.fns.procs.db.select({sql:'UPDATE team.team SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq',params:[opts.teamId]});
       await ctx.fns.procs.db.run({sql:'INSERT INTO team.event(id,team_id,seq,task_id,actor_kind,actor_id,kind,text,payload,causation_id,command_key,timestamp) VALUES(?,?,?,?,?,?,?,?,?::jsonb,?,?,?)',params:[Bun.randomUUIDv7(),opts.teamId,Number(ps[0].next_seq),paused.id,actor.kind,actor.id,'pause','Preempted by '+task.id+': '+c.note,JSON.stringify({command:c,task:paused}),null,opts.requestKey,now]});
      }
      const head=await ctx.fns.procs.db.select({sql:"SELECT COALESCE(MIN(rank),1)-1 AS r FROM team.task WHERE team_id=? AND assignee_agent_id=? AND id<>? AND status NOT IN ('done','cancelled')",params:[opts.teamId,target,task.id]});
      task.assigneeAgentId=target; task.status='assigned'; task.rank=Number(head[0].r); task.version++;
      await saveTask(task); recipients=[target];
      text='URGENT: '+c.note+(paused?' (paused '+paused.id+')':''); break;
     }
     case 'taskTransition': {
      if(!task) throw new Error('Task required');
      const slots=await ctx.fns.procs.db.select({sql:"SELECT id FROM team.task WHERE team_id=? AND assignee_agent_id=? AND status IN ('working','blocked') LIMIT 1",params:[opts.teamId,task.assigneeAgentId]});
      task=await ctx.fns.team.reduceTask({task,command:c.transition,actorKind:actor.kind,actorId:actor.id,supervisorId:String(team.supervisor_agent_id),slotTaskId:slots[0]?.id??null,now,submissionId:eventId,progressWindowMs:Number(team.progress_window_ms),dependencyStatuses:await depStatuses(task)});
      kind=c.transition.action;
      text='summary' in c.transition?c.transition.summary:'reason' in c.transition&&c.transition.reason?c.transition.reason:'note' in c.transition?c.transition.note:c.transition.action;
      if(c.transition.action==='claim') recipients=[String(team.supervisor_agent_id)].filter(id=>id!==actor.id);
      if(c.transition.action==='pause'&&task.assigneeAgentId) recipients=[actor.kind==='agent'&&actor.id===task.assigneeAgentId?String(team.supervisor_agent_id):task.assigneeAgentId];
      if(c.transition.action==='cancel'&&task.everStartedAt!==null&&task.assigneeAgentId) recipients=[task.assigneeAgentId];
      if(c.transition.action==='submit') {
       report=await ctx.fns.team.normalizeReport({report:c.transition.report??null,fallbackSummary:c.transition.summary,fallbackFiles:c.transition.artifacts,fallbackCheck:c.transition.verification});
       if(task.assigneeAgentId!==team.supervisor_agent_id) recipients=[String(team.supervisor_agent_id)];
       const waiting=await ctx.fns.procs.db.select({sql:"SELECT id FROM team.task WHERE team_id=? AND assignee_agent_id=? AND status='assigned' AND id<>? LIMIT 1",params:[opts.teamId,task.assigneeAgentId,task.id]});
       if(waiting.length&&task.assigneeAgentId) recipients.push(task.assigneeAgentId);
      }
      if(c.transition.action==='block') recipients=[String(team.supervisor_agent_id)];
      if(['approve','changes'].includes(c.transition.action)&&task.assigneeAgentId) recipients=[task.assigneeAgentId];
      break;
     }
     case 'say': {
      if(!c.text.trim()) throw new Error('Message required'); text=c.text;
      if(c.to==='all') recipients=members.map(m=>String(m.agent_id)); else {requireMember(c.to);recipients=[c.to];}
      if(c.replyTo) {const parent=await ctx.fns.procs.db.select({sql:'SELECT id FROM team.event WHERE team_id=? AND id=?',params:[opts.teamId,c.replyTo]});if(!parent.length)throw new Error('Reply event outside team');}
      break;
     }
     case 'report': {
      if(!['milestone','finding','risk','decision','progress'].includes(c.kind)||!c.text.trim()) throw new Error('Report kind and text required'); text=c.text;kind='report.'+c.kind;
      if(c.kind==='progress') {
       if(!task||actor.kind!=='agent'||actor.id!==task.assigneeAgentId||!['working','blocked'].includes(task.status)) throw new Error('Progress requires own active task');
       // An actual progress report is recorded; it does not reset the hard generation deadline.
       await ctx.fns.procs.db.run({sql:'UPDATE team.task SET last_progress_at=? WHERE team_id=? AND id=?',params:[now,opts.teamId,task.id]});
      }
      break;
     }
     case 'memberHire': {
      requireManager(); const p=c.persona;
      if(!c.agentId?.trim()||!p?.name?.trim()||!p?.role?.trim()) throw new Error('Hire requires agentId, persona name and role');
      const known=await ctx.fns.procs.db.select({sql:'SELECT agent_id FROM team.member WHERE team_id=? AND agent_id=?',params:[opts.teamId,c.agentId]});
      if(known.length) throw new Error('Agent already was a member of this team');
      if(members.length>=30) throw new Error('Roster limit of 30 members reached');
      const persona={name:p.name.trim(),role:p.role.trim(),skills:(p.skills??[]).map(String),allowed:(p.allowed??[]).map(String)};
      const responsibilities=[persona.skills.length?'Skills: '+persona.skills.join(', '):'',persona.allowed.length?'Allowed: '+persona.allowed.join(', '):'',c.brief?.trim()?'Brief: '+c.brief.trim():''].filter(Boolean).join('. ')||persona.role;
      await ctx.fns.procs.db.run({sql:'INSERT INTO team.member(team_id,agent_id,role,responsibilities,active,persona,joined_at,hired_by) VALUES(?,?,?,?,true,?::jsonb,?,?)',params:[opts.teamId,c.agentId,persona.role,responsibilities,JSON.stringify(persona),now,actor.id]});
      text=`Hired ${persona.name} (${persona.role})`; break;
     }
     case 'memberFire': {
      requireManager(); if(!c.reason?.trim()) throw new Error('Fire requires a reason');
      if(c.agentId===team.supervisor_agent_id) throw new Error('Supervisor cannot be fired');
      requireMember(c.agentId);
      if(c.reassignTo!==undefined) {requireMember(c.reassignTo); if(c.reassignTo===c.agentId) throw new Error('reassignTo must be another member');}
      // Every unfinished task leaves the departed member. Started work loses its start marker: the fire event is the explicit exception to "fixed assignee after first start".
      const open=await ctx.fns.procs.db.select({sql:"SELECT * FROM team.task WHERE team_id=? AND assignee_agent_id=? AND status NOT IN ('done','cancelled') ORDER BY rank NULLS LAST,id FOR UPDATE",params:[opts.teamId,c.agentId]});
      const returned:Array<{taskId:string;from:string;to:string|null}>=[];
      for(const r of open) {
       const t=mapTask(r); const from=t.status;
       t.assigneeAgentId=c.reassignTo??null; t.status=c.reassignTo?'assigned':'todo'; t.version++; t.everStartedAt=null; t.currentSubmissionId=null; t.blockedReason=null; t.progressDueAt=null; t.deadlineGeneration++;
       t.rank=await queueEnd(t.assigneeAgentId); t.pausedNote=`Returned from departed member ${c.agentId} (was ${from}): ${c.reason}`;
       await saveTask(t); returned.push({taskId:t.id,from,to:t.assigneeAgentId});
      }
      await ctx.fns.procs.db.run({sql:'UPDATE team.member SET active=false,left_at=?,left_reason=? WHERE team_id=? AND agent_id=?',params:[now,c.reason,opts.teamId,c.agentId]});
      await ctx.fns.procs.db.run({sql:'UPDATE team.persona SET current_agent_id=NULL,updated_at=? WHERE current_agent_id=?',params:[now,c.agentId]});
      await ctx.fns.procs.db.run({sql:'UPDATE team.persona_session SET ended_at=? WHERE agent_id=? AND ended_at IS NULL',params:[now,c.agentId]});
      await ctx.fns.procs.db.run({sql:"UPDATE team.delivery SET status='cancelled',last_error='recipient left the team' WHERE team_id=? AND recipient_agent_id=? AND status IN ('pending','claimed','failed')",params:[opts.teamId,c.agentId]});
      recipients=c.reassignTo&&returned.length?[c.reassignTo]:[]; text=`Member ${c.agentId} left: ${c.reason}`+(returned.length?`; ${returned.length} task(s) to ${c.reassignTo??'backlog'}`:'');
      extra={returned}; break;
     }
     case 'personaJoin': {
      requireManager(); const name=String(c.name??'').trim(); if(!name) throw new Error('personaJoin: name required');
      const p=(await ctx.fns.procs.db.select({sql:'SELECT name,owner_user_id,role FROM team.persona WHERE name=?',params:[name]}))[0];
      if(!p||String(p.owner_user_id)!==String(team.owner_user_id)) throw new Error('personaJoin: no persona '+name+' of the team owner');
      const cur=(await ctx.fns.procs.db.select({sql:'SELECT active FROM team.team_persona WHERE team_id=? AND persona_name=?',params:[opts.teamId,name]}))[0];
      if(cur?.active) throw new Error('personaJoin: '+name+' is already in the team');
      await ctx.fns.procs.db.run({sql:'INSERT INTO team.team_persona(team_id,persona_name,active,joined_at) VALUES(?,?,true,?) ON CONFLICT(team_id,persona_name) DO UPDATE SET active=true,joined_at=EXCLUDED.joined_at,left_at=NULL',params:[opts.teamId,name,now]});
      text=`${name} joined (${p.role})`; extra={persona:{name,role:String(p.role)}}; break;
     }
     case 'personaBind': {
      // A new live session for a persona: it becomes a roster member; open work of the previous session moves to it.
      requireManager(); const name=String(c.name??'').trim(); const agentId=String(c.agentId??'').trim();
      if(!name||!agentId) throw new Error('personaBind: name and agentId required');
      const tp=(await ctx.fns.procs.db.select({sql:'SELECT 1 FROM team.team_persona WHERE team_id=? AND persona_name=? AND active',params:[opts.teamId,name]}))[0];
      if(!tp) throw new Error('personaBind: '+name+' is not in the team');
      const p=(await ctx.fns.procs.db.select({sql:'SELECT * FROM team.persona WHERE name=? FOR UPDATE',params:[name]}))[0];
      const a=(await ctx.fns.procs.db.select({sql:'SELECT created_by,archived_at FROM agents WHERE id=?',params:[agentId]}))[0];
      if(!a||a.archived_at!=null||String(a.created_by)!==String(team.owner_user_id)) throw new Error('personaBind: session must be a live session of the team owner');
      if((await ctx.fns.procs.db.select({sql:'SELECT 1 FROM team.member WHERE team_id=? AND agent_id=?',params:[opts.teamId,agentId]})).length) throw new Error('personaBind: session already was a member');
      await ctx.fns.procs.db.run({sql:'INSERT INTO team.member(team_id,agent_id,role,responsibilities,active,persona,joined_at,hired_by) VALUES(?,?,?,?,true,?::jsonb,?,?)',params:[opts.teamId,agentId,String(p.role)||name,String(p.responsibilities)||String(p.role)||name,JSON.stringify({name,role:String(p.role)}),now,actor.id]});
      const prev=p.current_agent_id?String(p.current_agent_id):null;
      const moved:Array<{taskId:string;from:string}>=[];
      if(prev&&prev!==agentId&&c.moveOpen!==false&&members.some(m=>m.agent_id===prev)) {
       const open=await ctx.fns.procs.db.select({sql:"SELECT * FROM team.task WHERE team_id=? AND assignee_agent_id=? AND status NOT IN ('done','cancelled') ORDER BY rank NULLS LAST,id FOR UPDATE",params:[opts.teamId,prev]});
       for(const r of open) {
        const t=mapTask(r); const from=t.status;
        t.assigneeAgentId=agentId; if(['working','blocked','paused'].includes(t.status)) {t.status='assigned'; t.everStartedAt=null; t.blockedReason=null; t.progressDueAt=null; t.deadlineGeneration++;}
        t.version++; t.rank=await queueEnd(agentId); await saveTask(t); moved.push({taskId:t.id,from});
       }
       await ctx.fns.procs.db.run({sql:'UPDATE team.member SET active=false,left_at=?,left_reason=? WHERE team_id=? AND agent_id=?',params:[now,'replaced by a new session of '+name,opts.teamId,prev]});
       await ctx.fns.procs.db.run({sql:"UPDATE team.delivery SET status='cancelled',last_error='session replaced' WHERE team_id=? AND recipient_agent_id=? AND status IN ('pending','claimed','failed')",params:[opts.teamId,prev]});
      }
      if(prev&&prev!==agentId&&c.moveOpen!==false) await ctx.fns.procs.db.run({sql:'UPDATE team.persona_session SET ended_at=? WHERE agent_id=? AND ended_at IS NULL',params:[now,prev]});
      await ctx.fns.procs.db.run({sql:'UPDATE team.persona SET current_agent_id=?,updated_at=? WHERE name=?',params:[agentId,now,name]});
      await ctx.fns.procs.db.run({sql:'INSERT INTO team.persona_session(agent_id,persona_name,team_id,started_at) VALUES(?,?,?,?) ON CONFLICT(agent_id) DO NOTHING',params:[agentId,name,opts.teamId,now]});
      text=`${name}: new session ${agentId}`+(moved.length?`; ${moved.length} task(s) moved from ${prev}`:''); extra={persona:{name},agentId,previous:prev,moved}; break;
     }
     case 'personaLeave': {
      requireManager(); const name=String(c.name??'').trim(); if(!name||!c.reason?.trim()) throw new Error('personaLeave: name and reason required');
      const r=await ctx.fns.procs.db.select({sql:'UPDATE team.team_persona SET active=false,left_at=? WHERE team_id=? AND persona_name=? AND active RETURNING 1',params:[now,opts.teamId,name]});
      if(!r.length) throw new Error('personaLeave: '+name+' is not in the team');
      text=`${name} left: ${c.reason}`; extra={persona:{name}}; break;
     }
     default: throw new Error('Unsupported command');
     }
     if(task && (c.action==='taskAssign'||c.action==='taskReorder'||c.action==='taskTransition')) await saveTask(task);
     // Board changes advance team CAS; discussion and progress reports do not change normative versions.
     if(['taskCreate','taskAssign','taskReorder','preempt','taskTransition','memberHire','memberFire','personaJoin','personaBind','personaLeave'].includes(c.action)) await ctx.fns.procs.db.run({sql:'UPDATE team.team SET version=version+1 WHERE id=?',params:[opts.teamId]});
     const seqs=await ctx.fns.procs.db.select({sql:'UPDATE team.team SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq,version,status',params:[opts.teamId]});
     const seq=Number(seqs[0].next_seq);
     await ctx.fns.procs.db.run({sql:'INSERT INTO team.event(id,team_id,seq,task_id,actor_kind,actor_id,kind,text,payload,causation_id,command_key,timestamp) VALUES(?,?,?,?,?,?,?,?,?::jsonb,?,?,?)',params:[eventId,opts.teamId,seq,taskId,actor.kind,actor.id,kind,text,JSON.stringify({command:c,task,...(paused?{paused}:{}),...extra,...(report?{report}:{})}),c.action==='say'?c.replyTo??null:null,opts.requestKey,now]});
     for(const recipient of [...new Set(recipients)].filter(id=>c.action!=='say'||!(actor.kind==='agent'&&id===actor.id))) await ctx.fns.procs.db.run({sql:'INSERT INTO team.delivery(id,team_id,event_id,recipient_agent_id,next_at) VALUES(?,?,?,?,?)',params:[Bun.randomUUIDv7(),opts.teamId,eventId,recipient,now]});
     const result:Record<string,unknown>={teamId:opts.teamId,eventId,seq,teamVersion:Number(seqs[0].version),status:seqs[0].status,task,...(paused?{paused}:{}),...extra};
     await ctx.fns.procs.db.run({sql:'INSERT INTO team.command(team_id,actor_kind,actor_id,request_key,payload_hash,result) VALUES(?,?,?,?,?,?::jsonb)',params:[opts.teamId,actor.kind,actor.id,opts.requestKey,hash,JSON.stringify(result)]});
     committed=true; return result;
    }}) as Record<string,unknown>;
    if(!committed) return out; // exact replay: no refresh, no second interrupt
    try { await ctx.fns.procs.events.refresh({topic:'team'}); } catch {}
    if(opts.command.action==='preempt') {
     // Interrupt after commit. No documented safe API stops another agent's in-flight turn, so the assignee
     // gets an urgent wake-up message; the durable 'preempt' delivery in team.delivery is the source of truth.
     const target=String((out.task as types.team.Task).assigneeAgentId);
     let interrupt:Record<string,unknown>={messaged:false,stopped:false,reason:'no sender agent session (owner HTTP call); outbox delivery only'};
     if(session?.agent && session.agent.id!==target) {
      try { await ctx.fns.agent.message({agent:session.agent,to:target,text:`URGENT team ${opts.teamId}: stop your current task now. ${(out.paused as types.team.Task|undefined)?.id ?? 'Your current work'} is paused; start ${(out.task as types.team.Task).id} next. Note: ${opts.command.note}. Call team.sync first.`}); interrupt={messaged:true,stopped:false}; }
      catch(e) { interrupt={messaged:false,stopped:false,reason:String(e instanceof Error?e.message:e)}; }
     }
     return {...out,interrupt};
    }
    return out;
}
