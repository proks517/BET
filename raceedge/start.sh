#!/bin/bash
echo ""
echo " ================================"
echo "  RACEEDGE - Starting up..."
echo " ================================"
echo ""
if [ ! -d "node_modules" ]; then
  echo " Installing dependencies..."
  npm install
fi
echo " Frontend: http://localhost:5173"
echo " API:      http://localhost:3001"
echo ""
sleep 2
open http://localhost:5173 2>/dev/null || xdg-open http://localhost:5173 2>/dev/null
npm run dev
