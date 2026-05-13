/**
 * canuto-nav.js
 * Barra de navegación compartida entre todas las herramientas de canuto.ar
 * Incluir con: <script src="/canuto-nav.js"></script>
 * Agregar al body: <div id="canuto-nav"></div>
 *
 * Layout: logo · botón "Herramientas ▼" (abre panel) · botón Contacto
 * El panel desplegable tiene 3 cards destacadas grandes arriba y 4 más chicas abajo.
 */
(function() {
  const TOOLS = [
    { id: 'dolar-intradia',  label: 'Dólar Intradía',  emoji: '💵', href: '/dolar-intradia/',  desc: 'Cotización del dólar minuto a minuto', featured: true, color: 'amber', live: true },
    { id: 'datos-macro',     label: 'Datos Macro',     emoji: '🏛️', href: '/datos-macro/',     desc: 'Indicadores macro de Argentina',       featured: true, color: 'violet' },
    { id: 'subte',           label: 'Subte CABA',      emoji: '🚇', href: '/subte/',           desc: 'Estado del subte porteño en vivo',     featured: true, color: 'green',  live: true },
    { id: 'inflaciona',      label: 'Inflacioná',      emoji: '🔥', href: '/inflaciona/',      desc: '¿Cuánto subió un precio? AR/USA',      color: 'orange' },
    { id: 'dolar-historico', label: 'Dólar Histórico', emoji: '📈', href: '/dolar-historico/', desc: 'Serie diaria del dólar desde 2003',    color: 'sky'    },
    { id: 'gastos',          label: 'Mis Gastos',      emoji: '💳', href: '/gastos/',          desc: 'Calendario de gastos fijos del mes',   color: 'rose'   },
    { id: 'retiro',          label: 'Mi Retiro',       emoji: '🏖️', href: '/retiro/',          desc: 'Tu número para no trabajar más',       color: 'teal'   },
  ];
  const CONTACT_EMAIL = 'admin.canuto.ar@gmail.com';

  // Detectar página activa por path
  const currentPath = window.location.pathname.replace(/\/$/, '') || '/';

  function isActive(href) {
    const toolPath = href.replace(/\/$/, '');
    return currentPath === toolPath || currentPath.startsWith(toolPath + '/');
  }
  const activeTool = TOOLS.find(t => isActive(t.href));

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
        gap: 10px;
        height: 52px;
        position: relative;
      }
      .cnav-logo {
        font-size: 0.95rem;
        font-weight: 700;
        color: #e8eaf0;
        text-decoration: none;
        letter-spacing: -0.03em;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .cnav-logo span { color: #4ade80; }

      /* Botón trigger del dropdown */
      .cnav-trigger {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 14px 7px 12px;
        border-radius: 9px;
        background: #1a1e28;
        border: 1px solid #232736;
        color: #e8eaf0;
        font-family: inherit;
        font-size: 0.78rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
        white-space: nowrap;
      }
      .cnav-trigger:hover {
        background: #222732;
        border-color: #2d3245;
      }
      .cnav-trigger[aria-expanded="true"] {
        background: #222732;
        border-color: #2d3245;
        color: #fff;
      }
      .cnav-trigger-active {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 8px;
        background: rgba(74,222,128,0.12);
        color: #4ade80;
        border-radius: 99px;
        font-size: 0.68rem;
        font-weight: 700;
        margin-left: 2px;
      }
      .cnav-chev {
        display: inline-block;
        font-size: 0.65rem;
        line-height: 1;
        color: #8b90a4;
        transition: transform 0.2s;
      }
      .cnav-trigger[aria-expanded="true"] .cnav-chev {
        transform: rotate(180deg);
        color: #e8eaf0;
      }

      .cnav-spacer { flex: 1; }

      .cnav-contact {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 7px 12px;
        border-radius: 9px;
        background: rgba(45,212,191,0.10);
        border: 1px solid rgba(45,212,191,0.25);
        color: #2dd4bf;
        text-decoration: none;
        font-size: 0.74rem;
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

      /* ── PANEL DESPLEGABLE ────────────────────────────── */
      .cnav-panel-backdrop {
        position: fixed; inset: 52px 0 0 0;
        background: rgba(0,0,0,0.35);
        opacity: 0; pointer-events: none;
        transition: opacity 0.18s;
        z-index: 150;
      }
      .cnav-panel-backdrop.is-open {
        opacity: 1; pointer-events: auto;
      }
      .cnav-panel {
        position: absolute;
        top: 100%;
        left: 0; right: 0;
        background: #0d0f14;
        border-bottom: 1px solid #232736;
        box-shadow: 0 24px 60px -20px rgba(0,0,0,0.7);
        opacity: 0;
        transform: translateY(-8px);
        pointer-events: none;
        transition: opacity 0.18s, transform 0.18s;
        z-index: 199;
      }
      .cnav-panel.is-open {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      .cnav-panel-inner {
        max-width: 1100px;
        margin: 0 auto;
        padding: 22px 14px 24px;
      }
      .cnav-panel-section + .cnav-panel-section {
        margin-top: 18px;
      }
      .cnav-panel-label {
        font-size: 0.66rem;
        text-transform: uppercase;
        letter-spacing: 0.13em;
        color: #545870;
        margin-bottom: 10px;
        display: flex; align-items: center; gap: 10px;
      }
      .cnav-panel-label::after {
        content: '';
        flex: 1; height: 1px; background: #232736;
      }

      /* Cards destacadas grandes (3 columnas) */
      .cnav-grid-featured {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
      }
      .cnav-card-big {
        display: flex; align-items: center; gap: 14px;
        padding: 14px 16px;
        background: #13161e;
        border: 1.5px solid #232736;
        border-radius: 14px;
        text-decoration: none;
        color: inherit;
        transition: all 0.18s;
        position: relative; overflow: hidden;
        isolation: isolate;
      }
      .cnav-card-big::before {
        content: '';
        position: absolute; top: 0; left: 0; right: 0;
        height: 3px;
        background: var(--cnav-color, #4ade80);
        opacity: 0.5;
        transition: opacity 0.18s;
      }
      .cnav-card-big:hover {
        transform: translateY(-2px);
        border-color: var(--cnav-color, #4ade80);
        box-shadow: 0 10px 30px -10px rgba(0,0,0,0.5),
                    0 0 40px -15px var(--cnav-color, #4ade80);
      }
      .cnav-card-big:hover::before { opacity: 1; }
      .cnav-card-big[data-color="amber"]  { --cnav-color: #fbbf24; }
      .cnav-card-big[data-color="violet"] { --cnav-color: #a78bfa; }
      .cnav-card-big[data-color="green"]  { --cnav-color: #4ade80; }
      .cnav-card-big.is-active {
        border-color: var(--cnav-color, #4ade80);
        background: #1a1e28;
      }
      .cnav-card-big.is-active::before { opacity: 1; }

      .cnav-card-big-emoji {
        width: 44px; height: 44px;
        border-radius: 11px;
        background: rgba(255,255,255,0.04);
        border: 1.5px solid #232736;
        display: flex; align-items: center; justify-content: center;
        font-size: 1.55rem;
        flex-shrink: 0;
      }
      .cnav-card-big[data-color="amber"]  .cnav-card-big-emoji { background: rgba(251,191,36,0.12); border-color: rgba(251,191,36,0.3); }
      .cnav-card-big[data-color="violet"] .cnav-card-big-emoji { background: rgba(167,139,250,0.12); border-color: rgba(167,139,250,0.3); }
      .cnav-card-big[data-color="green"]  .cnav-card-big-emoji { background: rgba(74,222,128,0.12); border-color: rgba(74,222,128,0.3); }

      .cnav-card-big-body { flex: 1; min-width: 0; }
      .cnav-card-big-title {
        display: flex; align-items: center; gap: 7px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 0.95rem;
        font-weight: 700;
        color: #e8eaf0;
        letter-spacing: -0.02em;
        line-height: 1.1;
        margin-bottom: 4px;
      }
      .cnav-card-big-live {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 0.55rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--cnav-color, #4ade80);
        font-weight: 700;
        padding: 2px 5px;
        border-radius: 99px;
        background: rgba(255,255,255,0.04);
        border: 1px solid currentColor;
      }
      .cnav-card-big-live::before {
        content: '';
        width: 5px; height: 5px;
        border-radius: 50%;
        background: currentColor;
        box-shadow: 0 0 6px currentColor;
        animation: cnav-pulse 1.6s ease-in-out infinite;
      }
      @keyframes cnav-pulse {
        0%,100%{ opacity: 0.5; transform: scale(1); }
        50%    { opacity: 1;   transform: scale(1.3); }
      }
      .cnav-card-big-desc {
        font-family: 'IBM Plex Sans', system-ui, sans-serif;
        font-size: 0.78rem;
        color: #8b90a4;
        line-height: 1.4;
      }

      /* Cards "otras" más chicas (4 columnas) */
      .cnav-grid-rest {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 10px;
      }
      .cnav-card-small {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px;
        background: #13161e;
        border: 1px solid #232736;
        border-radius: 11px;
        text-decoration: none;
        color: inherit;
        transition: all 0.15s;
      }
      .cnav-card-small:hover {
        background: #1a1e28;
        border-color: var(--cnav-color, #2d3245);
        transform: translateY(-1px);
      }
      .cnav-card-small.is-active {
        background: #1a1e28;
        border-color: var(--cnav-color, #4ade80);
      }
      .cnav-card-small[data-color="orange"] { --cnav-color: #f97316; }
      .cnav-card-small[data-color="sky"]    { --cnav-color: #38bdf8; }
      .cnav-card-small[data-color="rose"]   { --cnav-color: #fb7185; }
      .cnav-card-small[data-color="teal"]   { --cnav-color: #2dd4bf; }
      .cnav-card-small-emoji {
        font-size: 1.15rem;
        line-height: 1;
        flex-shrink: 0;
      }
      .cnav-card-small-body { flex: 1; min-width: 0; }
      .cnav-card-small-title {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 0.8rem;
        font-weight: 700;
        color: #e8eaf0;
        letter-spacing: -0.02em;
        line-height: 1.1;
        margin-bottom: 2px;
      }
      .cnav-card-small-desc {
        font-family: 'IBM Plex Sans', system-ui, sans-serif;
        font-size: 0.68rem;
        color: #8b90a4;
        line-height: 1.3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* ── Responsive ──────────────────────────────────── */
      @media (max-width: 760px) {
        .cnav-grid-rest { grid-template-columns: repeat(2, 1fr); }
      }
      @media (max-width: 620px) {
        .cnav-grid-featured { grid-template-columns: 1fr; gap: 8px; }
        .cnav-card-big { padding: 12px 14px; }
        .cnav-card-big-emoji { width: 40px; height: 40px; font-size: 1.4rem; }
      }
      @media (max-width: 540px) {
        .cnav-inner { padding: 0 12px; gap: 8px; }
        .cnav-logo { font-size: 0.85rem; }
        .cnav-trigger { padding: 6px 10px 6px 10px; font-size: 0.72rem; }
        .cnav-trigger-active { display: none; }
        .cnav-contact .cnav-label { display: none; }
        .cnav-contact { padding: 6px 9px; }
        .cnav-panel-inner { padding: 16px 12px 18px; }
      }
    </style>
  `;

  const featuredHtml = TOOLS.filter(t => t.featured).map(t => `
    <a class="cnav-card-big${isActive(t.href) ? ' is-active' : ''}"
       href="${t.href}"
       data-color="${t.color || 'green'}"
       data-cnav-link>
      <span class="cnav-card-big-emoji" aria-hidden="true">${t.emoji}</span>
      <div class="cnav-card-big-body">
        <div class="cnav-card-big-title">
          <span>${t.label}</span>
          ${t.live ? '<span class="cnav-card-big-live">En vivo</span>' : ''}
        </div>
        <div class="cnav-card-big-desc">${t.desc}</div>
      </div>
    </a>
  `).join('');

  const restHtml = TOOLS.filter(t => !t.featured).map(t => `
    <a class="cnav-card-small${isActive(t.href) ? ' is-active' : ''}"
       href="${t.href}"
       data-color="${t.color || 'green'}"
       data-cnav-link>
      <span class="cnav-card-small-emoji" aria-hidden="true">${t.emoji}</span>
      <div class="cnav-card-small-body">
        <div class="cnav-card-small-title">${t.label}</div>
        <div class="cnav-card-small-desc">${t.desc}</div>
      </div>
    </a>
  `).join('');

  const html = `
    ${styles}
    <nav class="cnav-inner" role="navigation" aria-label="Herramientas Canuto">
      <a class="cnav-logo" href="/" aria-label="Canuto.ar inicio">
        <span>canuto</span>.ar
      </a>
      <button class="cnav-trigger"
              type="button"
              aria-expanded="false"
              aria-controls="cnav-panel"
              aria-haspopup="true">
        <span>Herramientas</span>
        ${activeTool ? `<span class="cnav-trigger-active">${activeTool.emoji} ${activeTool.label}</span>` : ''}
        <span class="cnav-chev" aria-hidden="true">▼</span>
      </button>
      <div class="cnav-spacer"></div>
      <a class="cnav-contact" href="mailto:${CONTACT_EMAIL}" title="Escribinos">
        <span class="cnav-emoji" aria-hidden="true">✉️</span>
        <span class="cnav-label">Contacto</span>
      </a>

      <div class="cnav-panel" id="cnav-panel" role="region" aria-label="Listado de herramientas">
        <div class="cnav-panel-inner">
          <div class="cnav-panel-section">
            <div class="cnav-panel-label">Destacadas</div>
            <div class="cnav-grid-featured">${featuredHtml}</div>
          </div>
          <div class="cnav-panel-section">
            <div class="cnav-panel-label">Más herramientas</div>
            <div class="cnav-grid-rest">${restHtml}</div>
          </div>
        </div>
      </div>
    </nav>
    <div class="cnav-panel-backdrop" aria-hidden="true"></div>
  `;

  const container = document.getElementById('canuto-nav');
  if (container) {
    container.innerHTML = html;
  } else {
    // Si no hay div#canuto-nav, insertamos al inicio del body
    const wrap = document.createElement('div');
    wrap.id = 'canuto-nav';
    wrap.innerHTML = html;
    document.body.insertBefore(wrap, document.body.firstChild);
  }

  // ── Toggle del panel ────────────────────────────────
  const trigger  = document.querySelector('.cnav-trigger');
  const panel    = document.querySelector('.cnav-panel');
  const backdrop = document.querySelector('.cnav-panel-backdrop');

  function openPanel() {
    if (!panel) return;
    panel.classList.add('is-open');
    if (backdrop) backdrop.classList.add('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
  }
  function closePanel() {
    if (!panel) return;
    panel.classList.remove('is-open');
    if (backdrop) backdrop.classList.remove('is-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
  function togglePanel() {
    if (panel && panel.classList.contains('is-open')) closePanel();
    else openPanel();
  }

  if (trigger) {
    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      togglePanel();
    });
  }
  if (backdrop) {
    backdrop.addEventListener('click', closePanel);
  }
  // Cerrar al clickear afuera
  document.addEventListener('click', function(e) {
    if (!panel || !panel.classList.contains('is-open')) return;
    if (panel.contains(e.target)) return;
    if (trigger && trigger.contains(e.target)) return;
    closePanel();
  });
  // Cerrar con Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && panel && panel.classList.contains('is-open')) {
      closePanel();
      if (trigger) trigger.focus();
    }
  });
  // Cerrar al navegar a una tool (delegación)
  document.querySelectorAll('[data-cnav-link]').forEach(function(a) {
    a.addEventListener('click', function() { closePanel(); });
  });
})();
