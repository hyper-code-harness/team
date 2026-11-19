/**
 * Create a persona: a named team member that outlives its sessions
 *
 * Owner (signed-in person) only. Writes team.persona and a first 'card' revision. Icon: given svg, else the icon of the latest session whose agents.meta.persona.name equals the name, else null (a letter face is drawn). Exact repeat with the same name and owner returns the existing persona with created:false (no overwrite; change it with team.personaSave). To put the persona into a team use team.create (personas) or team.personaJoin.
 * @param opts.name Display name, unique, e.g. "Ян".
 * @param opts.role Short role, e.g. "ядро".
 * @param opts.responsibilities What the persona is responsible for.
 * @param opts.icon SVG icon; omitted copies the latest session icon of this persona name.
 * @param opts.prompt Starting persona prompt (how it should work).
 * @param opts.notes Starting persona notes (memory).
 * @param opts.plugins Plugin names the persona works with.
 * @param opts.model Default model route for the persona's sessions.
 * @param opts.limits Optional limits, e.g. {promptChars, notesChars}.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Display name, unique, e.g. "Ян". */
        name: string;
        /** Short role, e.g. "ядро". */
        role: string;
        /** What the persona is responsible for. */
        responsibilities?: string;
        /** SVG icon; omitted copies the latest session icon of this persona name. */
        icon?: string;
        /** Starting persona prompt (how it should work). */
        prompt?: string;
        /** Starting persona notes (memory). */
        notes?: string;
        /** Plugin names the persona works with. */
        plugins?: string[];
        /** Default model route for the persona's sessions. */
        model?: string;
        /** Optional limits, e.g. {promptChars, notesChars}. */
        limits?: Record<string, unknown>;
    },
): Promise<{ name: string; created: boolean; icon: string | null }> {
    type Row = Record<string, any>;
    const actor = await ctx.fns.team.resolveActor({});
    if (actor.kind !== 'user') throw new Error('personaCreate: owner (signed-in person) only');
    const name = String(opts.name ?? '').trim(), role = String(opts.role ?? '').trim();
    if (!name || name.length > 40) throw new Error('personaCreate: name required, ≤40 chars');
    if (!role) throw new Error('personaCreate: role required');
    const existing = await ctx.fns.procs.db.select({ sql: 'SELECT owner_user_id, icon FROM team.persona WHERE name=?', params: [name] }) as Row[];
    if (existing[0]) { if (String(existing[0].owner_user_id) !== actor.id) throw new Error('personaCreate: name taken'); return { name, created: false, icon: existing[0].icon ?? null }; }
    let icon: string | null = opts.icon?.trim() || null;
    if (!icon) { const r = await ctx.fns.procs.db.select({ sql: "SELECT icon FROM agents WHERE meta->'persona'->>'name' = ? AND icon IS NOT NULL ORDER BY created_at DESC LIMIT 1", params: [name] }) as Row[]; icon = r[0]?.icon ?? null; }
    const now = Date.now();
    const card = { role, responsibilities: String(opts.responsibilities ?? '').trim(), icon, plugins: [...new Set((opts.plugins ?? []).map(String).map(s => s.trim()).filter(Boolean))], model: opts.model?.trim() || null, limits: opts.limits ?? {} };
    await ctx.fns.procs.db.transaction({ fn: async () => {
        await ctx.fns.procs.db.run({ sql: 'INSERT INTO team.persona(name,owner_user_id,role,responsibilities,icon,prompt,notes,plugins,model,limits,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?::text[],?,?::jsonb,?,?)', params: [name, actor.id, card.role, card.responsibilities, icon, String(opts.prompt ?? ''), String(opts.notes ?? ''), card.plugins, card.model, JSON.stringify(card.limits), now, now] });
        await ctx.fns.procs.db.run({ sql: "INSERT INTO team.persona_rev(id,persona_name,field,author_kind,author_id,before,after,summary,reason,base_version,at) VALUES(?,?,'card','user',?,'',?,'создана','',0,?)", params: [Bun.randomUUIDv7(), name, actor.id, JSON.stringify(card), now] });
    } });
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { name, created: true, icon };
}
