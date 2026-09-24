export async function accessAPI({path,method,body,params,access,abuse,alerts,monitor,send,requestId}) {
  let result,action,appId='';
  const app=path.match(/^\/admin\/apps\/([A-Za-z0-9_-]+)\/(access|quotas)$/);
  if(app){appId=app[1];if(method==='GET')result=app[2]==='access'?await access.describe(appId):await abuse.appSettings(appId);
    if(method==='PUT'){result=app[2]==='access'?await access.savePolicy(appId,body):await abuse.saveApp(appId,body);action=app[2]+'.settings';}}
  if(path==='/admin/servers'){
    if(method==='GET')result={servers:await access.servers()};
    if(method==='POST'){result=await access.createServer(body);action='server.request';}
  }
  const server=path.match(/^\/admin\/servers\/([A-Za-z0-9_-]+)$/);
  if(server&&method==='POST'){result=await access.updateServer(server[1],body);action='server.'+body.action;}
  if(path==='/admin/alerts'){
    if(method==='GET')result=await alerts.state();
    if(method==='PUT'){result=await alerts.save(body);action='alerts.settings';}
  }
  if(result!==undefined){if(action)await monitor.record({kind:'audit',action,appId,requestId});send(200,result);return true;}
  return false;
}
