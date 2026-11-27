"""Confine target filesystem access and TCP connect/bind on Linux with Landlock ABI 4+."""
import ctypes
import errno
import json
import os
import platform
import sys

if platform.machine() not in ("x86_64", "aarch64"):
    raise SystemExit("unsupported Landlock architecture")
libc = ctypes.CDLL(None, use_errno=True)
def checked(value):
    if value < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return value
def syscall(n, *args):
    return checked(libc.syscall(n, *args))
def record(*fields):
    return type("Rule", (ctypes.LittleEndianStructure,), {"_pack_": 1, "_fields_": fields})
u64 = ctypes.c_uint64
abi = syscall(444, 0, 0, 1)
if abi < 4:
    raise SystemExit("Landlock ABI 4 is required")
fs_rights = (1 << 15) - 1
rw = record(("fs", u64), ("net", u64))(fs_rights, 3)
fd = syscall(444, ctypes.byref(rw), ctypes.sizeof(rw), 0)
def permit(name, rights):
    if not os.path.exists(name):
        return
    pfd = os.open(name, os.O_PATH | os.O_CLOEXEC)
    try:
        if not os.path.isdir(name):
            rights &= (1 | 2 | 4 | (1 << 14))
        rule = record(("rights", u64), ("parent", ctypes.c_int))(rights, pfd)
        syscall(445, fd, 1, ctypes.byref(rule), 0)
    finally:
        os.close(pfd)
for name in json.loads(sys.argv[1]):
    permit(name, 1 | 4 | 8)
# Node opens the null device read/write for the journal helper stderr.
permit("/dev/null", 2 | 4)
permit(sys.argv[2], fs_rights)
for port in json.loads(sys.argv[3]):
    rule = record(("rights", u64), ("port", u64))(2, port)
    syscall(445, fd, 2, ctypes.byref(rule), 0)
checked(libc.prctl(38, 1, 0, 0, 0))
syscall(446, fd, 0)
os.close(fd)
os.execv(sys.argv[4], sys.argv[4:])
