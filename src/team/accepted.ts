/**
 * Lists owner acceptance marks of delegated child plan tasks and the review cutoff
 *
 * A finished child plan task sits in Review until the owner accepts it (team.accept). Tasks completed before `since` (the moment review for child tasks was introduced) count as accepted, so old history does not flood Review. Review has two passes: a manager's accept ('manager:<agentId>') is the first pass — the task stays in Review, listed in `checked`; only a person's accept is final and puts the key into `keys` (History). Keys are "<agentId>:<taskId>"; `at`/`by` cover both kinds of marks: `by` holds a person id or 'manager:<agentId>'. `continued` maps a task reopened into a new session (team.reopen, archived child) to that session and task; such keys also count in `keys` (out of Review).
 * @param opts.agentIds Child agent ids to look up; '' looks up team-task marks.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Child agent ids to look up. */
        agentIds: string[];
    },
): Promise<{since:number; keys:string[]; checked:string[]; at:Record<string,number>; by:Record<string,string>; continued:Record<string,{agentId:string;taskId:string;at:number}>}> {
    const since = 1795046400000; // start of the day review for child tasks was introduced; earlier completions are history
    // '' = team tasks (team.accept agent_id '' holds the manager's first-pass marks for them)
    const ids = [...new Set((opts.agentIds ?? []).map(x => String(x ?? '')))];
    if (!ids.length) return { since, keys: [], checked: [], at: {}, by: {}, continued: {} };
    let rows: Array<Record<string, any>> = [];
    // Missing table (migration not applied yet) means nothing accepted so far, not an error.
    try { rows = await ctx.fns.procs.db.select({ sql: 'SELECT agent_id, task_id, accepted_at, accepted_by FROM team.accept WHERE agent_id = ANY(?::text[])', params: [ids] }) as Array<Record<string, any>>; }
    catch (e) { if (!/team\.accept|does not exist/.test(String(e))) throw e; }
    const at: Record<string, number> = {}, by: Record<string, string> = {};
    for (const r of rows) { const k = String(r.agent_id) + ':' + String(r.task_id); at[k] = Number(r.accepted_at); by[k] = String(r.accepted_by ?? ''); }
    const keys = Object.keys(at);
    // Reopened in a new session (team.reopen of an archived child): the old card leaves Review, its work goes on in the new one.
    const continued: Record<string, { agentId: string; taskId: string; at: number }> = {};
    try { for (const r of await ctx.fns.procs.db.select({ sql: "SELECT agent_id, task_id, new_agent_id, new_task_id, at FROM team.reopen WHERE agent_id = ANY(?::text[]) AND new_agent_id <> '' ORDER BY at", params: [ids] }) as Array<Record<string, any>>) continued[String(r.agent_id) + ':' + String(r.task_id)] = { agentId: String(r.new_agent_id), taskId: String(r.new_task_id || 'task'), at: Number(r.at) }; }
    catch (e) { if (!/team\.reopen|does not exist/.test(String(e))) throw e; }
    const human = keys.filter(k => !/^manager:/.test(by[k] ?? ''));
    return { since, keys: [...new Set([...human, ...Object.keys(continued)])], checked: keys.filter(k => /^manager:/.test(by[k] ?? '') && !continued[k]), at, by, continued };
}
