/** Accept the owner's (CSRF-checked) «Вернуть в работу» / «В бэклог» button of a «Дальше» item in team.taskView (team.next): on success re-render the card in place (the popup stays open, the item shows as sent) with a toast; on failure answer with the refreshed card and the error.
 * @param opts.req Authenticated same-origin form request with taskId, optional agentId and idx.
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
 const taskId=get('taskId'), agentId=get('agentId'), idx=Number(get('idx'));
 if(!taskId) return new Response('taskId required',{status:400});
 if(!Number.isInteger(idx)||idx<0) return new Response('idx required',{status:400});
 // Keep the popup open: answer with the re-rendered card (the item now shows as sent) plus a toast header.
 const stay=async(message:string)=>{const r=ctx.fns.w.respond({toast:{message}});const h=new Headers(r.headers);h.set('content-type','text/html; charset=utf-8');return new Response(await ctx.fns.team.taskView({taskId,...(agentId?{agentId}:{})}),{status:200,headers:h});};
 let notice='';
 try {
  const out=await ctx.fns.team.next({taskId,idx,...(agentId?{agentId}:{})});
  const msg:Record<string,string>={changes:'Задача возвращена исполнителю в работу.',continueTask:'Исполнителю поставлена задача «доделать».',say:'Исполнителю отправлено: доделать.',agent:'Исполнителю отправлено: доделать.',manager:'Субагент в архиве — просьба доделать ушла менеджеру.',backlog:'Пункт поставлен в бэклог.',askManager:'Команды нет — менеджер получил просьбу поставить задачу.'};
  return await stay(out.duplicate?'Этот пункт уже отправлен.':out.kind==='continue'?'Вернул в работу '+String((out as any).toName||out.to)+'.':(msg[out.action]??'Готово.'));
 }
 catch(error) { notice='Не отправлено: '+(error instanceof Error?error.message:String(error)); }
 return html(await ctx.fns.team.taskView({taskId,...(agentId?{agentId}:{}),notice}));
}
