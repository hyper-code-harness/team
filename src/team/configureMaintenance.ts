/**
 * Register and grant an owner-scoped periodic team maintenance job.
 *
 * Use from authenticated owner HTTP context after activating a team. The core grant binds the current function definition and owner; no owner identity is accepted in options.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {},
): Promise<{name:string;ownerId:string}> {
    const actor=await ctx.fns.team.resolveActor({});if(actor.kind!=='user')throw new Error('Owner HTTP context required — Агент: cron grant для обслуживания команды настраивает только человек на /team/ (кнопка активации); команду, персону, hire/fire агент сессии человека делает сам');const name='team-maintenance:'+actor.id;await ctx.fns.cron.add({name,fn:'team.maintenance',every:'20s',args:{}});const grant=await ctx.fns.cron.grant({name,fn:'team.maintenance',scopes:['notification.enqueue']});return {name,ownerId:grant.ownerId};
}
