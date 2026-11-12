"use strict";
let csrfToken = null;
let browserToken = null;
let connection = null;
let busy = false;
const form = document.getElementById("connection");
const statusNode = document.getElementById("status");
const tokenNode = document.getElementById("token");
const tokenPanel = document.getElementById("token-panel");
const harnessConnectionNode = document.getElementById("harness-connection-id");
const gatewaySettingsForm = document.getElementById("gateway-settings");
const gatewayAddressNode = document.getElementById("gateway-address");
const gatewaySettingsStatus = document.getElementById("gateway-settings-status");
function showGatewaySettings(settings) {
  if (!settings) return;
  gatewayAddressNode.value = settings.gatewayOrigin;
  gatewaySettingsStatus.textContent = settings.restartRequired
    ? `Saved address: ${settings.gatewayOrigin}. Restart required; current address: ${settings.currentOrigin}. Refresh client bindings after restarting.`
    : `Current address: ${settings.currentOrigin}.`;
}
function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll("button")) button.disabled = value || !browserToken;
  document.getElementById("generate").disabled = value || !connection;
}
function clearOutputs() {
  tokenNode.value = "";
  harnessConnectionNode.value = "";
  tokenPanel.hidden = true;
}
async function request(path, payload) {
  const options = {credentials: "same-origin", cache: "no-store"};
  if (payload !== undefined) {
    options.method = "POST";
    options.headers = {"Content-Type": "application/json", "X-CSRF-Token": csrfToken, "X-Gateway-Session": browserToken};
    options.body = JSON.stringify(payload);
  } else if (path === "/api/browser-session") {
    options.headers = {"X-Gateway-UI": "1"};
  }
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.code || "REQUEST_FAILED");
  return data;
}
async function refreshBrowserSession() {
  const data = await request("/api/browser-session");
  if (!data.csrfToken || !data.browserToken) throw new Error("Browser session unavailable. Refresh this page.");
  csrfToken = data.csrfToken;
  browserToken = data.browserToken;
  return data;
}
async function perform(action) {
  if (busy) return;
  setBusy(true);
  try { await action(); }
  catch (error) { statusNode.textContent = error.message || "REQUEST_FAILED"; }
  finally { setBusy(false); }
}
form.addEventListener("submit", event => {
  event.preventDefault();
  if (busy || !browserToken) return;
  const payload = Object.fromEntries(new FormData(form));
  form.elements.webServiceKey.value = "";
  connection = null;
  clearOutputs();
  perform(async () => {
    // Refresh only the local session before save, including after a Gateway restart.
    await refreshBrowserSession();
    connection = await request("/api/connection", payload);
    statusNode.textContent = "Connection saved locally.";
  });
});
gatewaySettingsForm.addEventListener("submit", event => {
  event.preventDefault();
  if (busy || !browserToken) return;
  const gatewayOrigin = gatewayAddressNode.value;
  perform(async () => {
    await refreshBrowserSession();
    try {
      showGatewaySettings(await request("/api/gateway-settings", {gatewayOrigin}));
      statusNode.textContent = "Service URL saved.";
    } catch (error) {
      gatewaySettingsStatus.textContent = ({INVALID_GATEWAY_ADDRESS: "Enter an HTTP address on 127.0.0.1 with a port from 1 to 65535.",
        GATEWAY_SETTINGS_WRITE_FAILED: "Could not save the Service URL. The previous setting is unchanged."})[error.message] || "Service URL was not saved.";
      throw error;
    }
  });
});
document.getElementById("generate").addEventListener("click", () => perform(async () => {
  tokenNode.value = "";
  tokenPanel.hidden = true;
  const outcome = await request("/api/harness/token", {connectionId: connection.connectionId});
  harnessConnectionNode.value = outcome.connectionId;
  tokenNode.value = outcome.gatewayToken;
  tokenPanel.hidden = false;
  statusNode.textContent = "Harness token generated for this connection.";
}));
document.getElementById("copy").addEventListener("click", () => perform(async () => {
  await navigator.clipboard.writeText(tokenNode.value);
  statusNode.textContent = "Token copied.";
}));
perform(async () => {
  const data = await refreshBrowserSession();
  showGatewaySettings(data.gatewaySettings);
  connection = data.connection;
  form.elements.webServiceKey.value = "";
  if (connection) for (const field of ["bcMcpUrl", "company", "userName"]) form.elements[field].value = connection[field];
  statusNode.textContent = data.storageError || (connection ? "Saved connection restored." : "No connection saved.");
});
