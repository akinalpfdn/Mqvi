@echo off
echo Setting up MSVC environment...
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 (
    echo ERROR: vcvars64.bat failed
    exit /b 1
)
echo Compiling audio-capture.cpp...
cl.exe /EHsc /O2 /W3 "%~dp0audio-capture.cpp" /Fe:"%~dp0audio-capture.exe" ole32.lib mmdevapi.lib
if errorlevel 1 (
    echo ERROR: Compilation failed
    exit /b 1
)
echo Build successful: native\audio-capture.exe
