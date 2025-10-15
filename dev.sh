#!/bin/bash

# GitDone Local Development Script
# Simple menu-driven script to start/stop the development environment

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ASCII Art Banner
show_banner() {
    echo -e "${CYAN}"
    echo "  ██████╗ ██╗████████╗██████╗  ██████╗ ███╗   ██╗███████╗"
    echo " ██╔════╝ ██║╚══██╔══╝██╔══██╗██╔═══██╗████╗  ██║██╔════╝"
    echo " ██║  ███╗██║   ██║   ██║  ██║██║   ██║██╔██╗ ██║█████╗  "
    echo " ██║   ██║██║   ██║   ██║  ██║██║   ██║██║╚██╗██║██╔══╝  "
    echo " ╚██████╔╝██║   ██║   ██║  ██║╚██████╔╝██║ ╚████║███████╗"
    echo "  ╚═════╝ ╚═╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝"
    echo -e "${NC}"
    echo -e "${PURPLE}🚀 GitDone Local Development Environment${NC}"
    echo -e "${PURPLE}===========================================${NC}"
    echo ""
}

# Check if we're in the right directory
check_directory() {
    if [ ! -f "package.json" ] || [ ! -d "backend" ] || [ ! -d "frontend" ]; then
        echo -e "${RED}❌ Please run this script from the GitDone root directory${NC}"
        echo "Expected structure:"
        echo "  gitdone/"
        echo "  ├── backend/"
        echo "  ├── frontend/"
        echo "  └── package.json"
        exit 1
    fi
}

# Check prerequisites
check_prerequisites() {
    echo -e "${YELLOW}🔍 Checking prerequisites...${NC}"
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}❌ Node.js is not installed${NC}"
        echo "Please install Node.js 18+ from: https://nodejs.org/"
        exit 1
    fi
    
    # Check npm
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}❌ npm is not installed${NC}"
        echo "Please install npm"
        exit 1
    fi
    
    # Check Node.js version
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo -e "${RED}❌ Node.js version 18+ required (current: $(node -v))${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Node.js $(node -v) detected${NC}"
    echo -e "${GREEN}✅ npm $(npm -v) detected${NC}"
}

# Setup environment
setup_environment() {
    echo -e "${YELLOW}⚙️  Setting up environment...${NC}"

    # Export SMTP credentials from pass
    if command -v pass &> /dev/null; then
        export SMTP_USER=$(pass show gitdone/email/smtp_user)
        export SMTP_PASS=$(pass show gitdone/email/smtp_pass)
        export SMTP_FROM=$(pass show gitdone/email/smtp_from)
        echo -e "${GREEN}✅ SMTP credentials loaded from pass${NC}"
    else
        echo -e "${YELLOW}⚠️  'pass' command not found, using .env credentials${NC}"
    fi

    # Create .env if it doesn't exist
    if [ ! -f ".env" ]; then
        echo -e "${YELLOW}📝 Creating .env file from template...${NC}"
        cp .env.example .env
        echo -e "${GREEN}✅ .env file created${NC}"
        echo -e "${YELLOW}⚠️  Please edit .env file with your email configuration${NC}"
        echo "   Especially SMTP_USER and SMTP_PASS for email functionality"
    fi

    # Create data directories
    echo -e "${YELLOW}📁 Creating data directories...${NC}"
    mkdir -p data/events data/uploads data/git_repos
    echo -e "${GREEN}✅ Data directories created${NC}"
}

# Install dependencies
install_dependencies() {
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    
    # Install backend dependencies
    if [ ! -d "backend/node_modules" ]; then
        echo "Installing backend dependencies..."
        cd backend
        npm install
        cd ..
        echo -e "${GREEN}✅ Backend dependencies installed${NC}"
    else
        echo -e "${GREEN}✅ Backend dependencies already installed${NC}"
    fi
    
    # Install frontend dependencies
    if [ ! -d "frontend/node_modules" ]; then
        echo "Installing frontend dependencies..."
        cd frontend
        npm install
        cd ..
        echo -e "${GREEN}✅ Frontend dependencies installed${NC}"
    else
        echo -e "${GREEN}✅ Frontend dependencies already installed${NC}"
    fi
}

# Start development servers
start_servers() {
    echo -e "${YELLOW}🚀 Starting development servers...${NC}"
    
    # Check if servers are already running
    if pgrep -f "node.*backend/server.js" > /dev/null; then
        echo -e "${RED}❌ Backend server is already running${NC}"
        echo "Use 'Stop Servers' option first, or kill the process manually"
        return 1
    fi
    
    if pgrep -f "next dev" > /dev/null; then
        echo -e "${RED}❌ Frontend server is already running${NC}"
        echo "Use 'Stop Servers' option first, or kill the process manually"
        return 1
    fi
    
    # Start backend
    echo "Starting backend server..."
    cd backend
    npm start &
    BACKEND_PID=$!
    cd ..
    
    # Wait for backend to start
    echo "Waiting for backend to start..."
    sleep 3
    
    # Check if backend started successfully
    if ! pgrep -f "node.*backend/server.js" > /dev/null; then
        echo -e "${RED}❌ Backend failed to start${NC}"
        return 1
    fi
    
    # Start frontend
    echo "Starting frontend server..."
    cd frontend
    npm run dev &
    FRONTEND_PID=$!
    cd ..
    
    # Wait for frontend to start
    echo "Waiting for frontend to start..."
    sleep 5
    
    # Check if frontend started successfully
    if ! pgrep -f "next dev" > /dev/null; then
        echo -e "${RED}❌ Frontend failed to start${NC}"
        return 1
    fi
    
    echo -e "${GREEN}✅ Both servers started successfully!${NC}"
    echo ""
    echo -e "${CYAN}📱 Frontend: ${GREEN}http://localhost:3000${NC}"
    echo -e "${CYAN}🔧 Backend:  ${GREEN}http://localhost:3001${NC}"
    echo -e "${CYAN}🏥 Health:  ${GREEN}http://localhost:3001/api/health${NC}"
    echo ""
    echo -e "${YELLOW}Press Ctrl+C to stop servers${NC}"
    
    # Store PIDs for cleanup
    echo $BACKEND_PID > .backend.pid
    echo $FRONTEND_PID > .frontend.pid
    
    # Wait for user to stop
    wait
}

# Stop development servers
stop_servers() {
    echo -e "${YELLOW}🛑 Stopping development servers...${NC}"
    
    # Stop backend
    if pgrep -f "node.*backend/server.js" > /dev/null; then
        pkill -f "node.*backend/server.js"
        echo -e "${GREEN}✅ Backend server stopped${NC}"
    else
        echo -e "${YELLOW}⚠️  Backend server was not running${NC}"
    fi
    
    # Stop frontend
    if pgrep -f "next dev" > /dev/null; then
        pkill -f "next dev"
        echo -e "${GREEN}✅ Frontend server stopped${NC}"
    else
        echo -e "${YELLOW}⚠️  Frontend server was not running${NC}"
    fi
    
    # Clean up PID files
    rm -f .backend.pid .frontend.pid
    
    echo -e "${GREEN}✅ All servers stopped${NC}"
}

# Check server status
check_status() {
    echo -e "${YELLOW}📊 Checking server status...${NC}"
    echo ""
    
    # Check backend
    if pgrep -f "node.*backend/server.js" > /dev/null; then
        echo -e "${GREEN}✅ Backend: Running on port 3001${NC}"
        if curl -s http://localhost:3001/api/health > /dev/null 2>&1; then
            echo -e "${GREEN}   Health check: OK${NC}"
        else
            echo -e "${RED}   Health check: Failed${NC}"
        fi
    else
        echo -e "${RED}❌ Backend: Not running${NC}"
    fi
    
    # Check frontend
    if pgrep -f "next dev" > /dev/null; then
        echo -e "${GREEN}✅ Frontend: Running on port 3000${NC}"
        if curl -s http://localhost:3000 > /dev/null 2>&1; then
            echo -e "${GREEN}   Web interface: OK${NC}"
        else
            echo -e "${RED}   Web interface: Failed${NC}"
        fi
    else
        echo -e "${RED}❌ Frontend: Not running${NC}"
    fi
    
    echo ""
}

# Show logs
show_logs() {
    echo -e "${YELLOW}📋 Recent server logs:${NC}"
    echo ""
    
    echo -e "${CYAN}Backend logs (last 10 lines):${NC}"
    if pgrep -f "node.*backend/server.js" > /dev/null; then
        # Try to get logs from the running process
        echo "Backend server is running..."
    else
        echo "Backend server is not running"
    fi
    
    echo ""
    echo -e "${CYAN}Frontend logs (last 10 lines):${NC}"
    if pgrep -f "next dev" > /dev/null; then
        echo "Frontend server is running..."
    else
        echo "Frontend server is not running"
    fi
}

# Test the application
test_application() {
    echo -e "${YELLOW}🧪 Testing application...${NC}"
    echo ""
    
    # Test backend health
    echo -e "${CYAN}Testing backend health endpoint...${NC}"
    if curl -s http://localhost:3001/api/health | grep -q "healthy"; then
        echo -e "${GREEN}✅ Backend health check passed${NC}"
    else
        echo -e "${RED}❌ Backend health check failed${NC}"
        echo "Make sure backend is running on port 3001"
        return 1
    fi
    
    # Test frontend
    echo -e "${CYAN}Testing frontend...${NC}"
    if curl -s http://localhost:3000 > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Frontend is accessible${NC}"
    else
        echo -e "${RED}❌ Frontend is not accessible${NC}"
        echo "Make sure frontend is running on port 3000"
        return 1
    fi
    
    echo ""
    echo -e "${GREEN}🎉 All tests passed!${NC}"
    echo -e "${CYAN}You can now access:${NC}"
    echo -e "  📱 Frontend: http://localhost:3000"
    echo -e "  🔧 Backend:  http://localhost:3001"
}

# Clean up function
cleanup() {
    echo ""
    echo -e "${YELLOW}🛑 Stopping servers...${NC}"
    stop_servers
    echo -e "${GREEN}✅ Cleanup completed${NC}"
    exit 0
}

# Main menu
show_menu() {
    echo ""
    echo -e "${PURPLE}📋 Available Options:${NC}"
    echo -e "${GREEN}1)${NC} 🚀 Start Development Servers"
    echo -e "${GREEN}2)${NC} 🛑 Stop Development Servers"
    echo -e "${GREEN}3)${NC} 📊 Check Server Status"
    echo -e "${GREEN}4)${NC} 📋 Show Server Logs"
    echo -e "${GREEN}5)${NC} 🧪 Test Application"
    echo -e "${GREEN}6)${NC} 📦 Install/Update Dependencies"
    echo -e "${GREEN}7)${NC} ⚙️  Setup Environment"
    echo -e "${GREEN}8)${NC} ❓ Help"
    echo -e "${GREEN}9)${NC} 🚪 Exit"
    echo ""
}

# Help function
show_help() {
    echo -e "${CYAN}📚 GitDone Development Help${NC}"
    echo -e "${CYAN}=========================${NC}"
    echo ""
    echo -e "${YELLOW}🚀 Quick Start:${NC}"
    echo "1. Run this script: ./dev.sh"
    echo "2. Choose option 1 to start servers"
    echo "3. Open http://localhost:3000 in your browser"
    echo ""
    echo -e "${YELLOW}📋 Available Commands:${NC}"
    echo "• Start Servers: Starts both frontend and backend"
    echo "• Stop Servers: Stops all running servers"
    echo "• Check Status: Shows which servers are running"
    echo "• Show Logs: Displays recent server logs"
    echo "• Test Application: Runs basic health checks"
    echo "• Install Dependencies: Installs/updates npm packages"
    echo "• Setup Environment: Creates .env and data directories"
    echo ""
    echo -e "${YELLOW}🔧 Troubleshooting:${NC}"
    echo "• If servers won't start: Check if ports 3000/3001 are free"
    echo "• If dependencies fail: Make sure Node.js 18+ is installed"
    echo "• If email doesn't work: Configure SMTP settings in .env"
    echo ""
    echo -e "${YELLOW}📁 Project Structure:${NC}"
    echo "• Frontend: Next.js app on port 3000"
    echo "• Backend: Express API on port 3001"
    echo "• Data: Stored in ./data/ directory"
    echo "• Config: Environment variables in .env"
}

# Main script logic
main() {
    show_banner
    check_directory
    check_prerequisites
    
    # Set trap for cleanup on exit
    trap cleanup SIGINT SIGTERM
    
    while true; do
        show_menu
        read -p "Choose an option (1-9): " choice
        
        case $choice in
            1)
                setup_environment
                install_dependencies
                start_servers
                ;;
            2)
                stop_servers
                ;;
            3)
                check_status
                ;;
            4)
                show_logs
                ;;
            5)
                test_application
                ;;
            6)
                install_dependencies
                ;;
            7)
                setup_environment
                ;;
            8)
                show_help
                ;;
            9)
                echo -e "${GREEN}👋 Goodbye!${NC}"
                cleanup
                ;;
            *)
                echo -e "${RED}❌ Invalid option. Please choose 1-9.${NC}"
                ;;
        esac
        
        echo ""
        read -p "Press Enter to continue..."
    done
}

# Run main function
main "$@"