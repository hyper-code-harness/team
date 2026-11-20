/**
 * Change a persona's prompt, notes or card and record the revision
 *
 * One write path for personas. field 'prompt' | 'notes': give ops (deltas: add a line, remove a line — preferred, so knowledge is not lost by rewriting) or text (full replace), or revertOf (a revision id: the field gets that revision's `after` state, i.e. "roll back to this one"). field 'card': owner only — role, responsibilities, icon, plugins, model, limits. Who may write: the owner (author user, or an agent of the owner's own session — counts as the owner, recorded on_behalf_of; it sees only system personas and those of its project), or the persona itself — an agent that is the persona's current or past session — and only prompt/notes. The owner-only section of the prompt (between `<!-- owner -->` and `<!-- /owner -->`) cannot be changed by the persona. Size limits: prompt ≤ limits.promptChars (default 4000), notes ≤ limits.notesChars (default 6000) characters. baseVersion, when given, must equal the current persona version (stale edit check). Every save writes team.persona_rev (before, after, short summary, reason, base_version) and a public team.event kind 'persona' in each active team of the persona, then refreshes the 'team' live topic. No-op edits are not recorded.
 * @param opts.name Persona name.
 * @param opts.field What to change: 'prompt', 'notes' or 'card' (owner only).
 * @param opts.ops Deltas for prompt/notes: add appends a line (or inserts after a line equal to `after`), remove deletes lines equal to `line`.
 * @param opts.text Full replacement text for prompt/notes.
 * @param opts.revertOf Revision id to roll back to: the field gets that revision's `after` value.
 * @param opts.card Card fields to set (field 'card', owner only).
 * @param opts.reason Why the change is made; shown in the history.
 * @param opts.baseVersion Persona version the edit was based on; mismatch rejects the save.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona name. */
        name: string;
        /** What to change: 'prompt', 'notes' or 'card' (owner only). */
        field: 'prompt' | 'notes' | 'card';
        /** Deltas for prompt/notes: add appends a line (or inserts after a line equal to `after`), remove deletes lines equal to `line`. */
        ops?: Array<{ op: 'add' | 'remove'; line: string; after?: string }>;
        /** Full replacement text for prompt/notes. */
        text?: string;
        /** Revision id to roll back to: the field gets that revision's `after` value. */
        revertOf?: string;
        /** Card fields to set (field 'card', owner only). */
        card?: { role?: string; responsibilities?: string; icon?: string | null; plugins?: string[]; model?: string | null; limits?: Record<string, unknown> };
        /** Why the change is made; shown in the history. */
        reason?: string;
        /** Persona version the edit was based on; mismatch rejects the save. */
        baseVersion?: number;
    },
): Promise<{ name: string; field: string; changed: boolean; version: number; revisionId: string | null; summary: string }> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    const name = String(opts.name ?? '').trim();
    if (!name) throw new Error('personaSave: name required');
    if (!['prompt', 'notes', 'card'].includes(opts.field)) throw new Error('personaSave: field must be prompt, notes or card');
    const reason = String(opts.reason ?? '').trim().slice(0, 500);
    const OWN_RE = /<!--\s*owner\s*-->[\s\S]*?<!--\s*\/owner\s*-->/g;
    // Project visibility for an agent acting as the owner (checked outside the transaction: personaResolve may retry a failed query).
    let visErr = '';
    if (actor.kind === 'agent') { try { if ((await ctx.fns.team.personaResolve({ name }))?.name !== name) visErr = `persona ${name} is not visible from this session's project`; } catch (e) { visErr = (e as Error).message; } }
    const out = await ctx.fns.procs.db.transaction({ fn: async () => {
        const rows = await ctx.fns.procs.db.select({ sql: 'SELECT * FROM team.persona WHERE name=? FOR UPDATE', params: [name] }) as Row[];
        const p = rows[0]; if (!p) throw new Error('personaSave: no persona ' + name);
        // Owner = the signed-in person, or an agent of the owner's own session (team.resolveOwnerActor; recorded on_behalf_of).
        let own: { ownerId: string; onBehalfOf: string | null } | null = null;
        try { own = await ctx.fns.team.resolveOwnerActor({}); } catch { own = null; }
        const isOwner = !!own && own.ownerId === String(p.owner_user_id);
        let isSelf = false;
        if (actor.kind === 'agent') {
            const s = await ctx.fns.procs.db.select({ sql: 'SELECT 1 FROM team.persona_session WHERE persona_name=? AND agent_id=? UNION ALL SELECT 1 FROM team.persona WHERE name=? AND current_agent_id=?', params: [name, actor.id, name, actor.id] });
            isSelf = s.length > 0;
        }
        if (!isOwner && !isSelf) throw new Error('personaSave: only the owner or the persona itself may edit');
        // An agent acting for the owner sees only system personas and those of its own project.
        if (!isSelf && actor.kind === 'agent' && visErr) throw new Error(visErr);
        const onBehalfOf = !isSelf && actor.kind === 'agent' ? own?.onBehalfOf ?? null : null;
        if (opts.field === 'card' && !isOwner) throw new Error('personaSave: card (role, plugins, model, limits) is owner only');
        if (opts.baseVersion !== undefined && Number(opts.baseVersion) !== Number(p.version)) throw new Error(`personaSave: stale edit, base ${opts.baseVersion} ≠ current ${p.version}`);
        const limits: Row = (typeof p.limits === 'string' ? JSON.parse(p.limits) : p.limits) ?? {};
        let before = '', after = '', summary = '';
        const upd: Row = {};
        if (opts.field === 'card') {
            const c = opts.card ?? {};
            const cur: Row = { role: p.role, responsibilities: p.responsibilities, icon: p.icon ?? null, plugins: p.plugins ?? [], model: p.model ?? null, limits };
            const next: Row = { ...cur };
            if (opts.revertOf) {
                const r = await ctx.fns.procs.db.select({ sql: "SELECT after FROM team.persona_rev WHERE id=? AND persona_name=? AND field='card'", params: [opts.revertOf, name] }) as Row[];
                if (!r[0]) throw new Error('personaSave: no card revision ' + opts.revertOf);
                Object.assign(next, JSON.parse(String(r[0].after) || '{}'));
            } else {
                for (const k of ['role', 'responsibilities', 'icon', 'model'] as const) if (c[k] !== undefined) next[k] = c[k] === null ? null : String(c[k]);
                if (c.plugins !== undefined) next.plugins = [...new Set(c.plugins.map(String).map(s => s.trim()).filter(Boolean))];
                if (c.limits !== undefined) next.limits = c.limits ?? {};
            }
            before = JSON.stringify(cur); after = JSON.stringify(next);
            const diff = Object.keys(next).filter(k => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
            summary = diff.length ? 'карточка: ' + diff.join(', ') : '';
            Object.assign(upd, { role: next.role, responsibilities: next.responsibilities, icon: next.icon, plugins: next.plugins, model: next.model, limits: next.limits });
        } else {
            const field = opts.field;
            before = String(p[field] ?? '');
            if (opts.revertOf) {
                const r = await ctx.fns.procs.db.select({ sql: 'SELECT after FROM team.persona_rev WHERE id=? AND persona_name=? AND field=?', params: [opts.revertOf, name, field] }) as Row[];
                if (!r[0]) throw new Error('personaSave: no ' + field + ' revision ' + opts.revertOf);
                after = String(r[0].after);
            } else if (typeof opts.text === 'string') {
                after = opts.text.replace(/\u0000/g, '').replace(/\s+$/, '');
            } else if (opts.ops?.length) {
                const lines = before ? before.split('\n') : [];
                for (const o of opts.ops) {
                    const line = String(o.line ?? '').replace(/\s+$/, '');
                    if (!line.trim()) continue;
                    if (o.op === 'remove') { for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() === line.trim()) lines.splice(i, 1); }
                    else if (o.op === 'add') {
                        if (lines.some(l => l.trim() === line.trim())) continue;
                        const at = o.after ? lines.findIndex(l => l.trim() === String(o.after).trim()) : -1;
                        if (at >= 0) lines.splice(at + 1, 0, line); else lines.push(line);
                    } else throw new Error('personaSave: op must be add or remove');
                }
                after = lines.join('\n');
            } else throw new Error('personaSave: give ops, text or revertOf');
            if (field === 'prompt' && !isOwner) {
                const a = before.match(OWN_RE) ?? [], b = after.match(OWN_RE) ?? [];
                if (a.join('\n') !== b.join('\n')) throw new Error('personaSave: the <!-- owner --> section of the prompt is owner only');
            }
            const max = Number(field === 'prompt' ? limits.promptChars ?? 4000 : limits.notesChars ?? 6000);
            if (after.length > max) throw new Error(`personaSave: ${field} is ${after.length} chars, limit ${max} — compress old entries`);
            const bl = new Set(before.split('\n').map(s => s.trim()).filter(Boolean)), al = new Set(after.split('\n').map(s => s.trim()).filter(Boolean));
            const added = [...al].filter(x => !bl.has(x)), removed = [...bl].filter(x => !al.has(x));
            const cut = (s: string) => (s.length > 60 ? s.slice(0, 59) + '…' : s);
            summary = before === after ? '' : `${field}: +${added.length} −${removed.length}` + (added[0] ? ` «${cut(added[0])}»` : removed[0] ? ` −«${cut(removed[0])}»` : '');
            upd[field] = after;
        }
        if (before === after || !summary) return { name, field: opts.field, changed: false, version: Number(p.version), revisionId: null, summary: '' };
        const now = Date.now(), version = Number(p.version) + 1;
        const sets = Object.keys(upd);
        await ctx.fns.procs.db.run({ sql: `UPDATE team.persona SET ${sets.map(k => k === 'limits' ? 'limits=?::jsonb' : k === 'plugins' ? 'plugins=?::text[]' : k + '=?').join(',')}, version=?, updated_at=? WHERE name=?`, params: [...sets.map(k => k === 'limits' ? JSON.stringify(upd[k]) : upd[k]), version, now, name] });
        const revisionId = Bun.randomUUIDv7();
        await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.persona_rev(id,persona_name,field,author_kind,author_id,before,after,summary,reason,base_version,revert_of,at,on_behalf_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', params: [revisionId, name, opts.field, actor.kind, actor.id, before, after, summary, reason, Number(p.version), opts.revertOf ?? null, now, onBehalfOf] });
        const teams = await ctx.fns.procs.db.select({ sql: "SELECT tp.team_id FROM team.team_persona tp JOIN team.team t ON t.id=tp.team_id WHERE tp.persona_name=? AND tp.active AND t.status<>'archived'", params: [name] }) as Row[];
        const text = `${name}: ${summary}` + (opts.revertOf ? ' (откат)' : '') + (reason ? ' — ' + reason : '');
        for (const t of teams) {
            const s = await ctx.fns.procs.db.select({ sql: 'UPDATE team.team SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq', params: [t.team_id] }) as Row[];
            await ctx.fns.procs.db.run({ sql: "INSERT INTO team.event(id,team_id,seq,actor_kind,actor_id,kind,text,payload,timestamp,on_behalf_of) VALUES(?,?,?,?,?,'persona',?,?::jsonb,?,?)", params: [Bun.randomUUIDv7(), t.team_id, Number(s[0]!.next_seq), actor.kind, actor.id, text.slice(0, 1000), JSON.stringify({ persona: name, field: opts.field, revisionId, summary, reason, revertOf: opts.revertOf ?? null, version }), now, onBehalfOf] });
        }
        return { name, field: opts.field, changed: true, version, revisionId, summary };
    } }) as { name: string; field: string; changed: boolean; version: number; revisionId: string | null; summary: string };
    if (out.changed) { try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {} }
    return out;
}
