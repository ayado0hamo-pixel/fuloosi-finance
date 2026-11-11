const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),{webcrypto}=require('node:crypto');
function device(storage=new Map()){
 const nodes=new Map();const document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',innerHTML:'',addEventListener(){},classList:{add(){},remove(){},toggle(){}}});return nodes.get(id);},querySelectorAll(){return[];},addEventListener(){}};
 const context={document,crypto:webcrypto,Intl,Date,JSON,Number,Set,Map,Object,Array,String,Error,console,structuredClone,URL,Blob,atob,location:{origin:'https://example.github.io',pathname:'/fuloosi/'},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},alert(){},confirm:()=>true,setTimeout(){},setInterval(){},addEventListener(){},scrollTo(){}};
 context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'core.js'),'utf8'),context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'app.js'),'utf8'),context);
 return {context,storage,nodes,run:s=>vm.runInContext(s,context)};
}
test('new installs are empty; local expense and balance survive restart',async()=>{
 const d=device();assert.equal(d.run('state.accounts.length'),0);
 await d.run("put('accounts',{id:'11111111-1111-4111-8111-111111111111',name:'Test',currency:'JOD',opening_balance:50})");
 await d.run("put('entries',{id:'22222222-2222-4222-8222-222222222222',account_id:state.accounts[0].id,amount:7.25,kind:'expense',category:'food',note:'',occurred_on:'2026-11-10'})");
 assert.equal(d.run('bal(state.accounts[0])'),42.75);
 const restarted=device(d.storage);assert.equal(restarted.run('bal(state.accounts[0])'),42.75);
});
test('corrupt local data is preserved; another tab cannot silently overwrite',async()=>{
 const storage=new Map([['fuloosi-v3','broken original']]);const bad=device(storage);await assert.rejects(bad.run("put('accounts',{id:'x'})"));assert.equal(storage.get('fuloosi-v3'),'broken original');
 const d=device();d.storage.set('fuloosi-v3','changed elsewhere');await assert.rejects(d.run("put('accounts',{id:'x'})"));assert.equal(d.storage.get('fuloosi-v3'),'changed elsewhere');
});
test('two independent devices read shared snapshots and preserve negative balances (mock transport)',async()=>{
 const a=device(),b=device();const snapshot={accounts:[{id:'a',name:'Shared',currency:'USD',opening_balance:10}],entries:[],settings:null};
 for(const d of [a,b]){d.context.mockClient={rpc:async()=>({data:structuredClone(snapshot),error:null})};await d.run("client=mockClient;activate({user:{id:'user-a',email:'a@example.com'}})");}
 snapshot.entries.push({id:'e',account_id:'a',kind:'expense',amount:15});
 await a.run('reload()');await b.run('reload()');assert.equal(a.run('bal(state.accounts[0])'),-5);assert.equal(b.run('bal(state.accounts[0])'),-5);
 await b.run('activate(null)');assert.equal(b.run('state.accounts.length'),0);
});
test('failed sync prevents writes; stale update reports a conflict (mock transport)',async()=>{
 const d=device();d.context.mockClient={rpc:async()=>({data:null,error:Error('offline')})};await assert.rejects(d.run("client=mockClient;activate({user:{id:'u',email:'a@b.com'}})"));await assert.rejects(d.run("put('accounts',{id:'x'})"));
 d.context.mockClient={from(){return {update(){return this;},eq(){return this;},select:async()=>({data:[],error:null})};}};
 await assert.rejects(d.run("client=mockClient;cloudReady=true;editing='x';accountRevision=1;put('accounts',{id:'x'})"),/تغير السجل/);
});
test('late response from an old session cannot display another user data (mock transport)',async()=>{
 const d=device();let finish;d.context.mockClient={rpc:()=>new Promise(resolve=>finish=resolve)};
 const pending=d.run("client=mockClient;activate({user:{id:'a',email:'a@b.com'}})");
 await d.run('activate(null)');finish({data:{accounts:[{id:'private'}],entries:[],settings:null},error:null});await pending;
 assert.equal(d.run('state.accounts.length'),0);
});
