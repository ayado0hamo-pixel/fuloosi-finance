const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('./core.js');
const a={id:'11111111-1111-4111-8111-111111111111',name:'Test',currency:'JOD',opening_balance:100.1};
const e={id:'22222222-2222-4222-8222-222222222222',account_id:a.id,kind:'expense',amount:.1,category:'food',note:'',occurred_on:'2026-11-10'};
const data=()=>({accounts:[{...a}],entries:[{...e}],settings:{iqd_per_usd:1679,jod_per_usd:.709}});
test('expenses, income and negative balances use thousandths',()=>{
 assert.equal(core.balance(a,[e]),100);
 assert.equal(core.balance({...a,opening_balance:0},[e]),-.1);
 assert.equal(core.balance(a,[e,{...e,kind:'income',amount:5.25}]),105.25);
});
test('transfers subtract from source and add to target without becoming expenses',()=>{
 const b={...a,id:'55555555-5555-4555-8555-555555555555',name:'Target',opening_balance:0};
 const t={id:'66666666-6666-4666-8666-666666666666',from_account_id:a.id,to_account_id:b.id,from_amount:10,to_amount:9.5,note:'',occurred_on:'2026-11-11'};
 assert.equal(core.balance(a,[],[t]),90.1);
 assert.equal(core.balance(b,[],[t]),9.5);
});
test('reject orphaned, duplicate, invalid amount and impossible date backups',()=>{
 for(const mutate of [x=>x.entries[0].account_id='missing',x=>x.accounts.push({...a}),x=>x.entries[0].amount='NaN',x=>x.entries[0].amount=.0001,x=>x.entries[0].occurred_on='2026-02-30',x=>x.settings.iqd_per_usd=0]){const x=data();mutate(x);assert.throws(()=>core.validate(x));}
});
test('backup validation retains data and removes untrusted ownership fields',()=>{
 const x=data();x.accounts[0].user_id='other';const y=core.validate(x);assert.equal(y.entries[0].amount,.1);assert.equal(y.accounts[0].user_id,undefined);
});
test('only public Supabase keys accepted',()=>{
 const url='https://test.supabase.co',key=role=>'e30.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.sig';
 assert.equal(core.validConfig(url,key('anon')),true);
 assert.equal(core.validConfig(url,key('service_role')),false);
 assert.equal(core.validConfig(url,'sb_secret_abc'),false);
 assert.equal(core.validConfig(url,'sb_publishable_abc'),true);
 assert.equal(core.validConfig('http://test.supabase.co','sb_publishable_abc'),false);
});
test('monthly statistics convert every currency to JOD and calculate remaining budget',()=>{
 const x=data();
 x.settings.monthly_budget_jod=600;
 x.budgets=[{category:'food',monthly_limit_jod:100}];
 x.entries=[{...e,amount:10,occurred_on:'2026-11-10'}];
 const stats=core.monthStats(x,'2026-11');
 assert.equal(stats.total_spent_jod,10);
 assert.equal(stats.total_remaining_jod,590);
 assert.equal(stats.rows[0].remaining_jod,90);
 assert.equal(core.toJod(10,'USD',x.settings),7.09);
});
test('debt ledger keeps separate signed totals by currency',()=>{
 const person='33333333-3333-4333-8333-333333333333';
 const rows=[
  {person_id:person,direction:'owed_to_me',amount:20,currency:'JOD'},
  {person_id:person,direction:'i_owe',amount:5,currency:'JOD'},
  {person_id:person,direction:'i_owe',amount:1000,currency:'IQD'}
 ];
 assert.deepEqual(core.debtNet(person,rows),{IQD:-1000,JOD:15,USD:0});
});
