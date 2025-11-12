// app.js - Toast Browser full version

const proxyBase = '/api/proxy?url=';
const urlInput = document.getElementById('urlInput');
const goBtn = document.getElementById('goBtn');
const navForm = document.getElementById('navForm');
const webFrame = document.getElementById('webFrame');
const liveUrl = document.getElementById('liveUrl');
const webTitle = document.getElementById('webTitle');
const bookmarkBar = document.getElementById('bookmarkBar');
const bookmarkList = document.getElementById('bookmarkList');
const addBookmark = document.getElementById('addBookmark');
const manageBookmarks = document.getElementById('manageBookmarks');
const toastRoot = document.getElementById('toastRoot');
const backBtn = document.getElementById('backBtn');
const forwardBtn = document.getElementById('forwardBtn');

let historyStack = [];
let historyPos = -1;

// Toast notifications
function toast(text, type='info', ms=3500){
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  toastRoot.appendChild(el);
  setTimeout(()=> el.style.opacity = '0.0', ms - 400);
  setTimeout(()=> el.remove(), ms);
}

// --- Bookmarks ---
function loadBookmarks(){
  const raw = localStorage.getItem('toast_bookmarks');
  let list = raw ? JSON.parse(raw) : defaultBookmarks();
  renderBookmarks(list);
  renderBookmarkList(list);
}
function saveBookmarks(list){
  localStorage.setItem('toast_bookmarks', JSON.stringify(list));
}
function defaultBookmarks(){
  return [
    {title:'DuckDuckGo', url:'https://duckduckgo.com/'},
    {title:'MDN', url:'https://developer.mozilla.org/'},
    {title:'Wikipedia', url:'https://en.wikipedia.org/'},
    {title:'JS Alert', url:"javascript:alert('hi from bookmarklet!')"}
  ];
}
function renderBookmarks(list){
  bookmarkBar.innerHTML = '';
  list.forEach(b=>{
    const btn = document.createElement('button');
    btn.className = 'bm';
    btn.textContent = b.title || b.url;
    btn.title = b.url;
    btn.addEventListener('click', ()=> onBookmarkClick(b));
    bookmarkBar.appendChild(btn);
  });
}
function renderBookmarkList(list){
  bookmarkList.innerHTML = '';
  list.forEach((b, i)=>{
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'bm-link';
    a.textContent = b.title || b.url;
    a.addEventListener('click', (e)=>{
      e.preventDefault();
      onBookmarkClick(b);
    });
    li.appendChild(a);
    const del = document.createElement('button');
    del.textContent = '✖';
    del.title = 'Delete';
    del.addEventListener('click', ()=>{
      list.splice(i,1);
      saveBookmarks(list);
      renderBookmarks(list);
      renderBookmarkList(list);
      toast('Bookmark removed', 'info');
    });
    li.appendChild(del);
    bookmarkList.appendChild(li);
  });
}

function onBookmarkClick(bookmark){
  if(typeof bookmark.url === 'string' && bookmark.url.trim().toLowerCase().startsWith('javascript:')){
    runBookmarkletInIframe(bookmark.url);
    return;
  }
  urlInput.value = bookmark.url;
  navigateTo(bookmark.url, true);
}

function runBookmarkletInIframe(jsHref){
  const code = jsHref.replace(/^javascript:/i, '');
  if(!webFrame.contentWindow){
    toast('Web area not ready', 'info');
    return;
  }
  try {
    if(webFrame.contentDocument.readyState !== 'complete'){
      webFrame.addEventListener('load', function onl(){
        webFrame.removeEventListener('load', onl);
        try {
          webFrame.contentWindow.eval(code);
          toast('Bookmarklet executed', 'success');
        } catch(e){
          toast('Bookmarklet failed: ' + e.message, 'error');
        }
      });
      return;
    }
    webFrame.contentWindow.eval(code);
    toast('Bookmarklet executed', 'success');
  } catch(e){
    toast('Could not run bookmarklet: ' + e.message, 'error');
  }
}

// --- Navigation ---
function normalizeUrl(input){
  input = input.trim();
  if(!input) return '';
  if(/^javascript:/i.test(input)) return input;
  if(!/^https?:\/\//i.test(input)) input = 'https://' + input;
  return input;
}

async function navigateTo(rawUrl, pushHistory=true){
  if(!rawUrl) return;
  const url = normalizeUrl(rawUrl);

  // Keep input visible
  urlInput.value = url;
  liveUrl.textContent = url;

  if(url.startsWith('javascript:')){
    runBookmarkletInIframe(url);
    return;
  }

  const prox = proxyBase + encodeURIComponent(url);
  webFrame.src = prox;
  webTitle.textContent = 'Loading: ' + url;

  if(pushHistory){
    historyStack = historyStack.slice(0, historyPos+1);
    historyStack.push(url);
    historyPos = historyStack.length - 1;
  }
  updateNavButtons();
}

// History buttons
function updateNavButtons(){
  backBtn.disabled = historyPos <= 0;
  forwardBtn.disabled = historyPos >= historyStack.length - 1;
}
backBtn.addEventListener('click', ()=>{
  if(historyPos > 0){
    historyPos--;
    navigateTo(historyStack[historyPos], false);
  }
});
forwardBtn.addEventListener('click', ()=>{
  if(historyPos < historyStack.length - 1){
    historyPos++;
    navigateTo(historyStack[historyPos], false);
  }
});

// Form submit
navForm.addEventListener('submit', e=>{
  e.preventDefault();
  const v = urlInput.value.trim();
  if(!v) return;
  navigateTo(v, true);
});

// Add bookmark
addBookmark.addEventListener('click', ()=>{
  const list = JSON.parse(localStorage.getItem('toast_bookmarks') || '[]');
  const url = urlInput.value.trim();
  if(!url){ toast('Enter a URL to bookmark', 'info'); return; }
  const title = url.replace(/^https?:\/\//, '').replace(/\/.*$/,'');
  list.push({title, url});
  saveBookmarks(list);
  renderBookmarks(list);
  renderBookmarkList(list);
  toast('Bookmark saved', 'success');
});

// Toggle sidebar bookmarks
manageBookmarks.addEventListener('click', ()=>{
  document.querySelector('.sidebar').classList.toggle('open');
});

// Update live URL on iframe load
webFrame.addEventListener('load', ()=>{
  try {
    const doc = webFrame.contentDocument;
    const title = (doc && doc.title) || webFrame.src;
    webTitle.textContent = title;
    const meta = doc && doc.querySelector('meta[name="toast-original-url"]');
    if(meta && meta.content){
      liveUrl.textContent = meta.content;
      urlInput.value = meta.content;
    }
  } catch(e){
    console.warn('iframe load handling error', e);
  }
});

// --- Init ---
(function init(){
  loadBookmarks();

  // Default to DuckDuckGo if no hash
  let initialUrl = location.hash && location.hash.length > 1 
    ? decodeURIComponent(location.hash.slice(1)) 
    : 'https://duckduckgo.com/';  // DEFAULT

  urlInput.value = initialUrl;
  navigateTo(initialUrl, true);

  toast('Toast browser ready', 'info', 2000);
})();
