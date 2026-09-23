# ==============================================================================
# Script: program_external_flash.tcl
# Description: OpenOCD TCL script that writes a unified 2MB patched SPI image
#              into the external MX25R16 flash using the loaded spi_stub SRAM helper.
#              Erases sector blocks, writes page payloads, and validates write operations.
#
# Usage:
#   openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f program_external_flash.tcl
# ==============================================================================

set INPUT_BIN     "IB-SPI-patched-ca-endpoint.bin"

set STUB_ELF      "spi_stub.elf"
source spi_stub_addrs.tcl

set FLASH_SIZE    0x00200000           ;# 2 MiB
set CHUNK_SIZE    0x00001000           ;# 4 KiB (must match g_buf size)
set RUN_SLEEP_MS  700                  ;# 4KB erase can be tens/hundreds of ms; 700ms is safe

# Wait for the stub to publish a terminal status for THIS sector.
# Caller must clear g_out (mww $G_OUT 0) before `resume`; otherwise the previous
# sector's 0x22 done-code satisfies the poll immediately and the sector is
# halted before it is erased/programmed, while check_stub_status still sees "OK".
proc wait_stub_done {g_out_addr timeout_ms} {
    set t 0
    while {$t < $timeout_ms} {
        set d [read_memory $g_out_addr 8 3]
        set m0 [expr {[lindex $d 0] & 0xFF}]
        set m1 [expr {[lindex $d 1] & 0xFF}]
        set st [expr {[lindex $d 2] & 0xFF}]
        if {$m0 == 0xA5 && $m1 == 0x5A} {
            if {$st == 0x22} { return }
            if {$st == 0xEE || $st == 0xEF || $st == 0xE1 || $st == 0xE2} { return }
        }
        sleep 5
        set t [expr {$t + 5}]
    }
    puts "OpenOCD program_external_flash - ERROR: stub timeout waiting for completion. Aborting; flash may be partially written."
    shutdown error
}

# --- Load a slice of a raw binary file into RAM (OpenOCD 0.11 compatible) ---
proc load_image_bin {fname foffset address length} {
    # load_image <file> <baseaddr> bin <min_addr> <max_length>
    # Rebasing trick so min_addr maps to desired file offset.
    load_image $fname [expr {$address - $foffset}] bin $address $length
}

# --- Read status bytes using read_memory (mem2array deprecated) ---
proc check_stub_status {g_out_addr cur_flash_addr} {
    # g_out expected layout (at least first 16 bytes):
    # [0]=0xA5 [1]=0x5A [2]=status
    # fail: [3..6]=fail addr LE, [7..8]=bad off LE, [9]=expected, [10]=got
    set data [read_memory $g_out_addr 8 16]

    set marker0 [expr {[lindex $data 0] & 0xFF}]
    set marker1 [expr {[lindex $data 1] & 0xFF}]
    set st      [expr {[lindex $data 2] & 0xFF}]

    if {($marker0 != 0xA5) || ($marker1 != 0x5A)} {
        # Marker missing => don't early-abort (but normally should always be present)
        return 0
    }

    if {$st == 0xEF} {
        puts ""
        puts "OpenOCD program_external_flash - ERROR: stub parameter error (0xEF)."
        puts "This usually means g_flash_addr not 4KB-aligned or g_flash_len != 0x1000."
        puts [format "Chunk start: 0x%06X" $cur_flash_addr]
        return 1
    }

    if {($st == 0xE1) || ($st == 0xE2)} {
        set fail_addr [expr {
            ([lindex $data 3] & 0xFF) |
            (([lindex $data 4] & 0xFF) << 8) |
            (([lindex $data 5] & 0xFF) << 16) |
            (([lindex $data 6] & 0xFF) << 24)
        }]
        set bad_off [expr {
            ([lindex $data 7] & 0xFF) |
            (([lindex $data 8] & 0xFF) << 8)
        }]
        set expb [expr {[lindex $data 9] & 0xFF}]
        set gotb [expr {[lindex $data 10] & 0xFF}]

        puts ""
        puts [format "OpenOCD program_external_flash - ERROR: stub verify/program failure (0x%02X)" $st]
        puts [format "  SPI chunk start : 0x%06X" $cur_flash_addr]
        puts [format "  fail_addr      : 0x%08X" $fail_addr]
        puts [format "  bad_offset     : 0x%04X" $bad_off]
        puts [format "  expected       : 0x%02X" $expb]
        puts [format "  got            : 0x%02X" $gotb]
        return 1
    }

    return 0
}

proc assert_file_size {path expected} {
    set sz [file size $path]
    if {$sz != $expected} {
        puts [format "OpenOCD program_external_flash - ERROR: %s size is %d, expected %d (0x%X)" $path $sz $expected $expected]
        shutdown error
    }
}

# Sanity checks
assert_file_size $INPUT_BIN $FLASH_SIZE

# --- Main ---
init
reset halt

# Optional: SPI_SLOW=1 divides APB2 by 16 (RCC_CFGR.PPRE2=0b111), dropping the stub's SPI1
# clock from ~500 kHz to ~31 kHz. Use it if dump_external_flash.tcl only reads reliably with it.
if {[info exists ::env(SPI_SLOW)] && $::env(SPI_SLOW) == "1"} {
    mww 0x40023808 0x0000E000
    puts "OpenOCD program_external_flash - SPI_SLOW=1: APB2 prescaler set to /16 (SPI ~31 kHz)"
}

# Load stub into RAM and set stack
load_image $STUB_ELF
reg sp 0x20020000

puts [format "OpenOCD program_external_flash - Programming external SPI from %s" $INPUT_BIN]
puts [format "Stub entry: 0x%08X" $STUB_ENTRY]
puts [format "BUF_ADDR  : 0x%08X" $BUF_ADDR]
puts [format "G_LEN     : 0x%08X" $G_LEN]
puts [format "G_ADDR    : 0x%08X" $G_ADDR]
puts [format "G_OP      : 0x%08X" $G_OP]
puts [format "G_OUT     : 0x%08X" $G_OUT]

set addr 0
set idx 0

while {$addr < $FLASH_SIZE} {
    set remaining [expr {$FLASH_SIZE - $addr}]
    set this_len $CHUNK_SIZE
    if {$remaining < $CHUNK_SIZE} { set this_len $remaining }

    # For full-sector correctness we require EXACT 0x1000 chunks
    if {$this_len != 0x1000} {
        puts [format "OpenOCD program_external_flash - ERROR: last chunk length is 0x%X, expected 0x1000. Input file must be exactly 2MiB." $this_len]
        shutdown error
    }

    # Load chunk from file offset 'addr' into g_buf
    load_image_bin $INPUT_BIN $addr $BUF_ADDR $this_len
    
    if {$addr == 0} {
        set b [read_memory $BUF_ADDR 8 16]
        puts [format "OpenOCD program_external_flash - Chunk0 RAM 0:16 =%s" $b]
    }
    
    # Configure stub for WRITE
    mww $G_OP   1
    mww $G_ADDR $addr
    mww $G_LEN  $this_len

    # Clear marker+status so a stale 0x22 from the previous sector cannot satisfy the poll
    mww $G_OUT 0

    # Run stub
    resume $STUB_ENTRY
    wait_stub_done $G_OUT 5000
    halt

    if {[check_stub_status $G_OUT $addr]} {
        puts "OpenOCD program_external_flash - Aborting."
        shutdown error
    }

    incr idx
    set addr [expr {$addr + $this_len}]

    if {($idx % 64) == 0} {
        puts [format "OpenOCD program_external_flash - Progress: 0x%06X / 0x%06X" $addr $FLASH_SIZE]
    }
}

puts "OpenOCD program_external_flash - Done."
shutdown