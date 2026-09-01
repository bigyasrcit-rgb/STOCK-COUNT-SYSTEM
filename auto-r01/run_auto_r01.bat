@echo off
REM ============================================================
REM  Auto R01.102 import -> Firestore
REM  Called by Windows Task Scheduler daily at 08:10 (see README.md)
REM
REM  KEEP THIS FILE PURE ASCII.
REM  Thai text in a .bat breaks the cmd.exe parser (it re-reads the file by byte
REM  offset, so multi-byte characters split lines into garbage commands).
REM  All Thai documentation lives in README.md instead.
REM
REM  Works on any machine without editing: the Python script resolves the CSV
REM  folder from %USERPROFILE%\Desktop\run-upload-stock.
REM  If a machine keeps the file elsewhere, set it once:
REM      setx AUTO_R01_WATCH_FOLDER "D:\some\other\run-upload-stock"
REM ============================================================

set "LOG=%~dp0auto_r01.log"

REM --- log rotation: must happen before the >> handle is opened ---
if exist "%LOG%" (
  for %%F in ("%LOG%") do if %%~zF GTR 2097152 (
    if exist "%LOG%.1" del /q "%LOG%.1"
    move /y "%LOG%" "%LOG%.1" >nul
  )
)

REM --- locate Python: known install dirs, then PATH, then the py launcher ---
set "PYEXE="
for %%C in (
  "C:\Program Files\Python311\python.exe"
  "C:\Program Files\Python312\python.exe"
  "C:\Program Files\Python313\python.exe"
) do if not defined PYEXE if exist %%C set "PYEXE=%%~C"

if not defined PYEXE for /f "delims=" %%P in ('where python 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if not defined PYEXE for /f "delims=" %%P in ('where py 2^>nul') do if not defined PYEXE set "PYEXE=%%P"

REM Redirect is written BEFORE the echo on purpose. Trailing "%VAR%>> file" is a batch trap:
REM if the value ends in a digit, cmd reads it as a file-descriptor redirect (0>>, 2>> ...)
REM and the text escapes to the console instead of the log.
if not defined PYEXE (
  >>"%LOG%" echo [%DATE% %TIME%] ERROR: Python not found on this machine.
  >>"%LOG%" echo [%DATE% %TIME%] Install from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  exit /b 9
)

>>"%LOG%" echo [%DATE% %TIME%] --- run start on %COMPUTERNAME% as %USERNAME% using "%PYEXE%"
"%PYEXE%" "%~dp0auto_r01_import.py" %* >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
>>"%LOG%" echo [%DATE% %TIME%] --- run end, exit code %RC%
exit /b %RC%
