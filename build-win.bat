@echo off
setlocal

echo ============================================================
echo  Building AMMViewer for Windows (dir target, fast settings)
echo ============================================================
echo.

cd /d "%~dp0"

call node build.js
call npx electron-builder --win dir -c.compression=store -c.npmRebuild=false

set EXITCODE=%ERRORLEVEL%

if %EXITCODE% EQU 0 (
    echo Clearing old AMMViewerContents ...
    if exist "%~dp0AMMViewerContents" rmdir /S /Q "%~dp0AMMViewerContents"
    mkdir "%~dp0AMMViewerContents"

    echo Copying built files to AMMViewerContents ...
    xcopy /E /Y /I /Q "%~dp0dist\win-unpacked\*" "%~dp0AMMViewerContents\" >nul
    set EXITCODE=%ERRORLEVEL%
)

if %EXITCODE% EQU 0 (
    echo Creating AMMViewer.lnk shortcut at repo root ...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$w = New-Object -ComObject WScript.Shell;" ^
        "$s = $w.CreateShortcut('%~dp0AMMViewer.lnk');" ^
        "$s.TargetPath = '%~dp0AMMViewerContents\AMMViewer.exe';" ^
        "$s.WorkingDirectory = '%~dp0AMMViewerContents';" ^
        "$s.IconLocation = '%~dp0AMMViewerContents\AMMViewer.exe,0';" ^
        "$s.Save()"
    set EXITCODE=%ERRORLEVEL%
)

echo.
echo ============================================================
if %EXITCODE% EQU 0 (
    echo  Build SUCCEEDED.
    echo  Shortcut: %~dp0AMMViewer.lnk
    echo  Exe:      %~dp0AMMViewerContents\AMMViewer.exe
) else (
    echo  Build FAILED with exit code %EXITCODE%.
)
echo ============================================================
echo.

pause
endlocal
