// Deterministic workload for SWO trace checks: timer interrupts at known rates, a nested interrupt per TIM7 tick,
// one variable with a known access pattern, ITM stimulus with known bytes, and busy/idle phases.
// A probe-side tool enables ITM/DWT; without it the fixture runs the same and counts the stimulus it skipped.
// TIM6 and TIM7 name the two workload timers: STM32 basic timers TIM6/TIM7, on RA the 32-bit GPT0/GPT1.

#include <stdio.h>
#include <string.h>
#include "bsp/board_api.h"

#if CFG_TUSB_MCU == OPT_MCU_STM32F4
  #include "stm32f4xx_hal.h"
#elif CFG_TUSB_MCU == OPT_MCU_STM32H7
  #include "stm32h7xx_hal.h"
#elif CFG_TUSB_MCU == OPT_MCU_RAXXX
  // FSP's headers test undefined macros and use old-style prototypes, as the BSP's family.c allows
  #pragma GCC diagnostic push
  #pragma GCC diagnostic ignored "-Wstrict-prototypes"
  #pragma GCC diagnostic ignored "-Wundef"
  #include "bsp_api.h"
  #pragma GCC diagnostic pop
#else
  #error "SWO fixture supports stm32f4, stm32h7 and ra only"
#endif

#define SWO_FIXTURE_TIM6_HZ   1000u
#define SWO_FIXTURE_TIM7_HZ   100u
#define SWO_FIXTURE_BUSY_MS   100u
#define SWO_FIXTURE_IDLE_MS   100u
#define SWO_FIXTURE_ITM_SPIN  10000u  // FIFOREADY polls before a stimulus write is skipped

// Within each 1 ms SysTick period, every trace burst drains before the next one starts, even at a 1.5 MHz SWO
// with local timestamps (about 6.7 us per byte): SysTick at 0, TIM7's episode at 250-550 us every 10th period,
// TIM6 at 700 us, the ITM marker at 150 us of a period without TIM7. A packet arriving while the ITM is still
// sending is dropped as an overflow.
#define SWO_FIXTURE_TIM7_AT_US   250u
#define SWO_FIXTURE_GAP_US       150u  // around the nested interrupt in TIM7's episode
#define SWO_FIXTURE_TIM6_AT_US   700u
#define SWO_FIXTURE_MARKER_AT_US 150u

enum {
  ITM_PORT_TEXT = 1, // "swo-fixture <phase>\n" in 32-bit writes, its tail in 8-bit ones
  ITM_PORT_WORDS = 2 // per phase: 32-bit phase, 16-bit 0xA55A, 8-bit 0x7E
};

// Counters of one phase; a debug probe reads swo_fixture_last for the phase it captured
typedef struct {
  uint32_t phase;
  uint32_t tim6_count;   // timer interrupts at SWO_FIXTURE_TIM6_HZ
  uint32_t tim7_count;   // timer interrupts at SWO_FIXTURE_TIM7_HZ, each pends one nested interrupt
  uint32_t nested_count; // nested interrupts, entered inside a TIM7 handler
  uint32_t var_writes;   // writes of swo_fixture_var
  uint32_t var_reads;    // reads of swo_fixture_var
  uint32_t itm_sent;     // ITM stimulus writes made
  uint32_t itm_skipped;  // ITM stimulus writes dropped: ITM or the port disabled, or the FIFO stayed full
} swo_fixture_stats_t;

volatile uint32_t swo_fixture_var;
volatile swo_fixture_stats_t swo_fixture_cur;
volatile swo_fixture_stats_t swo_fixture_last;
volatile uint32_t swo_fixture_timclk_hz;

//--------------------------------------------------------------------+
// Interrupts: NESTED preempts TIM6 preempts TIM7
//--------------------------------------------------------------------+
static uint32_t tim7_us(void);

static void tim6_tick(void) {
  swo_fixture_cur.tim6_count++;
  swo_fixture_var = swo_fixture_cur.tim6_count;
  swo_fixture_cur.var_writes++;
}

static void wait_tim7_us(uint32_t us) {
  uint32_t const start = tim7_us();
  while (tim7_us() - start < us) {}
}

static void tim7_tick(IRQn_Type nested) {
  swo_fixture_cur.tim7_count++;
  (void) swo_fixture_var;
  swo_fixture_cur.var_reads++;
  wait_tim7_us(SWO_FIXTURE_GAP_US);
  NVIC_SetPendingIRQ(nested);
  __DSB();
  __ISB();
  wait_tim7_us(SWO_FIXTURE_GAP_US);
}

static void nested_tick(void) {
  swo_fixture_cur.nested_count++;
}

//--------------------------------------------------------------------+
// Timers, per family: each counts microseconds since its last update, its first update first_us after the start
//--------------------------------------------------------------------+
#if CFG_TUSB_MCU == OPT_MCU_STM32F4 || CFG_TUSB_MCU == OPT_MCU_STM32H7

#define TRACE_ENABLED() (CoreDebug->DEMCR & CoreDebug_DEMCR_TRCENA_Msk)

// nested interrupt: TIM8_TRG_COM_TIM14 is pended from the TIM7 handler only, its peripherals stay off
#define NESTED_IRQn TIM8_TRG_COM_TIM14_IRQn

void TIM6_DAC_IRQHandler(void);
void TIM7_IRQHandler(void);
void TIM8_TRG_COM_TIM14_IRQHandler(void);

void TIM6_DAC_IRQHandler(void) {
  TIM6->SR = ~TIM_SR_UIF;
  tim6_tick();
}

void TIM7_IRQHandler(void) {
  TIM7->SR = ~TIM_SR_UIF;
  tim7_tick(NESTED_IRQn);
}

void TIM8_TRG_COM_TIM14_IRQHandler(void) {
  nested_tick();
}

static uint32_t tim6_us(void) {
  return TIM6->CNT;
}

static uint32_t tim7_us(void) {
  return TIM7->CNT;
}

// Timer kernel clock: PCLK1 when the APB1 prescaler is 1, else 2 x PCLK1 (RM0090 RCC clocks; RM0433 Table 57, TIMPRE=0)
static uint32_t timer_clock_hz(void) {
  uint32_t const pclk1 = HAL_RCC_GetPCLK1Freq();
#if CFG_TUSB_MCU == OPT_MCU_STM32F4
  bool const apb1_div1 = (RCC->CFGR & RCC_CFGR_PPRE1) == RCC_CFGR_PPRE1_DIV1;
#else
  bool const apb1_div1 = (RCC->D2CFGR & RCC_D2CFGR_D2PPRE1) == RCC_D2CFGR_D2PPRE1_DIV1;
#endif
  return apb1_div1 ? pclk1 : 2 * pclk1;
}

static void timer_start(TIM_TypeDef* tim, IRQn_Type irq, uint32_t hz, uint32_t first_us, uint32_t priority) {
  tim->PSC = swo_fixture_timclk_hz / 1000000u - 1; // 1 MHz count
  tim->ARR = 1000000u / hz - 1;
  tim->EGR = TIM_EGR_UG;
  tim->CNT = 1000000u / hz - first_us;
  tim->SR = 0;
  tim->DIER = TIM_DIER_UIE;
  NVIC_SetPriority(irq, priority);
  NVIC_EnableIRQ(irq);
  tim->CR1 = TIM_CR1_CEN;
}

static void timers_init(void) {
  __HAL_RCC_TIM6_CLK_ENABLE();
  __HAL_RCC_TIM7_CLK_ENABLE();
  swo_fixture_timclk_hz = timer_clock_hz();
}

// A probe's halt stops SysTick (J-Link halts and restarts the core at every session close): the timers stop with it
// and keep their place in its period (RM0090 DBGMCU_APB1_FZ, RM0433 DBGMCU_APB1LFZ1). Set each phase, since a J-Link
// connect rewrites the register (measured 0x1800 on stm32f407disco).
static void timers_freeze_in_debug(void) {
  __HAL_DBGMCU_FREEZE_TIM6();
  __HAL_DBGMCU_FREEZE_TIM7();
}

static void timers_start(void) {
  NVIC_SetPriority(NESTED_IRQn, 1);
  NVIC_EnableIRQ(NESTED_IRQn);
  timer_start(TIM6, TIM6_DAC_IRQn, SWO_FIXTURE_TIM6_HZ, SWO_FIXTURE_TIM6_AT_US, 2);
  timer_start(TIM7, TIM7_IRQn, SWO_FIXTURE_TIM7_HZ, SWO_FIXTURE_TIM7_AT_US, 3);
}

#elif CFG_TUSB_MCU == OPT_MCU_RAXXX

#define TRACE_ENABLED() (DCB->DEMCR & DCB_DEMCR_TRCENA_Msk)

// The BSP's vector table is const in flash with USB entries only (slots 0-6): the fixture switches VTOR to its own
// flash table, the core's handlers as FSP's startup names them, GPT0 overflow in slot 7, GPT1 overflow in slot 8 and
// slot 9 linked to no event, pended by software only. It runs no USB, so the BSP's USB slots stay empty. FSP targets
// every slot it does not link at the Non-secure state (NVIC_ITNS and ICUSARG, which must match); a Non-secure slot
// takes its vector from the Non-secure VTOR, 0 here (measured on ra6m5_ek: HardFault, HFSR.VECTTBL), so the
// fixture makes its three slots Secure.
#define TIM6_SLOT   7
#define TIM7_SLOT   8
#define NESTED_SLOT 9
#define GPT_TPCS_DIV4 2u   // GTCR.TPCS: PCLKD/4, 25 MHz from PCLKD 100 MHz; PCLKD/1..1024 has no 1 MHz

static uint32_t ticks_per_us;

// IR is cleared only by software; read back so the interrupt does not fire again on return (RA6M5 HUM Figure 13.2)
static void ack(uint32_t slot) {
  R_ICU->IELSR[slot] &= ~R_ICU_IELSR_IR_Msk;
  (void) R_ICU->IELSR[slot];
}

static void tim6_isr(void) {
  ack(TIM6_SLOT);
  tim6_tick();
}

static void tim7_isr(void) {
  ack(TIM7_SLOT);
  tim7_tick((IRQn_Type) NESTED_SLOT);
}

static void nested_isr(void) {
  nested_tick();
}

static uint32_t tim6_us(void) {
  return R_GPT0->GTCNT / ticks_per_us;
}

static uint32_t tim7_us(void) {
  return R_GPT1->GTCNT / ticks_per_us;
}

void Reset_Handler(void);
void NMI_Handler(void);
void HardFault_Handler(void);
void MemManage_Handler(void);
void BusFault_Handler(void);
void UsageFault_Handler(void);
void SecureFault_Handler(void);
void SVC_Handler(void);
void DebugMon_Handler(void);
void PendSV_Handler(void);
void SysTick_Handler(void);

// entry 0, the initial stack pointer, is read only at reset, from the table at address 0
static void (*const vectors[BSP_VECTOR_TABLE_MAX_ENTRIES])(void) __attribute__((aligned(512))) = {
  [1] = Reset_Handler, [2] = NMI_Handler, [3] = HardFault_Handler, [4] = MemManage_Handler, [5] = BusFault_Handler,
  [6] = UsageFault_Handler, [7] = SecureFault_Handler, [11] = SVC_Handler, [12] = DebugMon_Handler,
  [14] = PendSV_Handler, [15] = SysTick_Handler,
  [16 + TIM6_SLOT] = tim6_isr, [16 + TIM7_SLOT] = tim7_isr, [16 + NESTED_SLOT] = nested_isr,
};

static void timer_setup(R_GPT0_Type* gpt, uint32_t slot, elc_event_t event, uint32_t hz, uint32_t first_us,
                        uint32_t priority) {
  uint32_t const period = 1000000u / hz * ticks_per_us;
  gpt->GTCR = GPT_TPCS_DIV4 << R_GPT0_GTCR_TPCS_Pos; // stopped, saw-wave up-count
  gpt->GTPR = period - 1;
  gpt->GTCNT = period - first_us * ticks_per_us;     // writable only while stopped
  gpt->GTST = 0;
  R_ICU->IELSR[slot] = (uint32_t) event;
  NVIC_SetPriority((IRQn_Type) slot, priority);
  NVIC_EnableIRQ((IRQn_Type) slot);
}

static void timers_init(void) {
  __disable_irq();
  SCB->VTOR = (uint32_t) vectors;
  __DSB();
  __ISB();
  __enable_irq();

  R_BSP_MODULE_START(FSP_IP_GPT, 0);
  R_BSP_MODULE_START(FSP_IP_GPT, 1);
  swo_fixture_timclk_hz = R_FSP_SystemClockHzGet(FSP_PRIV_CLOCK_PCLKD) / 4;
  ticks_per_us = swo_fixture_timclk_hz / 1000000u;

  uint32_t const slots = 1u << TIM6_SLOT | 1u << TIM7_SLOT | 1u << NESTED_SLOT;
  R_BSP_RegisterProtectDisable(BSP_REG_PROTECT_SAR);
  R_CPSCU->ICUSARG &= ~slots;
  NVIC->ITNS[0] &= ~slots;
  R_BSP_RegisterProtectEnable(BSP_REG_PROTECT_SAR);

  R_ICU->IELSR[NESTED_SLOT] = 0;
  timer_setup(R_GPT0, TIM6_SLOT, ELC_EVENT_GPT0_COUNTER_OVERFLOW, SWO_FIXTURE_TIM6_HZ, SWO_FIXTURE_TIM6_AT_US, 2);
  timer_setup(R_GPT1, TIM7_SLOT, ELC_EVENT_GPT1_COUNTER_OVERFLOW, SWO_FIXTURE_TIM7_HZ, SWO_FIXTURE_TIM7_AT_US, 3);
}

static void timers_freeze_in_debug(void) {}

static void timers_start(void) {
  NVIC_SetPriority((IRQn_Type) NESTED_SLOT, 1);
  NVIC_EnableIRQ((IRQn_Type) NESTED_SLOT);
  R_GPT0->GTCR |= R_GPT0_GTCR_CST_Msk;
  R_GPT1->GTCR |= R_GPT0_GTCR_CST_Msk;
}

#endif

//--------------------------------------------------------------------+
// ITM stimulus, never blocking
//--------------------------------------------------------------------+
static void itm_put(uint32_t port, uint32_t value, uint32_t size) {
  bool const enabled = TRACE_ENABLED() && (ITM->TCR & ITM_TCR_ITMENA_Msk) && (ITM->TER & (1UL << port));
  if (enabled) {
    for (uint32_t i = 0; i < SWO_FIXTURE_ITM_SPIN; i++) {
      if (ITM->PORT[port].u32 & 1u) { // FIFOREADY
        if (size == 1) {
          ITM->PORT[port].u8 = (uint8_t) value;
        } else if (size == 2) {
          ITM->PORT[port].u16 = (uint16_t) value;
        } else {
          ITM->PORT[port].u32 = value;
        }
        swo_fixture_cur.itm_sent++;
        return;
      }
    }
  }
  swo_fixture_cur.itm_skipped++;
}

static void itm_phase_marker(uint32_t phase) {
  char text[32];
  int const len = snprintf(text, sizeof(text), "swo-fixture %lu\n", (unsigned long) phase);
  int i = 0;
  for (; i + 4 <= len; i += 4) {
    uint32_t word;
    memcpy(&word, text + i, 4); // little-endian: the first character goes out first
    itm_put(ITM_PORT_TEXT, word, 4);
  }
  for (; i < len; i++) {
    itm_put(ITM_PORT_TEXT, (uint8_t) text[i], 1);
  }
  itm_put(ITM_PORT_WORDS, phase, 4);
  itm_put(ITM_PORT_WORDS, 0xA55Au, 2);
  itm_put(ITM_PORT_WORDS, 0x7Eu, 1);
}

//--------------------------------------------------------------------+
// Phases
//--------------------------------------------------------------------+
TU_ATTR_USED __attribute__((noinline)) static void swo_fixture_busy(uint32_t until_ms) {
  while ((int32_t) (tusb_time_millis_api() - until_ms) < 0) {
    __NOP();
  }
}

TU_ATTR_USED __attribute__((noinline)) static void swo_fixture_idle(uint32_t until_ms) {
  while ((int32_t) (tusb_time_millis_api() - until_ms) < 0) {
    __WFI();
  }
}

static void swo_fixture_init(void) {
  timers_init();

  // start right after a SysTick tick, so the timers keep their place in its period (both from the same PLL)
  (void) SysTick->CTRL;
  while (!(SysTick->CTRL & SysTick_CTRL_COUNTFLAG_Msk)) {}

  timers_start();
}

// SWO_FIXTURE_MARKER_AT_US into a SysTick period whose TIM7 episode is at least a period away
static bool marker_slot(void) {
  uint32_t const tim6_cnt = tim6_us(); // SysTick period position + 1000 - SWO_FIXTURE_TIM6_AT_US
  uint32_t const at = (SWO_FIXTURE_MARKER_AT_US + 1000u - SWO_FIXTURE_TIM6_AT_US) % 1000u;
  uint32_t const tim7_cnt = tim7_us(); // us since TIM7's last update
  return tim6_cnt >= at && tim6_cnt < at + 50u && tim7_cnt >= 1000u && tim7_cnt < 9000u;
}

// One phase: busy half with the ITM marker in its middle, then idle half; swo_fixture_last holds the counts of the
// last complete phase. The LED toggles at each phase start, a reference for an external probe.
static void swo_fixture_task(void) {
  uint32_t const start = tusb_time_millis_api();
  board_led_write(swo_fixture_cur.phase & 1u);
  timers_freeze_in_debug();
  swo_fixture_busy(start + SWO_FIXTURE_BUSY_MS / 2);
  while (!marker_slot()) {}
  itm_phase_marker(swo_fixture_cur.phase);
#ifdef LOGGER_RTT
  printf("swo-fixture %lu\n", (unsigned long) swo_fixture_cur.phase); // the marker's text again, on RTT channel 0
#endif
  swo_fixture_busy(start + SWO_FIXTURE_BUSY_MS);
  swo_fixture_idle(start + SWO_FIXTURE_BUSY_MS + SWO_FIXTURE_IDLE_MS);

  __disable_irq();
  swo_fixture_last = swo_fixture_cur;
  swo_fixture_cur = (swo_fixture_stats_t) {.phase = swo_fixture_cur.phase + 1};
  __enable_irq();
}

int main(void) {
  board_init();
  swo_fixture_init();
  while (1) {
    swo_fixture_task();
  }
}
