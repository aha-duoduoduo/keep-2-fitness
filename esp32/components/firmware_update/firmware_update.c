#include "firmware_update.h"

#include <stdlib.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_app_format.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "mbedtls/sha256.h"

#define MINIMUM_APP_IMAGE_SIZE 1024
#define EXPECTED_PROJECT_NAME "c1_bridge"
#define APP_DESCRIPTOR_OFFSET (sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t))
#define APP_PREFIX_SIZE (APP_DESCRIPTOR_OFFSET + sizeof(esp_app_desc_t))

struct firmware_update_session {
    esp_ota_handle_t handle;
    const esp_partition_t *partition;
    uint8_t expected_sha256[32];
    size_t expected_size;
    size_t written;
    size_t prefix_size;
    bool handle_active;
    bool identity_validated;
    uint8_t prefix[APP_PREFIX_SIZE];
};

static const char *TAG = "firmware_update";
static portMUX_TYPE update_lock = portMUX_INITIALIZER_UNLOCKED;
static bool update_in_progress;
static esp_timer_handle_t restart_timer;

static void copy_text(char *destination, size_t capacity, const char *source) {
    if (!destination || !capacity) return;
    strlcpy(destination, source ? source : "", capacity);
}

static int hex_value(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

static bool parse_sha256(const char *encoded, uint8_t decoded[32]) {
    if (!encoded || strlen(encoded) != FIRMWARE_UPDATE_SHA256_HEX_LENGTH) return false;
    for (size_t index = 0; index < 32; index++) {
        int high = hex_value(encoded[index * 2]);
        int low = hex_value(encoded[index * 2 + 1]);
        if (high < 0 || low < 0) return false;
        decoded[index] = (uint8_t)((high << 4) | low);
    }
    return true;
}

static bool reserve_update(void) {
    bool reserved = false;
    portENTER_CRITICAL(&update_lock);
    if (!update_in_progress) {
        update_in_progress = true;
        reserved = true;
    }
    portEXIT_CRITICAL(&update_lock);
    return reserved;
}

static void release_update(void) {
    portENTER_CRITICAL(&update_lock);
    update_in_progress = false;
    portEXIT_CRITICAL(&update_lock);
}

static bool update_is_in_progress(void) {
    bool result;
    portENTER_CRITICAL(&update_lock);
    result = update_in_progress;
    portEXIT_CRITICAL(&update_lock);
    return result;
}

static bool partition_pending_verify(const esp_partition_t *partition) {
    if (!partition) return false;
    esp_ota_img_states_t state;
    return esp_ota_get_state_partition(partition, &state) == ESP_OK &&
           state == ESP_OTA_IMG_PENDING_VERIFY;
}

void firmware_update_get_status(firmware_update_status_t *status) {
    if (!status) return;
    memset(status, 0, sizeof(*status));

    const esp_app_desc_t *description = esp_app_get_description();
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *boot = esp_ota_get_boot_partition();
    const esp_partition_t *next = esp_ota_get_next_update_partition(NULL);

    if (description) {
        copy_text(status->project_name, sizeof(status->project_name), description->project_name);
        copy_text(status->version, sizeof(status->version), description->version);
        copy_text(status->build_date, sizeof(status->build_date), description->date);
        copy_text(status->build_time, sizeof(status->build_time), description->time);
    }
    if (running) copy_text(status->running_partition, sizeof(status->running_partition), running->label);
    if (boot) copy_text(status->boot_partition, sizeof(status->boot_partition), boot->label);
    if (next) {
        copy_text(status->next_partition, sizeof(status->next_partition), next->label);
        status->next_partition_size = next->size;
    }
    status->ota_supported = next && running && next != running;
    status->update_in_progress = update_is_in_progress();
    status->pending_verify = partition_pending_verify(running);
}

esp_err_t firmware_update_confirm_running(void) {
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (!partition_pending_verify(running)) return ESP_OK;
    esp_err_t result = esp_ota_mark_app_valid_cancel_rollback();
    if (result == ESP_OK) {
        ESP_LOGI(TAG, "Confirmed running OTA image in %s", running->label);
    } else {
        ESP_LOGE(TAG, "Could not confirm running OTA image: %s", esp_err_to_name(result));
    }
    return result;
}

esp_err_t firmware_update_begin(size_t image_size,
                                const char *expected_sha256,
                                firmware_update_session_t **output) {
    if (!output || image_size < MINIMUM_APP_IMAGE_SIZE) return ESP_ERR_INVALID_ARG;
    *output = NULL;

    uint8_t expected[32];
    if (!parse_sha256(expected_sha256, expected)) return ESP_ERR_INVALID_CRC;
    if (!reserve_update()) return ESP_ERR_INVALID_STATE;

    const esp_partition_t *partition = esp_ota_get_next_update_partition(NULL);
    if (!partition) {
        release_update();
        return ESP_ERR_NOT_FOUND;
    }
    if (image_size > partition->size) {
        release_update();
        return ESP_ERR_INVALID_SIZE;
    }

    firmware_update_session_t *session = calloc(1, sizeof(*session));
    if (!session) {
        release_update();
        return ESP_ERR_NO_MEM;
    }
    session->partition = partition;
    session->expected_size = image_size;
    memcpy(session->expected_sha256, expected, sizeof(expected));

    esp_err_t result = esp_ota_begin(partition, image_size, &session->handle);
    if (result != ESP_OK) {
        free(session);
        release_update();
        return result;
    }
    session->handle_active = true;
    *output = session;
    ESP_LOGI(TAG, "Receiving %u bytes into %s", (unsigned)image_size, partition->label);
    return ESP_OK;
}

esp_err_t firmware_update_write(firmware_update_session_t *session,
                                const void *data,
                                size_t length) {
    if (!session || !session->handle_active || !data || !length) return ESP_ERR_INVALID_ARG;
    if (session->written > session->expected_size ||
        length > session->expected_size - session->written) return ESP_ERR_INVALID_SIZE;

    if (!session->identity_validated && session->prefix_size < sizeof(session->prefix)) {
        size_t prefix_remaining = sizeof(session->prefix) - session->prefix_size;
        size_t copy_length = length < prefix_remaining ? length : prefix_remaining;
        memcpy(session->prefix + session->prefix_size, data, copy_length);
        session->prefix_size += copy_length;
        if (session->prefix_size == sizeof(session->prefix)) {
            esp_image_header_t header;
            esp_app_desc_t description;
            memcpy(&header, session->prefix, sizeof(header));
            memcpy(&description, session->prefix + APP_DESCRIPTOR_OFFSET,
                   sizeof(description));
            if (header.magic != ESP_IMAGE_HEADER_MAGIC ||
                description.magic_word != ESP_APP_DESC_MAGIC_WORD ||
                strncmp(description.project_name, EXPECTED_PROJECT_NAME,
                        sizeof(description.project_name)) != 0) {
                ESP_LOGE(TAG, "Uploaded image is not a C1 Bridge application");
                return ESP_ERR_INVALID_RESPONSE;
            }
            session->identity_validated = true;
        }
    }
    esp_err_t result = esp_ota_write(session->handle, data, length);
    if (result == ESP_OK) session->written += length;
    return result;
}

static void destroy_session(firmware_update_session_t *session, bool abort_handle) {
    if (!session) return;
    if (abort_handle && session->handle_active) esp_ota_abort(session->handle);
    free(session);
    release_update();
}

static esp_err_t partition_sha256(const firmware_update_session_t *session,
                                  uint8_t digest[32]) {
    uint8_t *buffer = malloc(4096);
    if (!buffer) return ESP_ERR_NO_MEM;

    mbedtls_sha256_context sha256;
    mbedtls_sha256_init(&sha256);
    esp_err_t result = mbedtls_sha256_starts(&sha256, 0) == 0 ? ESP_OK : ESP_FAIL;
    size_t offset = 0;
    while (result == ESP_OK && offset < session->expected_size) {
        size_t length = session->expected_size - offset;
        if (length > 4096) length = 4096;
        result = esp_partition_read(session->partition, offset, buffer, length);
        if (result == ESP_OK && mbedtls_sha256_update(&sha256, buffer, length) != 0) {
            result = ESP_FAIL;
        }
        offset += length;
    }
    if (result == ESP_OK && mbedtls_sha256_finish(&sha256, digest) != 0) {
        result = ESP_FAIL;
    }
    mbedtls_sha256_free(&sha256);
    free(buffer);
    return result;
}

static void digest_hex(const uint8_t digest[32], char encoded[65]) {
    static const char alphabet[] = "0123456789abcdef";
    for (size_t index = 0; index < 32; index++) {
        encoded[index * 2] = alphabet[digest[index] >> 4];
        encoded[index * 2 + 1] = alphabet[digest[index] & 0x0f];
    }
    encoded[64] = '\0';
}

esp_err_t firmware_update_finish(firmware_update_session_t *session) {
    if (!session || !session->handle_active) return ESP_ERR_INVALID_ARG;
    if (session->written != session->expected_size || !session->identity_validated) {
        destroy_session(session, true);
        return ESP_ERR_INVALID_SIZE;
    }

    uint8_t actual_sha256[32];
    esp_err_t hash_result = partition_sha256(session, actual_sha256);
    if (hash_result != ESP_OK) {
        destroy_session(session, true);
        return hash_result;
    }
    if (memcmp(actual_sha256, session->expected_sha256, sizeof(actual_sha256)) != 0) {
        char actual[65];
        char expected[65];
        digest_hex(actual_sha256, actual);
        digest_hex(session->expected_sha256, expected);
        ESP_LOGE(TAG, "Uploaded image SHA-256 mismatch: actual=%s expected=%s", actual, expected);
        destroy_session(session, true);
        return ESP_ERR_INVALID_CRC;
    }

    esp_ota_handle_t handle = session->handle;
    const esp_partition_t *partition = session->partition;
    session->handle_active = false;
    esp_err_t result = esp_ota_end(handle);
    if (result == ESP_OK) result = esp_ota_set_boot_partition(partition);
    if (result == ESP_OK) {
        ESP_LOGI(TAG, "OTA image verified; next boot partition is %s", partition->label);
    } else {
        ESP_LOGE(TAG, "OTA finalization failed: %s", esp_err_to_name(result));
    }
    destroy_session(session, false);
    return result;
}

void firmware_update_abort(firmware_update_session_t *session) {
    destroy_session(session, true);
}

static void restart_callback(void *argument) {
    (void)argument;
    esp_restart();
}

esp_err_t firmware_update_schedule_restart(uint32_t delay_ms) {
    if (!restart_timer) {
        const esp_timer_create_args_t arguments = {
            .callback = restart_callback,
            .name = "ota_restart",
        };
        esp_err_t result = esp_timer_create(&arguments, &restart_timer);
        if (result != ESP_OK) return result;
    }
    if (esp_timer_is_active(restart_timer)) esp_timer_stop(restart_timer);
    return esp_timer_start_once(restart_timer, (uint64_t)delay_ms * 1000);
}
