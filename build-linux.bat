@echo off
setlocal EnableDelayedExpansion

REM ===================================================================
REM  build-linux.bat — cross-build a Linux distributable from Windows.
REM
REM  Output: dist\AMMViewer-linux.tar.gz
REM    Contains: AMMViewer-linux/  (full unpacked Electron app)
REM      AMMViewer                  — launcher (ELF, marked 0755)
REM      chrome-sandbox             — sandbox helper (marked 0755)
REM      *.so                       — shared libraries (marked 0755)
REM      resources/, locales/, etc. — app data (0644)
REM
REM  Why NOT AppImage? On a Windows host, electron-builder's AppImage
REM  assembly executes Linux ELF helper binaries, which fails on Windows.
REM  The unpacked-directory approach skips that toolchain; end-user
REM  experience is the same: extract the tar.gz, run the launcher.
REM
REM  pack-app-bundle.js sniffs ELF magic bytes and forces 0755 on every
REM  entry that needs it (NTFS can't carry the Unix +x bit).
REM ===================================================================

echo ============================================================
echo  Building AMMViewer for Linux (cross-build from Windows)
echo ============================================================
echo.

cd /d "%~dp0"

echo [1/3] Bundling renderer...
call node build.js
if errorlevel 1 (
    echo Renderer build FAILED.
    goto :end
)

echo [2/3] Running electron-builder --linux dir...
call npx electron-builder --linux dir -c.npmRebuild=false
if errorlevel 1 (
    echo electron-builder FAILED.
    goto :end
)

echo [3/3] Packing dist\linux-unpacked\ into tar.gz with exec bits...
set "UNPACKED=dist\linux-unpacked"
if not exist "%UNPACKED%" (
    echo Expected directory not found: %UNPACKED%
    set ERRORLEVEL=1
    goto :end
)

set "OUT_TGZ=dist\AMMViewer-linux.tar.gz"
call node pack-app-bundle.js --root "%UNPACKED%" --top-name "AMMViewer-linux" --out "%OUT_TGZ%"
if errorlevel 1 (
    echo Tar packing FAILED.
    goto :end
)

echo.
echo ============================================================
echo  Build SUCCEEDED.
echo    Unpacked:      %UNPACKED%
echo    Distributable: %OUT_TGZ%
echo.
echo  User instructions:
echo    tar -xzf AMMViewer-linux.tar.gz
echo    cd AMMViewer-linux
echo    ./AMMViewer
echo ============================================================

:end
echo.
pause
endlocal
