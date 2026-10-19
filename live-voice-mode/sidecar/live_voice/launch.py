"""Starting a process that outlives its parent: detached, windowless and outside the parent's job object."""

import ctypes
import subprocess
from ctypes import wintypes

FLAGS = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_BREAKAWAY_FROM_JOB
QUIET = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}


def jobless(process):
    """Whether `process` is in no job object."""
    found = wintypes.BOOL()
    ctypes.windll.kernel32.IsProcessInJob(wintypes.HANDLE(int(process._handle)), None, ctypes.byref(found))
    return not found.value


def start(argv):
    """Starts `argv` detached and broken away from every job, or else through WMI's Win32_Process.Create, outside the caller's tree."""
    try:
        process = subprocess.Popen(argv, creationflags=FLAGS, **QUIET)
        if jobless(process):
            return "popen"
        process.kill()
    except OSError:
        pass

    line = subprocess.list2cmdline(argv).replace("'", "''")
    create = f"Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='{line}'}}"
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", create], creationflags=subprocess.CREATE_NO_WINDOW, **QUIET)
    return "wmi"
