export const POST_CONTEXT_CSS = `.xitter-context{font:13px TwitterChirp,-apple-system,"Segoe UI",sans-serif;color:rgb(113,118,123);padding:10px 0}.xitter-context a{color:rgb(29,155,240);text-decoration:none}.xitter-context a:hover{text-decoration:underline}`;

export const POST_CONTEXT_SCRIPT = String.raw`(function(){
 var cache=new Map(),pending=new Set(),loading=new Set(),retryAfter=new Map(),timer;
 function postId(article){for(var a of article.querySelectorAll('a[href*="/status/"]')){if(a.querySelector("time")){var m=a.getAttribute("href").match(/\/status\/(\d+)/);if(m)return m[1];}}}
 function fill(article,id,data){if(article.querySelector(".xitter-context"))return;
  var box=document.createElement("div");box.className="xitter-context";
  var label=document.createElement("div");label.textContent=data.source||"Xitter for Web";box.appendChild(label);
  var link=document.createElement("a");link.href="/i/birdwatch/t/"+id;link.textContent="Community Notes"+(data.notes.length?" ("+data.notes.length+")":"");box.appendChild(link);
  if(data.can_write_notes&&!data.notes.some(function(n){return n.own;})){box.appendChild(document.createTextNode(" · "));var write=document.createElement("a");write.href="/i/communitynotes/contribute_form/"+id;write.textContent="Write a note";box.appendChild(write);}
  var reply=article.querySelector('[data-testid="reply"]'),group=reply&&reply.closest('[role="group"]');(group?group.parentElement:article.firstElementChild||article).appendChild(box);
 }
 function scan(){document.querySelectorAll('article[data-testid="tweet"]').forEach(function(a){var id=postId(a);if(!id)return;var data=cache.get(id);if(data)fill(a,id,data);else if(!loading.has(id)&&!(retryAfter.get(id)>Date.now()))pending.add(id);});if(pending.size&&!timer)timer=setTimeout(load,80);}
 async function load(){timer=null;var ids=Array.from(pending).slice(0,20);ids.forEach(function(id){pending.delete(id);loading.add(id);});
  try{var csrf=(document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)||[])[1]||"";
   var r=await fetch("/i/api/graphql/xitter/XitterPostContext",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({variables:{ids:ids}})});var data=await r.json();
   if(r.ok&&!data.errors)data.data.xitter_post_context.forEach(function(p){cache.set(p.id,p);});
   document.querySelectorAll('article[data-testid="tweet"]').forEach(function(a){var id=postId(a),p=cache.get(id);if(p)fill(a,id,p);});
  }catch(e){console.warn("Post context unavailable");}finally{ids.forEach(function(id){loading.delete(id);if(!cache.has(id))retryAfter.set(id,Date.now()+30000);});}if(pending.size&&!timer)timer=setTimeout(load,100);}
 new MutationObserver(function(){if(!timer)timer=setTimeout(function(){timer=null;scan();},80);}).observe(document.documentElement,{childList:true,subtree:true});scan();
})();`;
