# ==============================================================================
# Script: dump_external_flash.tcl
# Description: OpenOCD TCL script that dumps the entire external SPI flash (2 MiB)
#              in 4KB chunks. Loads spi_stub.elf into SRAM, configures parameters,
#              triggers SPI transactions, and dumps the memory buffers.
#
# Usage:
#   openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f dump_external_flash.tcl
# ==============================================================================

set STUB_ELF      "spi_stub.elf"
source spi_stub_addrs.tcl

set FLASH_SIZE    0x00200000
set CHUNK_SIZE    0x00001000
set OUT_CHUNK_DIR "."

# If your stub sets g_out[2]=0x7F while running, this will robustly wait for completion.
# If not, it will fall back to a short sleep.
proc wait_stub_done_or_sleep {g_out_addr timeout_ms} {
    set waited 0
    while {$waited < $timeout_ms} {
        # Read marker + status
        set d [read_memory $g_out_addr 8 3]
        set m0 [expr {[lindex $d 0] & 0xFF}]
        set m1 [expr {[lindex $d 1] & 0xFF}]
        set st [expr {[lindex $d 2] & 0xFF}]

        # If marker is present and status is not RUNNING (0x7F), we consider it done.
        if {$m0 == 0xA5 && $m1 == 0x5A && $st != 0x7F} {
            return
        }

        sleep 20
        set waited [expr {$waited + 20}]
    }

    # Marker/status polling didn't converge — stub may be stuck
    puts [format "WARNING: stub completion polling timed out after %dms — data in RAM buffer may be stale" $timeout_ms]
    return
}

init
reset halt

# Load stub into RAM once
load_image $STUB_ELF

# Set a safe stack top for STM32F411 SRAM end (128 KiB => top at 0x20020000)
reg sp 0x20020000

puts [format "OpenOCD dump_external_flash - Dumping external SPI: size=0x%06X chunk=0x%X" $FLASH_SIZE $CHUNK_SIZE]
puts [format "Stub entry: 0x%08X" $STUB_ENTRY]
puts [format "BUF_ADDR  : 0x%08X" $BUF_ADDR]
puts [format "G_LEN     : 0x%08X" $G_LEN]
puts [format "G_ADDR    : 0x%08X" $G_ADDR]
puts [format "G_OP      : 0x%08X" $G_OP]
puts [format "G_OUT     : 0x%08X" $G_OUT]

set addr 0
set chunk_index 0

while {$addr < $FLASH_SIZE} {
    set remaining [expr {$FLASH_SIZE - $addr}]
    set this_len $CHUNK_SIZE
    if {$remaining < $CHUNK_SIZE} { set this_len $remaining }

    # For a clean 2MiB dump with 4KB chunks, last chunk should still be 0x1000.
    # Keep logic generic anyway.

    # Configure stub for READ
    mww $G_OP   0
    mww $G_ADDR $addr
    mww $G_LEN  $this_len

    # Run stub
    resume $STUB_ENTRY
    # Wait for stub completion if it publishes status, else this returns after timeout.
    wait_stub_done_or_sleep $G_OUT 2000
    halt

    # Dump RAM buffer to a chunk file
    set fname [format "%s/spi_%06x.bin" $OUT_CHUNK_DIR $addr]
    dump_image $fname $BUF_ADDR $this_len

    incr chunk_index
    set addr [expr {$addr + $this_len}]

    if {($chunk_index % 64) == 0} {
        puts [format "OpenOCD dump_external_flash - Progress: 0x%06X / 0x%06X" $addr $FLASH_SIZE]
    }
}

puts "OpenOCD dump_external_flash - Done."
shutdown
