const $ = (id) => document.getElementById(id);
const metrics = ["power", "cadence", "duration", "distance", "calories"];
let focus = localStorage.focus || "power";
let state = {};
let history = [];
let wifiOperationActive = false;
let wifiChooserRequested = false;
let wifiAutoScanStarted = false;
let currentConfig = {};
let currentFirmware = {};

const fmtDuration = (seconds) => {
  const value = Math.max(0, seconds | 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
};

function selectedMetric() {
  const value = state.metrics || {};
  return {
    power: [value.power || 0, "W"],
    cadence: [value.cadence || 0, "RPM"],
    duration: [fmtDuration(value.duration || 0), ""],
    distance: [((value.distance || 0) / 1000).toFixed(2), "KM"],
    calories: [value.calories || 0, "KCAL"],
  }[focus];
}

function render() {
  const value = state.metrics || {};
  const primary = selectedMetric();
  $("primaryValue").textContent = primary[0];
  $("primaryUnit").textContent = primary[1];
  $("cadence").textContent = value.cadence || 0;
  $("resistance").textContent = value.resistance || 1;
  $("duration").textContent = fmtDuration(value.duration || 0);
  $("status").textContent = state.message || "等待单车";
  $("connection").textContent = state.bikeConnected ? "已连接" : "等待单车";
  $("connection").parentElement.classList.toggle(
    "connected",
    !!state.bikeConnected,
  );
  $("openSettings").textContent = state.deviceBound
    ? "已绑定设备"
    : "第一台只读";
  $("controls")
    .querySelectorAll("button")
    .forEach((button) => {
      button.disabled = !state.authorized || state.controlPending;
    });
  const training = value.trainingStatus || 0;
  $("startControl").hidden = training === 3;
  $("pauseControl").hidden = training !== 3;
  $("startControl").querySelector(".control-label").textContent =
    training === 4 ? "继续" : "开始";
  $("duration").parentElement.classList.toggle(
    "long",
    fmtDuration(value.duration || 0).length > 5,
  );
  document.querySelector(".dashboard").dataset.mode = focus;
  renderScale(value.resistance || 1, state.maxResistance || 18);
  drawTrace();
  requestAnimationFrame(fitPrimaryDisplay);
  if ($("settings").open && !wifiOperationActive) updateWifiSection(false);
}

function renderWifiConnection(nextState) {
  const ssid = currentConfig.wifiSsid || $("ssid").value.trim();
  switch (nextState.wifiState) {
    case "connected":
      $("wifiConnectedName").textContent = ssid || "已连接家庭网络";
      $("wifiConnectedMeta").textContent =
        `${nextState.wifiIp || "已取得网络地址"} · c1bridge.local`;
      break;
    case "password_error":
      $("wifiHint").textContent = "连接失败：密码错误或路由器拒绝认证。";
      break;
    case "not_found":
      $("wifiHint").textContent = "连接失败：没有找到该 2.4 GHz 网络。";
      break;
    case "failed":
      $("wifiHint").textContent =
        `连接失败：无线网络错误${nextState.wifiDisconnectReason ? `（代码 ${nextState.wifiDisconnectReason}）` : ""}。`;
      break;
    case "connecting":
      $("wifiHint").textContent = "Wi-Fi 配置已保存，正在连接…";
      break;
    default:
      $("wifiHint").textContent = "尚未连接家庭网络，正在搜索附近网络…";
  }
}

function updateWifiSection(allowAutomaticScan) {
  const showConnected =
    state.wifiState === "connected" && !wifiChooserRequested;
  $("wifiConnectedPanel").hidden = !showConnected;
  $("wifiChooser").hidden = showConnected;
  renderWifiConnection(state);

  if (
    !showConnected &&
    state.wifiState !== "connecting" &&
    allowAutomaticScan &&
    !wifiAutoScanStarted &&
    !wifiOperationActive
  ) {
    wifiAutoScanStarted = true;
    setTimeout(scanWifiNetworks, 0);
  }
}

function fitPrimaryDisplay() {
  const display = $("primaryDisplay");
  display.style.removeProperty("width");
  display.style.removeProperty("transform");
  const naturalWidth = display.scrollWidth;
  const availableWidth = $("primary").clientWidth;
  if (!naturalWidth || naturalWidth <= availableWidth) return;
  const scale = availableWidth / naturalWidth;
  display.style.width = `${naturalWidth * scale}px`;
  display.style.transform = `scaleX(${scale})`;
}

function renderScale(active, maximum) {
  const element = $("resistanceScale");
  element.textContent = "";
  for (let value = maximum; value >= 1; value--) {
    const row = document.createElement("div");
    row.className = `scale-row ${value % 3 === 0 ? "major" : ""} ${value === active ? "active" : ""}`;
    row.textContent = value;
    element.append(row);
  }
}

function renderTimeLabels() {
  const now = (state.metrics || {}).duration || 0;
  let labels;
  if (now === 0) {
    labels = ["", "", "", "", "00:00"];
  } else if (now < 60) {
    labels = Array.from({ length: 5 }, (_, index) =>
      fmtDuration(Math.round((now * index) / 4)),
    );
    for (let index = 1; index < labels.length - 1; index++) {
      if (labels[index] === labels[index - 1]) labels[index] = "";
    }
  } else {
    labels = [60, 45, 30, 15, 0].map((offset) => fmtDuration(now - offset));
  }
  $("timeLabels").replaceChildren(
    ...labels.map((label) => {
      const element = document.createElement("span");
      element.textContent = label;
      return element;
    }),
  );
}

function drawTrace() {
  const canvas = $("trace");
  const pixelRatio = devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;
  const context = canvas.getContext("2d");
  context.scale(pixelRatio, pixelRatio);
  context.clearRect(0, 0, width, height);
  renderTimeLabels();
  if (history.length < 2) return;
  const values = history.map(
    (sample) =>
      ({
        power: sample.power || 0,
        cadence: sample.cadence || 0,
        duration: sample.duration || 0,
        distance: sample.distance || 0,
        calories: sample.calories || 0,
      })[focus],
  );
  const maximum =
    Math.max(focus === "power" ? 60 : focus === "cadence" ? 30 : 1, ...values) *
    1.16;
  context.strokeStyle = "#d8d5ce";
  context.lineWidth = 1.15;
  context.lineJoin = "round";
  context.beginPath();
  values.forEach((value, index) => {
    const x = (index / (values.length - 1)) * (width - 7);
    const y = 8 + (height - 17) * (1 - value / maximum);
    index ? context.lineTo(x, y) : context.moveTo(x, y);
  });
  context.stroke();
  const finalValue = values.at(-1);
  const finalX = width - 7;
  const finalY = 8 + (height - 17) * (1 - finalValue / maximum);
  context.strokeStyle = "#e77846";
  context.lineWidth = 1.8;
  context.beginPath();
  context.arc(finalX, finalY, 3.7, 0, Math.PI * 2);
  context.stroke();
}

function changeFocus(delta = 1) {
  focus =
    metrics[(metrics.indexOf(focus) + delta + metrics.length) % metrics.length];
  localStorage.focus = focus;
  render();
}

$("primary").onclick = () => changeFocus();
document.querySelectorAll("[data-metric]").forEach((button) => {
  button.onclick = () => {
    focus = button.dataset.metric;
    localStorage.focus = focus;
    render();
  };
});
let touchStartX = 0;
$("primary").ontouchstart = (event) => (touchStartX = event.touches[0].clientX);
$("primary").ontouchend = (event) => {
  const delta = event.changedTouches[0].clientX - touchStartX;
  if (Math.abs(delta) > 34) changeFocus(delta < 0 ? 1 : -1);
};

function authHeaders(keyOverride) {
  const key = keyOverride === undefined ? localStorage.apiKey : keyOverride;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function api(path, body, keyOverride) {
  const response = await fetch("/api/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(keyOverride),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(response.status === 401 ? "API 密钥错误或缺失" : message);
  }
  return response.status === 204 ? null : response.json();
}

function fallbackSha256(bytes) {
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
    0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
    0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
    0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, Math.floor(bytes.length / 0x20000000));
  paddedView.setUint32(paddedLength - 4, (bytes.length * 8) >>> 0);

  const words = new Uint32Array(64);
  const rotate = (value, count) => (value >>> count) | (value << (32 - count));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = paddedView.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
      const sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
      words[index] =
        (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return Array.from(state, (value) => value.toString(16).padStart(8, "0")).join("");
}

async function firmwareSha256(buffer) {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
  }
  return fallbackSha256(new Uint8Array(buffer));
}

function formatFirmwareSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

async function loadFirmwareStatus() {
  try {
    currentFirmware = await api("/firmware");
    $("firmwareFile").disabled = false;
    $("firmwareVersion").textContent = `v${currentFirmware.version || "—"}`;
    $("firmwarePartition").textContent = currentFirmware.runningPartition || "—";
    $("firmwareCapacity").textContent = currentFirmware.maximumImageBytes
      ? formatFirmwareSize(currentFirmware.maximumImageBytes)
      : "—";
    if (!currentFirmware.otaSupported) {
      $("firmwareHint").textContent = "当前分区不支持在线更新。";
      $("firmwareFile").disabled = true;
    }
  } catch (error) {
    $("firmwareVersion").textContent = "读取失败";
    $("firmwareHint").textContent = error.message;
  }
}

function uploadFirmware(file, sha256) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/v1/firmware");
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("X-C1-Bridge-SHA256", sha256);
    Object.entries(authHeaders()).forEach(([name, value]) =>
      request.setRequestHeader(name, value),
    );
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.min(99, Math.round((event.loaded / event.total) * 100));
      $("firmwareProgress").style.setProperty("--progress", `${progress}%`);
      $("firmwareHint").textContent = `正在上传固件… ${progress}%`;
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText));
        } catch (_) {
          resolve({ accepted: true });
        }
      } else {
        reject(new Error(request.responseText || `更新失败（${request.status}）`));
      }
    };
    request.onerror = () => reject(new Error("上传连接中断"));
    request.ontimeout = () => reject(new Error("上传超时"));
    request.timeout = 90000;
    request.send(file);
  });
}

document.querySelectorAll("[data-training]").forEach((button) => {
  button.onclick = () =>
    api("/training", { status: +button.dataset.training }).catch(
      (error) => ($("status").textContent = error.message),
    );
});

let resistanceTimer;
$("resistanceScale").onpointerdown = () => {
  resistanceTimer = setTimeout(() => {
    const box = $("resistanceScale").getBoundingClientRect();
    const move = (pointer) => {
      const maximum = state.maxResistance || 18;
      const requested =
        maximum -
        Math.round(((pointer.clientY - box.top) / box.height) * (maximum - 1));
      const value = Math.max(1, Math.min(maximum, requested));
      renderScale(value, maximum);
      $("resistance").textContent = value;
    };
    const up = (pointer) => {
      move(pointer);
      api("/resistance", { value: +$("resistance").textContent }).catch(
        (error) => ($("status").textContent = error.message),
      );
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }, 250);
};
$("resistanceScale").onpointerup = () => clearTimeout(resistanceTimer);

function fillConfig(config) {
  currentConfig = config;
  $("serial").value = config.boundSn || config.suggestedSn || "";
  $("ssid").value = config.wifiSsid || "";
  $("apiAuth").checked = !!config.apiAuthEnabled;
  $("apiKey").value = localStorage.apiKey || "";
  updateWifiSection(true);
}

function resetFirmwareSelection() {
  $("firmwareFile").value = "";
  $("firmwareFileName").textContent = ".bin · 由设备校验后安装";
  $("installFirmware").disabled = true;
  $("firmwareProgress").hidden = true;
  $("firmwareProgress").style.setProperty("--progress", "0%");
}

$("openSettings").onclick = () => {
  wifiChooserRequested = false;
  wifiAutoScanStarted = false;
  $("manualSnPanel").hidden = true;
  $("wifiCredentials").hidden = true;
  resetFirmwareSelection();
  $("settings").showModal();
  $("settings").scrollTop = 0;
  requestAnimationFrame(() => ($("settings").scrollTop = 0));
  $("apiKey").value = localStorage.apiKey || "";
  api("/config")
    .then(fillConfig)
    .catch((error) => ($("qrHint").textContent = error.message));
  loadFirmwareStatus();
};

$("firmwareFile").onchange = () => {
  const file = $("firmwareFile").files[0];
  if (!file) {
    resetFirmwareSelection();
    return;
  }
  const maximum = currentFirmware.maximumImageBytes || 0;
  const validName = file.name.toLowerCase().endsWith(".bin");
  const validSize = file.size >= 1024 && (!maximum || file.size <= maximum);
  $("firmwareFileName").textContent = `${file.name} · ${formatFirmwareSize(file.size)}`;
  $("installFirmware").disabled = !validName || !validSize;
  if (!validName) {
    $("firmwareHint").textContent = "请选择 .bin 格式的 OTA 固件。";
  } else if (!validSize) {
    $("firmwareHint").textContent = maximum
      ? `文件超过 ${formatFirmwareSize(maximum)} 的 OTA 分区容量。`
      : "固件文件内容为空。";
  } else {
    $("firmwareHint").textContent = "文件已选择，安装前会计算并核对 SHA-256。";
  }
};

async function waitForFirmwareRestart(previousPartition) {
  await wait(2500);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const firmware = await api("/firmware");
      if (
        firmware.runningPartition !== previousPartition &&
        !firmware.pendingVerify &&
        !firmware.updateInProgress
      ) {
        currentFirmware = firmware;
        $("firmwareVersion").textContent = `v${firmware.version}`;
        $("firmwarePartition").textContent = firmware.runningPartition;
        return true;
      }
    } catch (_) {
      // 重启期间请求失败属于正常状态。
    }
    await wait(1000);
  }
  return false;
}

$("installFirmware").onclick = async () => {
  const file = $("firmwareFile").files[0];
  if (!file) return;
  const button = $("installFirmware");
  button.disabled = true;
  $("firmwareProgress").hidden = false;
  $("firmwareProgress").style.setProperty("--progress", "0%");
  try {
    $("firmwareHint").textContent = "正在计算固件 SHA-256…";
    const sha256 = await firmwareSha256(await file.arrayBuffer());
    await uploadFirmware(file, sha256);
    $("firmwareProgress").style.setProperty("--progress", "100%");
    $("firmwareHint").textContent = "固件校验通过，设备正在重启…";
    const restarted = await waitForFirmwareRestart(
      currentFirmware.runningPartition,
    );
    $("firmwareHint").textContent = restarted
      ? `更新完成，当前版本 v${currentFirmware.version}。`
      : "固件已安装，设备仍在重启；稍后重新打开此页面查看版本。";
  } catch (error) {
    $("firmwareHint").textContent = error.message;
    button.disabled = false;
  }
};
$("showManualSn").onclick = () => {
  $("manualSnPanel").hidden = false;
  $("serial").focus();
};
$("bind").onclick = () =>
  api("/device", { sn: $("serial").value.trim().toUpperCase() })
    .then(() => location.reload())
    .catch((error) => ($("qrHint").textContent = error.message));
$("readOnly").onclick = () =>
  api("/device", { sn: null })
    .then(() => location.reload())
    .catch((error) => ($("qrHint").textContent = error.message));
function wifiSignalLevel(rssi) {
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

function selectWifiNetwork(button, network) {
  document.querySelectorAll(".wifi-option").forEach((option) => {
    option.classList.toggle("selected", option === button);
  });
  $("wifiCredentials").hidden = false;
  $("ssid").value = network.ssid;
  $("ssid").readOnly = true;
  $("password").value = "";
  $("wifiHint").textContent = network.secure
    ? `已选择 ${network.ssid}，请输入密码。`
    : `已选择开放网络 ${network.ssid}。`;
  if (network.secure) $("password").focus();
  else $("password").value = "";
}

function renderWifiNetworks(networks) {
  const container = $("wifiNetworks");
  container.replaceChildren();
  networks
    .sort((left, right) => right.rssi - left.rssi)
    .forEach((network) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "wifi-option";

      const identity = document.createElement("span");
      identity.className = "wifi-identity";
      const name = document.createElement("strong");
      name.textContent = network.ssid;
      const details = document.createElement("small");
      details.textContent = `${network.secure ? "需要密码" : "开放网络"} · ${network.rssi} dBm`;
      identity.append(name, details);

      const signal = document.createElement("span");
      signal.className = "wifi-signal";
      signal.setAttribute(
        "aria-label",
        `信号 ${wifiSignalLevel(network.rssi)} 格`,
      );
      const level = wifiSignalLevel(network.rssi);
      for (let index = 1; index <= 4; index++) {
        const bar = document.createElement("i");
        bar.classList.toggle("active", index <= level);
        signal.append(bar);
      }
      button.append(identity, signal);
      button.onclick = () => selectWifiNetwork(button, network);
      container.append(button);
    });
  container.hidden = networks.length === 0;
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForWifiNetworks() {
  const startedAt = Date.now();
  const deadline = startedAt + 60000;
  while (Date.now() < deadline) {
    try {
      const result = await api("/wifi/scan");
      if (result.ready) return result;
    } catch (_) {
      // 扫描时 SoftAP 会短暂停顿；热点恢复后继续读取结果。
    }
    if (Date.now() - startedAt > 20000) {
      $("wifiHint").textContent =
        "搜索仍在进行。扫描期间配置热点会短暂停顿，页面会自动恢复。";
    }
    await wait(800);
  }
  throw new Error("60 秒内未收到扫描结果，请检查开发板是否仍在线");
}

async function scanWifiNetworks() {
  const button = $("scanWifi");
  button.disabled = true;
  wifiOperationActive = true;
  wifiAutoScanStarted = true;
  button.textContent = "搜索中…";
  $("wifiNetworks").hidden = true;
  $("wifiCredentials").hidden = true;
  $("wifiHint").textContent =
    "正在搜索附近的 2.4 GHz 网络，配置热点可能短暂停顿。";
  try {
    try {
      await api("/wifi/scan", {});
    } catch (_) {
      // 启动命令可能已生效，只是热点切换信道前响应没有送达。
    }
    const result = await waitForWifiNetworks();
    if (result.error) throw new Error(result.error);
    renderWifiNetworks(result.networks || []);
    $("wifiHint").textContent = result.networks?.length
      ? `找到 ${result.networks.length} 个网络，选择后输入密码。`
      : "没有发现网络，可重新搜索或手动输入网络名称。";
  } catch (error) {
    $("wifiHint").textContent = `搜索失败：${error.message}`;
  } finally {
    wifiOperationActive = false;
    button.disabled = false;
    button.textContent = "重新搜索";
  }
}

$("scanWifi").onclick = scanWifiNetworks;
$("changeWifi").onclick = () => {
  wifiChooserRequested = true;
  wifiAutoScanStarted = false;
  updateWifiSection(true);
};
$("showManualWifi").onclick = () => {
  $("wifiCredentials").hidden = false;
  $("ssid").readOnly = false;
  $("ssid").value = "";
  $("password").value = "";
  $("wifiHint").textContent = "请输入 2.4 GHz 网络名称和密码。";
  $("ssid").focus();
};
$("forgetWifi").onclick = async () => {
  const button = $("forgetWifi");
  button.disabled = true;
  wifiOperationActive = true;
  $("wifiConnectedMeta").textContent = "正在忘记该网络…";
  try {
    await api("/wifi/forget", {});
    currentConfig = { ...currentConfig, wifiConfigured: false, wifiSsid: "" };
    state = {
      ...state,
      wifiConnected: false,
      wifiState: "idle",
      wifiIp: "",
      wifiDisconnectReason: 0,
    };
    $("ssid").value = "";
    $("password").value = "";
    wifiChooserRequested = true;
    wifiAutoScanStarted = false;
  } catch (error) {
    $("wifiConnectedMeta").textContent = error.message;
    return;
  } finally {
    wifiOperationActive = false;
    button.disabled = false;
  }
  updateWifiSection(true);
};

async function waitForWifiConnection() {
  const deadline = Date.now() + 60000;
  let lastState;
  while (Date.now() < deadline) {
    try {
      lastState = await api("/state");
      if (lastState.wifiState === "connected") return lastState;
      if (lastState.wifiState === "password_error") {
        throw new Error("连接失败：密码错误或路由器拒绝认证。");
      }
      if (lastState.wifiState === "not_found") {
        throw new Error("连接失败：没有找到该 2.4 GHz 网络。");
      }
      if (lastState.wifiState === "failed") {
        throw new Error(
          `连接失败：无线网络错误${lastState.wifiDisconnectReason ? `（代码 ${lastState.wifiDisconnectReason}）` : ""}。`,
        );
      }
    } catch (error) {
      if (error.message.startsWith("连接失败")) throw error;
    }
    await wait(1000);
  }
  return lastState;
}

$("saveWifi").onclick = async () => {
  const button = $("saveWifi");
  button.disabled = true;
  wifiOperationActive = true;
  $("wifiHint").textContent = "正在保存 Wi-Fi 配置…";
  try {
    let saveError;
    try {
      await api("/wifi", {
        ssid: $("ssid").value.trim(),
        password: $("password").value,
      });
    } catch (error) {
      // The configuration can already be applied when the shared radio moves
      // to the target channel before the HTTP response reaches the browser.
      saveError = error;
    }
    $("wifiHint").textContent = "Wi-Fi 配置已保存，正在连接…";
    const result = await waitForWifiConnection();
    if (result?.wifiState === "connected") {
      state = result;
      currentConfig = {
        ...currentConfig,
        wifiConfigured: true,
        wifiSsid: $("ssid").value.trim(),
      };
      wifiChooserRequested = false;
      renderWifiConnection(state);
    } else if (saveError) {
      throw saveError;
    } else {
      $("wifiHint").textContent =
        "60 秒内尚未连接；配置已保存，开发板仍会在后台重试。";
    }
  } catch (error) {
    $("wifiHint").textContent = error.message;
  } finally {
    wifiOperationActive = false;
    button.disabled = false;
    updateWifiSection(false);
  }
};
$("saveApiAuth").onclick = async () => {
  const enabled = $("apiAuth").checked;
  const newKey = $("apiKey").value.trim();
  const currentKey = localStorage.apiKey || newKey;
  try {
    await api("/auth", { enabled, key: newKey }, currentKey);
    if (enabled) localStorage.apiKey = newKey;
    else localStorage.removeItem("apiKey");
    $("status").textContent = enabled
      ? "API 密钥验证已启用"
      : "API 密钥验证已关闭";
    connectEvents();
  } catch (error) {
    $("status").textContent = error.message;
  }
};

function accept(nextState) {
  state = nextState;
  history.push(nextState.metrics || {});
  if (history.length > 72) history.shift();
  render();
}

let eventSocket;
let reconnectTimer;
function connectEvents() {
  clearTimeout(reconnectTimer);
  if (eventSocket) {
    eventSocket.onclose = null;
    eventSocket.close();
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const key = localStorage.apiKey
    ? `?key=${encodeURIComponent(localStorage.apiKey)}`
    : "";
  eventSocket = new WebSocket(
    `${protocol}://${location.host}/api/v1/events${key}`,
  );
  eventSocket.onmessage = (event) => accept(JSON.parse(event.data));
  eventSocket.onclose = () =>
    (reconnectTimer = setTimeout(connectEvents, 1500));
  eventSocket.onerror = () => eventSocket.close();
}

api("/state")
  .then(accept)
  .catch((error) => ($("status").textContent = error.message));
connectEvents();
document.fonts?.ready.then(fitPrimaryDisplay);
window.addEventListener("resize", () => {
  drawTrace();
  fitPrimaryDisplay();
});
