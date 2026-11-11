'use strict';
(function(root){
  const currencies=['IQD','JOD','USD'];
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function money(value){
    const n=Number(value);
    if(value==null||value===''||!Number.isFinite(n)||Math.abs(n)>1e12||Math.abs(n*1000-Math.round(n*1000))>.001) throw Error('المبلغ غير صالح؛ أقصى دقة ثلاث منازل عشرية');
    return Math.round(n*1000);
  }
  function validate(x){
    if(!x||!Array.isArray(x.accounts)||!Array.isArray(x.entries)||!x.settings)throw Error('نسخة احتياطية غير صالحة');
    const ids=new Set(),eids=new Set();
    const accounts=x.accounts.map(a=>{
      if(!uuid.test(a.id)||ids.has(a.id)||typeof a.name!=='string'||!a.name.trim()||a.name.length>100||!currencies.includes(a.currency))throw Error('بيانات الحساب غير صالحة');
      ids.add(a.id);money(a.opening_balance);
      return {id:a.id,name:a.name,currency:a.currency,opening_balance:Number(a.opening_balance)};
    });
    if(new Set(accounts.map(a=>a.currency+'\0'+a.name)).size!==accounts.length)throw Error('يوجد حساب مكرر');
    const entries=x.entries.map(e=>{
      if(!uuid.test(e.id)||eids.has(e.id)||!ids.has(e.account_id)||!['expense','income','adjustment'].includes(e.kind)||money(e.amount)<=0||typeof e.occurred_on!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(e.occurred_on)||!Number.isFinite(Date.parse(e.occurred_on))||new Date(e.occurred_on).toISOString().slice(0,10)!==e.occurred_on)throw Error('بيانات العملية غير صالحة');
      if(typeof e.category!=='string'||e.category.length>200||typeof e.note!=='string'||e.note.length>2000)throw Error('الوصف غير صالح');
      eids.add(e.id);
      return {id:e.id,account_id:e.account_id,kind:e.kind,amount:Number(e.amount),category:e.category,note:e.note,occurred_on:e.occurred_on,created_at:e.created_at||new Date().toISOString()};
    });
    const settings={iqd_per_usd:Number(x.settings.iqd_per_usd),jod_per_usd:Number(x.settings.jod_per_usd)};
    if(Object.values(settings).some(v=>!Number.isFinite(v)||v<=0||v>1e9))throw Error('أسعار صرف غير صالحة');
    return {accounts,entries,settings};
  }
  function balance(a,entries){return (money(a.opening_balance)+entries.filter(e=>e.account_id===a.id).reduce((s,e)=>s+(e.kind==='expense'?-1:1)*money(e.amount),0))/1000;}
  function validConfig(url,key){
    if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url))return false;
    if(/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))return true;
    try{return JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).role==='anon';}catch{return false;}
  }
  const api={money,validate,balance,validConfig};root.FuloosiCore=api;
  if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
