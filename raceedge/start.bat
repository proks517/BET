@echo off
setlocal
pushd "%~dp0"

title RaceEdge
echo.
echo  ================================
echo   RACEEDGE - Starting up...
echo  ================================
echo.
echo  Checking dependencies...
if not exist "node_modules" (
  echo  Installing dependencies - please wait...
  npm install
  if errorlevel 1 (
    echo.
    echo  Dependency install failed.
    popd
    pause
    exit /b 1
  )
  echo  Done.
)
echo.
echo  Starting RaceEdge...
echo  Frontend: http://localhost:5173
echo  API:      http://localhost:3001
echo.
echo  Opening browser in 3 seconds...
timeout /t 3 /nobreak >nul
start http://localhost:5173
npm run dev
popd
pause
