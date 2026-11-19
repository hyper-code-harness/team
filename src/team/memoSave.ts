/**
 * Create or update one memo of a persona's memory and record the revision
 *
 * Persona memory is a set of memos, each at its own path ("code/board.md", "user/preferences.md", "howto/screenshots.md") with a title, a one-line description (shown in the brief's table of contents) and the text. Give content (full text) or ops (line deltas: add, or remove a line equal to `line`); a new memo needs title and content (or ops). revertOf (a memo revision id) restores that revision's state — text, title, description — and brings back a deleted memo. Who may write: the persona's owner (signed-in person) or the persona itself (an agent that is its current or past session, team.persona_session). name defaults to the caller session's persona. Size: one memo ≤ limits.memoChars (default 2500) characters — longer text is rejected with a request to compress it or split it into several memos, never cut; at most limits.memoCount (default 60) live memos. baseVersion, when given, must equal the memo's version. Every change writes team.persona_rev (field 'memo', path, before/after text, meta {title, description, deleted}) and a public team.event 'persona' in each active team of the persona; no-op edits are not recorded. This is the write that team.reportTask requires from a persona before it accepts a hand-in.
 * @param opts.name Persona name; default: the persona of the calling session.
 * @param opts.path Memo path, e.g. "code/board.md": letters, digits, - _ . / only, no leading slash, no "..".
 * @param opts.title Short title shown in the table of contents; required for a new memo.
 * @param opts.description One line: what is inside and when it applies; shown in the brief's table of contents.
 * @param opts.content Full new text of the memo.
 * @param opts.ops Line deltas instead of content: add appends a line (or inserts after a line equal to `after`), remove deletes lines equal to `line`.
 * @param opts.revertOf Memo revision id to roll back to.
 * @param opts.reason Why; shown in the history.
 * @param opts.baseVersion Memo version the edit was based on; mismatch rejects the save.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona name; default: the persona of the calling session. */
        name?: string;
        /** Memo path, e.g. "code/board.md": letters, digits, - _ . / only, no leading slash, no "..". */
        path: string;
        /** Short title shown in the table of contents; required for a new memo. */
        title?: string;
        /** One line: what is inside and when it applies; shown in the brief's table of contents. */
        description?: string;
        /** Full new text of the memo. */
        content?: string;
        /** Line deltas instead of content: add appends a line (or inserts after a line equal to `after`), remove deletes lines equal to `line`. */
        ops?: Array<{ op: 'add' | 'remove'; line: string; after?: string }>;
        /** Memo revision id to roll back to. */
        revertOf?: string;
        /** Why; shown in the history. */
        reason?: string;
        /** Memo version the edit was based on; mismatch rejects the save. */
        baseVersion?: number;
    },
): Promise<{ name: string; path: string; changed: boolean; created: boolean; version: number; chars: number; revisionId: string | null; summary: string }> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    const path = String(opts.path ?? '').trim();
    if (!path) throw new Error('memoSave: path required, e.g. "code/board.md"');
    if (path.length > 120 || !/^[\p{L}\p{N}_.\-]+(\/[\p{L}\p{N}_.\-]+)*$/u.test(path) || path.split('/').some(s => s === '..' || s === '.')) throw new Error('memoSave: bad path «' + path + '» — use words with - _ . and / like "code/board.md"');
    let name = String(opts.name ?? '').trim();
    if (!name && actor.kind === 'agent') {
        const r = await ctx.fns.procs.db.select({ sql: 'SELECT name FROM team.persona WHERE current_agent_id=? UNION ALL SELECT persona_name FROM team.persona_session WHERE agent_id=? LIMIT 1', params: [actor.id, actor.id] }) as Row[];
        name = String(r[0]?.name ?? '');
    }
    if (!name) throw new Error('memoSave: name required (this session is not a persona session)');
    const reason = String(opts.reason ?? '').trim().slice(0, 500);
    const clean = (s: string) => s.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
    const out = await ctx.fns.procs.db.transaction({ fn: async () => {
        const p = (await ctx.fns.procs.db.select({ sql: 'SELECT * FROM team.persona WHERE name=? FOR UPDATE', params: [name] }) as Row[])[0];
        if (!p) throw new Error('memoSave: no persona ' + name);
        const isOwner = actor.kind === 'user' && actor.id === String(p.owner_user_id);
        const isSelf = actor.kind === 'agent' && (await ctx.fns.procs.db.select({ sql: 'SELECT 1 FROM team.persona_session WHERE persona_name=? AND agent_id=? UNION ALL SELECT 1 FROM team.persona WHERE name=? AND current_agent_id=?', params: [name, actor.id, name, actor.id] })).length > 0;
        if (!isOwner && !isSelf) throw new Error(`memoSave: only the owner or a session of ${name} may write its memos (caller ${actor.kind} ${actor.id} is not in team.persona_session)`);
        const limits: Row = (typeof p.limits === 'string' ? JSON.parse(p.limits) : p.limits) ?? {};
        const cur = (await ctx.fns.procs.db.select({ sql: 'SELECT * FROM team.persona_memo WHERE persona_name=? AND path=? FOR UPDATE', params: [name, path] }) as Row[])[0];
        const live = cur && cur.deleted_at == null;
        if (opts.baseVersion !== undefined && Number(opts.baseVersion) !== Number(cur?.version ?? 0)) throw new Error(`memoSave: stale edit of ${path}, base ${opts.baseVersion} ≠ current ${cur?.version ?? 0}`);
        const before = live ? String(cur.content) : '';
        let title = String(opts.title ?? (live ? cur.title : '')).trim().slice(0, 200);
        let description = String(opts.description ?? (live ? cur.description : '')).replace(/\s+/g, ' ').trim().slice(0, 300);
        let after: string;
        if (opts.revertOf) {
            const r = (await ctx.fns.procs.db.select({ sql: "SELECT after, meta FROM team.persona_rev WHERE id=? AND persona_name=? AND field='memo' AND path=?", params: [opts.revertOf, name, path] }) as Row[])[0];
            if (!r) throw new Error('memoSave: no revision ' + opts.revertOf + ' of ' + path);
            const m: Row = (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) ?? {};
            if (m.deleted) throw new Error('memoSave: that revision is a delete — use memoDelete');
            after = String(r.after); title = String(m.title ?? title); description = String(m.description ?? description);
        } else if (typeof opts.content === 'string') after = clean(opts.content);
        else if (opts.ops?.length) {
            const lines = before ? before.split('\n') : [];
            for (const o of opts.ops) {
                const line = String(o.line ?? '').replace(/\s+$/, '');
                if (!line.trim()) continue;
                if (o.op === 'remove') { for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() === line.trim()) lines.splice(i, 1); }
                else if (o.op === 'add') {
                    if (lines.some(l => l.trim() === line.trim())) continue;
                    const at = o.after ? lines.findIndex(l => l.trim() === String(o.after).trim()) : -1;
                    if (at >= 0) lines.splice(at + 1, 0, line); else lines.push(line);
                } else throw new Error('memoSave: op must be add or remove');
            }
            after = lines.join('\n');
        } else if (live && (opts.title !== undefined || opts.description !== undefined)) after = before;
        else throw new Error('memoSave: give content, ops or revertOf');
        if (!title) throw new Error('memoSave: title required for a new memo ' + path);
        if (!after.trim()) throw new Error('memoSave: empty memo ' + path + ' — to remove it use team.memoDelete');
        const max = Number(limits.memoChars ?? 2500);
        if (after.length > max) throw new Error(`memoSave: memo ${path} would be ${after.length} chars, limit ${max}. Compress it: merge repeated lines, drop what is outdated or obvious from the code, or split it into several memos by topic (e.g. ${path.replace(/\.md$/, '')}/<part>.md) — then save again. Nothing was saved.`);
        if (!live) {
            const n = Number((await ctx.fns.procs.db.select({ sql: 'SELECT count(*)::int n FROM team.persona_memo WHERE persona_name=? AND deleted_at IS NULL', params: [name] }) as Row[])[0]?.n ?? 0);
            const maxN = Number(limits.memoCount ?? 60);
            if (n >= maxN) throw new Error(`memoSave: ${name} already has ${n} memos (limit ${maxN}) — merge or delete old ones (team.memoDelete) before creating ${path}`);
        }
        const metaChanged = live && (title !== String(cur.title) || description !== String(cur.description));
        if (live && before === after && !metaChanged) return { name, path, changed: false, created: false, version: Number(cur.version), chars: after.length, revisionId: null, summary: '' };
        const bl = new Set(before.split('\n').map(s => s.trim()).filter(Boolean)), al = new Set(after.split('\n').map(s => s.trim()).filter(Boolean));
        const added = [...al].filter(x => !bl.has(x)), removed = [...bl].filter(x => !al.has(x));
        const cut = (s: string) => (s.length > 60 ? s.slice(0, 59) + '…' : s);
        const summary = !live ? `мемо ${path}: создано «${cut(title)}»` : before === after ? `мемо ${path}: заголовок/описание` : `мемо ${path}: +${added.length} −${removed.length}` + (added[0] ? ` «${cut(added[0])}»` : removed[0] ? ` −«${cut(removed[0])}»` : '');
        const now = Date.now(), version = Number(cur?.version ?? 0) + 1;
        if (cur) await ctx.fns.procs.db.run({ sql: 'UPDATE team.persona_memo SET title=?, description=?, content=?, version=?, updated_at=?, deleted_at=NULL WHERE persona_name=? AND path=?', params: [title, description, after, version, now, name, path] });
        else await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.persona_memo(persona_name,path,title,description,content,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', params: [name, path, title, description, after, version, now, now] });
        const revisionId = Bun.randomUUIDv7();
        await ctx.fns.procs.db.run({ sql: "INSERT INTO team.persona_rev(id,persona_name,field,path,meta,author_kind,author_id,before,after,summary,reason,base_version,revert_of,at) VALUES(?,?,'memo',?,?::jsonb,?,?,?,?,?,?,?,?,?)", params: [revisionId, name, path, JSON.stringify({ title, description, deleted: false }), actor.kind, actor.id, before, after, summary, reason, Number(cur?.version ?? 0), opts.revertOf ?? null, now] });
        const teams = await ctx.fns.procs.db.select({ sql: "SELECT tp.team_id FROM team.team_persona tp JOIN team.team t ON t.id=tp.team_id WHERE tp.persona_name=? AND tp.active AND t.status<>'archived'", params: [name] }) as Row[];
        const text = `${name}: ${summary}` + (opts.revertOf ? ' (откат)' : '') + (reason ? ' — ' + reason : '');
        for (const t of teams) {
            const s = await ctx.fns.procs.db.select({ sql: 'UPDATE team.team SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq', params: [t.team_id] }) as Row[];
            await ctx.fns.procs.db.run({ sql: "INSERT INTO team.event(id,team_id,seq,actor_kind,actor_id,kind,text,payload,timestamp) VALUES(?,?,?,?,?,'persona',?,?::jsonb,?)", params: [Bun.randomUUIDv7(), t.team_id, Number(s[0]!.next_seq), actor.kind, actor.id, text.slice(0, 1000), JSON.stringify({ persona: name, field: 'memo', path, revisionId, summary, reason, revertOf: opts.revertOf ?? null, version }), now] });
        }
        return { name, path, changed: true, created: !live, version, chars: after.length, revisionId, summary };
    } }) as { name: string; path: string; changed: boolean; created: boolean; version: number; chars: number; revisionId: string | null; summary: string };
    if (out.changed) { try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {} }
    return out;
}
