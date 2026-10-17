#!/usr/bin/env python3
"""Capture a serial console into a new file, the bytes as received, with the time of every
chunk and the open recorded as the baseline (the target-debug skill's Log capture).

  console_capture.py --port /dev/serial/by-id/<port> --baud 115200 --seconds 20 \
                     --lines leave|low --out <new file> [--mark REGEX ...]

The port is named by /dev/serial/by-id or by-path; /dev/ttyACM<N> and /dev/ttyUSB<N> are
refused, since those numbers drift within one boot. The script configures its own fd: raw mode
and the baud rate with TCSANOW (TCSAFLUSH waits for another client's output to drain and
discards unread input), and puts the port's original settings back at the end; a restore that
fails fails the run.

--lines is the control-line policy, with no default: `leave` keeps DTR and RTS as the open set
them, `low` clears both once the port is configured. Neither keeps them low through the open: Linux
raises DTR and RTS when a serial port opens, and on Espressif boards a line change can reset
the chip (espressif.md, Console). A port without modem control lines (a pty) refuses `low`.
Closing the port drops both lines again when the restored settings carry HUPCL.

A reset at the open is measured, never assumed: each --mark pattern (a Python regex over the
bytes read as Latin-1, e.g. 'rst:0x[0-9a-f]+' for an Espressif ROM banner) is reported with the
time after the open of the chunk where each match starts. An empty capture reports no baseline:
nothing anchors it. Other processes holding the device open are listed as a possible
conflict: a second reader takes bytes from this one.

Output: the bytes in --out, one JSON line per chunk ({"t": s after the open, "offset", "len"})
in <out>.times, and a JSON summary on stdout. The capture ends at --seconds, at a signal, or
when the device goes away or hangs up (a reset that re-enumerates a USB console); its settings
then often cannot be restored, which fails the run like any other restore failure (a hung-up
USB-serial port keeps its termios: the USB-serial core does not reset them at hangup).

Windows (no termios): the port is COM<n> or \\\\.\\COM<n>. A COM number is stable there, unlike a
ttyACM number: the Ports class installer gives each device instance its own number and keeps it
across replugs, resets and reboots (a USB device with a serial number keeps it on any USB port,
one without has one per USB port, like by-path), where Linux takes the first free ttyACM slot at
each enumeration. Windows opens a comm port exclusively, so a port another program holds is
refused as busy, without the holder: Windows does not say which program has it (no otherOpeners).
The DCB and COMMTIMEOUTS are saved, the port set to raw 8N1 at --baud (any rate the driver's
SetCommState accepts) without flow control, parity, error-character or NUL handling, and both are
put back at the end. `leave` writes the DTR/RTS levels the open left (IOCTL_SERIAL_GET_DTRRTS)
into the DCB, `low` clears both with EscapeCommFunction after it; whether the open or the close
moves DTR/RTS is the driver's choice, and the restore re-applies the saved DCB's DTR/RTS control.
A read waits at most 50 ms, which bounds the end at --seconds and at Ctrl-C/Ctrl-Break. This
backend is unverified on hardware.

Exit: 0 captured (an empty capture included); 2 bad usage; 3 the port could not be opened or
configured, a read failed, its settings could not be restored, or an output file failed to close.
"""
import argparse
import bisect
import datetime
import errno
import itertools
import json
import math
import os
import re
import select
import signal
import struct
import sys
import time

try:
    import fcntl
    import termios
    import tty
except ImportError:  # Windows: the Win32 backend, capture_nt
    termios = None

DRIFTING = re.compile(r'/dev/tty(ACM|USB)[0-9]+')
COM_PORT = re.compile(r'(?:\\\\\.\\)?COM([1-9][0-9]*)', re.I)
MAX_MARKS = 20
READ_POLL_MS = 50

GENERIC_READ, GENERIC_WRITE, OPEN_EXISTING = 0x80000000, 0x40000000, 3
MAXDWORD = 0xFFFFFFFF
NOPARITY, ONESTOPBIT = 0, 0
DTR_CONTROL_DISABLE, DTR_CONTROL_ENABLE, DTR_CONTROL_HANDSHAKE = 0, 1, 2
RTS_CONTROL_DISABLE, RTS_CONTROL_ENABLE, RTS_CONTROL_HANDSHAKE, RTS_CONTROL_TOGGLE = 0, 1, 2, 3
CLRRTS, CLRDTR = 4, 6
IOCTL_SERIAL_GET_DTRRTS = 0x1B << 16 | 30 << 2    # CTL_CODE(FILE_DEVICE_SERIAL_PORT, 30, BUFFERED, ANY)
SERIAL_DTR_STATE, SERIAL_RTS_STATE = 1, 2
ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_INSUFFICIENT_BUFFER = 5, 32, 122
# a removed USB-serial port fails its reads with one of these (driver-specific, unverified on hardware)
ERRORS_GONE = {ERROR_ACCESS_DENIED, 22, 31, 433, 1167, 1617}    # BAD_COMMAND, GEN_FAILURE, NO_SUCH_DEVICE,
                                                                # DEVICE_NOT_CONNECTED, DEVICE_REMOVED

if termios is None:
    import ctypes
    from ctypes import wintypes

    class DCB(ctypes.Structure):
        _fields_ = [('DCBlength', wintypes.DWORD), ('BaudRate', wintypes.DWORD),
                    ('fBinary', wintypes.DWORD, 1), ('fParity', wintypes.DWORD, 1),
                    ('fOutxCtsFlow', wintypes.DWORD, 1), ('fOutxDsrFlow', wintypes.DWORD, 1),
                    ('fDtrControl', wintypes.DWORD, 2), ('fDsrSensitivity', wintypes.DWORD, 1),
                    ('fTXContinueOnXoff', wintypes.DWORD, 1), ('fOutX', wintypes.DWORD, 1),
                    ('fInX', wintypes.DWORD, 1), ('fErrorChar', wintypes.DWORD, 1),
                    ('fNull', wintypes.DWORD, 1), ('fRtsControl', wintypes.DWORD, 2),
                    ('fAbortOnError', wintypes.DWORD, 1), ('fDummy2', wintypes.DWORD, 17),
                    ('wReserved', wintypes.WORD), ('XonLim', wintypes.WORD), ('XoffLim', wintypes.WORD),
                    ('ByteSize', wintypes.BYTE), ('Parity', wintypes.BYTE), ('StopBits', wintypes.BYTE),
                    ('XonChar', ctypes.c_char), ('XoffChar', ctypes.c_char), ('ErrorChar', ctypes.c_char),
                    ('EofChar', ctypes.c_char), ('EvtChar', ctypes.c_char), ('wReserved1', wintypes.WORD)]

    class COMMTIMEOUTS(ctypes.Structure):
        _fields_ = [('ReadIntervalTimeout', wintypes.DWORD), ('ReadTotalTimeoutMultiplier', wintypes.DWORD),
                    ('ReadTotalTimeoutConstant', wintypes.DWORD), ('WriteTotalTimeoutMultiplier', wintypes.DWORD),
                    ('WriteTotalTimeoutConstant', wintypes.DWORD)]

    assert ctypes.sizeof(DCB) == 28 and ctypes.sizeof(COMMTIMEOUTS) == 20
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    _k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _H, _D, _B, _P = wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.LPVOID
    for _name, _res, _args in (
            ('CreateFileW', _H, (wintypes.LPCWSTR, _D, _D, _P, _D, _D, _H)),
            ('GetCommState', _B, (_H, ctypes.POINTER(DCB))),
            ('SetCommState', _B, (_H, ctypes.POINTER(DCB))),
            ('GetCommTimeouts', _B, (_H, ctypes.POINTER(COMMTIMEOUTS))),
            ('SetCommTimeouts', _B, (_H, ctypes.POINTER(COMMTIMEOUTS))),
            ('EscapeCommFunction', _B, (_H, _D)),
            ('ReadFile', _B, (_H, _P, _D, wintypes.LPDWORD, _P)),
            ('DeviceIoControl', _B, (_H, _D, _P, _D, _P, _D, wintypes.LPDWORD, _P)),
            ('CloseHandle', _B, (_H,)),
            ('QueryDosDeviceW', _D, (wintypes.LPCWSTR, wintypes.LPWSTR, _D))):
        _f = getattr(_k32, _name)
        _f.restype, _f.argtypes = _res, _args


class Stop(Exception):
    pass


def baud_constant(rate):
    if termios is None:  # Windows: the DCB takes the rate itself and the driver's SetCommState judges it
        return rate if 0 < rate <= MAXDWORD else None
    return getattr(termios, f'B{rate}', None)


def modem_lines(fd):
    """{'dtr', 'rts'}, or None on a port without modem control lines."""
    try:
        v = struct.unpack('i', fcntl.ioctl(fd, termios.TIOCMGET, struct.pack('i', 0)))[0]
    except OSError:
        return None
    return {'dtr': bool(v & termios.TIOCM_DTR), 'rts': bool(v & termios.TIOCM_RTS)}


def other_openers(device):
    """[{'pid', 'comm'}] of other processes with the device open, as /proc shows them."""
    found = []
    for pid in filter(str.isdigit, os.listdir('/proc')):
        if int(pid) == os.getpid():
            continue
        try:
            fds = os.listdir(f'/proc/{pid}/fd')
        except OSError:
            continue
        for fd in fds:
            try:
                if os.readlink(f'/proc/{pid}/fd/{fd}') == device:
                    with open(f'/proc/{pid}/comm') as f:
                        found.append({'pid': int(pid), 'comm': f.read().strip()})
                    break
            except OSError:
                continue
    return found


# The Win32 layer: one wrapper per call, raising OSError (winerror set) on failure.
def _ok(ok):
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())


def nt_port_exists(name):
    buf = ctypes.create_unicode_buffer(1024)
    return bool(_k32.QueryDosDeviceW(name, buf, len(buf))) or ctypes.get_last_error() == ERROR_INSUFFICIENT_BUFFER


def nt_open(device):
    h = _k32.CreateFileW(device, GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING, 0, None)
    if h is None or h == INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())
    return h


def nt_get_state(h):
    d = DCB(DCBlength=ctypes.sizeof(DCB))
    _ok(_k32.GetCommState(h, ctypes.byref(d)))
    return d


def nt_set_state(h, d):
    _ok(_k32.SetCommState(h, ctypes.byref(d)))


def nt_get_timeouts(h):
    t = COMMTIMEOUTS()
    _ok(_k32.GetCommTimeouts(h, ctypes.byref(t)))
    return t


def nt_set_timeouts(h, t):
    _ok(_k32.SetCommTimeouts(h, ctypes.byref(t)))


def nt_escape(h, func):
    _ok(_k32.EscapeCommFunction(h, func))


def nt_lines(h):
    """{'dtr', 'rts'} as the driver drives them, or None when it cannot report them."""
    v, got = wintypes.ULONG(), wintypes.DWORD()
    if not _k32.DeviceIoControl(h, IOCTL_SERIAL_GET_DTRRTS, None, 0, ctypes.byref(v), ctypes.sizeof(v),
                                ctypes.byref(got), None) or got.value < ctypes.sizeof(v):
        return None
    return {'dtr': bool(v.value & SERIAL_DTR_STATE), 'rts': bool(v.value & SERIAL_RTS_STATE)}


def nt_read(h, n):
    """Up to n bytes: what has arrived, waiting as the COMMTIMEOUTS say; b'' on a timeout."""
    buf, got = ctypes.create_string_buffer(n), wintypes.DWORD()
    _ok(_k32.ReadFile(h, buf, n, ctypes.byref(got), None))
    return buf.raw[:got.value]


def nt_close(h):
    _k32.CloseHandle(h)


def nt_raw(saved, baud, lines):
    """A copy of DCB saved set to raw 8N1 at baud without flow control, DTR/RTS held at lines (or,
    when the driver cannot report them, at the level saved's control mode leaves them idle)."""
    d = type(saved).from_buffer_copy(saved)
    d.BaudRate, d.ByteSize, d.Parity, d.StopBits = baud, 8, NOPARITY, ONESTOPBIT
    d.fBinary = 1
    d.fParity = d.fOutxCtsFlow = d.fOutxDsrFlow = d.fDsrSensitivity = 0
    d.fOutX = d.fInX = d.fErrorChar = d.fNull = d.fAbortOnError = 0
    if lines is None:
        lines = {'dtr': d.fDtrControl != DTR_CONTROL_DISABLE,
                 'rts': d.fRtsControl in (RTS_CONTROL_ENABLE, RTS_CONTROL_HANDSHAKE)}
    d.fDtrControl = DTR_CONTROL_ENABLE if lines['dtr'] else DTR_CONTROL_DISABLE
    d.fRtsControl = RTS_CONTROL_ENABLE if lines['rts'] else RTS_CONTROL_DISABLE
    return d


def marks(data, chunks, patterns):
    if not chunks:
        return []
    text = data.decode('latin-1')
    starts = [c['offset'] for c in chunks]
    out = []
    for pat in patterns:
        for m in itertools.islice(pat.finditer(text), MAX_MARKS):
            i = max(0, bisect.bisect_right(starts, m.start()) - 1)
            out.append({'pattern': pat.pattern, 'offset': m.start(), 't': chunks[i]['t'], 'text': m.group(0)})
    return out


def capture_posix(a, speed, out, times, result):
    def on_signal(signum, _frame):
        raise Stop(f'signal {signum}')

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, on_signal)
    fd, saved, errors = None, None, []
    chunks, size, ended = [], 0, 'time'
    try:
        fd = os.open(a.port, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
        t_open = time.monotonic()
        result['openedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
        saved = termios.tcgetattr(fd)
        tty.setraw(fd, termios.TCSANOW)
        attrs = termios.tcgetattr(fd)
        attrs[4] = attrs[5] = speed
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
        if a.lines == 'low':
            # after the baud: leaving B0 re-raises DTR, and RTS on ftdi (ftdi_sio.c, cdc-acm.c set_termios)
            try:
                fcntl.ioctl(fd, termios.TIOCMBIC, struct.pack('i', termios.TIOCM_DTR | termios.TIOCM_RTS))
            except OSError as e:
                raise OSError(e.errno, f'cannot clear DTR/RTS on this port ({e.strerror}); --lines low refused')
        result['lines'] = {'policy': a.lines, 'afterSetup': modem_lines(fd)}
        deadline = t_open + a.seconds
        while (left := deadline - time.monotonic()) > 0:
            ready, _, _ = select.select([fd], [], [], left)
            if not ready:
                continue
            try:
                chunk = os.read(fd, 4096)
            except BlockingIOError:
                continue
            except OSError as e:
                if e.errno not in (errno.EIO, errno.ENODEV, errno.ENXIO):
                    raise
                chunk = b''
            if not chunk:
                ended = 'device gone'
                break
            rec = {'t': round(time.monotonic() - t_open, 4), 'offset': size, 'len': len(chunk)}
            out.write(chunk)
            out.flush()
            times.write((json.dumps(rec) + '\n').encode())
            times.flush()
            chunks.append(rec)
            size += len(chunk)
    except Stop as e:
        ended = str(e)
    except (OSError, termios.error) as e:
        errors.append(f'{a.port}: {getattr(e, "strerror", None) or e}')
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, signal.SIG_IGN)
        if fd is not None:
            if saved is not None:
                try:
                    termios.tcsetattr(fd, termios.TCSANOW, saved)
                    result['terminalRestored'] = True
                except termios.error as e:
                    result['terminalRestored'] = False
                    errors.append(f'restoring the port settings: {e}')
            os.close(fd)
        for f in (out, times):
            try:
                f.close()
            except OSError as e:
                errors.append(f'closing {f.name}: {e}')
    return chunks, size, ended, errors


def capture_nt(a, speed, out, times, result):
    def on_signal(signum, _frame):
        raise Stop(f'signal {signum}')

    sigs = (signal.SIGINT, signal.SIGTERM, signal.SIGBREAK)    # SIGBREAK: Ctrl-Break
    for sig in sigs:
        signal.signal(sig, on_signal)
    h, saved, errors = None, None, []
    chunks, size, ended = [], 0, 'time'
    try:
        try:
            h = nt_open(result['device'])
        except OSError as e:
            if e.winerror not in (ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION):
                raise
            raise OSError(e.errno, 'busy: another program has the port open (Windows does not say which)')
        t_open = time.monotonic()
        result['openedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')
        saved = nt_get_state(h), nt_get_timeouts(h)
        nt_set_state(h, nt_raw(saved[0], speed, nt_lines(h)))
        if a.lines == 'low':
            # after SetCommState, which drives DTR/RTS as the DCB's control modes say
            try:
                nt_escape(h, CLRDTR)
                nt_escape(h, CLRRTS)
            except OSError as e:
                raise OSError(e.errno, f'cannot clear DTR/RTS on this port ({e.strerror}); --lines low refused')
        result['lines'] = {'policy': a.lines, 'afterSetup': nt_lines(h)}
        deadline, poll = t_open + a.seconds, None
        while (left := deadline - time.monotonic()) > 0:
            ms = max(1, min(READ_POLL_MS, math.ceil(left * 1000)))
            if ms != poll:
                # MAXDWORD/MAXDWORD/ms: ReadFile returns once bytes are there, or empty after ms
                t = COMMTIMEOUTS.from_buffer_copy(saved[1])
                t.ReadIntervalTimeout, t.ReadTotalTimeoutMultiplier, t.ReadTotalTimeoutConstant = MAXDWORD, MAXDWORD, ms
                nt_set_timeouts(h, t)
                poll = ms
            try:
                chunk = nt_read(h, 4096)
            except OSError as e:
                if e.winerror not in ERRORS_GONE:
                    raise
                ended = 'device gone'
                break
            if not chunk:
                continue
            rec = {'t': round(time.monotonic() - t_open, 4), 'offset': size, 'len': len(chunk)}
            out.write(chunk)
            out.flush()
            times.write((json.dumps(rec) + '\n').encode())
            times.flush()
            chunks.append(rec)
            size += len(chunk)
    except Stop as e:
        ended = str(e)
    except OSError as e:
        errors.append(f'{a.port}: {e.strerror or e}')
    finally:
        for sig in sigs:
            signal.signal(sig, signal.SIG_IGN)
        if h is not None:
            if saved is not None:
                result['terminalRestored'] = True
                for put, value in ((nt_set_state, saved[0]), (nt_set_timeouts, saved[1])):
                    try:
                        put(h, value)
                    except OSError as e:
                        result['terminalRestored'] = False
                        errors.append(f'restoring the port settings: {e}')
            nt_close(h)
        for f in (out, times):
            try:
                f.close()
            except OSError as e:
                errors.append(f'closing {f.name}: {e}')
    return chunks, size, ended, errors


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--port', required=True, help='/dev/serial/by-id/... or /dev/serial/by-path/...'
                   if termios else 'COM<n>')
    p.add_argument('--baud', required=True, type=int, help='baud rate, no default')
    p.add_argument('--seconds', required=True, type=float, help='capture length in seconds')
    p.add_argument('--lines', required=True, choices=['leave', 'low'],
                   help='DTR/RTS after the open: leave as opened, or clear both')
    p.add_argument('--out', required=True, help='new file for the bytes; <out>.times gets the chunk times')
    p.add_argument('--mark', action='append', default=[], metavar='REGEX',
                   help='report where this pattern occurs, with its time after the open (repeatable)')
    a = p.parse_args(argv)
    if termios is None:
        com = COM_PORT.fullmatch(a.port)
        if not com:
            p.error(f'--port {a.port}: name the port COM<n> on Windows')
        device = '\\\\.\\COM' + com.group(1)
        if not nt_port_exists(device[4:]):
            p.error(f'--port {a.port}: no such device')
    elif DRIFTING.fullmatch(a.port):
        p.error(f'--port {a.port}: ttyACM/ttyUSB numbers drift; name it by /dev/serial/by-id or by-path')
    elif not os.path.exists(a.port):
        p.error(f'--port {a.port}: no such device')
    speed = baud_constant(a.baud)
    if speed is None:
        p.error(f'--baud {a.baud}: not a rate this platform\'s termios offers' if termios else
                f'--baud {a.baud}: not a rate a DCB holds (1..{MAXDWORD})')
    if not (math.isfinite(a.seconds) and a.seconds > 0):
        p.error('--seconds must be a finite positive number')
    try:
        patterns = [re.compile(m) for m in a.mark]
    except re.error as e:
        p.error(f'--mark: {e}')
    times_path = a.out + '.times'
    files = []
    for path in (a.out, times_path):
        try:
            files.append(open(path, 'xb'))
        except OSError as e:
            for f in files:
                f.close()
                os.unlink(f.name)
            p.error(f'{path}: exists; a capture never overwrites' if isinstance(e, FileExistsError) else f'{path}: {e}')
    out, times = files
    if termios is not None:
        device = os.path.realpath(a.port)
    result = {'port': a.port, 'device': device, 'baud': a.baud, 'seconds': a.seconds, 'out': a.out, 'times': times_path}
    openers = other_openers(device) if termios else []
    if openers:
        result['otherOpeners'] = openers
    chunks, size, ended, errors = (capture_posix if termios else capture_nt)(a, speed, out, times, result)
    result.update(ended=ended, bytes=size, chunks=len(chunks),
                  firstByteAt=chunks[0]['t'] if chunks else None,
                  baseline='the open' if chunks else 'none: nothing was received')
    if patterns:
        try:
            with open(a.out, 'rb') as f:
                result['marks'] = marks(f.read(), chunks, patterns)
        except OSError as e:
            errors.append(f'reading {a.out} back for --mark: {e}')
    if errors:
        result['error'] = '; '.join(errors)
    print(json.dumps(result))
    return 3 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
