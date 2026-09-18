#!/usr/bin/env python3
"""Mechanics of the ataradov usb-sniffer: a bounded capture at the right link
speed, and the DUT's wire address out of a capture. Judgment (what to tap,
what a capture shows) is in SKILL.md.

    sniff.py capture OUT.pcapng --port 3-2.7 --seconds 30 --limit 3000000   # speed from sysfs
    sniff.py capture OUT.pcapng --speed hs --seconds 15 --fold               # explicit speed
    sniff.py addr CAP.pcapng                                                 # SET_ADDRESS values seen on the wire

capture always takes a wall-clock bound (--limit alone never ends on an idle bus
or an unfired trigger), refuses --speed and --port together, refuses a SuperSpeed
port (the sniffer is USB 2.0 only) and refuses while another usb_sniffer process
runs. It fails, keeping the file, when the tap showed no USB packet or the trigger
never fired: the sniffer's own records (line state, VBUS, trigger) say why. addr refuses a capture with no SET_ADDRESS and lists
every address when there are several: the caller picks the DUT."""
import argparse
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

SYSFS = Path('/sys/bus/usb/devices')
SPEEDS = {'1.5': 'ls', '12': 'fs', '480': 'hs'}


class Refused(Exception):
    pass


def port_speed(port, sysfs=SYSFS):
    """ls/fs/hs of the device at a sysfs port such as 3-2.7."""
    f = sysfs / port / 'speed'
    if not f.exists():
        raise Refused(f'no device at port {port} ({f} missing); see `lsusb -t`')
    speed = f.read_text().strip()
    if speed not in SPEEDS:
        raise Refused(f'port {port} runs at {speed} Mb/s; the sniffer captures USB 2.0 (ls/fs/hs) only')
    return SPEEDS[speed]


def tool(cmd, what, **kw):
    """Run a helper; a missing one is a refusal, not a traceback."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, **kw)
    except FileNotFoundError:
        raise Refused(f'{cmd[0]} not found ({what}); SKILL.md, Setup')


def running():
    """pids of usb_sniffer processes already capturing."""
    r = tool(['pgrep', '-x', 'usb_sniffer'], 'looking for a leftover capture')
    if r.returncode not in (0, 1):  # 1 is "no match"; anything else is pgrep itself failing
        raise Refused(f'pgrep failed ({r.returncode}): {r.stderr.strip()}')
    return r.stdout.split()


def contents(cap):
    """(USB packets, the sniffer's own records) of a capture: the records carry line
    state, VBUS and the trigger, and count as packets to every other tool."""
    r = tool(['tshark', '-r', str(cap), '-q', '-z', 'io,phs'], 'reading the capture')
    if r.returncode != 0:
        raise Refused(f'{cap} is not a readable capture: {r.stderr.strip()}')
    frames = {}
    for line in r.stdout.splitlines():
        name, _, rest = line.strip().partition(' ')
        if name in ('usbll', 'syslog') and 'frames:' in rest:
            frames[name] = int(rest.split('frames:')[1].split()[0])
    r = tool(['tshark', '-r', str(cap), '-Y', 'syslog', '-T', 'fields', '-e', 'syslog.msg'], 'reading the records')
    if r.returncode != 0:
        raise Refused(f'{cap}: tshark could not list the records: {r.stderr.strip()}')
    records = [l.strip() for l in r.stdout.splitlines() if l.strip()]
    if len(records) != frames.get('syslog', 0):
        raise Refused(f'{cap}: {frames.get("syslog", 0)} records counted but {len(records)} listed')
    return frames.get('usbll', 0), records


def terminated(signum, _frame):
    raise KeyboardInterrupt


def capture(a):
    if bool(a.speed) == bool(a.port):
        raise Refused('give exactly one of --speed and --port')
    if not 0 < a.seconds < float('inf'):
        raise Refused(f'--seconds must be positive and finite, got {a.seconds}')
    if a.limit is not None and a.limit <= 0:
        raise Refused(f'--limit must be positive, got {a.limit} (the tool counts down from it; 0 or less never stops)')
    if a.out.exists():
        raise Refused(f'{a.out} exists; a capture never overwrites, so a tool killed early cannot pass off the old file')
    for helper in ('usb_sniffer', 'editcap', 'tshark'):
        if shutil.which(helper) is None:
            raise Refused(f'{helper} not on PATH (SKILL.md, Setup)')
    pids = running()
    if pids:
        raise Refused(f'usb_sniffer already running (pid {" ".join(pids)}); a leftover capture, kill it first')
    speed = a.speed or port_speed(a.port)
    cmd = ['usb_sniffer', '--capture', '--fifo', str(a.out), '--speed', speed]
    if a.fold:
        cmd.append('--fold')
    if a.limit:
        cmd += ['--limit', str(a.limit)]
    if a.trigger:
        cmd += ['--trigger', a.trigger]
    print('+', ' '.join(cmd), f'(at most {a.seconds:g} s)', flush=True)
    # a TERM must take the tool down too: left alone it captures until the disk is full.
    # Blocked across the launch, so none can land between the child existing and `proc`
    # naming it; a pending one is delivered at the unblock, inside the protected region.
    signal.signal(signal.SIGTERM, terminated)
    stop = {signal.SIGTERM, signal.SIGINT}
    signal.pthread_sigmask(signal.SIG_BLOCK, stop)
    proc, rc, timed_out = None, None, False
    try:
        try:
            proc = subprocess.Popen(cmd, preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_UNBLOCK, stop))
        except OSError as e:
            raise Refused(f'cannot run usb_sniffer: {e}')
        signal.pthread_sigmask(signal.SIG_UNBLOCK, stop)
        try:
            rc = proc.wait(timeout=a.seconds)
        except subprocess.TimeoutExpired:
            timed_out = True
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, stop)
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait()
        signal.pthread_sigmask(signal.SIG_UNBLOCK, stop)   # one that waited is raised here, the tool gone
    if not timed_out and rc != 0:
        raise Refused(f'usb_sniffer exited {rc}')
    if not a.out.exists() or a.out.stat().st_size == 0:
        raise Refused(f'{a.out} is empty: the tool wrote nothing (is the sniffer plugged in?)')
    if timed_out:
        # The tool closes its file on no signal, so the time bound leaves it cut mid-packet
        # and every reader refuses it; editcap keeps the whole packets.
        fd, whole = tempfile.mkstemp(dir=a.out.parent, prefix=a.out.name + '.', suffix='.whole')
        os.close(fd)
        fixed = tool(['editcap', str(a.out), whole], 'keeping the whole packets')
        if fixed.returncode != 0:
            os.unlink(whole)
            raise Refused(f'{a.out} is cut short and editcap could not repair it: {fixed.stderr.strip()}')
        os.replace(whole, a.out)
    usb, records = contents(a.out)
    end = f'time bound {a.seconds:g} s' if timed_out else f'--limit {a.limit}' if a.limit else 'tool exit'
    print(f'{a.out}: {usb} USB packets, {len(records)} sniffer records, '
          f'{a.out.stat().st_size // 1024} KiB, speed {speed}, ended by {end}')
    if a.trigger and 'Starting capture' not in records:
        raise Refused(f'--trigger {a.trigger} never fired within {a.seconds:g} s ({a.out} kept: '
                      f'{"; ".join(records) or "no records"})')
    if not usb:
        raise Refused(f'no USB packets on the tap ({a.out} kept, records: {"; ".join(records[-8:]) or "none"}) - '
                      f'wrong --speed, or no device pulling up the tapped segment')


def set_addresses(tshark_fields):
    """{address: [frame numbers]} from 'frame<TAB>device' lines of the SET_ADDRESS filter (Wireshark
    dissects SET_ADDRESS's wValue as usb.device_address)."""
    seen = {}
    for line in tshark_fields.splitlines():
        frame, _, value = line.partition('\t')
        if value.strip():
            seen.setdefault(int(value, 0), []).append(int(frame))
    return seen


def addr_filter(address):
    """Display filter for one device's traffic; `contains "9."` would also match 19., 29., ..."""
    return f'usbll.src matches "^{address}[.]" || usbll.dst matches "^{address}[.]"'


def addr(a):
    r = tool(['tshark', '-r', str(a.cap), '-Y', 'usb.setup.bRequest == 5 && usb.bmRequestType == 0x00',
              '-T', 'fields', '-e', 'frame.number', '-e', 'usb.device_address'], 'reading the capture')
    if r.returncode != 0:
        raise Refused(f'tshark failed: {r.stderr.strip()}')
    seen = set_addresses(r.stdout)
    if not seen:
        raise Refused('no SET_ADDRESS in the capture: it started after enumeration, or the DUT is not on the tap')
    for address, frames in sorted(seen.items()):
        print(f'{address}\tframes {", ".join(map(str, frames))}\tfilter: {addr_filter(address)}')
    if len(seen) > 1:
        print(f'{len(seen)} devices enumerated on the tap; pick the DUT by frame order', file=sys.stderr)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('capture', help='bounded capture into a pcapng')
    c.add_argument('out', type=Path)
    c.add_argument('--speed', choices=['ls', 'fs', 'hs'], help='link speed of the tapped segment')
    c.add_argument('--port', help='sysfs port of the tapped device (3-2.7): its speed picks --speed')
    c.add_argument('--limit', type=int, help='stop after N packets (the tool exits by itself)')
    c.add_argument('--seconds', type=float, required=True,
                   help='wall-clock bound: the tool is killed after S seconds, armed or capturing')
    c.add_argument('--fold', action='store_true', help='fold empty frames')
    c.add_argument('--trigger', choices=['low', 'high', 'falling', 'rising'], help='arm on the external trigger pin')
    d = sub.add_parser('addr', help='SET_ADDRESS values seen in a capture')
    d.add_argument('cap', type=Path)
    a = p.parse_args()
    if not sys.platform.startswith('linux'):
        sys.exit(f'sniff.py is Linux-only (usbfs, signals); this is {sys.platform}')
    try:
        (capture if a.cmd == 'capture' else addr)(a)
        return 0
    except Refused as e:
        print(f'sniff: {e}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('sniff: interrupted; the tool was stopped, a partial capture may remain', file=sys.stderr)
        return 130


if __name__ == '__main__':
    sys.exit(main())
