---
name: target-debug
description: Use when firmware misbehaves on real hardware and the firmware's own state must explain it — a device that wedges, STALLs, NAKs forever, drops data, an endpoint stuck busy, a HardFault, a stuck ISR, a spinning core. Target-side evidence over a debug probe: logs, GDB autopsy, RAM trace, PC-sampling, SWO.
---

# target-debug — target-side capture & debugging over a debug probe

The **target** is the MCU running the code under test. The methods here work
for any firmware on a debug probe; the worked cases are USB stacks (device
role, host role, or both), where the link peer is not always a Linux PC: an MCU
host may face another board or a Linux gadget (e.g. a Raspberry Pi).

## Which skill answers what

| Skill                | Answers                                                          | Needs                                                   |
|----------------------|------------------------------------------------------------------|---------------------------------------------------------|
| **`target-debug`**   | **what the target did** (driver state, faults, where the core spins) | a debug probe on the target                        |
| `rtt`                | the target's log/console stream, and a post-mortem ring dump     | a probe, firmware that logs over SEGGER RTT             |
| `esp-target-debug`   | the same methods on Espressif's built-in USB-JTAG                | an ESP32-S3/P4 — read it FIRST there: other gdb, other openocd |
| `etm-trace`          | exactly which instructions ran (profile, coverage, history)      | a SEGGER J-Trace wired to the trace header — confirm with the user |
| `usb-sniffer`        | what crossed the wire (PIDs, handshakes, resets)                 | the hardware tap cabled in; role-agnostic               |
| `usb-kernel-debug`   | what a Linux host exchanged (usbmon URBs) and why its kernel acted (dynamic debug) | Linux on either end: PC host or gadget peer |

## What the project supplies

These skills know probes, not projects. Three things come from the project, and
none of them is ever guessed:

- **How to build a debug variant** (logging over RTT, trace init, where the ELF
  lands, the J-Link device name or OpenOCD config of a board): the project's
  `Build contract:` line in its `CLAUDE.md` names the skill or document that
  says. No contract: use the ELF and device/config the caller gave, and ask for
  what is missing.
- **How to take a rig board**: the project's `HIL contract:` line names its rig
  skill, which owns lock and release and says which HIL config json describes
  the host you are on. No contract: follow the procedure the caller gave; on a
  shared rig with none, ask before touching a board.
- **What its symbols and symptoms mean**: kept here, in `projects/`, for the
  projects this skill has been used on — see "Project notes" at the end.

A HIL config json maps board → probe, and `rtt.py` and `pc_sample.py` read it
directly (`--hil-config <file> --board <name>`; a flag given as well must agree):

| `flasher` field | Means | Becomes |
|---|---|---|
| `name` | how the rig flashes: `jlink`, `openocd`, `stlink` are probe routes; `esptool`, `lm4flash` are refused: they name no debug probe | the backend (`stlink` → openocd, and then `--cfg` is yours to give) |
| `uid` | the probe's serial | `--probe` |
| `args` | jlink: exactly `-device <name>`; openocd: its `-f`/`-c` arguments | `--device`, or `--cfg` whole |
| `vid_pid` | the probe model's USB IDs, openocd only | `--vid-pid` |

A J-Link entry supplies neither interface nor speed. On the J-Link route `--interface` and
`--speed` stay explicit; on the OpenOCD route they live inside `--cfg` and the two
flags are refused. `pc_sample.py` takes J-Link entries only. `etm_capture.py` does not read it — a J-Trace is one probe moved
between boards, named with `--probe`.

## Delegated sessions

When an agent dispatches this work (chief's `hw-validator` and `hw-debugger`
units), the prompt is the scope and these rules bind the unit; its role file
adds only what it may edit and when it stops.

- **Scope.** Stay within the prompt's board, operations and source paths;
  resolve the build and access through the project's contracts or the ELF,
  device/config and procedure it supplies. A missing technical input returns
  `blocked`, a missing authorization or human action `needs-user`, instead of
  waiting for an answer.
- **Identity.** Verify worktree, branch and HEAD, then board, probe serial and
  host against the prompt, or the probe against the HIL config entry it names,
  before acting.
- **Lock.** Hold the board lock for the whole hardware phase; a refused hold
  allows retries within the prompt's lock-wait budget, then `blocked` with the
  holder. A reproducer that takes the lock itself (tinyusb's `hil_test.py`)
  never runs under your hold and its guard is never bypassed: resolve the
  equivalent manual steps through the HIL contract, or return `blocked`.
- **Builds.** Through the build contract into a private build directory,
  leaving firmware staged for HIL untouched; save the pristine restoration
  artifact before changing the target. Tracked paths a build may rewrite are
  in the prompt's temporary scope, or reported before building.
- **Instrumentation.** Only the listed paths, from a clean checkout,
  uncommitted, each diff saved as a patch in the artifact directory. From a
  previous unit's dirty state (a recovery prompt): inspect the recorded patch
  and current changes first, restore only what is attributable to it, report
  ambiguous ownership untouched.
- **Observation.** Stay within the prompt's observation window and repetition
  budget; every attempted reproducer counts toward it, including failed or
  truncated captures. An early decisive observation may settle the claim;
  otherwise a shortened capture is partial evidence and cannot establish a
  pass that needs the full exposure. Anchor every
  state reading with the backend's validity check (Cortex-M: DHCSR) and record
  whether attaching halted or reset the target; a post-reset snapshot is never
  the failure state.
- **Host.** Leave the host as found: never clear kernel logs (`dmesg -C`) or
  other shared history, and restore every setting you change (dynamic debug,
  module parameters).
- **Budget.** Stop starting experiments when the remaining time cannot cover
  the experiment plus cleanup; never cut a restoration short for the deadline,
  report the overrun.
- **Cleanup, before releasing the lock.** Stop owned capture and debug clients
  before opening the restoration flasher, dispose of the source as your role
  says, reflash the pristine artifact and verify its programmed contents with
  the backend's procedure (the artifact hash recorded apart from that
  result), close the flasher, restore host settings, release the lock. Do
  only the cleanup your own actions or the explicitly assigned recovery state
  call for, establishing ownership before restoring a predecessor's state.
  Blocked before touching hardware with no recovery state assigned, the
  untouched actions are `n-a`, nothing is flashed and another holder's lock
  stays. If restoration cannot complete, keep the lock where
  you can, report the exact remaining source, firmware, process and lock
  state, and do not call the board ready.
- **Return.** The tested firmware identity, decisive observations, artifact
  locations, cleanup state and budget used; sampling done by hand on a native
  probe comes back with its command, and the limits name only what was
  actually unavailable.

## Rig discipline — lock first, always

On a shared rig, hold the project's board lock for the WHOLE manual session
(instrument, build, flash, capture, GDB) and never stop its CI runner. Rigs and
benches run many identical probes:

- Select the probe by serial: J-Link `-SelectEmuBySN <uid>`, its GDB server
  `-select usb=<uid>`, OpenOCD `-c 'adapter serial <uid>'`.
- Run on the host that owns the probe.
- One probe serves one client: quit JLinkExe before starting JLinkGDBServer on
  the same probe.

## Pick the least intrusive technique that can answer the question

Observation can mask the bug: one can change behavior under logging *and* under
the debugger. If the bug disappears when instrumented,
that IS a finding (timing-sensitive): move down in intrusiveness, not up.

| Technique                          | Intrusiveness                  | Reach for it when                                       |
|------------------------------------|--------------------------------|---------------------------------------------------------|
| PC-sampling                        | none — no halt, no code change | core wedged/spinning somewhere unknown                  |
| SWO exception trace / hw PC-sample | none — needs SWO pin wired     | ISR ordering/timing with zero code change               |
| DWT data trace                     | none — needs SWO pin wired     | stream one address's accesses: value + accessor PC      |
| Vector catch                       | none until a fault fires       | crash-shaped wedges — autopsy AT the faulting pc        |
| RAM ring-buffer                    | ~tens of cycles per event      | ISR ordering/timing bugs                                |
| Log lines (RTT)                    | µs per line                    | logic bugs that survive logging (J-Link or OpenOCD rtt) |
| Log lines (UART)                   | ms per line — blocking write   | same, when no debug-probe RTT path                      |
| dprintf / conditional breakpoint   | halt+resume per hit (~ms)      | low-rate probes post-wedge; never ISR-rate events       |
| GDB halt / breakpoints             | stops USB service entirely     | post-mortem state autopsy once wedged                   |

SWO exception trace and DWT data trace: `swo-dwt.md`. Vector catch and the fault
registers: `fault-autopsy.md`. GDB servers, OpenOCD batch sessions, the hardware
breakpoint budget, watchpoints, dprintf, FreeRTOS threads: `gdb.md` (all beside
this file).

## PC-sampling — where the core spins, without halting

`DWT_PCSR` (0xE000101C) returns the current PC on every read, target running
(Cortex-M3+; optional on M0+, reads 0 if absent; 0xFFFFFFFF = core halted or
WFI-asleep — `mem32 E000EDF0, 1`, DHCSR bit 17 S_HALT, tells which):

```bash
python3 <skill dir>/scripts/pc_sample.py --probe <uid> --device <JLINK_DEVICE> --interface swd --speed 4000 --elf <flashed.elf>
#   or: --hil-config <file> --board <name> --interface swd --speed 4000 --elf <flashed.elf>
#   --samples N (300), --interval-ms M, --raw FILE; DHCSR is read before and after,
#   sentinel and no-PCSR samples are counted apart; exit 1 unless every sample came back
```

The histogram's top entries are the spin site; a flat histogram = core is
servicing normally — and an idle loop has a hot spot of its own: learn it from a
healthy run before reading a wedged one. A core halted from a JLinkExe session is
running again once that session exits (Commander restores the run state it found;
seen 2026-09-18 on RP2350), so the sentinel means the target halted or slept by
itself. Native probes (ST-Link/CMSIS-DAP) are
not covered by the script yet: repeat `mdw 0xE000101C` over OpenOCD's telnet
:4444 by hand.

## RAM ring-buffer trace

The zero-print instrument: a small event ring in the
driver under suspicion, dumped over GDB after the failure. Single-writer (ISR) — no locking:

```c
typedef struct { uint16_t ev; uint16_t a; uint32_t b; } dbg_ev_t;
#define DBG_N 512                          // power of two
static volatile dbg_ev_t dbg_ring[DBG_N];  // volatile REQUIRED: -Os dead-store-
static volatile uint32_t dbg_wr;           // eliminates a write-only static array
static inline void DBG_EV(uint16_t ev, uint16_t a, uint32_t b) {
  uint32_t i = dbg_wr++;
  dbg_ring[i & (DBG_N - 1)] = (dbg_ev_t){ ev, a, b };
}
// call sites: DBG_EV(__LINE__, ep_addr, count);  — __LINE__ as event id
```

After building, `nm` the ELF for `dbg_ring`/`dbg_wr` — if they're missing the
compiler deleted your instrument and the run will "reproduce" with an empty ring.

Order is the index; if durations matter add a `uint32_t t = DWT->CYCCNT` field
(enable once: `CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk; DWT->CTRL |= 1;`
RISC-V: read `mcycle`). Let the failure happen, halt, then:

```gdb
p dbg_wr                          # total events; oldest slot = dbg_wr & (DBG_N-1) once wrapped
p dbg_ring
dump binary memory /tmp/ring.bin &dbg_ring[0] &dbg_ring[512]
```

## Log capture

Build with the stack's moderate log level (the verbose one adds per-transfer
noise and much more timing skew) and route it over RTT when the probe allows
— no UART wiring (the flags are the project's build contract). Stand the channel up
per the **rtt** skill (servers per probe, transport matrix, control-block
gotchas live there):

```bash
# RTT (J-Link probe; flash + reset first — the console owns the probe):
python3 <rtt skill dir>/scripts/rtt.py --backend jlink --probe <sn> --device <JLINK_DEVICE> --interface swd --speed auto --seconds 20 > /tmp/rtt.log
# UART (board's debug serial, if wired):
stty -F /dev/ttyACM<N> 115200 raw && timeout 20s cat /dev/ttyACM<N> | tee /tmp/uart.log
```

OpenOCD RTT (native probes: ST-Link/CMSIS-DAP): rtt skill §OpenOCD — exact
CB address from `nm`, attach-only. OpenOCD polls — bursty logs can drop
lines; prefer J-Link where both exist. The drain-model warning below
applies unchanged.

A wedged RTT build holds a log tail in RAM only if a live drain was running
(the default mode drops writes once the ring fills): the drain model, the
headless-proven server and the manual ring read are the **rtt** skill's
post-mortem section. Otherwise instrument with the RAM ring above.

## USB: dual-side capture — the default for enumeration/transfer bugs

Capture both ends at once: usbmon plus a target channel when a Linux PC is the
host; an MCU host has no usbmon on either end, so target channel plus the wire
(`usb-sniffer`), plus `usb-kernel-debug` on a Linux gadget peer. Start both
channels, then trigger the failing test (Linux-PC-host shown;
MCU host: swap usbmon for `usb-sniffer`, + `usb-kernel-debug` on a Linux
gadget peer):

```bash
<usb-kernel-debug skill dir>/scripts/usbcap.py <bus> 30 /tmp/host.pcapng & cap=$!   # host URBs; the board's bus — a VID: selector spanning buses is refused
python3 <rtt skill dir>/scripts/rtt.py --backend jlink --probe <sn> --device <dev> --interface swd --speed auto --seconds 30 > /tmp/target.rtt & rtt=$!  # target (rtt skill; or ring dump after)
wait $cap; rc_cap=$?; wait $rtt; rc_rtt=$?   # `wait $cap && wait $rtt` would skip the rtt wait when cap failed
[ $rc_cap -eq 0 ] && [ $rc_rtt -eq 0 ]       # a bare `wait` returns 0 even when one side failed
```

RTT lines and ring events carry no wall-clock: correlate on unambiguous
anchors — bus reset, SET_ADDRESS, the first transfer on the failing EP — then
lay device events between anchors in host-URB order. Logging the SOF/frame
number on the target gives a shared clock when you need finer alignment.
When host and target evidence disagree, or the host sees nothing at all, add
the wire itself: `usb-sniffer` skill (hardware tap, PID-level).

## Manuals

- J-Link (UM08001): <https://kb.segger.com/UM08001_J-Link_/_J-Trace_User_Guide> — flash breakpoints, RTT, SWO, monitor mode, Commander.
- OpenOCD: <https://openocd.org/doc/html/index.html> — `rtt`, `bp`/`wp`, `cortex_m vector_catch`/`maskisr`, `itm`/`tpiu`.
- "Debugging with GDB" (§5.1 = break/watch/dprintf): Tenth Edition (GDB 18)
  via the `read-doc` skill, or
  `curl -sL -o /tmp/gdb.pdf https://sourceware.org/gdb/current/onlinedocs/gdb.pdf`
  (the HTML mirror blocks fetchers). Installed `arm-none-eabi-gdb`
  `help <cmd>` is authoritative here.

## Warnings

- **Halting/resetting via the probe does NOT disconnect the device**: a DWC2
  soft-connect pullup stays up through core halt *and* reset, so the host's
  stuck URBs stay stuck and a wedged DUT stays wedged — recover the Linux
  host side (the rig's own procedure; its HIL contract names it).
- **A bug that vanishes under logging is a timing bug**, not fixed: switch to
  the ring buffer; if it vanishes under GDB too, PC-sampling only.
- **UART logging blocks in the write path** (worst perturbation, including
  inside the ISR); RTT is much cheaper but not free; verbose logging multiplies both.
- Flash/GDB only with the board lock held; a hold refused because CI is
  mid-test on that board means wait, don't force.
- **Instrumentation is temporary**: before `release`, reflash pristine
  firmware (the next CI run must not inherit a debug build) and revert the
  instrumentation diff. Handing the diff over with the diagnosis preserves the
  evidence; it does not count as cleanup.
- **A register snapshot without a validity anchor lies**: J-Link tool sessions
  can reset or briefly halt the DUT as a side effect, and a snapshot of a
  freshly-reset chip (e.g. NVIC ISER = 0) reads like a smoking gun. Read DHCSR
  (0xE000EDF0: bit 17 S_HALT, bit 25 S_RESET_ST) with every snapshot, and
  cross-check against something the device demonstrably still does.
- **"Flash OK" can lie** (silent no-op — old firmware keeps running). When
  behavior contradicts the flashed code: `objcopy -O binary fw.elf
  /tmp/fw.bin`, then `verifybin /tmp/fw.bin,<flash-base>` (J-Link, verified)
  or `verify_image` (OpenOCD); on mismatch reflash before debugging further.
- **A marginal link can fake a deterministic firmware bug** — down to failing
  the same test at the same iteration twice. "USB disconnect" in dmesg on a
  freshly re-cabled port (high devnum = churn) means the plug, not the code:
  first sustained bulk traffic is when a bad contact drops. Before declaring a
  regression, re-run the OLD build on the SAME link state — and if a bisect
  exonerates every hunk, believe it: re-test the exact failing binary.

## Project notes

Symbols, symptom tables and gotchas of the projects these skills have been used
on, one file each, for all six skills. Match the project by its repository
identity (`git remote get-url origin`), not by a directory name:

| Repository | Notes |
|---|---|
| `hathach/tinyusb` | `projects/tinyusb.md` |

Every entry there says how it is known (verified when, on which revision and
board, how — or only carried over). Check a symbol exists in the checkout in
front of you before relying on it. When a session establishes something
reusable about a project — reproduced, or read in its source — add it with
the same evidence, or correct the entry it contradicts; leave out the session's
chronology and dead ends. A project with no file: work from its source, and
start one when there is something worth keeping.
