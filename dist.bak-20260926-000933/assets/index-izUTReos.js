import{l as f,b as g,a as y,r as h,c as S}from"./api-DjcRX64I.js";/* empty css               */import{s as v,l as C}from"./shell-Bm8Yuh32.js";const s=document.querySelector("#content"),$=document.querySelector("#userName"),q=document.querySelector("#accountName"),b=document.querySelector("#accountRole"),x=document.querySelector("#groupCount"),k=document.querySelector("#siteCount"),u=document.querySelector("#keyCount"),w=document.querySelector("#infraCount"),A=document.querySelector("#directorySummary"),m=document.querySelector("#searchInput"),E=document.querySelector("#logoutBtn");let o=[],i=-1;const d=document.querySelector("#groupFilters");E.addEventListener("click",f);m.addEventListener("input",p);function p(){const t=i<0?o:[o[i]],e=B(t,m.value);j(e),F(e,m.value)}function L(){d.replaceChildren(),["全部应用",...o.map(t=>t.name)].forEach((t,e)=>{const n=document.createElement("button");n.type="button",n.textContent=`${t} · ${a(e===0?o:[o[e-1]])}`,n.setAttribute("aria-pressed",String(i===e-1)),n.addEventListener("click",()=>{i=e-1,d.querySelectorAll("button").forEach(r=>r.setAttribute("aria-pressed",String(r===n))),p()}),d.append(n)})}N();async function N(){try{const t=await g();if(!t)return;const e=t.nick||t.username||"汐航用户";$.textContent=e,q.textContent=e,b.textContent=t.role==="admin"?"管理员":"普通成员",document.querySelectorAll(".admin-only").forEach(r=>r.classList.toggle("hidden",t.role!=="admin")),v(t),C(t),o=(await y("/api/nav/groups")).groups||[],x.textContent=o.length,k.textContent=a(o),w.textContent=String(a(o.filter(r=>/基础|设施|运维/.test(r.name)))),G(),L(),p()}catch(t){if(t.status===401){h();return}s.className="workspace-empty",s.replaceChildren();const e=document.createElement("p");e.textContent=t.message||"应用暂时加载失败，请稍后重试。";const n=document.createElement("button");n.type="button",n.className="primary-btn",n.textContent="重新加载",n.addEventListener("click",()=>window.location.reload()),s.append(e,n)}}async function G(){if(u)try{const t=await y("/api/vault/credentials");u.textContent=String((t.credentials||[]).length)}catch{u.textContent="0"}}function j(t){if(t.length===0){s.className="workspace-empty",s.innerHTML="<p>暂时没有匹配的站点。可以换个关键词试试，管理员也可以在后台补充新的入口。</p>";return}s.className="system-sections",s.innerHTML=t.map(e=>`<section class="system-section ${/基础|设施|运维/.test(e.name)?"infrastructure-section":"business-section"}">
  <div class="system-section-head">
    <div>
      <h3>${c(e.name)}</h3>
      <p>${c(e.description||"已经整理好的内部系统入口")}</p>
    </div>
    <span>${(e.sites||[]).length} 个应用</span>
  </div>
  <div class="system-grid">${M(e.sites||[])}</div>
</section>`).join("")}function M(t){return t.length===0?'<p class="section-empty">这个分组还没有站点，等管理员放入新的入口。</p>':t.map(e=>`<a class="system-card" href="${c(S(e))}" target="_blank" rel="noreferrer">
  <span class="system-icon" style="background: ${I(e.name)};">${H(e.name)}</span>
  <div class="system-card-body">
    <strong>${c(e.name)}</strong>
    <p>${c(e.description||"安全打开这个内部系统")}</p>
  </div>
  <div class="system-card-foot">
    <div class="system-tags">${(e.tags||[]).map(n=>`<b>${c(n)}</b>`).join("")}</div>
    <span class="system-open">进入</span>
  </div>
</a>`).join("")}function B(t,e){const n=e.trim().toLowerCase();return n?t.map(r=>({...r,sites:(r.sites||[]).filter(l=>`${l.name} ${l.description} ${(l.tags||[]).join(" ")}`.toLowerCase().includes(n))})).filter(r=>r.sites.length>0):t}function F(t,e){const n=a(t);A.textContent=e.trim()?`已为你筛出 ${n} 个入口`:`已连接 ${t.length} 个应用分组，${n} 个站点入口`}function a(t){return t.reduce((e,n)=>e+(n.sites||[]).length,0)}function H(){return'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 16 16 8M9 8h7v7"/></svg>'}function I(){return"#edf5f8"}function c(t=""){return String(t).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}
