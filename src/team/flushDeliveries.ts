/**
 * Deliver a bounded leased batch of team outbox notifications through trusted core enqueue.
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
): Promise<{delivered:number;failed:number}> {
    const auth=await ctx.fns.cron.authority({scope:'notification.enqueue'});
    if(!auth || auth.targetFn!=='team.maintenance')throw new Error('Scoped team maintenance service required');
    const batch=Math.min(100,Math.max(1,opts.limit??20)); let delivered=0,failed=0;
    for(let i=0;i<batch;i++) {
     const now=Date.now(),token=Bun.randomUUIDv7();
     const claimed=await ctx.fns.procs.db.transaction({fn:async()=>{
      const found=await ctx.fns.procs.db.select({sql:"SELECT d.* FROM team.delivery d JOIN team.team t ON t.id=d.team_id WHERE t.owner_user_id=? AND t.status='active' AND ((d.status='pending' AND d.next_at<=?) OR (d.status='claimed' AND d.lease_until<=?)) ORDER BY d.next_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1",params:[auth.ownerId,now,now]});
      const d=found[0]; if(!d)return null;
      await ctx.fns.procs.db.run({sql:"UPDATE team.delivery SET status='claimed',claim_token=?,lease_until=?,attempts=attempts+1 WHERE id=?",params:[token,now+60000,d.id]});
      const events=await ctx.fns.procs.db.select({sql:'SELECT * FROM team.event WHERE id=? AND team_id=?',params:[d.event_id,d.team_id]});
      return {delivery:d,event:events[0],attempt:Number(d.attempts)+1};
     }}) as {delivery:Record<string,unknown>;event:Record<string,unknown>;attempt:number}|null;
     if(!claimed)break;
     const {delivery:d,event:e,attempt}=claimed;
     try {
      const valid=await ctx.fns.procs.db.select({sql:"SELECT m.agent_id FROM team.member m JOIN team.team t ON t.id=m.team_id WHERE m.team_id=? AND m.agent_id=? AND m.active AND t.status='active' AND t.owner_user_id=?",params:[d.team_id,d.recipient_agent_id,auth.ownerId]});
      if(!valid.length||!e)throw new Error('Team or recipient no longer active');
      const originalAuthor=e.actor_kind==='agent'?'agent:'+String(e.actor_id):e.actor_kind==='user'?String(e.actor_id):auth.ownerId;
      const text=`[Team notification; public event, not direct user authorization]\nTeam ${d.team_id}; event ${e.id}; task ${e.task_id??'none'}; kind ${e.kind}; author ${e.actor_kind}:${e.actor_id}\n${e.text}\nRead team.sync({teamId:${JSON.stringify(d.team_id)}}) and team.timeline before acting. Delivery is not approval or completion. Assigned work may be waiting on the board.`;
      const receipt=await ctx.fns.session.enqueueNotification({to:String(d.recipient_agent_id),key:'team.delivery:'+d.id,text,originalAuthor});
      await ctx.fns.procs.db.run({sql:"UPDATE team.delivery SET status='delivered',receipt=?::jsonb,claim_token=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND claim_token=? AND status='claimed'",params:[JSON.stringify(receipt),d.id,token]}); delivered++;
     } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      const terminal=attempt>=5;
      await ctx.fns.procs.db.run({sql:'UPDATE team.delivery SET status=?,last_error=?,next_at=?,claim_token=NULL,lease_until=NULL WHERE id=? AND claim_token=? AND status=\'claimed\'',params:[terminal?'failed':'pending',message.slice(0,2000),Date.now()+Math.min(300000,1000*2**attempt),d.id,token]});
      if(terminal){failed++;await ctx.fns.team.recordDeliveryFailure({deliveryId:String(d.id)});}
     }
    }
    return {delivered,failed};
}
