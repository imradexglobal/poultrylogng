@echo off

:: PoultryLog NG - Local Development
:: This script starts the development server and opens the app in the default browser.

echo ============================================
echo   PoultryLog NG - Local Development Server
echo ============================================
echo.

:: Install dependencies if node_modules is missing
if not exist "node_modules" (
    echo Installing npm dependencies...
    npm install
    if errorlevel 1 (
        echo npm install failed. Please check your Node/NPM setup.
        pause
        exit /b 1
    )
)

:: Start Vite dev server
echo Starting Vite dev server on http://localhost:3000
echo Press Ctrl+C to stop.
echo.
start "" "http://localhost:3000"
npm run dev

pause