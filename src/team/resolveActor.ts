/**
 * Resolve the trusted team caller from the injected session.
 *
 * Use before every team read or command. Agent identity takes precedence over an inherited user; service and anonymous calls cannot acquire owner authority.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {},
): Promise<types.team.Actor> {
    if(session?.kind==='service') throw new Error('Service context has no human or member authority');
    if(session?.agent || session?.agentId) { const current=await ctx.fns.agent.current({}); return {kind:'agent',id:current.id}; }
    if(session?.user?.id && session?.req) return {kind:'user',id:String(session.user.id)};
    throw new Error('Team requires an authenticated HTTP user or an injected agent session');
}
