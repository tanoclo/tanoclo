"""
ESPHome component schema and code generation definition for the Tado pairing controller.
This module defines the configuration options for the custom TadoPairing C++ component,
validates user input in YAML, and generates the necessary C++ code for compilation.
"""

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import pins
from esphome.components import spi
from esphome.const import CONF_ID

# Indicate to ESPHome that this component depends on the SPI bus being configured
DEPENDENCIES = ['spi']

# Declare the C++ namespace and class to ESPHome
tado_pairing_ns = cg.esphome_ns.namespace('tado_pairing')
TadoPairing = tado_pairing_ns.class_('TadoPairing', cg.Component, spi.SPIDevice)

# Configuration keys for GPIO pins and sniffer channel parameter
CONF_DIO0_PIN = "dio0_pin"
CONF_DIO2_PIN = "dio2_pin"
CONF_RST_PIN = "rst_pin"
CONF_CHANNEL = "channel"

# Validation schema defining parameters configurable through the YAML file
CONFIG_SCHEMA = cv.Schema({
    cv.GenerateID(): cv.declare_id(TadoPairing),
    # dio0_pin: RF module interrupt/packet received pin (usually GDO0/DIO0)
    cv.Required(CONF_DIO0_PIN): pins.internal_gpio_input_pin_schema,
    # dio2_pin: Optional secondary RF interrupt pin (usually GDO2/DIO2)
    cv.Optional(CONF_DIO2_PIN): pins.internal_gpio_input_pin_schema,
    # rst_pin: RF module hardware reset pin
    cv.Required(CONF_RST_PIN): pins.internal_gpio_output_pin_schema,
    # channel: Radio channel used for initial sniffing and transmission
    cv.Optional(CONF_CHANNEL, default=26): cv.int_,
}).extend(cv.COMPONENT_SCHEMA).extend(spi.spi_device_schema(False))

async def to_code(config):
    """
    Translates the validated YAML configuration into C++ code during the build process.
    Instantiates the TadoPairing class and calls setter methods for the configured pins/parameters.
    """
    # Create the C++ component variable
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    # Register this component as a device on the SPI bus
    await spi.register_spi_device(var, config)
    
    # Process and register DIO0 pin
    dio0_pin = await cg.gpio_pin_expression(config[CONF_DIO0_PIN])
    cg.add(var.set_dio0_pin(dio0_pin))
    
    # Process and register optional DIO2 pin if provided
    if CONF_DIO2_PIN in config:
        dio2_pin = await cg.gpio_pin_expression(config[CONF_DIO2_PIN])
        cg.add(var.set_dio2_pin(dio2_pin))
    
    # Process and register Reset pin
    rst_pin = await cg.gpio_pin_expression(config[CONF_RST_PIN])
    cg.add(var.set_rst_pin(rst_pin))
    
    # Set Sniffer Channel
    cg.add(var.set_channel(config[CONF_CHANNEL]))

