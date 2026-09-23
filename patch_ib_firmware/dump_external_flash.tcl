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

# Wait for the stub to publish a terminal status for THIS chunk.
# The caller must clear g_out (mww $G_OUT 0) before `resume`, otherwise the
# previous chunk's done-code is still present and polling returns immediately,
# racing the stub and capturing a stale buffer.
proc wait_stub_done {g_out_addr done_code timeout_ms} {
    set waited 0
    while {$waited < $timeout_ms} {
        set d [read_memory $g_out_addr 8 3]
        set m0 [expr {[lindex $d 0] & 0xFF}]
        set m1 [expr {[lindex $d 1] & 0xFF}]
        set st [expr {[lindex $d 2] & 0xFF}]
        if {$m0 == 0xA5 && $m1 == 0x5A} {
            if {$st == $done_code} { return 1 }
            if {$st == 0xEE || $st == 0xEF || $st == 0xE1 || $st == 0xE2} {
                puts [format "OpenOCD dump_external_flash - ERROR: stub reported failure status 0x%02X" $st]
                if {$st == 0xEE} {
                    set f [read_memory $g_out_addr 8 11]
                    puts [format "  JEDEC ID check failed: expected first byte 0x%02X, got 0x%02X (MX25R1635F should answer C2 28 15)" \
                        [expr {[lindex $f 9] & 0xFF}] [expr {[lindex $f 10] & 0xFF}]]
                }
                return 0
            }
        }
        sleep 5
        set waited [expr {$waited + 5}]
    }
    puts [format "OpenOCD dump_external_flash - ERROR: stub did not complete within %dms" $timeout_ms]
    return 0
}

set MAX_TRIES 16
set stub_errors 0
set mismatches 0
set retried_chunks 0
set extra_reads 0

proc files_equal {a b} {
    set fa [open $a rb]; set da [read $fa]; close $fa
    set fb [open $b rb]; set db [read $fb]; close $fb
    return [string equal $da $db]
}

init
reset halt

# Optional diagnostic: SPI_SLOW=1 divides APB2 by 16 (RCC_CFGR.PPRE2=0b111) so the stub's
# SPI1 clock drops from ~500 kHz to ~31 kHz. If MISO errors vanish at this rate the fault is
# rise-time/loading; if they persist it is bus contention or similar.
if {[info exists ::env(SPI_SLOW)] && $::env(SPI_SLOW) == "1"} {
    mww 0x40023808 0x0000E000
    puts "OpenOCD dump_external_flash - SPI_SLOW=1: APB2 prescaler set to /16 (SPI ~31 kHz)"
}

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

    # Read this chunk until two consecutive reads agree (retrying on stub errors such as
    # 0xEE JEDEC mismatch). MISO on this board can be marginal; a single read is not trusted.
    set fname [format "%s/spi_%06x.bin" $OUT_CHUNK_DIR $addr]
    set fchk  [format "%s/spi_%06x.chk" $OUT_CHUNK_DIR $addr]
    set prev_ok 0
    set agreed 0
    for {set try 1} {$try <= $MAX_TRIES} {incr try} {
        mww $G_OP   0
        mww $G_ADDR $addr
        mww $G_LEN  $this_len
        mww $G_OUT  0
        resume $STUB_ENTRY
        set ok [wait_stub_done $G_OUT 0x11 5000]
        halt
        if {!$ok} {
            incr stub_errors
            set prev_ok 0
            continue
        }
        if {!$prev_ok} {
            dump_image $fname $BUF_ADDR $this_len
            set prev_ok 1
            continue
        }
        dump_image $fchk $BUF_ADDR $this_len
        if {[files_equal $fname $fchk]} {
            file delete $fchk
            set agreed 1
            if {$try > 2} { incr retried_chunks; incr extra_reads [expr {$try - 2}] }
            break
        }
        # Mismatch: keep the newest as the candidate and go again
        incr mismatches
        file rename -force $fchk $fname
    }
    if {!$agreed} {
        puts [format "OpenOCD dump_external_flash - ERROR: chunk 0x%06X never produced two matching reads in %d tries. Aborting." $addr $MAX_TRIES]
        shutdown error
    }

    incr chunk_index
    set addr [expr {$addr + $this_len}]

    if {($chunk_index % 64) == 0} {
        puts [format "OpenOCD dump_external_flash - Progress: 0x%06X / 0x%06X" $addr $FLASH_SIZE]
    }
}

puts [format "OpenOCD dump_external_flash - Read reliability: stub errors=%d, read mismatches=%d, chunks needing >2 reads=%d (extra reads=%d) over %d chunks" $stub_errors $mismatches $retried_chunks $extra_reads $chunk_index]
puts "OpenOCD dump_external_flash - Done."
shutdown