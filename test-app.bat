@echo off

:: Test the PoultryLog NG app locally
:: Starts the dev server, opens the browser, and waits for user to close.

echo ===========================================
echo   PoultryLog NG - Local Test Runner
echo ===========================================
echo.

:: Ensure dependencies are installed
if not exist "node_modules" (
    echo Installing npm dependencies...
    npm install
    if errorlevel 1 (
        echo npm install failed. Check your Node/NPM setup.
        pause
        exit /b 1
    )
)

:: Start the Vite dev server
start "" "http://localhost:3000"
npm run dev

pause