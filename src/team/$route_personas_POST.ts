/** Accept the signed-in owner's (CSRF-checked) «Новая персона» form from team.personas: create the persona with team.personaCreate (face copied from the picked agent's icon), optionally hire it into a team with team.hire, then answer with the refreshed list and a notice.
 * @param opts.req Authenticated same-origin form request with name, role, responsibilities, plugins[], model, prompt, iconFrom (agent id) and optional teamId.
 */
export default async function(ctx:Context,session:Session|null,opts:{req:Request}):Promise<Response> {
 const req=opts.req;
 const html=(body:string,status=200)=>new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8'}});
 if(!session?.user?.id||!session.req) return new Response('Authentication required',{status:401});
 if(req.headers.get('sec-fetch-site')==='cross-site') return new Response('Same-origin request required',{status:403});
 const type=req.headers.get('content-type')??'';
 if(!type.startsWith('application/x-www-form-urlencoded')&&!type.startsWith('multipart/form-data')) return new Response('Form required',{status:415});
 if(Number(req.headers.get('content-length')??0)>100000) return new Response('Form too large',{status:413});
 const f=await req.formData(); const get=(k:string)=>String(f.get(k)??'').trim();
 if(!await ctx.fns.auth.verifyCsrf({req,token:get('_csrf')||req.headers.get('x-csrf-token')||''})) return new Response('Invalid CSRF token',{status:403});
 const name=get('name'), role=get('role');
 let notice='';
 try {
  if(!name||!role) throw new Error('нужны имя и роль');
  const plugins=f.getAll('plugins').map(v=>String(v).trim()).filter(Boolean);
  let icon:string|undefined;
  const from=get('iconFrom');
  if(from) { const r=await ctx.fns.procs.db.select({sql:'SELECT icon FROM agents WHERE id=?',params:[from]}) as Array<Record<string,any>>; if(r[0]?.icon) icon=String(r[0].icon); }
  const responsibilities=get('responsibilities'), model=get('model'), prompt=String(f.get('prompt')??'').replace(/\r\n/g,'\n').trim();
  const scope=get('scope'), projectId=get('projectId');
  const lv:Record<string,string>={}; if(scope==='system'||scope==='project') { lv.scope=scope; if(scope==='project'&&projectId) lv.projectId=projectId; }
  const c=await (ctx.fns.team.personaCreate as (o:Record<string,unknown>)=>ReturnType<typeof ctx.fns.team.personaCreate>)({...lv,name,role,...(responsibilities?{responsibilities}:{}),...(icon?{icon}:{}),...(prompt?{prompt}:{}),...(plugins.length?{plugins}:{}),...(model?{model}:{})});
  if(!c.created) throw new Error('персона «'+name+'» уже есть');
  notice='Создана «'+c.name+'».';
  const teamId=get('teamId');
  if(teamId) {
   try {
    const t=await ctx.fns.team.get({teamId});
    await ctx.fns.team.hire({teamId,requestKey:'persona-hire-'+name+'-'+Date.now(),expectedVersion:Number(t.team.version),persona:{name,role,skills:responsibilities?[responsibilities]:[]},...(prompt?{brief:prompt}:{}),...(model?{model}:{})});
    notice+=' Нанята в «'+String(t.team.title)+'».';
   } catch(e) { notice+=' Нанять не вышло: '+(e instanceof Error?e.message:String(e)); }
  }
  ctx.fns.procs.events.refresh({topic:'team',reason:'persona created '+name});
 } catch(error) { notice='Не создана: '+(error instanceof Error?error.message:String(error)); }
 return html(await ctx.fns.team.personas({notice}));
}
