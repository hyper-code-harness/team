/**
 * Record exhausted delivery and coalesce a nonrecursive supervisor alert.
 *
 * Internal service helper called after delivery retries are exhausted. Uses team row serialization, preserves system authorship in the public event and never generates a second alert about failure of an alert itself.
 * @param opts.deliveryId Failed delivery identifier.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Failed delivery identifier. */
        deliveryId: string;
    },
): Promise<boolean> {
    const auth=await ctx.fns.cron.authority({scope:'notification.enqueue'});if(!auth||auth.targetFn!=='team.maintenance')throw new Error('Scoped maintenance required');
    return await ctx.fns.procs.db.transaction({fn:async()=>{
     const ds=await ctx.fns.procs.db.select({sql:"SELECT d.* FROM team.delivery d JOIN team.team t ON t.id=d.team_id WHERE d.id=? AND d.status='failed' AND t.owner_user_id=?",params:[opts.deliveryId,auth.ownerId]});const d=ds[0];if(!d)return false;
     const teams=await ctx.fns.procs.db.select({sql:"SELECT * FROM team.team WHERE id=? AND status='active' FOR UPDATE",params:[d.team_id]});const team=teams[0];if(!team)return false;
     const es=await ctx.fns.procs.db.select({sql:'SELECT kind FROM team.event WHERE id=?',params:[d.event_id]});
     const previous=await ctx.fns.procs.db.select({sql:"SELECT id FROM team.event WHERE team_id=? AND kind='delivery.failed' AND causation_id=?",params:[d.team_id,d.id]});if(previous.length)return false;
     const outstanding=await ctx.fns.procs.db.select({sql:"SELECT d.id FROM team.delivery d JOIN team.event e ON e.id=d.event_id WHERE d.team_id=? AND e.kind='delivery.failed' AND d.status<>'delivered' LIMIT 1",params:[d.team_id]});
     const seqs=await ctx.fns.procs.db.select({sql:'UPDATE team.team SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq',params:[d.team_id]});const eventId=Bun.randomUUIDv7(),now=Date.now();
     await ctx.fns.procs.db.run({sql:"INSERT INTO team.event(id,team_id,seq,actor_kind,actor_id,kind,text,payload,causation_id,timestamp) VALUES(?,?,?,'system',?,'delivery.failed',?,?::jsonb,?,?)",params:[eventId,d.team_id,seqs[0].next_seq,auth.transportActor,'Delivery exhausted retries. Owner may inspect and retry in the team UI.',JSON.stringify({deliveryId:d.id,recipientAgentId:d.recipient_agent_id,lastError:d.last_error}),d.id,now]});
     if(es[0]?.kind!=='delivery.failed'&&!outstanding.length)await ctx.fns.procs.db.run({sql:'INSERT INTO team.delivery(id,team_id,event_id,recipient_agent_id,next_at) VALUES(?,?,?,?,?)',params:[Bun.randomUUIDv7(),d.team_id,eventId,team.supervisor_agent_id,now]});return true;
    }}) as boolean;
}
