/**
 * @file spi_stub.c
 * @brief SRAM execution stub for STM32F411 microcontroller to read/write external SPI flash (MX25R1635F).
 * 
 * Executed directly in target SRAM (starting at 0x20000000) via OpenOCD. Maps GPIO pins,
 * handles SPI1 master transactions, runs Sector Erase (4KB), Page Program (256B), and verifies
 * JEDEC ID.
 * 
 * Compile options:
 *   arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -O2 \
 *     -ffreestanding -fno-builtin -ffunction-sections -fdata-sections \
 *     -nostdlib \
 *     -Wl,--gc-sections -Wl,-Ttext=0x20000000 \
 *     -Wl,-e,stub_entry -Wl,--undefined=stub_entry \
 *     spi_stub.c -o spi_stub.elf
 */

#include <stdint.h>

#define PERIPH_BASE       0x40000000UL
#define AHB1PERIPH_BASE   (PERIPH_BASE + 0x00020000UL)
#define APB2PERIPH_BASE   (PERIPH_BASE + 0x00010000UL)

#define RCC_BASE          (AHB1PERIPH_BASE + 0x3800UL)
#define GPIOA_BASE        (AHB1PERIPH_BASE + 0x0000UL)
#define GPIOB_BASE        (AHB1PERIPH_BASE + 0x0400UL)
#define SPI1_BASE         (APB2PERIPH_BASE + 0x3000UL)

typedef struct {
  volatile uint32_t MODER;
  volatile uint32_t OTYPER;
  volatile uint32_t OSPEEDR;
  volatile uint32_t PUPDR;
  volatile uint32_t IDR;
  volatile uint32_t ODR;
  volatile uint32_t BSRR;
  volatile uint32_t LCKR;
  volatile uint32_t AFRL;
  volatile uint32_t AFRH;
} GPIO_TypeDef;

typedef struct {
  volatile uint32_t CR;        // RCC_CR
  volatile uint32_t PLLCFGR;   // RCC_PLLCFGR
  volatile uint32_t CFGR;      // RCC_CFGR
  volatile uint32_t CIR;
  volatile uint32_t AHB1RSTR;
  volatile uint32_t AHB2RSTR;
  volatile uint32_t AHB3RSTR;
  uint32_t          RESERVED0;
  volatile uint32_t APB1RSTR;
  volatile uint32_t APB2RSTR;
  uint32_t          RESERVED1[2];
  volatile uint32_t AHB1ENR;
  volatile uint32_t AHB2ENR;
  volatile uint32_t AHB3ENR;
  uint32_t          RESERVED2;
  volatile uint32_t APB1ENR;
  volatile uint32_t APB2ENR;
} RCC_TypeDef;

typedef struct {
  volatile uint32_t CR1;
  volatile uint32_t CR2;
  volatile uint32_t SR;
  volatile uint32_t DR;
  volatile uint32_t CRCPR;
  volatile uint32_t RXCRCR;
  volatile uint32_t TXCRCR;
  volatile uint32_t I2SCFGR;
  volatile uint32_t I2SPR;
} SPI_TypeDef;

#define RCC    ((RCC_TypeDef*)RCC_BASE)
#define GPIOA  ((GPIO_TypeDef*)GPIOA_BASE)
#define GPIOB  ((GPIO_TypeDef*)GPIOB_BASE)
#define SPI1   ((SPI_TypeDef*)SPI1_BASE)

__attribute__((section(".noinit")))
volatile uint8_t g_out[16];

__attribute__((section(".noinit"))) volatile uint32_t g_op;         // 0=read, 1=write
__attribute__((section(".noinit"))) volatile uint32_t g_flash_addr; // flash start address
__attribute__((section(".noinit"))) volatile uint32_t g_flash_len;  // byte count
__attribute__((section(".noinit"))) volatile uint8_t  g_buf[4096];  // chunk size

static void delay(volatile uint32_t n) {
  while (n--) __asm volatile ("nop");
}

static inline void cs_low(void) {
  GPIOB->BSRR = (1U << (9 + 16));
}

static inline void cs_high(void) {
  GPIOB->BSRR = (1U << 9);
}

static uint8_t spi1_xfer(uint8_t v) {
  while ((SPI1->SR & (1U << 1)) == 0) {}
  *(volatile uint8_t *)&SPI1->DR = v;
  while ((SPI1->SR & (1U << 0)) == 0) {}
  return *(volatile uint8_t *)&SPI1->DR;
}

static void spi1_init(void) {
  // Enable clocks: GPIOA, GPIOB, SPI1
  RCC->AHB1ENR |= (1U << 0) | (1U << 1);   // GPIOAEN, GPIOBEN
  RCC->APB2ENR |= (1U << 12);              // SPI1EN
  (void)RCC->AHB1ENR;
  (void)RCC->APB2ENR;

  // --- GPIOA: PA5/PA6/PA7 AF5 ---
  // MODER: set to 10b (AF) for pins 5,6,7
  GPIOA->MODER &= ~((3U<<(5*2)) | (3U<<(6*2)) | (3U<<(7*2)));
  GPIOA->MODER |=  ((2U<<(5*2)) | (2U<<(6*2)) | (2U<<(7*2)));

  // AFRL: AF5 (0101) for pins 5,6,7
  GPIOA->AFRL &= ~((0xFU<<(5*4)) | (0xFU<<(6*4)) | (0xFU<<(7*4)));
  GPIOA->AFRL |=  ((5U<<(5*4))  | (5U<<(6*4))  | (5U<<(7*4)));

  // Speed: high for pins 5,6,7
  GPIOA->OSPEEDR |= (3U<<(5*2)) | (3U<<(6*2)) | (3U<<(7*2));

  // MISO pull-up
  GPIOA->PUPDR &= ~((3U<<(5*2)) | (3U<<(6*2)) | (3U<<(7*2)));
  GPIOA->PUPDR |=  (1U<<(6*2)); // PA6 pull-up

  // --- GPIOB: PB9 as push-pull output for CS ---
  GPIOB->MODER &= ~(3U<<(9*2));
  GPIOB->MODER |=  (1U<<(9*2));   // output
  GPIOB->OTYPER &= ~(1U<<9);      // push-pull
  GPIOB->OSPEEDR |= (3U<<(9*2));  // high speed
  GPIOB->PUPDR &= ~(3U<<(9*2));
  GPIOB->PUPDR |=  (1U<<(9*2));   // pull-up so CS idles high

  cs_high();

  // --- SPI1 config (Mode 0: CPOL=0, CPHA=0) ---
  SPI1->CR1 = 0;
  // Bits: BR = 100 => fPCLK/32
  const uint32_t BR_DIV32 = (4U << 3);

  SPI1->CR1 =
      (1U << 2)  |   // MSTR
      BR_DIV32   |
      (1U << 9)  |   // SSM
      (1U << 8);     // SSI

  // Enable SPI
  SPI1->CR1 |= (1U << 6); // SPE
}

/**
 * @brief Records diagnostic status metadata fields upon memory verification failures.
 * @param code Diagnostic code identifier (e.g. 0xEE, 0xE1, 0xEF).
 * @param addr Start offset address of transaction.
 * @param off Relative byte offset where comparison mismatched.
 * @param exp Expected value.
 * @param got Actual read value from flash buffer.
 */
static void out_set_fail(uint8_t code, uint32_t addr, uint16_t off, uint8_t exp, uint8_t got) {
  g_out[2] = code;
  g_out[3] = (uint8_t)(addr & 0xFF);
  g_out[4] = (uint8_t)((addr >> 8) & 0xFF);
  g_out[5] = (uint8_t)((addr >> 16) & 0xFF);
  g_out[6] = (uint8_t)((addr >> 24) & 0xFF);
  g_out[7] = (uint8_t)(off & 0xFF);
  g_out[8] = (uint8_t)((off >> 8) & 0xFF);
  g_out[9] = exp;
  g_out[10] = got;
}

/**
 * @brief Reads data bytes directly from flash offset via SPI 0x03 Read command.
 * @param addr Start address offset in flash memory.
 * @param dst Buffer to store read bytes.
 * @param len Number of bytes to read.
 */
static void mx25_read_03(uint32_t addr, uint8_t *dst, uint32_t len) {
  cs_low();
  spi1_xfer(0x03);
  spi1_xfer((addr >> 16) & 0xFF);
  spi1_xfer((addr >>  8) & 0xFF);
  spi1_xfer((addr >>  0) & 0xFF);
  for (uint32_t i = 0; i < len; i++) dst[i] = spi1_xfer(0x00);
  cs_high();
}

/**
 * @brief Reads back a programmed page and verifies it matches the source buffer.
 * @param addr Start page address offset in flash.
 * @param expected Source buffer of expected page bytes.
 * @param len Length of verification block (usually 256 bytes).
 * @param bad_off Pointer to store the relative mismatch index.
 * @param got_byte Pointer to store the mismatched byte value read.
 * @return int 1 if verification succeeded (match), 0 on mismatch.
 */
static int mx25_verify_page(uint32_t addr, const uint8_t *expected, uint32_t len, uint16_t *bad_off, uint8_t *got_byte) {
  uint8_t tmp[256];
  mx25_read_03(addr, tmp, len);

  for (uint32_t i = 0; i < len; i++) {
    if (tmp[i] != expected[i]) {
      if (bad_off) *bad_off = (uint16_t)i;
      if (got_byte) *got_byte = tmp[i];
      return 0;
    }
  }
  return 1;
}

static uint8_t mx25_rdsr(void) {
  uint8_t sr;
  cs_low(); spi1_xfer(0x05); sr = spi1_xfer(0x00); cs_high();
  return sr;
}

static void mx25_wait_wip_clear(void) {
  volatile uint32_t timeout = 1000000;  // generous timeout for sector erase (~tens of ms)
  while ((mx25_rdsr() & 0x01) && --timeout) {}
}

static void mx25_wren(void) {
  cs_low(); spi1_xfer(0x06); cs_high();
}

static void mx25_sector_erase_4k(uint32_t addr) {
  mx25_wren();
  cs_low();
  spi1_xfer(0x20);
  spi1_xfer((addr >> 16) & 0xFF);
  spi1_xfer((addr >>  8) & 0xFF);
  spi1_xfer((addr >>  0) & 0xFF);
  cs_high();
  mx25_wait_wip_clear();
}

static void mx25_page_program(uint32_t addr, const uint8_t *src, uint32_t len) {
  mx25_wren();
  cs_low();
  spi1_xfer(0x02);
  spi1_xfer((addr >> 16) & 0xFF);
  spi1_xfer((addr >>  8) & 0xFF);
  spi1_xfer((addr >>  0) & 0xFF);
  for (uint32_t i = 0; i < len; i++) spi1_xfer(src[i]);
  cs_high();
  mx25_wait_wip_clear();
}

static void mx25_write_sector_full_verify(uint32_t base_addr, const uint8_t *sector_data, uint32_t len) {
  const uint32_t SECTOR = 4096;
  const uint32_t PAGE   = 256;

  if (((base_addr & (SECTOR - 1U)) != 0U) || (len != SECTOR)) {
    out_set_fail(0xEF, base_addr, 0, (uint8_t)(len & 0xFF), (uint8_t)((len >> 8) & 0xFF));
    while (1) { __asm volatile ("nop"); }
  }

  {
    uint8_t tmp[256];
    for (uint32_t off = 0; off < SECTOR; off += PAGE) {
      mx25_read_03(base_addr + off, tmp, PAGE);
      for (uint32_t i = 0; i < PAGE; i++) {
        if (tmp[i] != sector_data[off + i]) {
          goto do_program;
        }
      }
    }

    g_out[2] = 0x22;
    return;
  }

do_program:
  // Erase whole 4KB sector
  mx25_sector_erase_4k(base_addr);

  // Program ALL 16 pages and verify each
  for (uint32_t off = 0; off < SECTOR; off += PAGE) {
    mx25_page_program(base_addr + off, &sector_data[off], PAGE);

    uint16_t bad = 0;
    uint8_t got = 0;
    if (!mx25_verify_page(base_addr + off, &sector_data[off], PAGE, &bad, &got)) {
      out_set_fail(0xE1, base_addr + off, bad, sector_data[off + bad], got);
      while (1) { __asm volatile ("nop"); }
    }
  }

  g_out[2] = 0x22; // write OK
}

static void mx25_release_from_deep_powerdown(void) {
  cs_low();
  spi1_xfer(0xAB);
  cs_high();
  delay(20000);
}

static void mx25_read_jedec_id(uint8_t out3[3]) {
  cs_low();
  spi1_xfer(0x9F);
  out3[0] = spi1_xfer(0x00);
  out3[1] = spi1_xfer(0x00);
  out3[2] = spi1_xfer(0x00);
  cs_high();
}

void stub_main(void) {
  g_out[0] = 0xA5;
  g_out[1] = 0x5A;
  g_out[2] = 0x7F;

  spi1_init();
  mx25_release_from_deep_powerdown();

  // Verify JEDEC ID matches expected MX25R1635F (C2 28 15)
  {
    uint8_t jedec[3];
    mx25_read_jedec_id(jedec);
    if (jedec[0] != 0xC2 || jedec[1] != 0x28 || jedec[2] != 0x15) {
      out_set_fail(0xEE, 0, 0, 0xC2, jedec[0]);
      while (1) { __asm volatile ("nop"); }
    }
  }

  uint32_t len = g_flash_len;
  if (len == 0 || len > sizeof(g_buf)) len = sizeof(g_buf);

  if (g_op == 0) {
    mx25_read_03(g_flash_addr, (uint8_t*)g_buf, len);
    g_out[2] = 0x11;
  } else {
    mx25_write_sector_full_verify(g_flash_addr, (const uint8_t*)g_buf, len);
    // g_out[2] already set by mx25_write_sector_full_verify (0x22 on success)
  }

  while (1) { __asm volatile ("nop"); }
}

// Minimal entry point symbol for OpenOCD
__attribute__((naked, used, section(".stub_entry")))
void stub_entry(void) {
  __asm volatile (
    "ldr r0, =0x20020000 \n"
    "mov sp, r0          \n"
    "bl  stub_main       \n"
    "b   .               \n"
  );
}

