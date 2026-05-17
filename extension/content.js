// extension/content.js
const SIDEBAR_ID = 'cfz-migration-sidebar';
const TOGGLE_ID  = 'cfz-sidebar-toggle';

function injectSidebar() {
  if (document.getElementById(SIDEBAR_ID)) return;

  const toggle = document.createElement('div');
  toggle.id = TOGGLE_ID;
  toggle.title = 'CloudFuze Migration Viewer';
  toggle.innerHTML = `<svg width="22" height="22" viewBox="0 0 20 20" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M10 2L3 6v8l7 4 7-4V6L10 2zm0 2.2l5 2.85V13l-5 2.85L5 13V7.05L10 4.2z"/></svg>`;
  Object.assign(toggle.style, {
    position: 'fixed', right: '16px', top: '50%', transform: 'translateY(-50%)',
    width: '44px', height: '44px', background: '#0129AC', borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', zIndex: '999999', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    transition: 'right 0.3s, background 0.2s',
  });
  toggle.addEventListener('mouseenter', () => { toggle.style.background = '#0050e6'; });
  toggle.addEventListener('mouseleave', () => { toggle.style.background = '#0129AC'; });

  const sidebar = document.createElement('div');
  sidebar.id = SIDEBAR_ID;
  Object.assign(sidebar.style, {
    position: 'fixed', right: '0', top: '0', width: '380px', height: '100vh',
    background: 'white', zIndex: '999998', boxShadow: '-4px 0 16px rgba(0,0,0,0.15)',
    transform: 'translateX(100%)', transition: 'transform 0.3s ease',
  });

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('sidebar.html');
  Object.assign(iframe.style, { width: '100%', height: '100%', border: 'none' });
  sidebar.appendChild(iframe);

  let open = false;
  toggle.addEventListener('click', () => {
    open = !open;
    sidebar.style.transform = open ? 'translateX(0)' : 'translateX(100%)';
    toggle.style.right = open ? '396px' : '16px';
  });

  document.body.appendChild(toggle);
  document.body.appendChild(sidebar);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectSidebar);
} else {
  injectSidebar();
}

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(injectSidebar, 500);
  }
}).observe(document.body, { subtree: true, childList: true });
