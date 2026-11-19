/**
 * Read a cursor-paginated public timeline for an authorized team
 *
 * Use to read ordered team events after a sequence cursor, optionally filtering by task or event kind. Returns an ascending event array; continue with the last returned seq. Payloads are public within the team. Identity is resolved only from injected context.
 * @param opts.teamId Persistent team identifier.
 * @param opts.afterSeq Exclusive sequence cursor; zero starts at the beginning. @default 0 @minimum 0
 * @param opts.limit Maximum number of events in this page. @default 100 @minimum 1 @maximum 500
 * @param opts.taskId Return only events associated with this task.
 * @param opts.kind Return only events of this exact kind.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persistent team identifier. */
        teamId: string;
        /** Exclusive sequence cursor; zero starts at the beginning. @default 0 @minimum 0 */
        afterSeq?: number;
        /** Maximum number of events in this page. @default 100 @minimum 1 @maximum 500 */
        limit?: number;
        /** Return only events associated with this task. */
        taskId?: string;
        /** Return only events of this exact kind. */
        kind?: string;
    },
): Promise<{id:string;team_id:string;seq:number;task_id:string|null;actor_kind:'user'|'agent'|'system';actor_id:string;kind:string;text:string;payload:Record<string,unknown>;causation_id:string|null;command_key:string|null;timestamp:number}[]> {
    const actor=await ctx.fns.team.resolveActor({});
    if(!opts.teamId?.trim()) throw new Error('teamId is required');
    const after=opts.afterSeq??0, limit=opts.limit??100;
    if(!Number.isSafeInteger(after)||after<0) throw new Error('afterSeq must be a nonnegative safe integer');
    if(!Number.isSafeInteger(limit)||limit<1||limit>500) throw new Error('limit must be an integer from 1 to 500');
    const authorized=await ctx.fns.procs.db.select({sql:"SELECT t.id FROM team.team t WHERE t.id=? AND ((?='user' AND t.owner_user_id=?) OR (?='agent' AND EXISTS (SELECT 1 FROM team.member m WHERE m.team_id=t.id AND m.agent_id=?)))",params:[opts.teamId,actor.kind,actor.id,actor.kind,actor.id]});
    if(!authorized.length) throw new Error('Team not found or access denied');
    const predicates=['team_id=?','seq>?']; const params:(string|number)[]=[opts.teamId,after];
    if(opts.taskId!==undefined){predicates.push('task_id=?');params.push(opts.taskId);}
    if(opts.kind!==undefined){predicates.push('kind=?');params.push(opts.kind);}
    params.push(limit);
    return await ctx.fns.procs.db.select({sql:'SELECT * FROM team.event WHERE '+predicates.join(' AND ')+' ORDER BY seq ASC LIMIT ?',params});
}
