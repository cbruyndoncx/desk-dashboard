' Starts the dashboard collector in WSL with no visible window. Safe to run twice (second instance exits on port-in-use).
CreateObject("WScript.Shell").Run "wsl.exe -d Ubuntu -- /path/to/desk-dashboard/run-server.sh", 0, False
