"use strict";

(function () {
  // DOM elements
  const supportStatus = document.getElementById("supportStatus");
  const secureContext = document.getElementById("secureContext");
  const connectBtn = document.getElementById("connectBtn");
  const disconnectBtn = document.getElementById("disconnectBtn");
  const portInfo = document.getElementById("portInfo");
  const statusMsg = document.getElementById("statusMsg");
  const baudEl = document.getElementById("baud");
  const dataBitsEl = document.getElementById("dataBits");
  const parityEl = document.getElementById("parity");
  const stopBitsEl = document.getElementById("stopBits");
  const rtsctsEl = document.getElementById("rtscts");
  const hexInput = document.getElementById("hexInput");
  const sendBtn = document.getElementById("sendBtn");
  const receiveLog = document.getElementById("receiveLog");
  const clearLogBtn = document.getElementById("clearLogBtn");
  const viewModeEl = document.getElementById("viewMode");
  const autoScrollEl = document.getElementById("autoScroll");
  const authorizedPortsEl = document.getElementById("authorizedPorts");
  const refreshPortsBtn = document.getElementById("refreshPortsBtn");
  const openSelectedBtn = document.getElementById("openSelectedBtn");

  /** @type {SerialPort|null} */
  let port = null;
  /** @type {ReadableStreamDefaultReader<Uint8Array>|null} */
  let reader = null;
  /** @type {WritableStreamDefaultWriter<Uint8Array>|null} */
  let writer = null;
  /** @type {Uint8Array[]} */
  const rxChunks = [];
  const textDecoder = new TextDecoder("utf-8", { fatal: false });

  // Feature checks
  const serialSupported = "serial" in navigator;
  supportStatus.textContent = serialSupported ? "Web Serial available" : "Web Serial not available";
  supportStatus.style.background = serialSupported ? "#14532d" : "#7f1d1d";
  secureContext.textContent = window.isSecureContext ? "Secure context" : "Not secure context";
  secureContext.style.background = window.isSecureContext ? "#1e3a8a" : "#7f1d1d";

  if (!serialSupported) {
    disableAll(true);
    setStatus("This browser does not support Web Serial. Use a Chromium-based browser.");
  }

  // UI wiring
  connectBtn.addEventListener("click", onConnectClick);
  disconnectBtn.addEventListener("click", disconnect);
  sendBtn.addEventListener("click", onSendClick);
  clearLogBtn.addEventListener("click", () => {
    rxChunks.length = 0;
    renderLog();
  });
  viewModeEl.addEventListener("change", renderLog);
  refreshPortsBtn.addEventListener("click", refreshAuthorizedPorts);
  authorizedPortsEl.addEventListener("change", () => {
    openSelectedBtn.disabled = !authorizedPortsEl.value;
  });
  openSelectedBtn.addEventListener("click", onOpenSelectedClick);

  // Attempt to reuse previously authorized ports (optional convenience)
  // Not auto-connecting; we still require user gesture for open.
  navigator.serial.getPorts?.().then((ports) => {
    if (ports && ports.length > 0) {
      setStatus("Previously authorized port available. Select and open, or click Connect.");
    }
    populateAuthorizedPorts(ports || []);
  }).catch(() => { /* no-op */ });

  // Listen for device plug/unplug events to refresh list
  if (navigator.serial && typeof navigator.serial.addEventListener === "function") {
    try {
      navigator.serial.addEventListener("connect", () => refreshAuthorizedPorts());
      navigator.serial.addEventListener("disconnect", () => refreshAuthorizedPorts());
    } catch (_) { /* ignore */ }
  }

  window.addEventListener("beforeunload", () => {
    // Best-effort cleanup
    if (port && port.readable) {
      try { reader?.cancel(); } catch (_) {}
    }
    if (port) {
      try { port.close(); } catch (_) {}
    }
  });

  function getSerialOptions() {
    const baudRate = parseInt(baudEl.value, 10);
    const dataBits = parseInt(dataBitsEl.value, 10);
    const stopBits = parseInt(stopBitsEl.value, 10);
    const parity = parityEl.value; // "none" | "even" | "odd"
    const flowControl = rtsctsEl.checked ? "hardware" : "none";
    return { baudRate, dataBits, stopBits, parity, flowControl };
  }

  async function onConnectClick() {
    try {
      setStatus("");
      // If a previously granted port exists, allow opening without a chooser; otherwise request.
      const existingPorts = await navigator.serial.getPorts();
      if (existingPorts && existingPorts.length > 0) {
        port = existingPorts[0];
      } else {
        port = await navigator.serial.requestPort({ filters: [] });
      }
      await openPort();
    } catch (err) {
      setStatus(`Connect failed: ${getErrorMessage(err)}`);
    }
  }

  async function onOpenSelectedClick() {
    try {
      setStatus("");
      const index = parseInt(authorizedPortsEl.value, 10);
      if (Number.isNaN(index)) {
        setStatus("Select a port first.");
        return;
      }
      const ports = await navigator.serial.getPorts();
      if (!ports[index]) {
        setStatus("Selected port is no longer available.");
        await refreshAuthorizedPorts();
        return;
      }
      port = ports[index];
      await openPort();
    } catch (err) {
      setStatus(`Open selected failed: ${getErrorMessage(err)}`);
    }
  }

  async function openPort() {
    if (!port) return;
    await port.open(getSerialOptions());
    updateUiConnected(true);

    // Start reader
    reader = port.readable.getReader();
    readLoop().catch((err) => {
      setStatus(`Read error: ${getErrorMessage(err)}`);
    });
  }

  async function disconnect() {
    try {
      setStatus("");
      if (reader) {
        try { await reader.cancel(); } catch (_) {}
        try { reader.releaseLock(); } catch (_) {}
        reader = null;
      }
      if (writer) {
        try { await writer.close(); } catch (_) {}
        try { writer.releaseLock(); } catch (_) {}
        writer = null;
      }
      if (port) {
        try { await port.close(); } catch (_) {}
      }
    } finally {
      port = null;
      updateUiConnected(false);
    }
  }

  async function readLoop() {
    while (true) {
      if (!reader) break;
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        // Store chunk and render
        rxChunks.push(value);
        renderLogTail(value);
      }
    }
  }

  async function refreshAuthorizedPorts() {
    try {
      const ports = await navigator.serial.getPorts();
      populateAuthorizedPorts(ports || []);
    } catch (err) {
      setStatus(`Refresh failed: ${getErrorMessage(err)}`);
    }
  }

  function populateAuthorizedPorts(ports) {
    authorizedPortsEl.innerHTML = "";
    if (!ports || ports.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(none)";
      authorizedPortsEl.appendChild(opt);
      openSelectedBtn.disabled = true;
      return;
    }
    ports.forEach((p, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      // Try to extract some info; USB vendor/product ids may be available
      const usb = p.getInfo ? p.getInfo() : {};
      const vid = usb && usb.usbVendorId != null ? usb.usbVendorId.toString(16).padStart(4, "0") : "";
      const pid = usb && usb.usbProductId != null ? usb.usbProductId.toString(16).padStart(4, "0") : "";
      const idStr = vid && pid ? ` (VID:PID ${vid}:${pid})` : "";
      opt.textContent = `Port ${idx + 1}${idStr}`;
      authorizedPortsEl.appendChild(opt);
    });
    openSelectedBtn.disabled = !authorizedPortsEl.value;
  }

  async function onSendClick() {
    try {
      const bytes = parseHexToBytes(hexInput.value);
      if (!bytes.length) {
        setStatus("Nothing to send (hex input is empty).");
        return;
      }
      await writeBytes(bytes);
      setStatus(`Sent ${bytes.length} bytes.`);
    } catch (err) {
      setStatus(`Send failed: ${getErrorMessage(err)}`);
    }
  }

  async function writeBytes(bytes) {
    if (!port) throw new Error("Not connected");
    if (!writer) writer = port.writable.getWriter();
    await writer.write(bytes);
  }

  function parseHexToBytes(input) {
    if (!input || !input.trim()) return new Uint8Array();
    // Remove 0x prefixes, then strip non-hex separators (spaces, commas, newlines, underscores)
    const withoutPrefixes = input.replace(/0x/gi, "");
    const hexOnly = withoutPrefixes.replace(/[^0-9a-fA-F]/g, "");
    if (hexOnly.length % 2 !== 0) {
      throw new Error("Odd number of hex digits after cleaning input.");
    }
    const byteCount = hexOnly.length / 2;
    const out = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i++) {
      const byteStr = hexOnly.substr(i * 2, 2);
      const byteVal = Number.parseInt(byteStr, 16);
      if (Number.isNaN(byteVal)) {
        throw new Error(`Invalid hex byte: ${byteStr}`);
      }
      out[i] = byteVal;
    }
    return out;
  }

  function renderLog() {
    if (viewModeEl.value === "hex") {
      receiveLog.textContent = chunksToHex(rxChunks);
    } else {
      receiveLog.textContent = chunksToText(rxChunks);
    }
    if (autoScrollEl.checked) {
      receiveLog.scrollTop = receiveLog.scrollHeight;
    }
  }

  function renderLogTail(chunk) {
    // Fast path for appending the latest chunk only
    if (viewModeEl.value === "hex") {
      const tail = bytesToHex(chunk);
      receiveLog.textContent += (receiveLog.textContent ? " " : "") + tail;
    } else {
      receiveLog.textContent += textDecoder.decode(chunk, { stream: true });
    }
    if (autoScrollEl.checked) {
      receiveLog.scrollTop = receiveLog.scrollHeight;
    }
  }

  function chunksToHex(chunks) {
    if (!chunks.length) return "";
    const parts = [];
    for (const c of chunks) parts.push(bytesToHex(c));
    return parts.join(" ");
  }

  function bytesToHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      const h = bytes[i].toString(16).padStart(2, "0");
      s += (i === 0 ? "" : " ") + h.toUpperCase();
    }
    return s;
  }

  function chunksToText(chunks) {
    if (!chunks.length) return "";
    let s = "";
    for (const c of chunks) s += textDecoder.decode(c, { stream: true });
    return s;
  }

  function updateUiConnected(isConnected) {
    connectBtn.disabled = isConnected;
    disconnectBtn.disabled = !isConnected;
    sendBtn.disabled = !isConnected;
    portInfo.textContent = isConnected ? "Connected" : "Not connected";
    portInfo.style.background = isConnected ? "#14532d" : "#1f2937";
  }

  function disableAll(disabled) {
    connectBtn.disabled = disabled;
    disconnectBtn.disabled = disabled;
    sendBtn.disabled = disabled;
    baudEl.disabled = disabled;
    dataBitsEl.disabled = disabled;
    parityEl.disabled = disabled;
    stopBitsEl.disabled = disabled;
    rtsctsEl.disabled = disabled;
  }

  function setStatus(msg) {
    statusMsg.textContent = msg || "";
  }

  function getErrorMessage(err) {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    if (err.message) return err.message;
    try { return JSON.stringify(err); } catch (_) { return String(err); }
  }
})();


