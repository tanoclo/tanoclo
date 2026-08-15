# ==============================================================================
# spi_stub_addrs.tcl
# Description: Defines global STM32 SRAM offset address locations generated during
#              spi_stub compilation. Used by OpenOCD flash scripts.
# ==============================================================================
set STUB_ENTRY 0x20000510
set BUF_ADDR   0x20001520
set G_LEN      0x20002520
set G_ADDR     0x20002524
set G_OP       0x20002528
set G_OUT      0x2000252c
