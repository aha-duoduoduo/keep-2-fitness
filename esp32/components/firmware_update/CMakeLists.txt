idf_component_register(
    SRCS "firmware_update.c"
    INCLUDE_DIRS "include"
    REQUIRES app_update bootloader_support esp_app_format esp_partition esp_timer mbedtls
)
