#!/bin/bash

# Start development servers for both static site and FastAPI backend

echo "🚀 Starting development servers..."

# Activate virtual environment
source venv/bin/activate

# Start FastAPI backend in background
echo "📦 Starting FastAPI backend on http://localhost:8000..."
uvicorn api.index:app --reload --port 8000 &
FASTAPI_PID=$!

# Wait a moment for FastAPI to start
sleep 2

# Start proxy server in background
echo "🌐 Starting proxy server on http://localhost:3000..."
node proxy-server.js &
PROXY_PID=$!

echo ""
echo "✅ Development environment ready:"
echo "   - Main site: http://localhost:3000"
echo "   - FastAPI direct: http://localhost:8000 (all api/*.py functions mounted)"
echo ""
echo "Press Ctrl+C to stop all servers"

# Wait for Ctrl+C
trap "kill $FASTAPI_PID $PROXY_PID; exit" INT
wait
