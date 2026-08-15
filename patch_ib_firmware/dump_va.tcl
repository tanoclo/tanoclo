# ==============================================================================
# Script: dump_va.tcl
# Description: OpenOCD TCL script that dumps the entire internal flash memory
#              of VA (Valve Adapter) devices (512 KiB / 0x80000 bytes) into VA.bin.
#              Targets the nRF52 chip series.
#
# Usage:
#   openocd -f interface/stlink.cfg -f target/nrf52.cfg -f dump_va.tcl
# ==============================================================================

# Transition from configuration to active debug stage
init
# Halt the CPU immediately
halt
# Dump the 512KB internal flash
dump_image VA.bin 0 0x80000
puts "OpenOCD dump_va - Done."
shutdown