// Two small pages for passkeys, served by the server itself (no framework):
//
//   GET /api/pages/passkeys?return=…        the owner adds a passkey for this device (Face ID)
//   GET /api/pages/approvals/:id?return=…   the owner reads a Tier 3 change and signs exactly it
//
// The web app navigates to them; the iOS app opens them in the system sign-in sheet (as device
// pairing does), so one WebAuthn implementation serves Safari and the app. They call the JSON
// routes on the same origin with the Access cookie. `return` is where to go afterwards: a path on
// this origin, or the app's own scheme (which closes the iOS sheet).
import type { ApprovalView } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Only a path on this origin or the app's scheme; anything else is dropped. */
export function safeReturn(ctx: Ctx, raw: string | null): string {
  if (!raw) return "";
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
  if (raw.startsWith(`${ctx.config.devices.appScheme}://`)) return raw;
  return "";
}

export const PAGE_HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const STYLE = `
:root{--bg:#fff;--fg:#1c2024;--muted:#60646c;--line:#e0e1e6;--card:#f9f9fb;--accent:#0d74ce;--danger:#ce2c31;--ok:#218358}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#edeef0;--muted:#b0b4ba;--line:#2e3135;--card:#18191b;--accent:#70b8ff;--danger:#ff9592;--ok:#3dd68c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
.card{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:14px 16px;margin:16px 0}
dl{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:6px 12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0;font:13px/1.4 ui-monospace,Menlo,monospace}
code{font:12px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
button,input{font:inherit}input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}button{border:0;border-radius:8px;padding:12px 18px;font-weight:600;cursor:pointer}
.primary{background:var(--accent);color:#fff}.secondary{background:transparent;color:var(--danger);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}#status{min-height:1.5em;margin-top:16px}.ok{color:var(--ok)}.err{color:var(--danger)}`;

// base64url <-> ArrayBuffer and the JSON <-> WebAuthn conversions (no library in the page)
const SCRIPT_LIB = `
const b2u=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const u2b=(s)=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';const r=atob(s);const a=new Uint8Array(r.length);for(let i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a.buffer;};
const $=(id)=>document.getElementById(id);
function say(t,cls){const s=$('status');s.textContent=t;s.className=cls||'';}
async function api(method,path,body){const r=await fetch(path,{method,credentials:'same-origin',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error((j.error&&j.error.message)||('HTTP '+r.status));return j;}
function done(ret){if(ret)setTimeout(()=>{location.href=ret;},900);}
function noWebAuthn(){if(!window.PublicKeyCredential){say('This browser has no passkey support.','err');return true;}return false;}`;

function page(title: string, body: string, script: string): Uint8Array {
  return new TextEncoder().encode(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}<div id="status" role="status" aria-live="polite"></div></main><script>${SCRIPT_LIB}\n${script}</script></body></html>`,
  );
}

export function passkeysPage(ctx: Ctx, o: { email: string; ret: string; count: number }): Uint8Array {
  const body = `<h1>Passkey for infrastructure changes</h1>
<p class="muted">Signed in as ${esc(o.email)}, the owner of ${esc(ctx.config.instanceName)}. Infrastructure (Tier 3) changes are approved only with a passkey on your own device: Face ID, Touch ID or the device's PIN.</p>
<div class="card"><p>Passkeys registered: <strong id="count">${o.count}</strong></p>
<label for="name" class="muted">Name for this device</label><input id="name" maxlength="80" placeholder="iPhone"></div>
<div class="row"><button class="primary" id="add">Add a passkey on this device</button></div>`;
  const script = `
const RET=${JSON.stringify(o.ret)};
$('name').value=/iPhone/.test(navigator.userAgent)?'iPhone':/iPad/.test(navigator.userAgent)?'iPad':/Mac/.test(navigator.userAgent)?'Mac':'This device';
$('add').onclick=async()=>{if(noWebAuthn())return;$('add').disabled=true;say('Waiting for Face ID…');
try{const o=await api('POST','/api/passkeys/register/options');
const pk={...o,challenge:u2b(o.challenge),user:{...o.user,id:u2b(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(c=>({...c,id:u2b(c.id)}))};
const c=await navigator.credentials.create({publicKey:pk});
const res={id:c.id,rawId:b2u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),authenticatorAttachment:c.authenticatorAttachment||undefined,
response:{clientDataJSON:b2u(c.response.clientDataJSON),attestationObject:b2u(c.response.attestationObject),transports:c.response.getTransports?c.response.getTransports():[]}};
await api('POST','/api/passkeys/register',{response:res,name:$('name').value});
$('count').textContent=String(Number($('count').textContent)+1);say('Passkey added.','ok');done(RET);}
catch(e){say('Not added: '+(e.message||e),'err');}finally{$('add').disabled=false;}};`;
  return page("Add a passkey", body, script);
}

export function approvalPage(ctx: Ctx, o: { approval: ApprovalView; ret: string; hasPasskey: boolean }): Uint8Array {
  const a = o.approval;
  const pending = a.state === "pending" && a.canDecide;
  const fields = a.preview.fields.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join("");
  const body = `<h1>Infrastructure change</h1>
<p class="muted">Asked by ${esc(a.user.email)}${a.taskTitle ? ` in the task "${esc(a.taskTitle)}"` : ""}. Approving signs exactly this change with your passkey.</p>
<div class="card"><p><strong>${esc(a.preview.summary)}</strong></p><dl>${fields}</dl>${a.preview.body ? `<pre>${esc(a.preview.body)}</pre>` : ""}</div>
${a.reason ? `<div class="card"><p class="muted">Why</p><p>${esc(a.reason)}</p></div>` : ""}
<p class="muted">Change fingerprint (SHA-256)<br><code id="hash">${esc(a.changeHash ?? "")}</code></p>
${
  pending
    ? o.hasPasskey
      ? `<div class="row"><button class="primary" id="approve">Approve with Face ID</button><button class="secondary" id="deny">Deny</button></div>`
      : `<p class="err">No passkey yet. <a href="/api/pages/passkeys?return=${encodeURIComponent(`/api/pages/approvals/${a.id}${o.ret ? `?return=${encodeURIComponent(o.ret)}` : ""}`)}">Add one on this device</a> first.</p><div class="row"><button class="secondary" id="deny">Deny</button></div>`
    : `<p><strong>This request is ${esc(a.state)}.</strong></p>`
}`;
  const script = `
const ID=${JSON.stringify(a.id)},RET=${JSON.stringify(o.ret)};
const ap=$('approve'),dn=$('deny');
if(ap)ap.onclick=async()=>{if(noWebAuthn())return;ap.disabled=true;if(dn)dn.disabled=true;say('Waiting for Face ID…');
try{const r=await api('POST','/api/approvals/'+ID+'/passkey/options');
if(r.changeHash!==$('hash').textContent)throw new Error('the change differs from what is shown; reload');
const o=r.options;const pk={...o,challenge:u2b(o.challenge),allowCredentials:(o.allowCredentials||[]).map(c=>({...c,id:u2b(c.id)}))};
const c=await navigator.credentials.get({publicKey:pk});
const res={id:c.id,rawId:b2u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),authenticatorAttachment:c.authenticatorAttachment||undefined,
response:{clientDataJSON:b2u(c.response.clientDataJSON),authenticatorData:b2u(c.response.authenticatorData),signature:b2u(c.response.signature),userHandle:c.response.userHandle?b2u(c.response.userHandle):undefined}};
await api('POST','/api/approvals/'+ID+'/passkey',{response:res});say('Approved and signed.','ok');ap.remove();if(dn)dn.remove();done(RET);}
catch(e){say('Not approved: '+(e.message||e),'err');ap.disabled=false;if(dn)dn.disabled=false;}};
if(dn)dn.onclick=async()=>{dn.disabled=true;if(ap)ap.disabled=true;
try{await api('POST','/api/approvals/'+ID+'/decide',{decision:'deny'});say('Denied.','ok');dn.remove();if(ap)ap.remove();done(RET);}
catch(e){say('Not denied: '+(e.message||e),'err');dn.disabled=false;if(ap)ap.disabled=false;}};`;
  return page("Infrastructure change", body, script);
}
