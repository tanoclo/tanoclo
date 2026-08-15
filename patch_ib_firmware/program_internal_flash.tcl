# ==============================================================================
# Script: program_internal_flash.tcl
# Description: OpenOCD TCL script that writes a 512KB patched internal firmware
#              binary (at offset 0x08000000) into STM32 internal flash memory,
#              erasing segments and running validation checks.
#
# Usage:
#   openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f program_internal_flash.tcl
# ==============================================================================

set INT_INPUT_BIN   "IB-patched-ca-endpoint-crc.bin"
set INT_BASE_ADDR   0x08000000
set INT_EXPECT_SIZE 0x00080000     ;

proc assert_file_size {path expected} {
    set sz [file size $path]
    if {$sz != $expected} {
        puts [format "OpenOCD program_internal_flash - ERROR: %s size is %d, expected %d (0x%X)" $path $sz $expected $expected]
        shutdown
    }
}

# Sanity checks
assert_file_size $INT_INPUT_BIN $INT_EXPECT_SIZE

# ----------------- Start -----------------
init
reset halt

# ----------------- Internal flash program -----------------
puts [format "OpenOCD program_internal_flash - Programming internal flash from %s to 0x%08X" $INT_INPUT_BIN $INT_BASE_ADDR]

# Program internal flash
flash write_image erase $INT_INPUT_BIN $INT_BASE_ADDR bin

# Verify
verify_image $INT_INPUT_BIN $INT_BASE_ADDR bin

puts "OpenOCD program_internal_flash - Internal flash programming + verify complete."
shutdown
