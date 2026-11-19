/** Accept the owner's (CSRF-checked) persona edit from team.persona: save the prompt and notes (team.personaSave author=user, one revision per changed field) or roll a field or a memo back to a revision (revertOf; memo revisions go through team.memoSave), then answer with the refreshed page and a notice.
 * @param opts.req Authenticated same-origin form request with name, baseVersion, and either prompt/notes/reason or revertOf.
 */
export default async function(ctx:Context,session:Session|null,opts:{req:Request}):Promise<Response> {
 const req=opts.req;
 const html=(body:string,status=200)=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8'}});
 if(!session?.user?.id||!session.req) return new Response('Authentication required',{status:401});
 if(req.headers.get('sec-fetch-site')==='cross-site') return new Response('Same-origin request required',{status:403});
 const type=req.headers.get('content-type')??'';
 if(!type.startsWith('application/x-www-form-urlencoded')&&!type.startsWith('multipart/form-data')) return new Response('Form required',{status:415});
 if(Number(req.headers.get('content-length')??0)>200000) return new Response('Form too large',{status:413});
 const f=await req.formData(); const get=(k:string)=>String(f.get(k)??'');
 if(!await ctx.fns.auth.verifyCsrf({req,token:get('_csrf')||req.headers.get('x-csrf-token')||''})) return new Response('Invalid CSRF token',{status:403});
 const name=get('name').trim(); if(!name) return new Response('name required',{status:400});
 const p=await ctx.fns.team.personaGet({name,revisions:100});
 if(!p) return new Response('Persona not found',{status:404});
 if(p.ownerUserId!==String(session.user.id)) return new Response('Owner required',{status:403});
 const base=Number(get('baseVersion'))||undefined;
 const reason=get('reason').trim();
 let notice='';
 try {
  const revertOf=get('revertOf').trim();
  if(revertOf) {
   const rev=p.revisions.find(r=>r.id===revertOf); if(!rev) throw new Error('ревизия не найдена');
   if(rev.field==='memo') {
    const r=await ctx.fns.team.memoSave({name,path:String(rev.path??''),revertOf,reason:reason||'откат владельцем'});
    notice=r.changed?`Откат мемо ${r.path}: ${r.summary||'v'+r.version}.`:'Уже совпадает с этой версией.';
    ctx.fns.procs.events.refresh({topic:'team',reason:'persona '+name});
    return html(await ctx.fns.team.persona({name,notice}));
   }
   if(rev.field!=='prompt'&&rev.field!=='notes') throw new Error('откатить можно только промпт, заметки или мемо');
   const r=await ctx.fns.team.personaSave({name,field:rev.field,revertOf,...(base?{baseVersion:base}:{}),reason:reason||'откат владельцем'});
   notice=r.changed?`Откат ${rev.field==='prompt'?'промпта':'заметок'}: ${r.summary||'v'+r.version}.`:'Уже совпадает с этой версией.';
  } else {
   const norm=(s:string)=>s.replace(/\r\n/g,'\n');
   const parts:string[]=[]; let version=base;
   for(const field of ['prompt','notes'] as const) {
    if(!f.has(field)) continue;
    const text=norm(get(field)); if(text===norm(field==='prompt'?p.prompt:p.notes)) continue;
    const r=await ctx.fns.team.personaSave({name,field,text,...(version?{baseVersion:version}:{}),...(reason?{reason}:{})});
    if(r.changed) { parts.push(r.summary||field); version=r.version; }
   }
   notice=parts.length?'Сохранено: '+parts.join('; ')+'.':'Изменений нет.';
  }
  ctx.fns.procs.events.refresh({topic:'team',reason:'persona '+name});
 } catch(error) { notice='Не сохранено: '+(error instanceof Error?error.message:String(error)); }
 return html(await ctx.fns.team.persona({name,notice}));
}
