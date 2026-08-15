# ==============================================================================
# Script: dump_ru.tcl
# Description: OpenOCD TCL script that dumps the entire internal flash memory
#              of RU (Receiver Unit) devices (64 KiB / 0x10000 bytes) into RU.bin.
#              Configures DBGMCU registers (0x40015804 and 0x40015808) to freeze
#              watchdogs and maintain clock lines during low-power sleep modes.
#
# Usage:
#   openocd -f interface/stlink.cfg -f target/stm32l0.cfg -f dump_ru.tcl
# ==============================================================================

# Transition from configuration to active debug stage
init
# Halt the CPU immediately
halt
# Keep debug clocks running during Sleep, Stop, and Standby modes
mww 0x40015804 0x00000007
# Freeze both Independent Watchdog (IWDG) and Window Watchdog (WWDG) when halted
# (0x1000 is IWDG, 0x0800 is WWDG. Setting 0x1800 covers both)
mww 0x40015808 0x00001800
# Dump the 64KB internal flash
dump_image RU.bin 0x08000000 0x10000
puts "OpenOCD dump_ru - Done."
shutdown