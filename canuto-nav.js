/**
 * canuto-nav.js
 * Barra de navegación compartida entre todas las herramientas de canuto.ar
 * Incluir con: <script src="/canuto-nav.js"></script>
 * Agregar al body: <div id="canuto-nav"></div>
 */
(function() {
  const TOOLS = [
    { id: 'retiro',          label: 'Mi Retiro',       emoji: '🏖️', href: '/retiro/',          desc: 'Tu número para no trabajar más' },
    { id: 'gastos',          label: 'Mis Gastos',      emoji: '💳', href: '/gastos/',          desc: 'Calendario de gastos fijos del mes' },
    { id: 'dolar-en-vivo',   label: 'Dólar en Vivo',   emoji: '💵', href: '/dolar-en-vivo/',   desc: 'Cotizaciones del dólar al instante' },
    { id: 'dolar-intradia',  label: 'Dólar Intra-día', emoji: '⏱️', href: '/dolar-intradia/',  desc: 'Seguimiento minuto a minuto del día' },
    { id: 'dolar-historico', label: 'Dólar Histórico', emoji: '📈', href: '/dolar-historico/', desc: 'Serie histórica del dólar desde 2003' },
    { id: 'inflaciona',      label: 'Inflacioná',      emoji: '🔥', href: '/inflaciona/',      desc: 'Cuánto subió un precio (AR/USA)' },
    { id: 'datos-macro',     label: 'Datos Macro',     emoji: '🏛️', href: '/datos-macro/',     desc: 'Indicadores macro de Argentina' },
  ];
  const CONTACT_EMAIL = 'admin.canuto.ar@gmail.com';

  // Detectar página activa por path
  const currentPath = window.location.pathname.replace(/\/$/, '') || '/';

  const styles = `
    <style id="canuto-nav-styles">
      #canuto-nav {
        position: sticky;
        top: 0;
        z-index: 200;
        background: rgba(13,15,20,0.95);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border-bottom: 1px solid #232736;
        font-family: 'IBM Plex Mono', 'Courier New', monospace;
      }
      .cnav-inner {
        max-width: 1100px;
        margin: 0 auto;
        padding: 0 14px;
        display: flex;
        align-items: center;
        gap: 0;
        height: 52px;
      }
      .cnav-logo {
        font-size: 0.95rem;
        font-weight: 700;
        color: #e8eaf0;
        text-decoration: none;
        letter-spacing: -0.03em;
        margin-right: 14px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .cnav-logo span { color: #4ade80; }
      /* Wrapper para poder pintar un fade-out a la derecha cuando hay scroll */
      .cnav-tools-wrap {
        position: relative;
        flex: 1;
        min-width: 0;
      }
      .cnav-tools-wrap::after {
        content: '';
        position: absolute;
        top: 0; right: 0; bottom: 0;
        width: 28px;
        pointer-events: none;
        background: linear-gradient(to right, transparent, rgba(13,15,20,0.95));
        opacity: 0;
        transition: opacity 0.15s;
      }
      .cnav-tools-wrap.has-overflow::after { opacity: 1; }
      .cnav-tools {
        display: flex;
        align-items: center;
        gap: 1px;
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
      }
      .cnav-tools::-webkit-scrollbar { display: none; }
      .cnav-tool {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 6px 9px;
        border-radius: 7px;
        text-decoration: none;
        color: #8b90a4;
        font-size: 0.76rem;
        font-weight: 500;
        white-space: nowrap;
        transition: all 0.15s;
        border: 1px solid transparent;
        flex-shrink: 0;
      }
      .cnav-tool:hover {
        color: #e8eaf0;
        background: #1a1e28;
        border-color: #232736;
      }
      .cnav-tool.active {
        color: #0d0f14;
        background: #4ade80;
        border-color: transparent;
        font-weight: 700;
      }
      .cnav-tool .cnav-emoji {
        font-size: 0.85rem;
        line-height: 1;
      }
      .cnav-contact {
        flex-shrink: 0;
        margin-left: 6px;
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 6px 9px;
        border-radius: 7px;
        background: rgba(45,212,191,0.10);
        border: 1px solid rgba(45,212,191,0.25);
        color: #2dd4bf;
        text-decoration: none;
        font-size: 0.72rem;
        font-weight: 600;
        white-space: nowrap;
        transition: all 0.15s;
      }
      .cnav-contact:hover {
        background: rgba(45,212,191,0.18);
        border-color: rgba(45,212,191,0.45);
        color: #5eead4;
      }
      .cnav-contact .cnav-emoji { font-size: 0.85rem; line-height: 1; }
      /* Mobile: solo mostrar emoji en pantallas chicas */
      @media (max-width: 540px) {
        .cnav-tool .cnav-label { display: none; }
        .cnav-tool { padding: 6px 9px; }
        .cnav-contact .cnav-label { display: none; }
        .cnav-contact { padding: 6px 9px; margin-left: 6px; }
        .cnav-logo { margin-right: 10px; font-size: 0.85rem; }
        .cnav-inner { padding: 0 12px; }
      }
    </style>
  `;

  function isActive(href) {
    const toolPath = href.replace(/\/$/, '');
    return currentPath === toolPath || currentPath.startsWith(toolPath + '/');
  }

  const html = `
    ${styles}
    <nav class="cnav-inner" role="navigation" aria-label="Herramientas Canuto">
      <a class="cnav-logo" href="/" aria-label="Canuto.ar inicio">
        <span>canuto</span>.ar
      </a>
      <div class="cnav-tools-wrap">
        <div class="cnav-tools" role="list">
          ${TOOLS.map(t => `
            <a class="cnav-tool${isActive(t.href) ? ' active' : ''}"
               href="${t.href}"
               title="${t.desc}"
               role="listitem">
              <span class="cnav-emoji" aria-hidden="true">${t.emoji}</span>
              <span class="cnav-label">${t.label}</span>
            </a>
          `).join('')}
        </div>
      </div>
      <a class="cnav-contact" href="mailto:${CONTACT_EMAIL}" title="Escribinos">
        <span class="cnav-emoji" aria-hidden="true">✉️</span>
        <span class="cnav-label">Contacto</span>
      </a>
    </nav>
  `;

  const container = document.getElementById('canuto-nav');
  if (container) {
    container.innerHTML = html;
  } else {
    // Si no hay div#canuto-nav, insertamos al inicio del body
    document.body.insertAdjacentHTML('afterbegin', `<div id="canuto-nav">${html}</div>`);
  }

  // Mostrar fade-out a la derecha cuando hay overflow horizontal y todavía no se
  // llegó al final del scroll. Permite que el usuario perciba que hay más tools
  // a las que se puede llegar haciendo scroll horizontal (típico en laptops <1100px).
  function syncOverflowIndicator() {
    const wrap = document.querySelector('.cnav-tools-wrap');
    const list = wrap && wrap.querySelector('.cnav-tools');
    if (!wrap || !list) return;
    const slack = list.scrollWidth - list.clientWidth - list.scrollLeft;
    if (slack > 4) wrap.classList.add('has-overflow');
    else wrap.classList.remove('has-overflow');
  }
  // Inicial + reactivo a resize/scroll
  requestAnimationFrame(syncOverflowIndicator);
  window.addEventListener('resize', syncOverflowIndicator);
  const _list = document.querySelector('.cnav-tools');
  if (_list) _list.addEventListener('scroll', syncOverflowIndicator, { passive: true });
})();
