/**
 * Ask a colleague persona a question: its live session answers via team.answer, or a consultant answers from its memory and history
 *
 * Call from a persona session before touching another persona's area (e.g. Ян asks Даша about the dashboard). One question — one answer, recorded in team.ask. Live session of the persona (current_agent_id or an open team.persona_session, not archived, not the caller) → mode 'live': that session gets an agent message «Вопрос от <name> по задаче …: … Ответь одним вызовом team.answer({ askId, text })»; the answer comes back to the caller later as an agent message — do not wait or poll, go on with the task. No live session → mode 'consultant': no session is started; one LLM call speaks as the persona from its memos (team.memoSearch), past tasks (team.historySearch) and old messages (team.sessionSearch) and the answer is returned right here (status 'answered'). The chronicle gets «<Ян> спросил <Дашу>: …» and «<Даша> ответила: …». Ping-pong guards: no asking yourself or your own persona; one open question per caller and persona (status 'duplicate' returns the open one); a session may not ask back the persona whose question to it is still open — answer it with team.answer first; at most 10 questions per session.
 * @param opts.persona Persona to ask, e.g. "Даша".
 * @param opts.question The question, up to 2000 characters; say what you plan to change and what you need to know.
 * @param opts.taskId Your task id (plan or team), named in the question and the chronicle.
 */
export default async function (
    ctx: Context,
    session: Session | null,
    opts: {
        /** Persona to ask, e.g. "Даша". */
        persona: string;
        /** The question, up to 2000 characters; say what you plan to change and what you need to know. */
        question: string;
        /** Your task id (plan or team), named in the question and the chronicle. */
        taskId?: string;
    },
): Promise<{ askId: string; persona: string; mode: 'live' | 'consultant'; status: 'asked' | 'answered' | 'duplicate'; to: string | null; answer: string | null; hint: string }> {
    type Row = Record<string, any>;
    const db = ctx.fns.procs.db;
    const actor = await ctx.fns.team.resolveActor({});
    if (actor.kind !== 'agent') throw new Error('team.ask: call from an agent session (a persona asks a colleague)');
    const persona = String(opts.persona ?? '').trim();
    const question = String(opts.question ?? '').replace(/\u0000/g, '').trim();
    if (!persona) throw new Error('team.ask: persona required');
    if (!question) throw new Error('team.ask: question is empty');
    if (question.length > 2000) throw new Error('team.ask: question longer than 2000 characters');
    const p = (await db.select({ sql: 'SELECT name, role, responsibilities, prompt, model, current_agent_id FROM team.persona WHERE name=?', params: [persona] }) as Row[])[0];
    if (!p) throw new Error('team.ask: no persona ' + persona);
    const me = actor.id;
    const myPersona = String(((await db.select({ sql: 'SELECT name FROM team.persona WHERE current_agent_id=? UNION ALL SELECT persona_name FROM team.persona_session WHERE agent_id=? LIMIT 1', params: [me, me] })) as Row[])[0]?.name ?? '');
    if (myPersona === persona) throw new Error('team.ask: that is your own persona — search your history with team.historySearch / team.sessionSearch');
    let myName = myPersona;
    if (!myName) { const a = (await db.select({ sql: 'SELECT title, meta FROM agents WHERE id=?', params: [me] }) as Row[])[0]; let m: Row = {}; try { m = typeof a?.meta === 'string' ? JSON.parse(a.meta) : (a?.meta ?? {}); } catch {} myName = String(m?.persona?.name ?? a?.title ?? me).slice(0, 40); }

    // ping-pong guards
    const open = (await db.select({ sql: "SELECT * FROM team.ask WHERE from_agent_id=? AND to_persona=? AND status='asked' ORDER BY created_at DESC LIMIT 1", params: [me, persona] }) as Row[])[0];
    if (open) return { askId: String(open.id), persona, mode: open.mode, status: 'duplicate', to: open.to_agent_id ?? null, answer: null, hint: 'Твой вопрос этой персоне ещё без ответа — ответ придёт сообщением, не жди в цикле.' };
    const back = (await db.select({ sql: "SELECT id, from_name FROM team.ask WHERE to_agent_id=? AND from_agent_id IN (SELECT agent_id FROM team.persona_session WHERE persona_name=? UNION SELECT current_agent_id FROM team.persona WHERE name=?) AND status='asked' LIMIT 1", params: [me, persona, persona] }) as Row[])[0];
    if (back) throw new Error(`team.ask: ${back.from_name} ждёт твоего ответа (askId ${back.id}) — сначала team.answer({ askId, text }), встречный вопрос не задают`);
    const [cnt] = await db.select({ sql: 'SELECT count(*)::int n FROM team.ask WHERE from_agent_id=?', params: [me] }) as Row[];
    if (Number(cnt?.n ?? 0) >= 10) throw new Error('team.ask: 10 questions from this session already — decide yourself or post a question to the team (team.post kind question)');

    // task title for the message and chronicle
    const taskId = String(opts.taskId ?? '').trim() || null;
    let taskTitle = '';
    if (taskId) {
        const a = (await db.select({ sql: 'SELECT scratchpad FROM agents WHERE id=?', params: [me] }) as Row[])[0];
        let sp: Row = {}; try { sp = typeof a?.scratchpad === 'string' ? JSON.parse(a.scratchpad || '{}') : (a?.scratchpad ?? {}); } catch {}
        taskTitle = String((sp.plan?.tasks ?? []).find((t: Row) => t?.id === taskId)?.title ?? '');
        if (!taskTitle) taskTitle = String(((await db.select({ sql: 'SELECT title FROM team.task WHERE id=? LIMIT 1', params: [taskId] }).catch(() => [])) as Row[])[0]?.title ?? '');
    }

    // live session of the persona: current or open persona_session, not archived, not the caller
    const live = (await db.select({ sql: `SELECT a.id FROM agents a WHERE a.archived_at IS NULL AND a.id <> ? AND a.id IN (SELECT current_agent_id FROM team.persona WHERE name=? AND current_agent_id IS NOT NULL UNION SELECT agent_id FROM team.persona_session WHERE persona_name=? AND ended_at IS NULL)
          ORDER BY (a.id = ?) DESC, a.created_at DESC LIMIT 1`, params: [me, persona, persona, String(p.current_agent_id ?? '')] }) as Row[])[0];
    const id = Bun.randomUUIDv7(); const now = Date.now();
    const acc = (n: string) => (/а$/.test(n) ? n.slice(0, -1) + 'у' : /я$/.test(n) ? n.slice(0, -1) + 'ю' : /[бвгджзклмнпрстфхцчшщ]$/i.test(n) ? n + 'а' : n);
    const cut = (s: string, n: number) => { const f = s.replace(/\s+/g, ' ').trim(); return f.length > n ? f.slice(0, n - 1) + '…' : f; };
    const post = async (text: string, kind: 'question' | 'note') => { try { await ctx.fns.team.post({ text: cut(text, 280), kind, ...(taskId ? { taskId } : {}) }); } catch {} };
    const mode: 'live' | 'consultant' = live ? 'live' : 'consultant';
    await db.run({ sql: 'INSERT INTO team.ask (id, from_agent_id, from_name, to_persona, to_agent_id, mode, task_id, task_title, question, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', params: [id, me, myName, persona, live ? String(live.id) : null, mode, taskId, taskTitle, question, 'asked', now] });
    await post(`${myName} спросил(а) ${acc(persona)}: ${question}`, 'question');

    if (live) {
        const to = String(live.id);
        const sender = (session as any)?.agent?.id === me ? (session as any).agent : ((ctx.state as any)?.agent?.[me] ?? await ctx.fns.session.load({ id: me }));
        const text = `Вопрос от ${myName}${taskTitle || taskId ? ` по задаче «${taskTitle || taskId}»` : ''} (askId ${id}):\n\n${question}\n\nОтветь одним вызовом team.answer({ askId: '${id}', text }) — коротко, по своей области; встречных вопросов не задавай, свою работу не прерывай дольше, чем нужно на ответ.`;
        await ctx.fns.agent.message({ agent: sender, to, text });
        try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
        return { askId: id, persona, mode, status: 'asked', to, answer: null, hint: `Вопрос ушёл живой сессии ${persona} (${to}). Ответ придёт сообщением — не жди в цикле, продолжай работу.` };
    }

    // consultant: one LLM call as the persona, from its memos and history; no session is started
    const [memos, hist, msgs] = await Promise.all([
        ctx.fns.team.memoSearch({ name: persona, query: question, limit: 4, withContent: true }).catch(() => ({ memos: [] as any[] })),
        ctx.fns.team.historySearch({ query: question, persona, limit: 5 }).catch(() => ({ rows: [] as any[] })),
        ctx.fns.team.sessionSearch({ query: question, persona, limit: 6 }).catch(() => ({ rows: [] as any[] })),
    ]);
    const memoTxt = (memos.memos as any[]).map(m => `### ${m.path} — ${m.title}\n${String(m.content ?? '').slice(0, 2500)}`).join('\n\n');
    const histTxt = (hist.rows as any[]).map(r => `- «${r.title}» (${r.status}${r.stars ? ', ★' + r.stars : ''}) [${r.field}]: ${r.fragment}`).join('\n');
    const msgTxt = (msgs.rows as any[]).map(r => `- ${r.agentId}#${r.idx} ${r.role}: ${r.fragment}`).join('\n');
    const system = `Ты — ${persona}${p.role ? ', ' + p.role : ''}${p.responsibilities ? '. Отвечаешь за: ' + p.responsibilities : ''}. Коллега по команде задаёт вопрос по твоей области. Отвечай от первого лица, по-русски, коротко (до 1200 символов), только по фактам из своей памяти и истории ниже: файлы, функции, решения, ловушки. Чего там нет — так и скажи и подскажи, где посмотреть (team.historySearch / team.sessionSearch с persona '${persona}'). Не задавай встречных вопросов.`;
    const user = `Вопрос от ${myName}${taskTitle ? ` (задача «${taskTitle}»)` : ''}:\n${question}\n\n## Моя память (мемо)\n${memoTxt || '(ничего по теме)'}\n\n## Мои прошлые задачи\n${histTxt || '(ничего по теме)'}\n\n## Мои старые сообщения\n${msgTxt || '(ничего по теме)'}`;
    let answer = '';
    try {
        const r = await ctx.fns.llm.call({ system, user: user.slice(0, 24000), max_tokens: 1200, timeoutMs: 120000, ...(p.model ? { model: String(p.model) } : {}) });
        answer = String(r.text ?? '').trim();
    } catch (e) { answer = ''; await db.run({ sql: "UPDATE team.ask SET status='failed', answer=? WHERE id=?", params: [String((e as Error)?.message ?? e).slice(0, 500), id] }); throw new Error('team.ask: consultant failed: ' + String((e as Error)?.message ?? e).slice(0, 200)); }
    if (!answer) answer = 'Не знаю — в моей памяти и истории ничего по этому вопросу.';
    await db.run({ sql: "UPDATE team.ask SET status='answered', answer=?, answered_by='consultant', answered_at=? WHERE id=?", params: [answer, Date.now(), id] });
    await post(`${persona} ответил(а) по памяти: ${answer}`, 'note');
    try { await ctx.fns.procs.events.refresh({ topic: 'team' }); } catch {}
    return { askId: id, persona, mode, status: 'answered', to: null, answer, hint: `У персоны ${persona} нет живой сессии — ответил консультант по её мемо и истории (сессия не создавалась). Проверь по коду, если ответ важен.` };
}
