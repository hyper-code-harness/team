/** Legacy route of the old «Принять» form (the popup now posts stars to /team/rate). Compatible: the owner's (CSRF-checked) accept requires stars — team.accept → team.rate (the executor then closes or reworks): on success empty the app popup body (popup.js then closes it) with a toast; on failure answer with the refreshed card and the error.
 * @param opts.req Authenticated same-origin form request with taskId, optional agentId, stars 1–5 (required) and optional comment.
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
 const taskId=get('taskId'), agentId=get('agentId');
 if(!taskId) return new Response('taskId required',{status:400});
 const close=(message:string)=>{const r=ctx.fns.w.respond({toast:{message}});const h=new Headers(r.headers);h.set('HX-Retarget','#app-popup-body');h.set('HX-Reswap','innerHTML');return new Response('',{status:200,headers:h});};
 const stars=Number(get('stars')||0), comment=get('text')||get('comment');
 if(!stars) return html(await ctx.fns.team.taskView({taskId,...(agentId?{agentId}:{}),notice:'Поставьте оценку.'}));
 try { const r=await ctx.fns.team.accept({taskId,stars,...(comment?{comment}:{}),...(agentId?{agentId}:{})}); return close('Оценка ★'+stars+' отправлена'+(r.final?': задача закрыта.':' — исполнитель сам закроет задачу или доделает.')); }
 catch(error) { return html(await ctx.fns.team.taskView({taskId,...(agentId?{agentId}:{}),notice:'Не принято: '+(error instanceof Error?error.message:String(error))})); }
}
