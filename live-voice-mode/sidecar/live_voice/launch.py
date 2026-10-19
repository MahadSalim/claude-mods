"""Starting a process that outlives its parent, detached, windowless and outside the parent's job object, and the single-instance lock."""

import ctypes
import msvcrt
import os
import subprocess
import time
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


def hold(path, seconds):
    """Locks `path` through a new handle, waiting up to `seconds`: the handle, locked until closed, or None when another handle holds the lock."""
    handle = os.open(path, os.O_RDWR | os.O_CREAT)
    deadline = time.monotonic() + seconds

    while True:
        try:
            msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
            return handle
        except OSError:
            if time.monotonic() > deadline:
                os.close(handle)
                return None
            time.sleep(0.2)


def free(path):
    """Whether no handle holds the lock on `path`."""
    handle = hold(path, 0)
    if handle is None:
        return False
    msvcrt.locking(handle, msvcrt.LK_UNLCK, 1)
    os.close(handle)
    return True
