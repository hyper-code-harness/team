/**
 * Emit one public escalation per overdue task deadline generation.
 *
 * Internal maintenance operation requiring an owner-scoped trusted cron service. Never substitutes an agent or user actor; all domain storage remains in the team schema.
 * @param opts.limit Maximum rows considered in one bounded batch. @default 20 @minimum 1 @maximum 100
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Maximum rows considered in one bounded batch. @default 20 @minimum 1 @maximum 100 */
        limit?: number;
    },
): Promise<{escalated:number}> {
    const auth=await ctx.fns.cron.authority({scope:'notification.enqueue'});
    if(!auth||auth.targetFn!=='team.maintenance')throw new Error('Scoped team maintenance service required');
    const now=Date.now();
    const due=await ctx.fns.procs.db.select({sql:"SELECT task.id,task.team_id FROM team.task task JOIN team.team t ON t.id=task.team_id WHERE t.owner_user_id=? AND t.status='active' AND task.progress_due_at<=? AND task.status IN ('working','blocked','assigned') AND NOT EXISTS (SELECT 1 FROM team.event e WHERE e.team_id=task.team_id AND e.kind='deadline' AND e.causation_id='deadline:'||task.id||':'||task.deadline_generation::text) ORDER BY task.progress_due_at LIMIT ?",params:[auth.ownerId,now,Math.min(100,Math.max(1,opts.limit??20))]});
    let escalated=0;
    for(const d of due) {
     const emitted=await ctx.fns.procs.db.transaction({fn:async()=>{
      const teams=await ctx.fns.procs.db.select({sql:"SELECT * FROM team.team WHERE id=? AND owner_user_id=? AND status='active' FOR UPDATE",params:[d.team_id,auth.ownerId]});const team=teams[0];if(!team)return false;
      const tasks=await ctx.fns.procs.db.select({sql:'SELECT * FROM team.task WHERE team_id=? AND id=?',params:[d.team_id,d.id]});const task=tasks[0];
      if(!task||task.progress_due_at===null||Number(task.progress_due_at)>now||!['working','blocked','assigned'].includes(task.status))return false;
      const causation='deadline:'+task.id+':'+task.deadline_generation;
      const seen=await ctx.fns.procs.db.select({sql:"SELECT id FROM team.event WHERE team_id=? AND kind='deadline' AND causation_id=?",params:[d.team_id,causation]});if(seen.length)return false;
      const seqs=await ctx.fns.procs.db.select({sql:'UPDATE team.team SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq',params:[d.team_id]});
      const eventId=Bun.randomUUIDv7();
      await ctx.fns.procs.db.run({sql:"INSERT INTO team.event(id,team_id,seq,task_id,actor_kind,actor_id,kind,text,payload,causation_id,timestamp) VALUES(?,?,?,?,'system',?,'deadline',?,?::jsonb,?,?)",params:[eventId,d.team_id,seqs[0].next_seq,task.id,auth.transportActor,'Progress deadline exceeded; review the current task before taking action.',JSON.stringify({deadlineGeneration:task.deadline_generation,progressDueAt:task.progress_due_at}),causation,now]});
      await ctx.fns.procs.db.run({sql:'INSERT INTO team.delivery(id,team_id,event_id,recipient_agent_id,next_at) VALUES(?,?,?,?,?)',params:[Bun.randomUUIDv7(),d.team_id,eventId,team.supervisor_agent_id,now]});
      return true;
     }});if(emitted)escalated++;
    }
    if(escalated) try { await ctx.fns.procs.events.refresh({topic:'team'}); } catch {}
    return {escalated};
}
