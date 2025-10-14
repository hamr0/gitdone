#!/bin/bash

# GitDone Quick Start Script
# One-command setup and start for local development

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🚀 GitDone Quick Start${NC}"
echo -e "${BLUE}======================${NC}"
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "backend" ] || [ ! -d "frontend" ]; then
    echo -e "${RED}❌ Please run this script from the GitDone root directory${NC}"
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed${NC}"
    echo "Please install Node.js 18+ from: https://nodejs.org/"
    exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v) detected${NC}"

# Setup environment
echo -e "${YELLOW}⚙️  Setting up environment...${NC}"

# Clear any existing SMTP environment variables to prevent conflicts with .env file
unset SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM 2>/dev/null || true

if [ ! -f ".env" ]; then
    cp .env.example .env
    echo -e "${GREEN}✅ .env file created${NC}"
    echo -e "${YELLOW}⚠️  Please update .env with your SMTP credentials${NC}"
fi

mkdir -p data/events data/uploads data/git_repos
echo -e "${GREEN}✅ Data directories created${NC}"

# Install dependencies
echo -e "${YELLOW}📦 Installing dependencies...${NC}"

if [ ! -d "backend/node_modules" ]; then
    echo "Installing backend dependencies..."
    cd backend && npm install && cd ..
fi

if [ ! -d "frontend/node_modules" ]; then
    echo "Installing frontend dependencies..."
    cd frontend && npm install && cd ..
fi

echo -e "${GREEN}✅ Dependencies installed${NC}"

# Start servers
echo -e "${YELLOW}🚀 Starting servers...${NC}"

# Kill any existing servers
pkill -f "node.*backend/server.js" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

# Start backend
echo "Starting backend..."
cd backend
npm start &
BACKEND_PID=$!
cd ..

# Wait for backend
sleep 3

# Start frontend
echo "Starting frontend..."
cd frontend
npm run dev &
FRONTEND_PID=$!
cd ..

# Wait for frontend
sleep 5

echo ""
echo -e "${GREEN}🎉 GitDone is running!${NC}"
echo ""
echo -e "${BLUE}📱 Frontend: http://localhost:3000${NC}"
echo -e "${BLUE}🔧 Backend:  http://localhost:3001${NC}"
echo -e "${BLUE}🏥 Health:  http://localhost:3001/api/health${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop servers${NC}"

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}🛑 Stopping servers...${NC}"
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    pkill -f "node.*backend/server.js" 2>/dev/null || true
    pkill -f "next dev" 2>/dev/null || true
    echo -e "${GREEN}✅ Servers stopped${NC}"
    exit 0
}

# Set trap for cleanup
trap cleanup SIGINT SIGTERM

# Wait for user to stop
wait