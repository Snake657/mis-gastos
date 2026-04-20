/**
 * canuto-nav.js
 * Barra de navegación compartida entre todas las herramientas de canuto.ar
 * Incluir con: <script src="/canuto-nav.js"></script>
 * Agregar al body: <div id="canuto-nav"></div>
 */
(function() {
  const TOOLS = [
    { id: 'gastos',          label: 'Mis Gastos',       emoji: '💳', href: '/gastos/',          desc: 'Calendario de gastos fijos' },
    { id: 'retiro',          label: 'Mi Retiro',         emoji: '🏖️', href: '/retiro/',           desc: 'Calculá tu retiro' },
    { id: 'dolar-en-vivo',   label: 'Dólar en Vivo',    emoji: '💵', href: '/dolar-en-vivo/',    desc: 'Cotizaciones al instante' },
    { id: 'dolar-historico', label: 'Dólar Histórico',  emoji: '📈', href: '/dolar-historico/',  desc: 'Historial desde 2003' },
  ];

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
        border-bottom: 1px solid #232736;
        font-family: 'IBM Plex Mono', 'Courier New', monospace;
      }
      .cnav-inner {
        max-width: 1100px;
        margin: 0 auto;
        padding: 0 20px;
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
        margin-right: 28px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .cnav-logo span { color: #4ade80; }
      .cnav-tools {
        display: flex;
        align-items: center;
        gap: 2px;
        overflow-x: auto;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
        flex: 1;
      }
      .cnav-tools::-webkit-scrollbar { display: none; }
      .cnav-tool {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: 7px;
        text-decoration: none;
        color: #8b90a4;
        font-size: 0.78rem;
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
      /* Mobile: solo mostrar emoji en pantallas chicas */
      @media (max-width: 500px) {
        .cnav-tool .cnav-label { display: none; }
        .cnav-tool { padding: 6px 10px; }
        .cnav-logo { margin-right: 12px; font-size: 0.85rem; }
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
    </nav>
  `;

  const container = document.getElementById('canuto-nav');
  if (container) {
    container.innerHTML = html;
  } else {
    // Si no hay div#canuto-nav, insertamos al inicio del body
    document.body.insertAdjacentHTML('afterbegin', `<div id="canuto-nav">${html}</div>`);
  }
})();
