#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define FIRMWARE_UPDATE_SHA256_HEX_LENGTH 64

typedef struct firmware_update_session firmware_update_session_t;

typedef struct {
    char project_name[32];
    char version[32];
    char build_date[16];
    char build_time[16];
    char running_partition[17];
    char boot_partition[17];
    char next_partition[17];
    size_t next_partition_size;
    bool ota_supported;
    bool update_in_progress;
    bool pending_verify;
} firmware_update_status_t;

void firmware_update_get_status(firmware_update_status_t *status);
esp_err_t firmware_update_confirm_running(void);

esp_err_t firmware_update_begin(size_t image_size,
                                const char *expected_sha256,
                                firmware_update_session_t **session);
esp_err_t firmware_update_write(firmware_update_session_t *session,
                                const void *data,
                                size_t length);
esp_err_t firmware_update_finish(firmware_update_session_t *session);
void firmware_update_abort(firmware_update_session_t *session);
esp_err_t firmware_update_schedule_restart(uint32_t delay_ms);
