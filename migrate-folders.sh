#!/bin/bash
# ============================================================
#  canuto.ar — Migración a estructura de carpetas
#  Correr desde la RAÍZ del repo de GitHub
#  Resultado: URLs limpias sin .html (canuto.ar/gastos/ etc.)
# ============================================================

set -e

echo "🚀 Iniciando migración de carpetas canuto.ar..."

# Herramientas que se convierten en carpeta/index.html
TOOLS=(
  "gastos"
  "retiro"
  "dolar-en-vivo"
  "dolar-historico"
  "indicadores-macro"
  "inflaciona"
  "reservas-y-deuda"
)

for tool in "${TOOLS[@]}"; do
  if [ -f "${tool}.html" ]; then
    mkdir -p "${tool}"
    mv "${tool}.html" "${tool}/index.html"
    echo "  ✓ ${tool}.html → ${tool}/index.html"
  else
    echo "  ⚠ No encontrado: ${tool}.html (ya migrado?)"
  fi
done

# Borrar landing.html si existe (obsoleto)
if [ -f "landing.html" ]; then
  rm landing.html
  echo "  🗑 landing.html eliminado (obsoleto)"
fi

echo ""
echo "✅ Migración completada. Estructura final:"
echo ""
echo "  /index.html                     → canuto.ar/"
echo "  /gastos/index.html              → canuto.ar/gastos/"
echo "  /retiro/index.html              → canuto.ar/retiro/"
echo "  /dolar-en-vivo/index.html       → canuto.ar/dolar-en-vivo/"
echo "  /dolar-historico/index.html     → canuto.ar/dolar-historico/"
echo "  /indicadores-macro/index.html   → canuto.ar/indicadores-macro/"
echo "  /inflaciona/index.html          → canuto.ar/inflaciona/"
echo "  /reservas-y-deuda/index.html    → canuto.ar/reservas-y-deuda/"
echo ""
echo "📌 Próximos pasos:"
echo "  git add -A"
echo "  git commit -m 'refactor: estructura de carpetas para URLs limpias'"
echo "  git push"
echo ""
echo "⚠️  Si tenés redirects configurados en algún lado, actualizalos."
