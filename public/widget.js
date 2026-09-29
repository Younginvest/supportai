(function () {
  var scriptTag = document.currentScript;
  var publicKey = scriptTag.getAttribute('data-key');
  var label = scriptTag.getAttribute('data-label') || 'Chat with us';
  if (!publicKey) { console.error('SupportAI widget: missing data-key'); return; }
  var apiBase = new URL(scriptTag.src, location.href).origin;
  var storeKey = 'supportai_conv_' + publicKey;

  var css = document.createElement('style');
  css.textContent = '.said-btn{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:#1f6f5c;color:#fff;border:none;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;font-size:22px;z-index:999999}'
    + '.said-panel{position:fixed;bottom:86px;right:20px;width:320px;max-width:90vw;height:440px;max-height:70vh;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,system-ui,sans-serif;z-index:999999}'
    + '.said-panel.open{display:flex}'
    + '.said-head{background:#1f6f5c;color:#fff;padding:12px 14px;font-size:14px;font-weight:600}'
    + '.said-body{flex:1;overflow-y:auto;padding:10px;background:#f7f6f2}'
    + '.said-msg{max-width:80%;padding:8px 10px;border-radius:10px;margin:6px 0;font-size:13px;line-height:1.4;white-space:pre-wrap}'
    + '.said-msg.visitor{margin-left:auto;background:#1f6f5c;color:#fff}'
    + '.said-msg.agent{margin-right:auto;background:#e9e7de;color:#222}'
    + '.said-foot{display:flex;border-top:1px solid #e2e0d8}'
    + '.said-foot textarea{flex:1;border:none;padding:10px;font-size:13px;resize:none;height:44px;font-family:inherit}'
    + '.said-foot button{border:none;background:#1f6f5c;color:#fff;padding:0 14px;cursor:pointer;font-size:13px}'
    + '.said-note{font-size:10px;color:#888;padding:4px 10px;background:#f7f6f2}';
  document.head.appendChild(css);

  var btn = document.createElement('button');
  btn.className = 'said-btn'; btn.textContent = '💬'; btn.title = label;
  var panel = document.createElement('div'); panel.className = 'said-panel';
  panel.innerHTML = '<div class="said-head">' + label + '</div><div class="said-body"></div>'
    + '<div class="said-note">Replies are checked by a person before sending.</div>'
    + '<div class="said-foot"><textarea placeholder="Type a message..."></textarea><button>Send</button></div>';
  document.body.appendChild(btn); document.body.appendChild(panel);

  var body = panel.querySelector('.said-body');
  var textarea = panel.querySelector('textarea');
  var sendBtn = panel.querySelector('button');
  var state = JSON.parse(sessionStorage.getItem(storeKey) || 'null');
  var poller = null;

  function renderMessages(list) {
    body.innerHTML = '';
    list.forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'said-msg ' + (m.role === 'visitor' ? 'visitor' : 'agent');
      d.textContent = m.body;
      body.appendChild(d);
    });
    body.scrollTop = body.scrollHeight;
  }

  function poll() {
    if (!state) return;
    fetch(apiBase + '/api/widget/' + publicKey + '/conversations/' + state.conversationId + '/messages', {
      headers: { 'X-Visitor-Token': state.visitorToken },
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.messages) renderMessages(d.messages);
    }).catch(function () {});
  }

  function start() { poller = setInterval(poll, 3000); poll(); }

  function send() {
    var text = textarea.value.trim();
    if (!text) return;
    textarea.value = '';
    if (!state) {
      fetch(apiBase + '/api/widget/' + publicKey + '/conversations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.conversationId) return;
        state = { conversationId: d.conversationId, visitorToken: d.visitorToken };
        sessionStorage.setItem(storeKey, JSON.stringify(state));
        start();
      });
    } else {
      renderMessages([{ role: 'visitor', body: text }]); // optimistic, replaced by next poll
      fetch(apiBase + '/api/widget/' + publicKey + '/conversations/' + state.conversationId + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Visitor-Token': state.visitorToken },
        body: JSON.stringify({ message: text }),
      }).then(poll);
    }
  }

  sendBtn.addEventListener('click', send);
  textarea.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  btn.addEventListener('click', function () {
    panel.classList.toggle('open');
    if (panel.classList.contains('open') && state) start();
  });
  if (state) poll();
})();
