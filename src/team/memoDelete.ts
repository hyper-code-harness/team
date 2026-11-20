/**
 * Delete one memo of a persona's memory, keeping its history
 *
 * Soft delete: the memo leaves the table of contents and the brief, its revisions stay in team.persona_rev (a 'memo' revision with meta.deleted=true and after=''), and team.memoSave with revertOf brings it back. Same rights as team.memoSave: the owner (or an agent of the owner's own session, recorded on_behalf_of; project visibility applies) or a session of the persona; name defaults to the caller session's persona. Deleting a missing or already deleted memo returns changed:false.
 * @param opts.name Persona name; default: the persona of the calling session.
 * @param opts.path Memo path, e.g. "code/board.md".
 * @param opts.reason Why; shown in the history.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona name; default: the persona of the calling session. */
        name?: string;
        /** Memo path, e.g. "code/board.md". */
        path: string;
        /** Why; shown in the history. */
        reason?: string;
    },
): Promise<{ name: string; path: string; changed: boolean; revisionId: string | null }> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    const path = String(opts.path ?? '').trim();
    if (!path) throw new Error('memoDelete: path required');
    let name = String(opts.name ?? '').trim();
    if (!name && actor.kind === 'agent') name = String(((await ctx.fns.procs.db.select({ sql: 'SELECT name FROM team.persona WHERE current_agent_id=? UNION ALL SELECT persona_name FROM team.persona_session WHERE agent_id=? LIMIT 1', params: [actor.id, actor.id] })) as Row[])[0]?.name ?? '');
    if (!name) throw new Error('memoDelete: name required');
    const reason = String(opts.reason ?? '').trim().slice(0, 500);
    // Project visibility for an agent acting as the owner (checked outside the transaction: personaResolve may retry a failed query).
    let visErr = '';
    if (actor.kind === 'agent') { try { if ((await ctx.fns.team.personaResolve({ name }))?.name !== name) visErr = `persona ${name} is not visible from this session's project`; } catch (e) { visErr = (e as Error).message; } }
    const out = await ctx.fns.procs.db.transaction({ fn: async () => {
        const p = (await ctx.fns.procs.db.select({ sql: 'SELECT owner_user_id FROM team.persona WHERE name=? FOR UPDATE', params: [name] }) as Row[])[0];
        if (!p) throw new Error('memoDelete: no persona ' + name);
        // Owner = the signed-in person, or an agent of the owner's own session (team.resolveOwnerActor; recorded on_behalf_of).
        let own: { ownerId: string; onBehalfOf: string | null } | null = null;
        try { own = await ctx.fns.team.resolveOwnerActor({}); } catch { own = null; }
        const isOwner = !!own && own.ownerId === String(p.owner_user_id);
        const isSelf = actor.kind === 'agent' && (await ctx.fns.procs.db.select({ sql: 'SELECT 1 FROM team.persona_session WHERE persona_name=? AND agent_id=? UNION ALL SELECT 1 FROM team.persona WHERE name=? AND current_agent_id=?', params: [name, actor.id, name, actor.id] })).length > 0;
        if (!isOwner && !isSelf) throw new Error('memoDelete: only the owner or a session of ' + name + ' may delete its memos');
        // An agent acting for the owner sees only system personas and those of its own project.
        if (!isSelf && actor.kind === 'agent' && visErr) throw new Error(visErr);
        const onBehalfOf = !isSelf && actor.kind === 'agent' ? own?.onBehalfOf ?? null : null;
        const cur = (await ctx.fns.procs.db.select({ sql: 'SELECT * FROM team.persona_memo WHERE persona_name=? AND path=? FOR UPDATE', params: [name, path] }) as Row[])[0];
        if (!cur || cur.deleted_at != null) return { name, path, changed: false, revisionId: null };
        const now = Date.now(), revisionId = Bun.randomUUIDv7();
        await ctx.fns.procs.db.run({ sql: 'UPDATE team.persona_memo SET deleted_at=?, updated_at=?, version=version+1 WHERE persona_name=? AND path=?', params: [now, now, name, path] });
        const summary = `мемо ${path}: удалено`;
        await ctx.fns.procs.db.run({ sql: "INSERT INTO team.persona_rev(id,persona_name,field,path,meta,author_kind,author_id,before,after,summary,reason,base_version,revert_of,at,on_behalf_of) VALUES(?,?,'memo',?,?::jsonb,?,?,?,'',?,?,?,NULL,?,?)", params: [revisionId, name, path, JSON.stringify({ title: cur.title, description: cur.description, deleted: true }), actor.kind, actor.id, String(cur.content), summary, reason, Number(cur.version), now, onBehalfOf] });
        return { name, path, changed: true, revisionId };
    } }) as { name: string; path: string; changed: boolean; revisionId: string | null };
    if (out.changed) { try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {} }
    return out;
}
