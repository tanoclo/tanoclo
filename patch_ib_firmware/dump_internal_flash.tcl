# ==============================================================================
# Script: dump_internal_flash.tcl
# Description: OpenOCD TCL script that dumps the entire internal STM32 flash
#              memory (512 KiB / 0x80000 bytes) into unmodded.bin.
#
# Usage:
#   openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -f dump_internal_flash.tcl
# ==============================================================================

init
reset halt

#Read internal flash
flash read_bank 0 unmodded.bin 0 0x80000

puts "OpenOCD dump_internal_flash - Done."
shutdown
