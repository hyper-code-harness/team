/**
 * Reconcile bounded team deliveries and task deadlines for one trusted cron owner.
 *
 * Non-LLM cron entry point. Requires a grant scoped to this exact target function and uses the service owner rather than caller-supplied identity. Missing grants fail closed without database work.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {},
): Promise<{authorized:boolean;delivered:number;failed:number;escalated:number}> {
    const auth=await ctx.fns.cron.authority({scope:'notification.enqueue'}); if(!auth||auth.targetFn!=='team.maintenance') return {authorized:false,delivered:0,failed:0,escalated:0};
    const deadlines=await ctx.fns.team.checkDeadlines({limit:20}); const deliveries=await ctx.fns.team.flushDeliveries({limit:20});
    if(deliveries.delivered||deliveries.failed) try { await ctx.fns.procs.events.refresh({topic:'team'}); } catch {}
    return {authorized:true,...deadlines,...deliveries};
}
