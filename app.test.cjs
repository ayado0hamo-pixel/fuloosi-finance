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
 await d.run("insertRow('accounts',{id:'11111111-1111-4111-8111-111111111111',name:'Test',currency:'JOD',opening_balance:50})");
 await d.run("insertRow('entries',{id:'22222222-2222-4222-8222-222222222222',account_id:state.accounts[0].id,amount:7.25,kind:'expense',category:'food',note:'',occurred_on:'2026-11-10',created_at:'2026-11-10T00:00:00Z'})");
 assert.equal(d.run('bal(state.accounts[0])'),42.75);
 const restarted=device(d.storage);assert.equal(restarted.run('bal(state.accounts[0])'),42.75);
});
test('corrupt local data is preserved; another tab cannot silently overwrite',async()=>{
 const storage=new Map([['fuloosi-v3','broken original']]);const bad=device(storage);await assert.rejects(bad.run("insertRow('accounts',{id:'x'})"));assert.equal(storage.get('fuloosi-v3'),'broken original');
 const d=device();d.storage.set('fuloosi-v3','changed elsewhere');await assert.rejects(d.run("insertRow('accounts',{id:'x'})"));assert.equal(d.storage.get('fuloosi-v3'),'changed elsewhere');
});
test('two independent devices read shared snapshots and preserve negative balances (mock transport)',async()=>{
 const a=device(),b=device();const snapshot={accounts:[{id:'a',name:'Shared',currency:'USD',opening_balance:10}],entries:[],settings:null};
 for(const d of [a,b]){d.context.mockClient={rpc:async()=>({data:structuredClone(snapshot),error:null})};await d.run("client=mockClient;activate({user:{id:'user-a',email:'a@example.com'}})");}
 snapshot.entries.push({id:'e',account_id:'a',kind:'expense',amount:15});
 await a.run('reload()');await b.run('reload()');assert.equal(a.run('bal(state.accounts[0])'),-5);assert.equal(b.run('bal(state.accounts[0])'),-5);
 await b.run('activate(null)');assert.equal(b.run('state.accounts.length'),0);
});
test('failed sync prevents writes; stale update reports a conflict (mock transport)',async()=>{
 const d=device();d.context.mockClient={rpc:async()=>({data:null,error:Error('offline')})};await assert.rejects(d.run("client=mockClient;activate({user:{id:'u',email:'a@b.com'}})"));await assert.rejects(d.run("insertRow('accounts',{id:'x'})"));
 d.context.mockClient={from(){return {update(){return this;},eq(){return this;},select:async()=>({data:[],error:null})};}};
 await assert.rejects(d.run("client=mockClient;cloudReady=true;updateRow('accounts','x',{id:'x'},1)"),/تغير السجل/);
});
test('late response from an old session cannot display another user data (mock transport)',async()=>{
 const d=device();let finish;d.context.mockClient={rpc:()=>new Promise(resolve=>finish=resolve)};
 const pending=d.run("client=mockClient;activate({user:{id:'a',email:'a@b.com'}})");
 await d.run('activate(null)');finish({data:{accounts:[{id:'private'}],entries:[],settings:null},error:null});await pending;
 assert.equal(d.run('state.accounts.length'),0);
});
test('budgets and debt names survive local restart',async()=>{
 const d=device();
 await d.run("insertRow('debt_people',{id:'33333333-3333-4333-8333-333333333333',name:'Ali',created_at:'2026-11-11T00:00:00Z'})");
 await d.run("insertRow('debt_entries',{id:'44444444-4444-4444-8444-444444444444',person_id:'33333333-3333-4333-8333-333333333333',direction:'owed_to_me',amount:12,currency:'JOD',note:'',occurred_on:'2026-11-11',created_at:'2026-11-11T00:00:00Z'})");
 assert.equal(d.run("FuloosiCore.debtNet(state.debt_people[0].id,state.debt_entries).JOD"),12);
 const restarted=device(d.storage);assert.equal(restarted.run('state.debt_people[0].name'),'Ali');
});
test('local transfer changes both balances and survives restart',async()=>{
 const d=device();
 await d.run("insertRow('accounts',{id:'11111111-1111-4111-8111-111111111111',name:'From',currency:'JOD',opening_balance:50})");
 await d.run("insertRow('accounts',{id:'55555555-5555-4555-8555-555555555555',name:'To',currency:'JOD',opening_balance:0})");
 await d.run("insertRow('transfers',{id:'66666666-6666-4666-8666-666666666666',from_account_id:'11111111-1111-4111-8111-111111111111',to_account_id:'55555555-5555-4555-8555-555555555555',from_amount:12,to_amount:12,note:'',occurred_on:'2026-11-11',created_at:'2026-11-11T00:00:00Z'})");
 assert.equal(d.run('bal(state.accounts[0])'),38);
 assert.equal(d.run('bal(state.accounts[1])'),12);
 const restarted=device(d.storage);assert.equal(restarted.run('state.transfers.length'),1);
});

test('tapping a balance reconciles increases and decreases without counting them as spending', async () => {
  const d = device();
  await d.run(`
    insertRow('accounts', {
      id: '11111111-1111-4111-8111-111111111111', name: 'Test', currency: 'JOD', opening_balance: 104.76
    });
  `);
  await d.run(`
    insertRow('entries', {
      id: '22222222-2222-4222-8222-222222222222', account_id: state.accounts[0].id,
      amount: 7.25, kind: 'expense', category: 'food', note: '', occurred_on: today()
    });
  `);
  d.run('render(); showAccountForm(state.accounts[0].id)');
  assert.match(d.nodes.get('accountList').innerHTML, /showBalanceForm.*97\.51/);
  assert.equal(d.nodes.get('abalance').disabled, true);
  d.run('showBalanceForm()');
  assert.equal(d.nodes.get('newBalance').value, 97.51);
  d.nodes.get('newBalance').value = '110';
  await d.run('saveAccountBalance()');
  assert.equal(d.run('bal(state.accounts[0])'), 110);
  assert.equal(d.run('state.entries[1].amount'), 12.49);

  d.run('showBalanceForm(state.accounts[0].id)');
  d.nodes.get('newBalance').value = '-5.125';
  await d.run('saveAccountBalance()');
  assert.equal(d.run('state.accounts[0].opening_balance'), 104.76);
  assert.equal(d.run('state.entries[2].amount'), 115.125);
  assert.equal(d.run('FuloosiCore.monthStats(state, thisMonth()).total_spent_jod'), 7.25);
  assert.match(d.nodes.get('expenseSummary').textContent, /7\.25 JOD/);
  assert.match(d.nodes.get('entryList').innerHTML, /تسوية رصيد/);
  assert.equal(device(d.storage).run('bal(state.accounts[0])'), -5.125);
});

test('a deleted cloud account name can be reused despite a stale snapshot', async () => {
  const d = device();
  const old = { id: '11111111-1111-4111-8111-111111111111', name: 'Test Cash', currency: 'USD', opening_balance: 20, revision: 1 };
  let accounts = [old];
  let staleReload;
  let releaseStale;
  let pauseSnapshot = false;
  let alert;
  d.context.alert = text => { alert = text; };
  d.context.mockClient = {
    async rpc() {
      const response = { data: { accounts: structuredClone(accounts) }, error: null };
      if (!pauseSnapshot) return response;
      pauseSnapshot = false;
      return new Promise(resolve => { releaseStale = () => resolve(response); });
    },
    from(table) {
      assert.equal(table, 'accounts');
      return {
        delete() { return this; },
        eq() { return this; },
        async select() {
          pauseSnapshot = true;
          staleReload = d.run('reload()');
          accounts = [];
          return { data: [{ id: old.id }], error: null };
        },
        insert(account) {
          if (accounts.some(row => row.name === account.name && row.currency === account.currency)) {
            return { select: async () => ({ error: { code: '23505' } }) };
          }
          accounts.push({ ...account, revision: 1 });
          return { select: async () => ({ data: [account], error: null }) };
        }
      };
    }
  };
  await d.run("client = mockClient; activate({ user: { id: 'user', email: 'test@example.com' } })");
  await d.run('deleteAccount(state.accounts[0].id)');
  assert.equal(d.run('state.accounts.length'), 0);
  releaseStale();
  await staleReload;
  assert.equal(d.run('state.accounts.length'), 0);

  const addCash = async amount => {
    d.run('showAccountForm()');
    d.nodes.get('aname').value = old.name;
    d.nodes.get('acurrency').value = 'USD';
    d.nodes.get('abalance').value = String(amount);
    await d.run('saveAccount()');
  };
  await addCash(35);
  assert.equal(d.run('state.accounts[0].opening_balance'), 35);
  assert.notEqual(d.run('state.accounts[0].id'), old.id);
  await addCash(50);
  assert.match(alert, /هذا الاسم موجود.*USD/);
  assert.equal(accounts.length, 1);

  accounts = []; // A different device deleted the account while this form was open.
  await d.run('saveAccount()');
  assert.equal(d.run('state.accounts[0].opening_balance'), 50);
});

test('debt forms add both directions, edit, delete, and reuse a person name', async () => {
  const d = device();
  let alert;
  d.context.alert = text => { alert = text; };
  const addPerson = async name => {
    d.run('showPersonForm()');
    d.nodes.get('personName').value = name;
    await d.run('savePerson()');
  };
  const addDebt = async (direction, amount, currency) => {
    d.context.document.getElementById('debtDirection').value = direction;
    d.context.document.getElementById('debtAmount').value = amount;
    d.context.document.getElementById('debtCurrency').value = currency;
    await d.run('saveDebtEntry()');
  };
  await addPerson('Friend A');
  await addPerson('Friend B');
  const person = d.run('state.debt_people[1]');
  assert.equal(d.nodes.get('debtPerson').value, person.id);
  await addDebt('owed_to_me', '0.1', 'JOD');
  await addDebt('owed_to_me', '0.2', 'JOD');
  await addDebt('i_owe', '0.3', 'JOD');
  await addDebt('i_owe', '12.125', 'USD');
  assert.equal(d.run('FuloosiCore.debtNet(null, state.debt_entries).JOD'), 0);
  assert.match(d.nodes.get('personList').innerHTML, /عليك 12\.125 USD/);
  assert.match(d.nodes.get('debtList').innerHTML, /هو مدين إلي/);
  assert.match(d.nodes.get('debtList').innerHTML, /أنا مدين إله/);

  d.run('showPersonForm(state.debt_people[1].id)');
  d.nodes.get('personName').value = 'Friend Renamed';
  await d.run('savePerson()');
  d.run('editDebtEntry(state.debt_entries[3].id)');
  d.nodes.get('debtDirection').value = 'owed_to_me';
  d.nodes.get('debtAmount').value = '10.50';
  d.nodes.get('debtNote').value = 'Updated note';
  await d.run('saveDebtEntry()');
  assert.match(d.nodes.get('personList').innerHTML, /إلك 10\.50 USD/);
  assert.match(d.nodes.get('debtList').innerHTML, /Updated note/);
  assert.equal(device(d.storage).run('state.debt_people[1].name'), 'Friend Renamed');

  await d.run('deletePerson(state.debt_people[1].id)');
  assert.match(alert, /عنده حركات ديون/);
  await d.run('deleteDebtEntry(state.debt_entries[2].id)');
  assert.equal(d.run('FuloosiCore.debtNet(null, state.debt_entries).JOD'), 0.3);
  for (const id of d.run('state.debt_entries.map(entry => entry.id)')) {
    await d.run(`deleteDebtEntry(${JSON.stringify(id)})`);
  }
  await d.run('deletePerson(state.debt_people[1].id)');
  await addPerson('Friend Renamed');
  assert.notEqual(d.run('state.debt_people[1].id'), person.id);
  assert.equal(device(d.storage).run('state.debt_entries.length'), 0);
});

test('partial receipt and full payment update cash and debt together', async () => {
  const d = device();
  const accountId = '11111111-1111-4111-8111-111111111111';
  const personId = '33333333-3333-4333-8333-333333333333';
  d.context.fixture = {
    accounts: [
      { id: accountId, name: 'Cash', currency: 'JOD', opening_balance: 50 },
      { id: '55555555-5555-4555-8555-555555555555', name: 'Dollars', currency: 'USD', opening_balance: 5 }
    ],
    entries: [],
    debt_people: [{ id: personId, name: 'Ali' }],
    debt_entries: [
      { id: '44444444-4444-0444-4444-444444444444', person_id: personId, currency: 'JOD', direction: 'owed_to_me', amount: 12, note: '', occurred_on: '2026-11-11' },
      { id: '66666666-6666-4666-8666-666666666666', person_id: personId, currency: 'USD', direction: 'i_owe', amount: 2, note: '', occurred_on: '2026-11-11' }
    ]
  };
  d.run('localMutation(next => Object.assign(next, fixture)); render()');
  const netTotal = d.nodes.get('totalAfterDebts').textContent;
  const initialCash = d.nodes.get('total').textContent;
  assert.notEqual(netTotal, initialCash);
  assert.match(d.nodes.get('personList').innerHTML, /تسديد JOD/);
  d.run("showSettlementForm(fixture.debt_people[0].id, 'JOD')");
  assert.equal(d.nodes.get('settlementAmount').value, 12);
  assert.doesNotMatch(d.nodes.get('settlementAccount').innerHTML, /Dollars/);

  d.nodes.get('settlementAmount').value = '12.001';
  await d.run('saveDebtSettlement()');
  assert.match(d.nodes.get('message').textContent, /أكبر من الرصيد/);
  d.nodes.get('settlementAccount').value = d.context.fixture.accounts[1].id;
  await d.run('saveDebtSettlement()');
  assert.match(d.nodes.get('message').textContent, /بنفس عملة الدين/);
  d.nodes.get('settlementAccount').value = accountId;
  d.nodes.get('settlementAmount').value = '4.25';
  await d.run('saveDebtSettlement()');
  assert.equal(d.run('bal(state.accounts[0])'), 54.25);
  assert.equal(d.run('FuloosiCore.debtNet(null, state.debt_entries).JOD'), 7.75);
  assert.notEqual(d.nodes.get('total').textContent, initialCash);
  assert.equal(d.nodes.get('totalAfterDebts').textContent, netTotal);
  assert.match(d.nodes.get('entryList').innerHTML, /استلام تسديد دين/);

  d.run("showSettlementForm(fixture.debt_people[0].id, 'USD')");
  await d.run('saveDebtSettlement()');
  assert.equal(d.run('bal(state.accounts[1])'), 3);
  assert.equal(d.run('FuloosiCore.debtNet(null, state.debt_entries).USD'), 0);
  assert.doesNotMatch(d.nodes.get('personList').innerHTML, /تسديد USD/);
  assert.equal(d.nodes.get('totalAfterDebts').textContent, netTotal);
  assert.equal(d.run('FuloosiCore.monthStats(state, thisMonth()).total_spent_jod'), 0);

  const restarted = device(d.storage);
  assert.equal(restarted.run('bal(state.accounts[1])'), 3);
  await restarted.run('deleteDebtEntry(state.debt_entries[3].id)');
  assert.equal(restarted.run('bal(state.accounts[1])'), 5);
  assert.equal(restarted.run('FuloosiCore.debtNet(null, state.debt_entries).USD'), -2);
  assert.equal(restarted.nodes.get('totalAfterDebts').textContent, netTotal);
  await restarted.run('deleteAccount(state.accounts[0].id)');
  assert.match(restarted.nodes.get('message').textContent, /مرتبط بتسديد/);
});

test('cloud settlement retries use the same ID and refresh the wallet snapshot', async () => {
  const d = device();
  const date = '2026-11-11';
  const snapshot = {
    accounts: [{ id: 'wallet', name: 'Cash', currency: 'JOD', opening_balance: 10 }],
    debt_people: [{ id: 'person', name: 'Ali' }],
    debt_entries: [{ id: 'debt', person_id: 'person', currency: 'JOD', direction: 'owed_to_me', amount: 5, occurred_on: date }]
  };
  const calls = [];
  d.context.mockClient = {
    async rpc(name, params) {
      if (name === 'fuloosi_snapshot') return { data: structuredClone(snapshot), error: null };
      assert.equal(name, 'fuloosi_settle_debt');
      calls.push(params);
      if (calls.length === 1) return { error: Error('response lost') };
      snapshot.debt_entries.push({
        id: params.p_id, person_id: params.p_person_id, settlement_account_id: params.p_account_id,
        currency: params.p_currency, direction: params.p_direction, amount: params.p_amount, occurred_on: params.p_occurred_on
      });
      return { error: null };
    }
  };
  await d.run("client=mockClient;activate({user:{id:'user-a',email:'a@example.com'}})");
  d.run("showSettlementForm('person', 'JOD')");
  d.nodes.get('settlementDate').value = date;
  await d.run('saveDebtSettlement()');
  assert.match(d.nodes.get('message').textContent, /response lost/);
  await d.run('saveDebtSettlement()');
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(d.run('bal(state.accounts[0])'), 15);
  assert.equal(d.run('FuloosiCore.debtNet(null, state.debt_entries).JOD'), 0);
  assert.equal(d.run('settlementDraft'), null);
});
