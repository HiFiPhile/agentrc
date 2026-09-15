#!/usr/bin/env python3
"""Where does the core spin? Sample DWT_PCSR over a J-Link without halting and
histogram the PCs by function (the target-debug skill's PC-sampling technique).

  pc_sample.py --probe <serial> --device <JLINK_DEVICE> --elf <flashed.elf> [--samples N]

Reads DHCSR before and after the samples so a 0xFFFFFFFF sample (core halted or
in WFI) can be read against the core's state. A capture is complete only when
every requested sample and both DHCSR reads came back: JLinkExe exits 0 after a
failed command, so the output is the evidence, not the exit code.
"""
import argparse
import collections
import math
import os
import re
import shutil
import subprocess
import sys

DWT_PCSR = 0xE000101C
DHCSR = 0xE000EDF0
SENTINEL = 0xFFFFFFFF
# "E000101C = 20000ABC" — JLinkExe may prefix the line with its "J-Link>" prompt
_MEM32_RE = re.compile(r'([0-9A-Fa-f]{8}) = ([0-9A-Fa-f]{8})')


class ToolError(RuntimeError):
    pass


def jlink_script(samples, interval_ms):
    lines = [f'mem32 {DHCSR:X}, 1']
    for _ in range(samples):
        lines.append(f'mem32 {DWT_PCSR:X}, 1')
        if interval_ms:
            lines.append(f'Sleep {interval_ms}')
    lines += [f'mem32 {DHCSR:X}, 1', 'qc']
    return '\n'.join(lines) + '\n'


def parse_reads(text):
    """(pcs, dhcsr) from JLinkExe output: every DWT_PCSR value in order and every
    DHCSR value in order."""
    pcs, dhcsr = [], []
    for m in _MEM32_RE.finditer(text):
        addr, val = int(m.group(1), 16), int(m.group(2), 16)
        if addr == DWT_PCSR:
            pcs.append(val)
        elif addr == DHCSR:
            dhcsr.append(val)
    return pcs, dhcsr


def sample(probe, device, samples, interval_ms, speed, timeout):
    exe = shutil.which('JLinkExe')
    if not exe:
        raise ToolError('JLinkExe not on PATH')
    cmd = [exe, '-device', device, '-SelectEmuBySN', probe, '-if', 'swd', '-speed', str(speed),
           '-autoconnect', '1', '-nogui', '1']
    try:
        r = subprocess.run(cmd, input=jlink_script(samples, interval_ms), capture_output=True,
                           text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise ToolError(f'JLinkExe did not finish within {timeout:.0f} s') from e
    pcs, dhcsr = parse_reads(r.stdout)
    if len(pcs) != samples or len(dhcsr) != 2:
        tail = '\n'.join((r.stdout + r.stderr).strip().splitlines()[-6:])
        raise ToolError(f'incomplete capture: {len(pcs)}/{samples} samples, {len(dhcsr)}/2 DHCSR reads '
                        f'(exit {r.returncode}); last output:\n{tail}')
    return pcs, dhcsr


def symbolize(addr2line, elf, pcs, timeout):
    """{pc: (func, 'file:line')} for the given PCs; a PC addr2line cannot place is ('??', '')."""
    if not pcs:
        return {}
    exe = shutil.which(addr2line)
    if not exe:
        raise ToolError(f'{addr2line} not on PATH')
    cmd = [exe, '-e', elf, '-f', '-C'] + [f'0x{pc:08x}' for pc in pcs]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise ToolError(f'{addr2line} did not finish within {timeout:.0f} s') from e
    if r.returncode != 0:
        raise ToolError(f'{addr2line} failed: {r.stderr.strip() or r.stdout.strip()}')
    lines = r.stdout.splitlines()
    if len(lines) != 2 * len(pcs):
        raise ToolError(f'{addr2line} returned {len(lines)} lines for {len(pcs)} addresses')
    out = {}
    for i, pc in enumerate(pcs):
        func, loc = lines[2 * i].strip(), lines[2 * i + 1].strip()
        out[pc] = ('??', '') if func.startswith('??') else (func, loc)
    return out


def report(pcs, dhcsr, symbols, top, out=sys.stdout):
    """Histogram by function (a spin loop is several PCs), each with its PC sites."""
    usable = [pc for pc in pcs if pc not in (0, SENTINEL)]
    sentinel = sum(1 for pc in pcs if pc == SENTINEL)
    no_pcsr = sum(1 for pc in pcs if pc == 0)
    by_pc = collections.Counter(usable)
    by_func = collections.Counter()
    sites = collections.defaultdict(list)
    for pc, n in by_pc.items():
        func, loc = symbols.get(pc, ('??', ''))
        by_func[func] += n
        sites[func].append((n, pc, loc))
    unresolved = by_func['??']
    print(f'{len(usable)} usable of {len(pcs)} samples', file=out)
    for func, n in by_func.most_common(top):
        print(f'{n:6d} {100 * n / len(usable):5.1f}%  {func}', file=out)
        for m, pc, loc in sorted(sites[func], reverse=True)[:4]:
            print(f'{"":6} {m:6d}    0x{pc:08x}  {loc}', file=out)
    print(f'sentinel 0xFFFFFFFF (halted or WFI): {sentinel}', file=out)
    print(f'no PCSR (0): {no_pcsr}', file=out)
    print(f'unresolved symbols: {unresolved}', file=out)
    for when, v in zip(('before', 'after'), dhcsr):
        halt = 'halted' if v & (1 << 17) else 'running'
        print(f'DHCSR {when}: 0x{v:08x} ({halt}{", reset since last read" if v & (1 << 25) else ""})',
              file=out)
    return len(usable)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--probe', required=True, help='J-Link serial (rigs run several probes)')
    p.add_argument('--device', required=True, help='J-Link device name')
    p.add_argument('--elf', required=True, help='the flashed firmware ELF, for symbols')
    p.add_argument('--samples', type=int, default=300, help='DWT_PCSR reads (default 300)')
    p.add_argument('--interval-ms', type=int, default=0,
                   help='JLinkExe Sleep between reads, milliseconds (default 0: back to back)')
    p.add_argument('--speed', type=int, default=4000, help='SWD clock in kHz (default 4000)')
    p.add_argument('--timeout', type=float, help='bound on each tool run in seconds '
                   '(default: samples x (interval + 50 ms) + 20 s)')
    p.add_argument('--top', type=int, default=15, help='histogram rows (default 15)')
    p.add_argument('--raw', help='also write every sampled PC, one hex value per line')
    p.add_argument('--addr2line', default='arm-none-eabi-addr2line', help='symbolizer (default arm-none-eabi-addr2line)')
    a = p.parse_args(argv)
    if a.samples <= 0 or a.interval_ms < 0 or a.speed <= 0 or a.top <= 0:
        p.error('--samples, --speed and --top must be positive, --interval-ms non-negative')
    if a.timeout is not None and not (math.isfinite(a.timeout) and a.timeout > 0):
        p.error('--timeout must be a finite positive number of seconds')
    if not os.path.isfile(a.elf):
        p.error(f'ELF not found: {a.elf}')
    timeout = a.timeout if a.timeout is not None else a.samples * (a.interval_ms + 50) / 1000 + 20
    try:
        pcs, dhcsr = sample(a.probe, a.device, a.samples, a.interval_ms, a.speed, timeout)
        if a.raw:
            with open(a.raw, 'w') as f:
                f.writelines(f'{pc:08x}\n' for pc in pcs)
        symbols = symbolize(a.addr2line, a.elf, sorted({pc for pc in pcs if pc not in (0, SENTINEL)}), timeout)
    except ToolError as e:
        print(f'error: {e}', file=sys.stderr)
        return 1
    usable = report(pcs, dhcsr, symbols, a.top)
    if not usable:
        print('error: no usable sample (core halted, asleep, or no DWT_PCSR on this core)', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
