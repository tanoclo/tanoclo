"""
ESPHome component schema and code generation definition for the Tado RF sniffer.
This module validates configuration settings for the custom TadoSniffer C++ component
and generates the corresponding C++ instantiation code.
"""

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import pins
from esphome.components import spi
from esphome.const import CONF_ID

# Indicate to ESPHome that this component requires SPI to communicate with the RF transceiver
DEPENDENCIES = ['spi']

# Declare the C++ namespace and class to ESPHome
tado_sniffer_ns = cg.esphome_ns.namespace('tado_sniffer')
TadoSniffer = tado_sniffer_ns.class_('TadoSniffer', cg.Component, spi.SPIDevice)

# Configuration keys for hardware pins, radio channel, and TCP streaming host/port
CONF_DIO0_PIN = "dio0_pin"
CONF_DIO2_PIN = "dio2_pin"
CONF_RST_PIN = "rst_pin"
CONF_CHANNEL = "channel"
CONF_TCP_HOST = "tcp_host"
CONF_TCP_PORT = "tcp_port"

# Validation schema defining parameters configurable through the YAML file
CONFIG_SCHEMA = cv.Schema({
    cv.GenerateID(): cv.declare_id(TadoSniffer),
    # dio0_pin: RF module interrupt/packet received pin (usually GDO0/DIO0)
    cv.Required(CONF_DIO0_PIN): pins.internal_gpio_input_pin_schema,
    # dio2_pin: Optional secondary RF interrupt pin (usually GDO2/DIO2)
    cv.Optional(CONF_DIO2_PIN): pins.internal_gpio_input_pin_schema,
    # rst_pin: RF module hardware reset pin
    cv.Required(CONF_RST_PIN): pins.internal_gpio_output_pin_schema,
    # channel: Radio channel used for initial sniffing
    cv.Optional(CONF_CHANNEL, default=26): cv.int_,
    # tcp_host: TCP server IP/hostname to stream raw sniffed packet bytes to
    cv.Optional(CONF_TCP_HOST): cv.string,
    # tcp_port: TCP server port
    cv.Optional(CONF_TCP_PORT): cv.port,
}).extend(cv.COMPONENT_SCHEMA).extend(spi.spi_device_schema(False))

async def to_code(config):
    """
    Translates the validated YAML configuration into C++ code during the build process.
    Instantiates the TadoSniffer class and calls setter methods for pins, channel, and TCP streaming settings.
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
    
    # Set optional TCP streaming host and port
    if CONF_TCP_HOST in config:
        cg.add(var.set_tcp_host(config[CONF_TCP_HOST]))
    if CONF_TCP_PORT in config:
        cg.add(var.set_tcp_port(config[CONF_TCP_PORT]))