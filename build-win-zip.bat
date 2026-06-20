@echo off
setlocal EnableDelayedExpansion

REM ===================================================================
REM  build-win-zip.bat — build a Windows distributable as a single zip.
REM
REM  Output: dist\AMMViewer-win.zip
REM    Contains: AMMViewer-win\  (full unpacked Electron app)
REM      AMMViewer.exe            — launcher
REM      *.dll                    — runtime libraries
REM      resources\app.asar       — packaged renderer + main
REM      locales\, *.pak, etc.    — Electron / Chromium support files
REM
REM  Pipeline:
REM    1. Bundle the renderer (esbuild).
REM    2. electron-builder --win dir → dist\win-unpacked\
REM    3. Rename win-unpacked → AMMViewer-win (so the zip's top-level
REM       directory has a sensible name when the user extracts).
REM    4. Zip via System.IO.Compression.ZipFile (PowerShell). Faster
REM       than Compress-Archive on large trees.
REM    5. Rename AMMViewer-win back to win-unpacked, in case another
REM       build script (build-win.bat) expects the original path.
REM
REM  This script does NOT touch AMMViewerContents\ or the AMMViewer.lnk
REM  shortcut — that's build-win.bat's job, for in-place dev testing.
REM  This one is for shipping a release artifact.
REM ===================================================================

echo ============================================================
echo  Building AMMViewer for Windows (distributable zip)
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/4] Bundling renderer...
call node build.js
if errorlevel 1 (
    echo Renderer build FAILED.
    goto :end
)

echo [2/4] Running electron-builder --win dir...
call npx electron-builder --win dir -c.compression=store -c.npmRebuild=false
if errorlevel 1 (
    echo electron-builder FAILED.
    goto :end
)

set "UNPACKED=dist\win-unpacked"
set "STAGED=dist\AMMViewer-win"
set "OUT_ZIP=dist\AMMViewer-win.zip"

if not exist "%UNPACKED%" (
    echo Expected directory not found: %UNPACKED%
    set ERRORLEVEL=1
    goto :end
)

echo [3/4] Renaming %UNPACKED% to %STAGED% for zip top-level...
if exist "%STAGED%" rmdir /S /Q "%STAGED%"
if exist "%OUT_ZIP%" del /F /Q "%OUT_ZIP%"
move "%UNPACKED%" "%STAGED%" >nul
if errorlevel 1 (
    echo Rename FAILED.
    goto :end
)

echo [4/4] Zipping to %OUT_ZIP%...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;" ^
    "[System.IO.Compression.ZipFile]::CreateFromDirectory(" ^
    "  (Resolve-Path '%STAGED%').Path," ^
    "  (Join-Path (Resolve-Path 'dist').Path 'AMMViewer-win.zip')," ^
    "  [System.IO.Compression.CompressionLevel]::Optimal," ^
    "  $true)"
set ZIP_ERR=%ERRORLEVEL%

REM Always rename back, even if the zip step failed.
move "%STAGED%" "%UNPACKED%" >nul

if not %ZIP_ERR% EQU 0 (
    echo Zip step FAILED with exit code %ZIP_ERR%.
    set ERRORLEVEL=%ZIP_ERR%
    goto :end
)

for /f "delims=" %%S in ('powershell -NoProfile -Command "'{0:N1} MB' -f ((Get-Item '%OUT_ZIP%').Length / 1MB)"') do set "ZIP_SIZE=%%S"

echo.
echo ============================================================
echo  Build SUCCEEDED.
echo    Unpacked:      %UNPACKED%
echo    Distributable: %OUT_ZIP%  (!ZIP_SIZE!)
echo.
echo  User instructions:
echo    Extract AMMViewer-win.zip anywhere.
echo    Run AMMViewer-win\AMMViewer.exe.
echo ============================================================

:end
echo.
pause
endlocal
