import esphome.codegen as cg
import esphome.config_validation as cv
from esphome import pins
from esphome.components import spi
from esphome.const import CONF_ID
from esphome.components import web_server_base

DEPENDENCIES = ['spi', 'web_server_base']

tado_emulator_ns = cg.esphome_ns.namespace('tado_emulator')
TadoEmulatorComponent = tado_emulator_ns.class_('TadoEmulatorComponent', cg.Component, spi.SPIDevice)

CONF_DIO0_PIN = "dio0_pin"
CONF_RST_PIN = "rst_pin"
CONF_CHANNEL = "channel"
CONF_WEB_SERVER_BASE_ID = "web_server_base_id"

CONF_AUTO_MAC_ACK = "auto_mac_ack"

CONFIG_SCHEMA = cv.Schema({
    cv.GenerateID(): cv.declare_id(TadoEmulatorComponent),
    cv.Required(CONF_DIO0_PIN): pins.internal_gpio_input_pin_schema,
    cv.Required(CONF_RST_PIN): pins.internal_gpio_output_pin_schema,
    cv.Optional(CONF_CHANNEL, default=26): cv.int_,
    cv.Optional(CONF_AUTO_MAC_ACK, default=False): cv.boolean,
    cv.Optional('server_url', default=''): cv.string,
    cv.Optional('api_key', default=''): cv.string,
    cv.GenerateID(CONF_WEB_SERVER_BASE_ID): cv.use_id(web_server_base.WebServerBase),
}).extend(cv.COMPONENT_SCHEMA).extend(spi.spi_device_schema(False))

async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await spi.register_spi_device(var, config)
    
    dio0_pin = await cg.gpio_pin_expression(config[CONF_DIO0_PIN])
    cg.add(var.set_dio0_pin(dio0_pin))
    
    rst_pin = await cg.gpio_pin_expression(config[CONF_RST_PIN])
    cg.add(var.set_rst_pin(rst_pin))
    
    cg.add(var.set_channel(config[CONF_CHANNEL]))
    cg.add(var.set_auto_mac_ack(config[CONF_AUTO_MAC_ACK]))
    
    server = await cg.get_variable(config[CONF_WEB_SERVER_BASE_ID])
    cg.add(var.set_server_base(server))
    cg.add(var.set_server_url(config['server_url']))
    cg.add(var.set_api_key(config['api_key']))
